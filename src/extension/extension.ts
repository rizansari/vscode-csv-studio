import * as path from 'path';
import * as vscode from 'vscode';
import { changeDialect, convertFromJson, convertTo, diffWithFile, mergeFiles, repair, splitFile } from './commands/files';
import { CsvStudioEditor } from './editor/CsvStudioEditor';
import { QueryStore } from './queryStore';
import { Secrets } from './secrets';
import { CsvTextSupport } from './textEditor';
import { UserTransforms } from './userTransforms';
import { activeCsvUri, errorMessage, LARGE_VIEW_TYPE, PREVIEW_SCHEME, PreviewProvider, readFileText, VIEW_TYPE } from './util';

export function activate(context: vscode.ExtensionContext) {
  const queries = new QueryStore(context.workspaceState);
  const secrets = new Secrets(context);
  const transforms = new UserTransforms(context);
  const studio = CsvStudioEditor.register(context, queries, secrets, transforms);
  const previews = new PreviewProvider();

  /** Commands that act on a CSV file: an explorer URI, the focused studio, or the active editor. */
  const onCsv = (name: string, run: (uri: vscode.Uri) => unknown) =>
    vscode.commands.registerCommand(`csvStudio.${name}`, async (arg?: unknown) => {
      try {
        const uri = activeCsvUri(arg, () => studio.activeUri());
        if (!uri) {
          vscode.window.showWarningMessage('CSV Studio: open a CSV file first.');
          return;
        }
        await run(uri);
      } catch (e) {
        vscode.window.showErrorMessage(`CSV Studio: ${errorMessage(e)}`);
      }
    });
  const plain = (name: string, run: () => unknown) =>
    vscode.commands.registerCommand(`csvStudio.${name}`, async () => {
      try {
        await run();
      } catch (e) {
        vscode.window.showErrorMessage(`CSV Studio: ${errorMessage(e)}`);
      }
    });

  context.subscriptions.push(
    transforms,
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, previews),
    new CsvTextSupport((doc, row, col) => studio.selectInStudios(doc, row, col)),
    vscode.workspace.onDidGrantWorkspaceTrust(() => studio.refreshAll()),

    onCsv('open', (uri) => vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE)),
    onCsv('openToSide', (uri) => vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, vscode.ViewColumn.Beside)),
    onCsv('openLarge', (uri) => vscode.commands.executeCommand('vscode.openWith', uri, LARGE_VIEW_TYPE)),
    onCsv('query', (uri) => studio.focusSql(uri)),
    onCsv('repair', (uri) => repair(uri, previews)),
    onCsv('changeDialect', changeDialect),
    onCsv('splitFile', splitFile),
    onCsv('diffWithFile', diffWithFile),
    onCsv('convertTo', convertTo),
    onCsv('addTable', async (uri) => {
      const files = await vscode.window.showOpenDialog({ canSelectMany: true, filters: { 'CSV / TSV': ['csv', 'tsv', 'tab', 'psv'] }, openLabel: 'Add as SQL table' });
      if (!files?.length) return;
      const names: string[] = [];
      for (const f of files) {
        const name = studio.addTable(uri, path.basename(f.fsPath), await readFileText(f));
        if (name) names.push(name);
      }
      if (names.length) vscode.window.showInformationMessage(`CSV Studio: added SQL table(s) ${names.join(', ')}. Example: SELECT * FROM data JOIN ${names[0]} USING (id)`);
      else vscode.window.showWarningMessage('CSV Studio: open the file in CSV Studio first, then add tables.');
    }),
    vscode.commands.registerCommand('csvStudio.mergeFiles', async (arg?: unknown) => {
      try {
        await mergeFiles(activeCsvUri(arg, () => studio.activeUri()));
      } catch (e) {
        vscode.window.showErrorMessage(`CSV Studio: ${errorMessage(e)}`);
      }
    }),
    plain('convertFromJson', convertFromJson),
    plain('setSecret', () => secrets.promptSet()),
    plain('deleteSecret', () => secrets.promptDelete()),
    plain('newTransform', () => transforms.create()),
  );
}

export function deactivate() {}
