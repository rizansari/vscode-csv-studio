import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { fieldRanges } from '../../core/csv/parse';
import { applyEdit, type CsvEditOp } from '../../core/edit';
import { presetInfo, PRESETS } from '../../core/transforms/presets';
import { runTransform, type TransformOutput } from '../../core/transforms/run';
import type { TransformSpec } from '../../core/transforms/types';
import { recordIndex } from '../../core/table';
import type { ColType } from '../../core/types';
import type { ExportRequest, HostMessage, WebviewMessage } from '../../shared/messages';
import { exportData, type ExportData } from '../commands/export';
import { QueryStore } from '../queryStore';
import { Secrets } from '../secrets';
import { Session, sqlFunctionHelp } from '../session';
import { UserTransforms } from '../userTransforms';
import { config, errorMessage, LARGE_VIEW_TYPE, replaceText, VIEW_TYPE } from '../util';

/** Where a session's text comes from: an open TextDocument (editable) or a file read from disk. */
interface Source {
  uri: vscode.Uri;
  doc?: vscode.TextDocument;
  text(): string;
  readOnlyReason?: string;
  apply?(next: string): Promise<boolean>;
}

interface Panel {
  source: Source;
  session: Session;
  webview: vscode.Webview;
  post(m: HostMessage): void;
  sendMeta(): void;
  /** Query behind the result currently shown, used by "export SQL result". */
  lastQuery?: string;
}

const PREVIEW_ROWS = 50;

