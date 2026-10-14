import * as crypto from 'crypto';
import * as vm from 'vm';
import { aesDecrypt, aesEncrypt, deriveKey, fernetDecrypt, formatDate, parseAnyDate } from './presets';
import type { TransformContext } from './types';

export type UserFn = (value: string, row: Record<string, string>, ctx: TransformContext) => unknown;

export interface UserTransform {
  id: string;
  label: string;
  fn: UserFn;
}

/** Helpers available to user transforms as `ctx.helpers` (and as globals for convenience). */
export const HELPERS = {
  aesDecrypt,
  aesEncrypt,
  deriveKey,
  fernetDecrypt,
  formatDate,
  parseDate: parseAnyDate,
  base64: (s: string) => Buffer.from(s, 'base64').toString('utf8'),
  toBase64: (s: string) => Buffer.from(s, 'utf8').toString('base64'),
};

export const TRANSFORM_TEMPLATE = `// CSV Studio transform. Runs once per cell: return the new value.
//   value  – the cell text
//   row    – the whole row, keyed by column name (e.g. row.email)
//   ctx    – { rowIndex, secret(name), state, helpers }
// Available globals: crypto (Node crypto), Buffer, helpers.
// Keys and passwords: run "CSV Studio: Set Secret…" and read them with ctx.secret('name').
// Keep it synchronous if you also want to call it from SQL as js_<file name>(value).

export const label = 'My transform';

export default function (value, row, ctx) {
  if (!value) return value;
  // Example: AES-256-GCM, base64 of IV(12) | ciphertext | tag(16)
  // const key = helpers.deriveKey(ctx.secret('my-key'), 'hex', 'aes-256-gcm');
  // return helpers.aesDecrypt(Buffer.from(value, 'base64'), { algorithm: 'aes-256-gcm', key }).toString('utf8');
  return value.trim();
}
`;

/**
 * Compiles a user transform file. Accepts `export default function…`, `export default (…) => …`
 * or `module.exports = …`, plus an optional `export const label = '…'`.
 *
 * The code runs in a separate vm context without require, process or file system access, with a
 * time limit per call. A vm context is not a security boundary, so callers must only run code
 * from trusted workspaces.
 */
export function compileUserTransform(id: string, source: string, timeoutMs = 2000): UserTransform {
  const body = source
    .replace(/\bexport\s+default\s+/, 'module.exports.default = ')
    .replace(/\bexport\s+const\s+label\s*=/, 'module.exports.label =');
  const sandbox = {
    module: { exports: {} as Record<string, unknown> },
    crypto,
    Buffer,
    helpers: HELPERS,
    console: { log: () => undefined, warn: () => undefined, error: () => undefined },
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
  };
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  new vm.Script(body, { filename: `${id}.js` }).runInContext(context, { timeout: timeoutMs });
  const exported = sandbox.module.exports;
  const fn = (exported.default ?? (typeof exported === 'function' ? exported : undefined)) as UserFn | undefined;
  if (typeof fn !== 'function') throw new Error(`${id}.js must export a default function`);
  const call = new vm.Script('__fn(__v, __r, __c)', { filename: `${id}.js` });
  return {
    id,
    label: typeof exported.label === 'string' ? exported.label : id,
    fn: (value, row, ctx) => {
      context.__fn = fn;
      context.__v = value;
      context.__r = row;
      context.__c = ctx;
      return call.runInContext(context, { timeout: timeoutMs });
    },
  };
}
