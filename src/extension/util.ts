import * as vscode from 'vscode';
import { minimalEdit } from '../core/edit';

export const VIEW_TYPE = 'csvStudio.editor';
export const LARGE_VIEW_TYPE = 'csvStudio.largeViewer';
export const PREVIEW_SCHEME = 'csv-studio';

export function config() {
  return vscode.workspace.getConfiguration('csvStudio');
}

export function isCsvDoc(doc: vscode.TextDocument): boolean {
  return /\.(csv|tsv|tab|psv)$/i.test(doc.fileName) || doc.languageId === 'csv' || doc.languageId === 'tsv';
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Replaces the document text with a single minimal edit so undo, dirty state and cursor stay sane. */
export async function replaceText(doc: vscode.TextDocument, next: string): Promise<boolean> {
  const edit = minimalEdit(doc.getText(), next);
  if (!edit) return true;
  const we = new vscode.WorkspaceEdit();
  we.replace(doc.uri, new vscode.Range(doc.positionAt(edit.offset), doc.positionAt(edit.offset + edit.length)), edit.content);
  return vscode.workspace.applyEdit(we);
}

export async function openUntitled(content: string, language: string, beside = true): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument({ content, language });
  return vscode.window.showTextDocument(doc, beside ? vscode.ViewColumn.Beside : undefined);
}

/** Read-only virtual documents for previews (e.g. repaired CSV shown in a diff). */
export class PreviewProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private counter = 0;

  create(label: string, content: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: '/' + label, query: String(++this.counter) });
    this.contents.set(uri.toString(), content);
    return uri;
  }

  dispose(uri: vscode.Uri) {
    this.contents.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }
}

export async function closeDiffTabs(modified: vscode.Uri) {
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === modified.toString());
  if (tabs.length) await vscode.window.tabGroups.close(tabs);
}

export async function readFileText(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

/** The CSV document a command should act on: an explicit URI, the focused studio, or the active editor. */
export function activeCsvUri(arg: unknown, studioUri: () => vscode.Uri | undefined): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  const studio = studioUri();
  if (studio) return studio;
  const doc = vscode.window.activeTextEditor?.document;
  if (doc && isCsvDoc(doc)) return doc.uri;
  return undefined;
}
