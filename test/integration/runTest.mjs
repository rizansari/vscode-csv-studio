// Runs the smoke suite inside a real VS Code. Uses the local install when VSCODE_PATH is set or found, else downloads one.
import { runTests } from '@vscode/test-electron';
import { existsSync, mkdtempSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Terminals inside VS Code inherit this, which would make the Code binary behave like plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const root = resolve(import.meta.dirname, '../..');
const local = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const vscodeExecutablePath = process.env.VSCODE_PATH ?? (existsSync(local) ? local : undefined);

// Work on copies so the fixtures are never modified.
const workspace = mkdtempSync(join(tmpdir(), 'csv-studio-'));
for (const f of ['customers.csv', 'broken.csv']) copyFileSync(join(root, 'test/fixtures', f), join(workspace, f));

await runTests({
  vscodeExecutablePath,
  extensionDevelopmentPath: root,
  extensionTestsPath: join(root, 'dist/test/suite.js'),
  launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${join(workspace, '.user')}`],
});