export class CsvStudioEditor implements vscode.CustomTextEditorProvider, vscode.CustomReadonlyEditorProvider {
  private readonly panels = new Set<Panel>();
  private active: Panel | undefined;
  private readonly pendingSqlFocus = new Set<string>();
  private suppressSelectUntil = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly queries: QueryStore,
    private readonly secrets: Secrets,
    private readonly transforms: UserTransforms,
  ) {}

  static register(context: vscode.ExtensionContext, queries: QueryStore, secrets: Secrets, transforms: UserTransforms) {
    const p = new CsvStudioEditor(context, queries, secrets, transforms);
    const opts = { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true };
    context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW_TYPE, p, opts), vscode.window.registerCustomEditorProvider(LARGE_VIEW_TYPE, p, opts));
    return p;
  }

  activeUri(): vscode.Uri | undefined {
    return this.active?.source.uri;
  }

  /** Mirrors the text-editor cursor into studios showing that file. */
  selectInStudios(doc: vscode.TextDocument, row: number, col: number) {
    if (Date.now() < this.suppressSelectUntil) return;
    for (const p of this.panels) if (p.source.doc === doc) p.post({ type: 'select', row, col, viewIndex: p.session.viewIndexOf(row) });
  }

  async focusSql(uri: vscode.Uri) {
    const panel = [...this.panels].find((p) => p.source.uri.toString() === uri.toString());
    if (panel) {
      panel.post({ type: 'focusSql' });
      return;
    }
    this.pendingSqlFocus.add(uri.toString());
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, vscode.ViewColumn.Beside);
  }

  refreshAll() {
    for (const p of this.panels) void this.sendTransforms(p);
  }

  /** Registers another file as a SQL table for the studio showing `uri`. */
  addTable(uri: vscode.Uri, fileName: string, text: string): string | undefined {
    const panel = [...this.panels].find((p) => p.source.uri.toString() === uri.toString());
    if (!panel) return undefined;
    const name = panel.session.addTable(fileName, text);
    panel.sendMeta();
    return name;
  }

  // ---- CustomReadonlyEditorProvider (large files, read straight from disk)
  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel) {
    const bytes = await vscode.workspace.fs.readFile(document.uri);
    const text = Buffer.from(bytes).toString('utf8');
    const mb = (bytes.byteLength / 1024 / 1024).toFixed(0);
    this.attach(panel, { uri: document.uri, text: () => text, readOnlyReason: `Large-file mode (${mb} MB, read-only). Query, filter and export still work.` });
  }

  // ---- CustomTextEditorProvider (editable; the TextDocument is the source of truth)
  resolveCustomTextEditor(doc: vscode.TextDocument, panel: vscode.WebviewPanel) {
    this.attach(panel, { uri: doc.uri, doc, text: () => doc.getText(), apply: (next) => replaceText(doc, next) });
  }

  private attach(webviewPanel: vscode.WebviewPanel, source: Source) {
    const webview = webviewPanel.webview;
    const distUri = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    webview.options = { enableScripts: true, localResourceRoots: [distUri] };
    webview.html = this.html(webview, distUri);

    const typesKey = `csvStudio.types:${source.uri.toString()}`;
    const session = new Session(source.uri.fsPath || source.uri.path, this.context.workspaceState.get<(ColType | null)[]>(typesKey, []), config().get('typeInferenceSample', 100000), path.join(this.context.extensionPath, 'dist'));
    session.load(source.text());

    const panel: Panel = {
      source,
      session,
      webview,
      post: (m) => void webview.postMessage(m),
      sendMeta: () => panel.post({ type: 'meta', meta: session.meta(!source.apply, source.readOnlyReason, vscode.workspace.isTrusted) }),
    };
    this.panels.add(panel);
    if (webviewPanel.active) this.active = panel;

    let pending: NodeJS.Timeout | undefined;
    const disposables: vscode.Disposable[] = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document !== source.doc || !e.contentChanges.length) return;
        clearTimeout(pending);
        pending = setTimeout(() => {
          session.load(source.text());
          panel.sendMeta();
        }, 150);
      }),
      this.queries.onDidChange(() => panel.post({ type: 'queries', ...this.queries.all() })),
      this.secrets.onDidChange(() => void this.sendTransforms(panel)),
      this.transforms.onDidChange(() => void this.sendTransforms(panel)),
      webviewPanel.onDidChangeViewState(() => {
        if (webviewPanel.active) this.active = panel;
        else if (this.active === panel) this.active = undefined;
      }),
      webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(panel, m, typesKey)),
    ];
    webviewPanel.onDidDispose(() => {
      clearTimeout(pending);
      disposables.forEach((d) => d.dispose());
      session.dispose();
      this.panels.delete(panel);
      if (this.active === panel) this.active = undefined;
    });
  }

  private async sendTransforms(panel: Panel) {
    const user = await this.transforms.load(undefined, false);
    panel.post({ type: 'transforms', presets: PRESETS.map(presetInfo), user: this.transforms.list(), secrets: this.secrets.names(), sqlFunctions: sqlFunctionHelp(user) });
  }

  private async edit(panel: Panel, op: CsvEditOp) {
    const { source, session } = panel;
    if (!source.apply) throw new Error(source.readOnlyReason ?? 'This file is read-only');
    const next = applyEdit(source.text(), session.table, op);
    if (!(await source.apply(next))) throw new Error('The edit could not be applied');
  }

  private async onMessage(panel: Panel, m: WebviewMessage, typesKey: string) {
    const { session, source } = panel;
    try {
      switch (m.type) {
        case 'ready':
          panel.sendMeta();
          panel.post({ type: 'queries', ...this.queries.all() });
          await this.sendTransforms(panel);
          if (this.pendingSqlFocus.delete(source.uri.toString())) panel.post({ type: 'focusSql' });
          break;
        case 'getRows':
          panel.post({ type: 'rows', reqId: m.reqId, viewVersion: session.viewVersion, start: m.start, rows: session.rows(m.start, m.count) });
          break;
        case 'setView':
          session.setView(m.spec);
          panel.sendMeta();
          break;
        case 'distinct': {
          const d = session.distinct(m.col);
          panel.post({ type: 'distinct', reqId: m.reqId, col: m.col, values: d.values, total: d.total });
          break;
        }
        case 'profile':
          panel.post({ type: 'profile', reqId: m.reqId, col: m.col, profile: session.profile(m.col) });
          break;
        case 'edit':
          await this.edit(panel, m.op);
          break;
        case 'applySort':
          if (session.view.length !== session.table.rows.length) throw new Error('Clear the filters first: sorting the file needs every row in the view');
          await this.edit(panel, { kind: 'reorderRows', order: session.view });
          session.setView({ ...session.viewSpec, sorts: [] });
          break;
        case 'clearRange': {
          const width = session.table.columns.length;
          const cols = m.cols.filter((c) => c < width);
          const cells = Array.from(session.view.subarray(m.start, m.end + 1)).flatMap((row) => cols.filter((col) => session.table.rows[row][col]).map((col) => ({ row, col, value: '' })));
          if (cells.length) await this.edit(panel, { kind: 'setCells', cells });
          break;
        }
        case 'setType':
          session.setType(m.col, m.colType);
          await this.context.workspaceState.update(typesKey, session.typeOverrides);
          panel.sendMeta();
          break;
        case 'setDialect':
          session.setDialect(m.dialect);
          panel.sendMeta();
          break;
        case 'sql':
          await this.runSql(panel, m.reqId, m.query, m.record);
          break;
        case 'buildQuery':
          panel.post({ type: 'sqlText', query: session.buildQuery() });
          break;
        case 'export':
          await exportData(session, await this.exportRows(panel, m.request), m.request, source.apply);
          break;
        case 'transformPreview': {
          const rows = Array.from(session.view.subarray(0, PREVIEW_ROWS));
          const out = await this.transform(panel, m.spec, rows);
          panel.post({ type: 'transformPreview', reqId: m.reqId, rows: out.results, errors: out.errors });
          break;
        }
        case 'transformApply':
          await this.applyTransform(panel, m.spec);
          break;
        case 'removeVirtual':
          session.removeVirtual(m.name);
          panel.sendMeta();
          break;
        case 'command':
          if (m.command === 'openText') await vscode.window.showTextDocument(source.uri, { viewColumn: vscode.ViewColumn.Beside });
          else await vscode.commands.executeCommand(`csvStudio.${m.command}`, source.uri);
          break;
        case 'reveal':
          await this.reveal(panel, m.row, m.col);
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(m.text);
          vscode.window.setStatusBarMessage(`$(copy) Copied ${m.label ?? ''}`.trim(), 2000);
          break;
        case 'saveQuery':
          await this.queries.save(m.query);
          break;
        case 'deleteQuery':
          await this.queries.remove(m.query);
          break;
        case 'error':
          vscode.window.showErrorMessage(`CSV Studio: ${m.message}`);
          break;
      }
    } catch (e) {
      vscode.window.showErrorMessage(`CSV Studio: ${errorMessage(e)}`);
      panel.sendMeta();
    } finally {
      if (m.type === 'transformApply' || m.type === 'export') panel.post({ type: 'busy', label: null });
    }
  }

  private async runSql(panel: Panel, reqId: number, query: string, record: boolean) {
    try {
      const [secrets, user] = await Promise.all([this.secrets.all(), this.transforms.load(undefined, record)]);
      const r = await panel.session.runSql(query, config().get('sqlPreviewLimit', 10000), secrets, user);
      panel.lastQuery = query;
      panel.post({ type: 'sqlResult', reqId, result: { ...r, rows: r.rows.map((row) => row.map((v) => (v instanceof Uint8Array ? `<blob ${v.length} bytes>` : v))) } });
      if (record && query.trim()) await this.queries.addHistory({ query });
    } catch (e) {
      panel.post({ type: 'sqlError', reqId, error: errorMessage(e) });
    }
  }

  private async exportRows(panel: Panel, req: ExportRequest): Promise<ExportData> {
    const { session } = panel;
    panel.post({ type: 'busy', label: 'Exporting…' });
    if (req.source === 'sql') {
      if (!panel.lastQuery) throw new Error('Run a query first');
      const [secrets, user] = await Promise.all([this.secrets.all(), this.transforms.load(undefined, false)]);
      const r = await session.runSql(panel.lastQuery, Infinity, secrets, user);
      return { columns: r.columns, rows: r.rows.map((row) => row.map((v) => (v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v))) };
    }
    const all = session.columnNames;
    const cols = req.columns?.length ? req.columns : all.map((_, i) => i);
    const rowNums = req.source === 'rows' && req.rows ? req.rows : Array.from(req.viewRange ? session.view.subarray(req.viewRange[0], req.viewRange[1] + 1) : session.view);
    const width = session.table.columns.length;
    const rows = rowNums.map((r) => cols.map((c) => (c < width ? (session.table.rows[r][c] ?? '') : (session.virtual[c - width]?.values[r] ?? ''))));
    return { columns: cols.map((c) => all[c]), rows };
  }

  private async transform(panel: Panel, spec: TransformSpec, rows: number[]) {
    const user = spec.kind === 'user' ? await this.transforms.load([spec.id]) : new Map();
    if (spec.kind === 'user' && !user.has(spec.id)) throw new Error(vscode.workspace.isTrusted ? `Transform "${spec.id}" was not allowed or failed to compile` : 'User transforms only run in trusted workspaces');
    const { session } = panel;
    return runTransform(spec, {
      columns: session.columnNames,
      rows: session.allRows(),
      rowIndexes: rows,
      secrets: await this.secrets.all(),
      user,
      timeoutMs: config().get('transformTimeoutMs', 2000),
    });
  }

  private async applyTransform(panel: Panel, spec: TransformSpec) {
    const { session } = panel;
    const cols = spec.cols?.length ? [...new Set(spec.cols)] : [spec.col];
    const width = session.table.columns.length;
    if (spec.target === 'inPlace' && cols.some((c) => c >= width)) throw new Error('Virtual columns cannot be changed in place');
    const rows = spec.onlyView ? Array.from(session.view).sort((a, b) => a - b) : session.table.rows.map((_, i) => i);
    panel.post({ type: 'busy', label: `Transforming ${rows.length.toLocaleString()} rows${cols.length > 1 ? ` × ${cols.length} columns` : ''}…` });
    // Every column runs against the original rows, so the results never depend on column order.
    const outs: { col: number; out: TransformOutput }[] = [];
    for (const col of cols) outs.push({ col, out: await this.transform(panel, { ...spec, col }, rows) });
    const nameFor = (col: number) =>
      cols.length === 1 && spec.newName?.trim() ? spec.newName.trim() : `${session.columnNames[col]}${cols.length > 1 && spec.nameSuffix?.trim() ? spec.nameSuffix.trim() : `_${spec.id}`}`;

    if (spec.target === 'virtual') {
      // Build every column before adding any: adding one can replace (and shift) existing virtual columns.
      const base = session.allRows();
      const added = outs.map(({ col, out }) => {
        const values = base.map((r) => r[col] ?? '');
        for (const r of out.results) values[r.row] = r.after;
        return { name: nameFor(col), values };
      });
      for (const v of added) session.addVirtual(v.name, v.values);
      panel.sendMeta();
    } else if (spec.target === 'newColumn') {
      const columns = outs.map(({ col, out }) => {
        const values = session.table.rows.map(() => '');
        for (const r of out.results) values[r.row] = r.after;
        // A virtual source column has no place in the file: append its result at the end.
        return { name: nameFor(col), at: Math.min(col + 1, width), values };
      });
      await this.edit(panel, { kind: 'addColumns', columns });
    } else {
      const cells = outs.flatMap(({ col, out }) => out.results.filter((r) => r.after !== r.before).map((r) => ({ row: r.row, col, value: r.after })));
      if (cells.length) await this.edit(panel, { kind: 'setCells', cells });
    }

    const total = outs.reduce((s, o) => s + o.out.results.length, 0);
    const errors = outs.reduce((s, o) => s + o.out.errors, 0);
    const msg = `Transformed ${total.toLocaleString()} value(s)` + (errors ? `; ${errors} failed and were left unchanged` : '');
    if (errors) {
      const { col, out } = outs.find((o) => o.out.errors)!;
      const first = out.results.find((r) => r.error)!;
      vscode.window.showWarningMessage(`CSV Studio: ${msg}. First error (${session.columnNames[col]}, row ${first.row + 1}): ${first.error}`);
    } else vscode.window.setStatusBarMessage(`$(check) ${msg}`, 4000);
  }

  private async reveal(panel: Panel, row: number, col: number) {
    const { source, session } = panel;
    if (!source.doc) return;
    const editor = vscode.window.visibleTextEditors.find((e) => e.document === source.doc);
    if (!editor) return;
    const t = session.table;
    const rec = recordIndex(t, row);
    const text = source.doc.getText();
    const ranges = fieldRanges(text, t.parsed.starts[rec], t.parsed.ends[rec], t.dialect);
    const [s, e] = ranges[Math.min(col, ranges.length - 1)] ?? [t.parsed.starts[rec], t.parsed.starts[rec]];
    const sel = new vscode.Selection(source.doc.positionAt(e), source.doc.positionAt(s));
    this.suppressSelectUntil = Date.now() + 300;
    editor.selection = sel;
    editor.revealRange(sel, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private html(webview: vscode.Webview, distUri: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'index.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'index.css'));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>CSV Studio</title>
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
