import * as iconv from 'iconv-lite';
import * as path from 'path';
import * as vscode from 'vscode';
import { writeOptions } from '../../core/csv/serialize';
import { EXPORT_FORMATS, exportRows, type ExportFormat } from '../../core/export';
import type { Encoding, ExportRequest } from '../../shared/messages';
import type { Session } from '../session';
import { openUntitled } from '../util';

export function encode(text: string, encoding: Encoding = 'utf8'): Buffer {
  switch (encoding) {
    case 'utf8bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(text, 'utf16le')]);
    case 'latin1':
      return iconv.encode(text, 'win1252');
    default:
      return Buffer.from(text, 'utf8');
  }
}

export interface ExportData {
  columns: string[];
  rows: (string | number | null)[][];
}

/**
 * Writes rows somewhere. `apply` replaces the source document (undoable); it is undefined for
 * read-only sources.
 */
export async function exportData(session: Session, data: ExportData, req: ExportRequest, apply?: (text: string) => Promise<boolean>) {
  const format: ExportFormat = req.format;
  const info = EXPORT_FORMATS.find((f) => f.id === format)!;
  const opts = { ...writeOptions(session.table.dialect, req.options ?? {}), tableName: session.mainAlias(), nest: req.options?.nest ?? false };
  const content = exportRows(data.columns, data.rows, format, opts);
  const count = `${data.rows.length.toLocaleString()} row${data.rows.length === 1 ? '' : 's'}`;

  switch (req.target) {
    case 'newTab':
      await openUntitled(content, info.language);
      return;
    case 'copy':
      await vscode.env.clipboard.writeText(content);
      vscode.window.setStatusBarMessage(`$(copy) Copied ${count} as ${info.label}`, 2500);
      return;
    case 'replace': {
      if (!apply) throw new Error('This file is read-only');
      if (format !== 'csv' && format !== 'tsv') throw new Error('Only CSV/TSV can replace the file');
      const ok = await vscode.window.showWarningMessage(`Replace the whole file with ${count}? (Undo with Ctrl/Cmd+Z)`, { modal: true }, 'Replace');
      if (ok === 'Replace') await apply(content);
      return;
    }
    case 'save': {
      const base = path.basename(session.fileName).replace(/\.[^.]+$/, '') || 'result';
      const dir = path.dirname(session.fileName);
      const defaultUri = path.isAbsolute(dir) ? vscode.Uri.file(path.join(dir, `${base}.result.${info.ext}`)) : undefined;
      const uri = await vscode.window.showSaveDialog({ defaultUri, filters: { [info.label]: [info.ext] }, saveLabel: `Save ${count}` });
      if (!uri) return;
      await vscode.workspace.fs.writeFile(uri, encode(content, req.options?.encoding));
      const open = await vscode.window.showInformationMessage(`Saved ${count} to ${path.basename(uri.fsPath)}`, 'Open', 'Open in CSV Studio');
      if (open === 'Open') await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside });
      if (open === 'Open in CSV Studio') await vscode.commands.executeCommand('vscode.openWith', uri, 'csvStudio.editor', vscode.ViewColumn.Beside);
      return;
    }
  }
}
