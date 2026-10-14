import * as path from 'path';
import * as vscode from 'vscode';
import { diffAsRows, diffByKey, mergeTables, splitRows } from '../../core/compare';
import { delimiterName, type Dialect, type Eol } from '../../core/csv/dialect';
import { DEFAULT_REPAIR, repairCsv } from '../../core/csv/lint';
import { writeCsv, writeOptions, type WriteOptions } from '../../core/csv/serialize';
import { EXPORT_FORMATS, exportRows, fromJson } from '../../core/export';
import { tableNameFor } from '../../core/sql/engine';
import { loadTable } from '../../core/table';
import { closeDiffTabs, openUntitled, readFileText, replaceText, type PreviewProvider } from '../util';

async function openDoc(uri: vscode.Uri) {
  return vscode.workspace.openTextDocument(uri);
}

/** Shows the repaired file in a diff and applies it after confirmation. */
export async function repair(uri: vscode.Uri, previews: PreviewProvider) {
  const doc = await openDoc(uri);
  const t = loadTable(doc.getText(), doc.fileName);
  const fixed = repairCsv(t, DEFAULT_REPAIR);
  if (fixed === doc.getText()) {
    vscode.window.showInformationMessage('CSV Studio: nothing to repair.');
    return;
  }
  const preview = previews.create(`repaired${path.extname(doc.fileName) || '.csv'}`, fixed);
  await vscode.commands.executeCommand('vscode.diff', doc.uri, preview, 'Repair CSV (preview)', { preview: true, viewColumn: vscode.ViewColumn.Beside });
  const choice = await vscode.window.showInformationMessage('Apply the repaired CSV shown in the diff? (pads short rows, names extra columns, drops blank lines and a trailing empty column)', 'Apply', 'Cancel');
  await closeDiffTabs(preview);
  previews.dispose(preview);
  if (choice === 'Apply') await replaceText(doc, fixed);
}

const DELIMS: [string, string][] = [
  [',', 'Comma'],
  [';', 'Semicolon'],
  ['\t', 'Tab'],
  ['|', 'Pipe'],
];

async function pickWriteOptions(d: Dialect, title: string): Promise<WriteOptions | undefined> {
  const delim = await vscode.window.showQuickPick(
    DELIMS.map(([v, label]) => ({ label, description: v === d.delimiter ? 'current' : undefined, v })),
    { title, placeHolder: 'Delimiter' },
  );
  if (!delim) return;
  const quoting = await vscode.window.showQuickPick(
    [
      { label: 'Minimal', detail: 'Quote only fields that need it', v: 'minimal' as const },
      { label: 'All fields', detail: 'Quote every field', v: 'all' as const },
      { label: 'Non-numeric', detail: 'Quote every field that is not a number', v: 'nonNumeric' as const },
    ],
    { title, placeHolder: 'Quoting' },
  );
  if (!quoting) return;
  const eol = await vscode.window.showQuickPick(
    [
      { label: 'LF (\\n)', description: d.eol === '\n' ? 'current' : undefined, v: '\n' as Eol },
      { label: 'CRLF (\\r\\n)', description: d.eol === '\r\n' ? 'current' : undefined, v: '\r\n' as Eol },
    ],
    { title, placeHolder: 'Line endings' },
  );
  if (!eol) return;
  return { ...writeOptions(d), delimiter: delim.v, quoting: quoting.v, eol: eol.v };
}

export async function changeDialect(uri: vscode.Uri) {
  const doc = await openDoc(uri);
  const t = loadTable(doc.getText(), doc.fileName);
  const o = await pickWriteOptions(t.dialect, `Rewrite ${path.basename(doc.fileName)} (now: ${delimiterName(t.dialect.delimiter)})`);
  if (!o) return;
  await replaceText(doc, writeCsv(t.rawHeader, t.rows, o));
}

export async function splitFile(uri: vscode.Uri) {
  const t = loadTable(await readFileText(uri), uri.fsPath);
  const how = await vscode.window.showQuickPick(
    [
      { label: 'By column value', detail: 'One file per distinct value', v: 'column' },
      { label: 'Every N rows', detail: 'Chunks of equal size', v: 'size' },
    ],
    { placeHolder: 'Split how?' },
  );
  if (!how) return;
  let groups: Map<string, string[][]>;
  if (how.v === 'column') {
    const col = await vscode.window.showQuickPick(t.columns.map((c, i) => ({ label: c, i })), { placeHolder: 'Column to split by' });
    if (!col) return;
    groups = splitRows(t.rows, { column: col.i });
    if (groups.size > 500 && (await vscode.window.showWarningMessage(`This creates ${groups.size} files. Continue?`, { modal: true }, 'Continue')) !== 'Continue') return;
  } else {
    const n = await vscode.window.showInputBox({ prompt: 'Rows per file', value: '10000', validateInput: (v) => (/^[1-9]\d*$/.test(v) ? null : 'Enter a positive number') });
    if (!n) return;
    groups = splitRows(t.rows, { size: Number(n) });
  }
  const folder = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, defaultUri: vscode.Uri.file(path.dirname(uri.fsPath)), openLabel: 'Write files here' });
  if (!folder?.[0]) return;
  const base = path.basename(uri.fsPath).replace(/\.[^.]+$/, '');
  const ext = path.extname(uri.fsPath) || '.csv';
  const o = writeOptions(t.dialect);
  for (const [key, rows] of groups) {
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder[0], `${base}_${key}${ext}`), Buffer.from(writeCsv(t.rawHeader ?? t.columns, rows, o), 'utf8'));
  }
  vscode.window.showInformationMessage(`CSV Studio: wrote ${groups.size} file(s) to ${folder[0].fsPath}`);
}

