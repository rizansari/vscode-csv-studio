import * as vscode from 'vscode';

const NAMES = 'csvStudio.secretNames';
const PREFIX = 'csvStudio.secret.';

/**
 * Keys and passwords for transforms, kept in VS Code SecretStorage (the OS keychain). Only the
 * names are stored in global state so they can be listed; values never touch settings or files.
 */
export class Secrets {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  names(): string[] {
    return this.context.globalState.get<string[]>(NAMES, []);
  }

  async all(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const n of this.names()) {
      const v = await this.context.secrets.get(PREFIX + n);
      if (v !== undefined) out[n] = v;
    }
    return out;
  }

  async promptSet() {
    const name = await vscode.window.showInputBox({
      prompt: 'Secret name (used in transforms and SQL, e.g. "payments-key")',
      validateInput: (v) => (/^[\w.-]+$/.test(v) ? null : 'Use letters, digits, ".", "-" or "_"'),
    });
    if (!name) return;
    const value = await vscode.window.showInputBox({ prompt: `Value for "${name}" (key in hex/base64, or a passphrase)`, password: true, ignoreFocusOut: true });
    if (value === undefined) return;
    await this.context.secrets.store(PREFIX + name, value);
    if (!this.names().includes(name)) await this.context.globalState.update(NAMES, [...this.names(), name].sort());
    this.emitter.fire();
    vscode.window.showInformationMessage(`CSV Studio: secret "${name}" saved in the OS keychain.`);
  }

  async promptDelete() {
    const name = await vscode.window.showQuickPick(this.names(), { placeHolder: 'Delete which secret?' });
    if (!name) return;
    await this.context.secrets.delete(PREFIX + name);
    await this.context.globalState.update(NAMES, this.names().filter((n) => n !== name));
    this.emitter.fire();
  }
}
