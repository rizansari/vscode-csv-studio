import type { HostMessage, WebviewMessage } from '../../src/shared/messages';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api: VsCodeApi =
  typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : { postMessage: (m) => console.log('[post]', m), getState: () => undefined, setState: () => undefined };

export function post(message: WebviewMessage) {
  api.postMessage(message);
}

export function onHostMessage(handler: (m: HostMessage) => void): () => void {
  const listener = (e: MessageEvent<HostMessage>) => handler(e.data);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

type WithReq = Extract<HostMessage, { reqId: number }>;
const pending = new Map<number, (m: WithReq) => void>();
let nextId = 1;

window.addEventListener('message', (e: MessageEvent<HostMessage>) => {
  const m = e.data;
  if (m && 'reqId' in m) {
    const resolve = pending.get(m.reqId);
    if (resolve) {
      pending.delete(m.reqId);
      resolve(m);
    }
  }
});

/** Sends a message carrying a fresh reqId and resolves with the host's reply to it. */
export function request<T extends WithReq>(build: (reqId: number) => WebviewMessage): Promise<T> {
  const reqId = nextId++;
  return new Promise((resolve) => {
    pending.set(reqId, resolve as (m: WithReq) => void);
    post(build(reqId));
  });
}

/** View state that survives the webview being hidden/restored. */
export interface PersistedState {
  widths?: Record<string, number>;
  hidden?: string[];
  frozen?: number;
  order?: string[];
  wrap?: boolean;
  sqlOpen?: boolean;
  sqlHeight?: number;
  sqlText?: string;
}

export function loadState(): PersistedState {
  return (api.getState() as PersistedState | undefined) ?? {};
}

export function saveState(patch: PersistedState) {
  api.setState({ ...loadState(), ...patch });
}
