import * as vscode from 'vscode';
import { lint } from '../core/csv/lint';
import { fieldRanges } from '../core/csv/parse';
import { loadTable, type Table } from '../core/table';
import { config, isCsvDoc } from './util';

const PALETTE: [string, string][] = [
  ['#2f6fb0', '#79b8ff'],
  ['#b0561e', '#f0a05a'],
  ['#2e8540', '#7fd18b'],
  ['#9b3fa8', '#d59ae0'],
  ['#a07a00', '#e8c55a'],
  ['#1a8a8a', '#6fd6d6'],
];

const LINT_LIMIT = 20 * 1024 * 1024;

/** Parses each CSV document once per version and shares the result. */
class TableCache {
  private cache = new WeakMap<vscode.TextDocument, { version: number; table: Table }>();
  get(doc: vscode.TextDocument): Table {
    const hit = this.cache.get(doc);
    if (hit?.version === doc.version) return hit.table;
    const table = loadTable(doc.getText(), doc.fileName);
    this.cache.set(doc, { version: doc.version, table });
    return table;
  }
}

/** Row/column of an offset, using the record offsets from the parse. */
export function cellAt(doc: vscode.TextDocument, t: Table, offset: number): { row: number; col: number } | null {
  const { starts, ends } = t.parsed;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  if (!starts.length || offset < starts[lo] || offset > ends[lo]) return null;
  const ranges = fieldRanges(doc.getText(), starts[lo], ends[lo], t.dialect);
  const col = Math.max(0, ranges.findIndex(([, e]) => offset <= e));
  return { row: lo - (t.rawHeader ? 1 : 0), col };
}

/**
 * Rainbow columns, a column-name hover and a status bar cell locator for CSV files opened as text,
 * plus lint diagnostics with a "Repair CSV" quick fix.
 */
export class CsvTextSupport implements vscode.Disposable, vscode.HoverProvider, vscode.CodeActionProvider {
  private readonly tables = new TableCache();
  private readonly decorations = PALETTE.map(([light, dark]) => vscode.window.createTextEditorDecorationType({ light: { color: light }, dark: { color: dark } }));
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('csv-studio');
  private readonly subs: vscode.Disposable[];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly onCursorCell: (doc: vscode.TextDocument, row: number, col: number) => void) {
    const selector: vscode.DocumentSelector = [{ pattern: '**/*.{csv,tsv,tab,psv}' }, { language: 'csv' }, { language: 'tsv' }];
    this.subs = [
      vscode.languages.registerHoverProvider(selector, this),
      vscode.languages.registerCodeActionsProvider(selector, this, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => this.decorate(e.textEditor)),
      vscode.window.onDidChangeTextEditorSelection((e) => this.updateStatus(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor((e) => this.updateStatus(e)),
      vscode.workspace.onDidChangeTextDocument((e) => isCsvDoc(e.document) && this.schedule()),
      vscode.workspace.onDidOpenTextDocument((d) => isCsvDoc(d) && this.lintDoc(d)),
      vscode.workspace.onDidCloseTextDocument((d) => this.diagnostics.delete(d.uri)),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('csvStudio.rainbowColumns') && this.schedule()),
    ];
    vscode.workspace.textDocuments.filter(isCsvDoc).forEach((d) => this.lintDoc(d));
    this.schedule();
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      for (const e of vscode.window.visibleTextEditors) if (isCsvDoc(e.document)) {
        this.decorate(e);
        this.lintDoc(e.document);
      }
      this.updateStatus(vscode.window.activeTextEditor);
    }, 200);
  }

  private decorate(editor: vscode.TextEditor) {
    if (!isCsvDoc(editor.document)) return;
    const buckets: vscode.Range[][] = PALETTE.map(() => []);
    if (config().get('rainbowColumns', true)) {
      const doc = editor.document;
      const t = this.tables.get(doc);
      const text = doc.getText();
      for (const visible of editor.visibleRanges) {
        const from = doc.offsetAt(visible.start);
        const to = doc.offsetAt(visible.end);
        const first = Math.max(0, upperBound(t.parsed.starts, from) - 1);
        for (let r = first; r < t.parsed.starts.length && t.parsed.starts[r] <= to; r++) {
          fieldRanges(text, t.parsed.starts[r], t.parsed.ends[r], t.dialect).forEach(([s, e], i) => {
            if (e > s) buckets[i % PALETTE.length].push(new vscode.Range(doc.positionAt(s), doc.positionAt(e)));
          });
        }
      }
    }
    this.decorations.forEach((d, i) => editor.setDecorations(d, buckets[i]));
  }

  private updateStatus(editor?: vscode.TextEditor) {
    if (!editor || !isCsvDoc(editor.document)) {
      this.status.hide();
      return;
    }
    const t = this.tables.get(editor.document);
    const cell = cellAt(editor.document, t, editor.document.offsetAt(editor.selection.active));
    if (!cell) {
      this.status.hide();
      return;
    }
    const name = t.columns[cell.col] ?? `column ${cell.col + 1}`;
    this.status.text = cell.row < 0 ? `$(table) header · ${name}` : `$(table) Row ${cell.row + 1} · ${name}`;
    this.status.tooltip = `${t.rows.length.toLocaleString()} rows × ${t.columns.length} columns`;
    this.status.command = 'csvStudio.openToSide';
    this.status.show();
    if (cell.row >= 0) this.onCursorCell(editor.document, cell.row, cell.col);
  }

  private lintDoc(doc: vscode.TextDocument) {
    if (doc.getText().length > LINT_LIMIT) return;
    const t = this.tables.get(doc);
    const issues = lint(doc.getText(), t).slice(0, 500);
    this.diagnostics.set(
      doc.uri,
      issues.map((i) => {
        const range = new vscode.Range(doc.positionAt(i.offset), doc.positionAt(i.offset + i.length));
        const d = new vscode.Diagnostic(range, i.message, i.severity === 'error' ? vscode.DiagnosticSeverity.Error : i.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information);
        d.source = 'CSV Studio';
        d.code = i.kind;
        return d;
      }),
    );
  }

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const t = this.tables.get(doc);
    const cell = cellAt(doc, t, doc.offsetAt(pos));
    if (!cell) return undefined;
    const name = t.columns[cell.col] ?? `column ${cell.col + 1}`;
    return new vscode.Hover(new vscode.MarkdownString(`**${name}** · column ${cell.col + 1}` + (cell.row >= 0 ? ` · row ${cell.row + 1}` : ' (header)')));
  }

  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    const ours = ctx.diagnostics.filter((d) => d.source === 'CSV Studio');
    if (!ours.length) return [];
    const action = new vscode.CodeAction('Repair CSV (CSV Studio)', vscode.CodeActionKind.QuickFix);
    action.command = { command: 'csvStudio.repair', title: 'Repair CSV', arguments: [doc.uri] };
    action.diagnostics = ours;
    action.isPreferred = true;
    return [action];
  }

  dispose() {
    clearTimeout(this.timer);
    this.subs.forEach((s) => s.dispose());
    this.decorations.forEach((d) => d.dispose());
    this.status.dispose();
    this.diagnostics.dispose();
  }
}

function upperBound(a: number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
