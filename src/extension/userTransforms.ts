import { createHash } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { compileUserTransform, TRANSFORM_TEMPLATE, type UserTransform } from '../core/transforms/sandbox';
import type { UserTransformInfo } from '../shared/messages';
import { config, errorMessage } from './util';

const FOLDER = '.vscode/csv-studio/transforms';
const APPROVED = 'csvStudio.approvedTransforms';

/**
 * JavaScript transforms from `.vscode/csv-studio/transforms/*.js`. They only run in trusted
 * workspaces, and each file version must be approved once before it runs.
 */
export class UserTransforms implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private files = new Map<string, { uri: vscode.Uri; source: string; hash: string }>();
  private compiled = new Map<string, UserTransform>();
  private errors = new Map<string, string>();
  private readonly watcher = vscode.workspace.createFileSystemWatcher(`**/${FOLDER}/*.js`);

  constructor(private readonly context: vscode.ExtensionContext) {
    const reload = () => void this.scan().then(() => this.emitter.fire());
    this.watcher.onDidChange(reload);
    this.watcher.onDidCreate(reload);
    this.watcher.onDidDelete(reload);
    reload();
  }

  async scan() {
    const uris = await vscode.workspace.findFiles(`${FOLDER}/*.js`, undefined, 200);
    this.files = new Map();
    for (const uri of uris) {
      const source = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      const id = path.basename(uri.fsPath, '.js');
      this.files.set(id, { uri, source, hash: createHash('sha256').update(source).digest('hex') });
    }
    this.compiled.clear();
    this.errors.clear();
  }

  list(): UserTransformInfo[] {
    return [...this.files.keys()].sort().map((id) => {
      const label = this.compiled.get(id)?.label ?? /export\s+const\s+label\s*=\s*['"`]([^'"`]+)/.exec(this.files.get(id)!.source)?.[1] ?? id;
      const error = !vscode.workspace.isTrusted ? 'Workspace is not trusted' : this.errors.get(id);
      return { id, label, error };
    });
  }

  private approved(): Record<string, string> {
    return this.context.workspaceState.get<Record<string, string>>(APPROVED, {});
  }

  /** Compiles the transforms, asking the user to approve new or changed files first. */
  async load(ids?: string[], ask = true): Promise<Map<string, UserTransform>> {
    const out = new Map<string, UserTransform>();
    if (!vscode.workspace.isTrusted) return out;
    for (const [id, f] of this.files) {
      if (ids && !ids.includes(id)) continue;
      if (this.approved()[id] !== f.hash) {
        if (!ask) continue;
        const choice = await vscode.window.showWarningMessage(
          `Run the JavaScript transform "${id}.js" from this workspace? It runs with limited access, but only allow code you trust.`,
          { modal: true },
          'Allow',
          'Open File',
        );
        if (choice === 'Open File') await vscode.window.showTextDocument(f.uri);
        if (choice !== 'Allow') continue;
        await this.context.workspaceState.update(APPROVED, { ...this.approved(), [id]: f.hash });
      }
      try {
        let t = this.compiled.get(id);
        if (!t) {
          t = compileUserTransform(id, f.source, config().get<number>('transformTimeoutMs', 2000));
          this.compiled.set(id, t);
        }
        this.errors.delete(id);
        out.set(id, t);
      } catch (e) {
        this.errors.set(id, errorMessage(e));
      }
    }
    return out;
  }

  async create() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage('CSV Studio: open a folder to store transforms in .vscode/csv-studio/transforms.');
      return;
    }
    const name = await vscode.window.showInputBox({ prompt: 'Transform name (file name, also the SQL function js_<name>)', value: 'decrypt_card', validateInput: (v) => (/^[A-Za-z][\w-]*$/.test(v) ? null : 'Start with a letter; use letters, digits, - or _') });
    if (!name) return;
    const uri = vscode.Uri.joinPath(folder.uri, FOLDER, `${name}.js`);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(TRANSFORM_TEMPLATE, 'utf8'));
    }
    await vscode.window.showTextDocument(uri);
  }

  dispose() {
    this.watcher.dispose();
    this.emitter.dispose();
  }
}
