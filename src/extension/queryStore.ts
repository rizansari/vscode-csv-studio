import * as vscode from 'vscode';
import type { SavedQuery } from '../shared/messages';
import { config } from './util';

const HISTORY = 'csvStudio.history';
const SAVED = 'csvStudio.saved';

const same = (a: SavedQuery, b: SavedQuery) => a.query === b.query;

/** Query history and saved queries, kept per workspace. */
export class QueryStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly state: vscode.Memento) {}

  all(): { history: SavedQuery[]; saved: SavedQuery[] } {
    return { history: this.state.get<SavedQuery[]>(HISTORY, []), saved: this.state.get<SavedQuery[]>(SAVED, []) };
  }

  async addHistory(q: SavedQuery) {
    const size = config().get<number>('queryHistorySize', 30);
    const history = [q, ...this.all().history.filter((h) => !same(h, q))].slice(0, size);
    await this.state.update(HISTORY, history);
    this.emitter.fire();
  }

  async save(q: SavedQuery) {
    const name = q.name ?? (await vscode.window.showInputBox({ prompt: 'Name for this saved query', value: q.query.slice(0, 40) }));
    if (name === undefined) return;
    const saved = [...this.all().saved.filter((s) => !same(s, q)), { ...q, name }];
    await this.state.update(SAVED, saved);
    this.emitter.fire();
  }

  async remove(q: SavedQuery) {
    await this.state.update(SAVED, this.all().saved.filter((s) => !same(s, q)));
    this.emitter.fire();
  }
}
