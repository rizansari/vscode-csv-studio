import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const ws = () => vscode.workspace.workspaceFolders![0].uri;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ext = () => vscode.extensions.all.find((e) => e.packageJSON.name === 'csv-studio')!;

const tests: [string, () => Promise<void>][] = [
  ['activates and registers commands', async () => {
    await ext().activate();
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ['csvStudio.open', 'csvStudio.query', 'csvStudio.repair', 'csvStudio.setSecret', 'csvStudio.diffWithFile']) assert.ok(cmds.includes(c), c);
  }],
  ['lints broken CSV and offers the Repair quick fix', async () => {
    const uri = vscode.Uri.joinPath(ws(), 'broken.csv');
    await vscode.window.showTextDocument(uri);
    await wait(800);
    const diags = vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'CSV Studio');
    assert.ok(diags.some((d) => d.code === 'fieldCount'), 'fieldCount diagnostic');
    assert.ok(diags.some((d) => d.code === 'unterminatedQuote'), 'unterminatedQuote diagnostic');
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', uri, diags[0].range);
    assert.ok(actions.some((a) => a.title === 'Repair CSV (CSV Studio)'));
  }],
  ['shows the column name on hover', async () => {
    const uri = vscode.Uri.joinPath(ws(), 'customers.csv');
    await vscode.window.showTextDocument(uri);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, new vscode.Position(1, 6));
    const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value))).join(' ');
    assert.ok(text.includes('**name**'), text);
  }],
  ['opens the CSV Studio editor and the large-file viewer', async () => {
    const uri = vscode.Uri.joinPath(ws(), 'customers.csv');
    for (const viewType of ['csvStudio.editor', 'csvStudio.largeViewer']) {
      await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
      await wait(1200);
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(tab?.input instanceof vscode.TabInputCustom && tab.input.viewType === viewType, viewType);
    }
  }],
  ['converts JSON to CSV', async () => {
    const doc = await vscode.workspace.openTextDocument({ language: 'json', content: '[{"a":1,"b":{"c":"x,y"}},{"a":2}]' });
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('csvStudio.convertFromJson');
    await wait(300);
    assert.strictEqual(vscode.window.activeTextEditor?.document.getText(), 'a,b.c\n1,"x,y"\n2,\n');
  }],
  ['ships the SQLite wasm next to the bundle', async () => {
    assert.ok(fs.existsSync(path.join(ext().extensionPath, 'dist', 'sql-wasm.wasm')));
  }],
];

export async function run() {
  const failures: string[] = [];
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      console.log(`  ✗ ${name}\n    ${(e as Error).message}`);
      failures.push(name);
    }
  }
  if (failures.length) throw new Error(`${failures.length} integration test(s) failed`);
}