export async function mergeFiles(uri?: vscode.Uri) {
  const picked = await vscode.window.showOpenDialog({ canSelectMany: true, filters: { 'CSV / TSV': ['csv', 'tsv', 'tab', 'psv'] }, openLabel: 'Merge', defaultUri: uri });
  if (!picked?.length) return;
  const files = uri && !picked.some((p) => p.toString() === uri.toString()) ? [uri, ...picked] : picked;
  const tables = await Promise.all(files.map(async (f) => loadTable(await readFileText(f), f.fsPath)));
  const source = await vscode.window.showQuickPick(['No', 'Yes'], { placeHolder: 'Add a source_file column?' });
  if (!source) return;
  const merged = mergeTables(
    tables.map((t) => ({ columns: t.columns, rows: t.rows })),
    source === 'Yes' ? files.map((f) => path.basename(f.fsPath)) : undefined,
  );
  await openUntitled(writeCsv(merged.columns, merged.rows, writeOptions(tables[0].dialect)), 'csv');
  vscode.window.showInformationMessage(`CSV Studio: merged ${files.length} files into ${merged.rows.length.toLocaleString()} rows (columns matched by name).`);
}

export async function diffWithFile(uri: vscode.Uri) {
  const other = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'CSV / TSV': ['csv', 'tsv', 'tab', 'psv'] }, openLabel: 'Compare' });
  if (!other?.[0]) return;
  const a = loadTable(await readFileText(uri), uri.fsPath);
  const b = loadTable(await readFileText(other[0]), other[0].fsPath);
  const common = a.columns.filter((c) => b.columns.includes(c));
  if (!common.length) throw new Error('The files have no column names in common');
  const keys = await vscode.window.showQuickPick(
    common.map((c, i) => ({ label: c, picked: i === 0 && /id$/i.test(c) })),
    { canPickMany: true, placeHolder: 'Key column(s) that identify a row' },
  );
  if (!keys?.length) return;
  const sa = { columns: a.columns, rows: a.rows };
  const sb = { columns: b.columns, rows: b.rows };
  const d = diffByKey(sa, sb, keys.map((k) => k.label));
  const summary = `+${d.added.length} added, −${d.removed.length} removed, ~${d.changed.length} changed` + (d.duplicateKeys.length ? ` (${d.duplicateKeys.length} duplicate keys ignored)` : '');
  if (!d.added.length && !d.removed.length && !d.changed.length) {
    vscode.window.showInformationMessage(`CSV Studio: no differences in shared columns. ${d.addedColumns.length || d.removedColumns.length ? `Columns differ: +${d.addedColumns.join(', ')} −${d.removedColumns.join(', ')}` : ''}`);
    return;
  }
  const rows = diffAsRows(d, sa, sb);
  await openUntitled(writeCsv(rows.columns, rows.rows, writeOptions(a.dialect)), 'csv');
  vscode.window.showInformationMessage(`CSV Studio: ${summary}. One row per difference opened in a new tab.`);
}

export async function convertTo(uri: vscode.Uri) {
  const t = loadTable(await readFileText(uri), uri.fsPath);
  const pick = await vscode.window.showQuickPick(
    EXPORT_FORMATS.filter((f) => f.id !== 'csv').map((f) => ({ label: f.label, f })),
    { placeHolder: 'Convert to…' },
  );
  if (!pick) return;
  const nest = pick.f.id === 'json' || pick.f.id === 'yaml' || pick.f.id === 'ndjson' ? (await vscode.window.showQuickPick(['Keep "a.b" columns flat', 'Nest "a.b" columns into objects'], { placeHolder: 'Dotted column names' }))?.startsWith('Nest') ?? false : false;
  await openUntitled(exportRows(t.columns, t.rows, pick.f.id, { ...writeOptions(t.dialect), tableName: tableNameFor(uri.fsPath), nest }), pick.f.language);
}

export async function convertFromJson() {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc) throw new Error('Open a JSON file first');
  const { columns, rows } = fromJson(JSON.parse(doc.getText()));
  await openUntitled(writeCsv(columns, rows, { delimiter: ',', quote: '"', eol: '\n', quoting: 'minimal', header: true }), 'csv');
}
