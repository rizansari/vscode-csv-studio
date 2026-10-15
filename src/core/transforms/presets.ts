import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { dateTimeOffset, parseDate, parseDateTime, type DateOrder } from '../types';
import type { ParamSpec, TransformContext, TransformInfo } from './types';

export interface Preset extends TransformInfo {
  run(value: string, p: Record<string, string>, ctx: TransformContext): string;
}

function decode(s: string, enc: string): Buffer {
  const t = s.trim();
  if (enc === 'hex') {
    if (!/^(?:[0-9a-f]{2})*$/i.test(t)) throw new Error('Not valid hex');
    return Buffer.from(t, 'hex');
  }
  if (enc === 'base64url') return Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (enc === 'utf8') return Buffer.from(s, 'utf8');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(t)) throw new Error('Not valid base64');
  return Buffer.from(t, 'base64');
}

function encode(b: Buffer, enc: string): string {
  return enc === 'base64url' ? b.toString('base64url') : b.toString(enc as BufferEncoding);
}

const AES = ['aes-256-gcm', 'aes-192-gcm', 'aes-128-gcm', 'aes-256-cbc', 'aes-192-cbc', 'aes-128-cbc', 'aes-256-ctr', 'aes-128-ctr', 'aes-256-ecb', 'aes-128-ecb'];

function keyBytes(algorithm: string): number {
  return Number(/aes-(\d+)/.exec(algorithm)![1]) / 8;
}

/** Turns the stored secret into key bytes of the length the algorithm needs. */
export function deriveKey(secret: string, format: string, algorithm: string): Buffer {
  const need = keyBytes(algorithm);
  const key = format === 'passphrase' ? crypto.createHash('sha256').update(secret, 'utf8').digest().subarray(0, need) : decode(secret, format);
  if (key.length !== need) throw new Error(`${algorithm} needs a ${need}-byte key, got ${key.length} bytes (check key format)`);
  return key;
}

const mode = (alg: string) => alg.split('-')[2] as 'gcm' | 'cbc' | 'ctr' | 'ecb';

export interface AesOptions {
  algorithm: string;
  key: Buffer;
  /** Where the IV comes from: prefix of the data, a separate value, or none (ECB). */
  iv?: Buffer;
  ivLength?: number;
  /** GCM: auth tag appended at the end (default) or placed right after the IV. */
  tagPosition?: 'suffix' | 'afterIv';
  aad?: string;
}

export function aesDecrypt(data: Buffer, o: AesOptions): Buffer {
  const m = mode(o.algorithm);
  let offset = 0;
  let iv: Buffer | null = null;
  if (m !== 'ecb') {
    if (o.iv) iv = o.iv;
    else {
      const len = o.ivLength || (m === 'gcm' ? 12 : 16);
      iv = data.subarray(0, len);
      offset = len;
    }
  }
  if (m === 'gcm') {
    const tagLen = 16;
    let tag: Buffer;
    let ct: Buffer;
    if (o.tagPosition === 'afterIv') {
      tag = data.subarray(offset, offset + tagLen);
      ct = data.subarray(offset + tagLen);
    } else {
      tag = data.subarray(data.length - tagLen);
      ct = data.subarray(offset, data.length - tagLen);
    }
    if (tag.length !== tagLen) throw new Error('Data too short for IV + tag');
    const d = crypto.createDecipheriv(o.algorithm as crypto.CipherGCMTypes, o.key, iv!);
    if (o.aad) d.setAAD(Buffer.from(o.aad, 'utf8'));
    d.setAuthTag(tag);
    try {
      return Buffer.concat([d.update(ct), d.final()]);
    } catch {
      throw new Error('Authentication failed (wrong key, IV or data)');
    }
  }
  const d = crypto.createDecipheriv(o.algorithm, o.key, iv);
  try {
    return Buffer.concat([d.update(data.subarray(offset)), d.final()]);
  } catch {
    throw new Error('Decryption failed (wrong key, IV or padding)');
  }
}

/** Encrypts with a random IV, laid out as IV | ciphertext | tag (GCM) — the same layout aesDecrypt reads by default. */
export function aesEncrypt(plain: Buffer, o: Omit<AesOptions, 'iv' | 'tagPosition'>): Buffer {
  const m = mode(o.algorithm);
  const iv = m === 'ecb' ? null : crypto.randomBytes(o.ivLength || (m === 'gcm' ? 12 : 16));
  const c = crypto.createCipheriv(o.algorithm, o.key, iv);
  if (m === 'gcm' && o.aad) (c as crypto.CipherGCM).setAAD(Buffer.from(o.aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const tag = m === 'gcm' ? (c as crypto.CipherGCM).getAuthTag() : Buffer.alloc(0);
  return Buffer.concat([iv ?? Buffer.alloc(0), ct, tag]);
}

export function fernetDecrypt(token: string, key: string): string {
  const k = decode(key, 'base64url');
  if (k.length !== 32) throw new Error('Fernet key must be 32 bytes (url-safe base64)');
  const data = decode(token, 'base64url');
  if (data.length < 57 || data[0] !== 0x80) throw new Error('Not a Fernet token');
  const body = data.subarray(0, data.length - 32);
  const mac = crypto.createHmac('sha256', k.subarray(0, 16)).update(body).digest();
  if (!crypto.timingSafeEqual(mac, data.subarray(data.length - 32))) throw new Error('Fernet signature mismatch (wrong key?)');
  const iv = data.subarray(9, 25);
  const d = crypto.createDecipheriv('aes-128-cbc', k.subarray(16), iv);
  return Buffer.concat([d.update(data.subarray(25, data.length - 32)), d.final()]).toString('utf8');
}

function pad(n: number, w = 2) {
  return String(n).padStart(w, '0');
}

function zone(offsetMin: number): string {
  if (!offsetMin) return 'Z';
  const a = Math.abs(offsetMin);
  return `${offsetMin < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/**
 * Formats a timestamp with YYYY, MM, DD, HH, mm, ss, SSS (milliseconds) and Z (zone, e.g. +03:00)
 * tokens, or "iso", "epoch", "epoch-ms". Wall-clock fields are shown at `offsetMin` (default UTC).
 */
export function formatDate(ms: number, pattern: string, offsetMin = 0): string {
  if (pattern === 'epoch') return String(Math.floor(ms / 1000));
  if (pattern === 'epoch-ms') return String(ms);
  const d = new Date(ms + offsetMin * 60_000);
  if (pattern === 'iso') pattern = 'YYYY-MM-DDTHH:mm:ss.SSSZ';
  return pattern.replace(/YYYY|SSS|MM|DD|HH|mm|ss|Z/g, (t) =>
    t === 'YYYY'
      ? String(d.getUTCFullYear())
      : t === 'SSS'
        ? pad(d.getUTCMilliseconds(), 3)
        : t === 'MM'
          ? pad(d.getUTCMonth() + 1)
          : t === 'DD'
            ? pad(d.getUTCDate())
            : t === 'HH'
              ? pad(d.getUTCHours())
              : t === 'mm'
                ? pad(d.getUTCMinutes())
                : t === 'ss'
                  ? pad(d.getUTCSeconds())
                  : zone(offsetMin),
  );
}

export function parseAnyDate(s: string, order: DateOrder | 'auto'): number | null {
  const t = s.trim();
  if (/^\d{10}$/.test(t)) return Number(t) * 1000;
  if (/^\d{13}$/.test(t)) return Number(t);
  const dt = parseDateTime(t);
  if (dt !== null) return dt;
  for (const o of order === 'auto' ? (['ymd', 'dmy', 'mdy'] as const) : [order]) {
    const ms = parseDate(t, o);
    if (ms !== null) return ms;
  }
  const iso = Date.parse(t.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T'));
  return Number.isNaN(iso) ? null : iso;
}

const P = {
  algorithm: { name: 'algorithm', label: 'Algorithm', type: 'select', options: AES, default: 'aes-256-gcm' },
  key: { name: 'key', label: 'Key (secret name)', type: 'secret' },
  keyFormat: { name: 'keyFormat', label: 'Key format', type: 'select', options: ['hex', 'base64', 'utf8', 'passphrase'], default: 'hex' },
} satisfies Record<string, ParamSpec>;

const IV_PARAMS: ParamSpec[] = [
  { name: 'ivSource', label: 'IV', type: 'select', options: ['prefix', 'column', 'fixed'], default: 'prefix' },
  { name: 'ivColumn', label: 'IV column', type: 'column', when: { ivSource: ['column'] } },
  { name: 'ivFixed', label: 'IV (hex)', type: 'text', when: { ivSource: ['fixed'] } },
  { name: 'ivLength', label: 'IV length (bytes)', type: 'number', placeholder: '12 for GCM, 16 otherwise', optional: true, when: { ivSource: ['prefix'] } },
  { name: 'tagPosition', label: 'GCM tag position', type: 'select', options: ['suffix', 'afterIv'], default: 'suffix' },
  { name: 'aad', label: 'GCM additional data', type: 'text', optional: true },
];

function ivFrom(p: Record<string, string>, ctx: TransformContext, encoding: string): Buffer | undefined {
  if (p.ivSource === 'column') {
    const v = ctx.row[p.ivColumn];
    if (v === undefined) throw new Error(`IV column "${p.ivColumn}" not found`);
    return /^[0-9a-f]+$/i.test(v.trim()) && v.trim().length % 2 === 0 ? decode(v, 'hex') : decode(v, encoding === 'hex' ? 'base64' : encoding);
  }
  if (p.ivSource === 'fixed') return decode(p.ivFixed ?? '', 'hex');
  return undefined;
}

const ZONE_PARAM: ParamSpec = { name: 'zone', label: 'Time zone', type: 'select', options: ['UTC', 'keep offset'], default: 'UTC' };

const titleCase =(s: string) => s.toLowerCase().replace(/(^|[\s\-_'])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());

export const PRESETS: Preset[] = [
  // ---- Crypto
  {
    id: 'aes-decrypt',
    label: 'AES decrypt',
    group: 'Crypto',
    description: 'Decrypt AES (GCM/CBC/CTR/ECB). Default layout: IV | ciphertext | tag, base64.',
    sql: 'decrypt',
    params: [P.algorithm, P.key, P.keyFormat, { name: 'inputFormat', label: 'Input encoding', type: 'select', options: ['base64', 'base64url', 'hex'], default: 'base64' }, ...IV_PARAMS],
    run(v, p, ctx) {
      if (!v.trim()) return v;
      const algorithm = p.algorithm || 'aes-256-gcm';
      const key = deriveKey(ctx.secret(p.key), p.keyFormat || 'hex', algorithm);
      const out = aesDecrypt(decode(v, p.inputFormat || 'base64'), {
        algorithm,
        key,
        iv: ivFrom(p, ctx, p.inputFormat || 'base64'),
        ivLength: Number(p.ivLength) || undefined,
        tagPosition: p.tagPosition === 'afterIv' ? 'afterIv' : 'suffix',
        aad: p.aad || undefined,
      });
      return out.toString('utf8');
    },
  },
  {
    id: 'aes-encrypt',
    label: 'AES encrypt',
    group: 'Crypto',
    description: 'Encrypt with a random IV; output IV | ciphertext | tag.',
    sql: 'encrypt',
    params: [P.algorithm, P.key, P.keyFormat, { name: 'outputFormat', label: 'Output encoding', type: 'select', options: ['base64', 'base64url', 'hex'], default: 'base64' }, { name: 'aad', label: 'GCM additional data', type: 'text', optional: true }],
    run(v, p, ctx) {
      if (!v) return v;
      const algorithm = p.algorithm || 'aes-256-gcm';
      return encode(aesEncrypt(Buffer.from(v, 'utf8'), { algorithm, key: deriveKey(ctx.secret(p.key), p.keyFormat || 'hex', algorithm), aad: p.aad || undefined }), p.outputFormat || 'base64');
    },
  },
  {
    id: 'fernet-decrypt',
    label: 'Fernet decrypt',
    group: 'Crypto',
    description: 'Decrypt Python cryptography.fernet tokens.',
    sql: 'fernet_decrypt',
    params: [P.key],
    run: (v, p, ctx) => (v.trim() ? fernetDecrypt(v, ctx.secret(p.key)) : v),
  },
  {
    id: 'hash',
    label: 'Hash / HMAC',
    group: 'Crypto',
    description: 'One-way hash (pseudonymise IDs); HMAC when a key is given.',
    sql: 'hash',
    params: [
      { name: 'algorithm', label: 'Algorithm', type: 'select', options: ['sha256', 'sha512', 'sha1', 'md5'], default: 'sha256' },
      { name: 'output', label: 'Output', type: 'select', options: ['hex', 'base64'], default: 'hex' },
      { name: 'key', label: 'HMAC key (secret, optional)', type: 'secret', optional: true },
    ],
    run(v, p, ctx) {
      const alg = p.algorithm || 'sha256';
      const h = p.key ? crypto.createHmac(alg, ctx.secret(p.key)) : crypto.createHash(alg);
      return h.update(v, 'utf8').digest((p.output || 'hex') as crypto.BinaryToTextEncoding);
    },
  },
  // ---- Encoding
  {
    id: 'base64-decode',
    label: 'Base64 decode',
    group: 'Encoding',
    description: 'Standard or URL-safe base64 → text.',
    sql: 'b64decode',
    params: [],
    run: (v) => (v.trim() ? decode(v, 'base64url').toString('utf8') : v),
  },
  { id: 'base64-encode', label: 'Base64 encode', group: 'Encoding', description: 'Text → base64.', sql: 'b64encode', params: [], run: (v) => Buffer.from(v, 'utf8').toString('base64') },
  { id: 'hex-decode', label: 'Hex decode', group: 'Encoding', description: 'Hex → text.', sql: 'hexdecode', params: [], run: (v) => decode(v, 'hex').toString('utf8') },
  { id: 'hex-encode', label: 'Hex encode', group: 'Encoding', description: 'Text → hex.', sql: 'hexencode', params: [], run: (v) => Buffer.from(v, 'utf8').toString('hex') },
  { id: 'url-decode', label: 'URL decode', group: 'Encoding', description: 'Percent-decoding (+ as space).', sql: 'urldecode', params: [], run: (v) => decodeURIComponent(v.replace(/\+/g, ' ')) },
  { id: 'url-encode', label: 'URL encode', group: 'Encoding', description: 'Percent-encoding.', sql: 'urlencode', params: [], run: (v) => encodeURIComponent(v) },
  {
    id: 'gunzip-base64',
    label: 'Gunzip (base64)',
    group: 'Encoding',
    description: 'Base64 of gzip/deflate data → text.',
    sql: 'gunzip',
    params: [],
    run(v) {
      if (!v.trim()) return v;
      const b = decode(v, 'base64url');
      return (b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : zlib.inflateSync(b)).toString('utf8');
    },
  },
  { id: 'gzip-base64', label: 'Gzip (base64)', group: 'Encoding', description: 'Text → gzip → base64.', params: [], run: (v) => zlib.gzipSync(Buffer.from(v, 'utf8')).toString('base64') },
  {
    id: 'jwt-decode',
    label: 'JWT decode',
    group: 'Encoding',
    description: 'Show the payload (or header) of a JWT. The signature is NOT verified.',
    sql: 'jwt_payload',
    params: [
      { name: 'part', label: 'Part', type: 'select', options: ['payload', 'header'], default: 'payload' },
      { name: 'claim', label: 'Single claim (optional)', type: 'text', optional: true, placeholder: 'sub' },
    ],
    run(v, p) {
      if (!v.trim()) return v;
      const parts = v.trim().replace(/^Bearer\s+/i, '').split('.');
      if (parts.length < 2) throw new Error('Not a JWT');
      const obj = JSON.parse(decode(parts[p.part === 'header' ? 0 : 1], 'base64url').toString('utf8'));
      if (p.claim) {
        const c = obj[p.claim];
        return c === undefined ? '' : typeof c === 'object' ? JSON.stringify(c) : String(c);
      }
      return JSON.stringify(obj);
    },
  },
  // ---- Text
  { id: 'trim', label: 'Trim whitespace', group: 'Text', description: 'Remove leading/trailing spaces.', sql: 'trim_ws', params: [], run: (v) => v.trim() },
  { id: 'upper', label: 'UPPERCASE', group: 'Text', description: '', params: [], run: (v) => v.toUpperCase() },
  { id: 'lower', label: 'lowercase', group: 'Text', description: '', params: [], run: (v) => v.toLowerCase() },
  { id: 'title', label: 'Title Case', group: 'Text', description: '', sql: 'title_case', params: [], run: (v) => titleCase(v) },
  {
    id: 'find-replace',
    label: 'Find & replace',
    group: 'Text',
    description: 'Replace every occurrence of a text.',
    params: [
      { name: 'find', label: 'Find', type: 'text' },
      { name: 'replace', label: 'Replace with', type: 'text', optional: true },
    ],
    run: (v, p) => (p.find ? v.split(p.find).join(p.replace ?? '') : v),
  },
  {
    id: 'regex-replace',
    label: 'Regex replace',
    group: 'Text',
    description: 'Replace matches; use $1, $2 for groups.',
    params: [
      { name: 'pattern', label: 'Pattern', type: 'text' },
      { name: 'replacement', label: 'Replacement', type: 'text', optional: true },
      { name: 'flags', label: 'Flags', type: 'text', default: 'g' },
    ],
    run: (v, p) => v.replace(new RegExp(p.pattern, p.flags ?? 'g'), p.replacement ?? ''),
  },
  {
    id: 'regex-extract',
    label: 'Regex extract',
    group: 'Text',
    description: 'Keep only the match (or one group); empty when no match.',
    params: [
      { name: 'pattern', label: 'Pattern', type: 'text' },
      { name: 'group', label: 'Group', type: 'number', default: '0' },
    ],
    run(v, p) {
      const m = new RegExp(p.pattern).exec(v);
      return m ? (m[Number(p.group) || 0] ?? '') : '';
    },
  },
  {
    id: 'mask',
    label: 'Mask',
    group: 'Text',
    description: 'Hide characters, e.g. ************1234.',
    sql: 'mask',
    params: [
      { name: 'keepStart', label: 'Keep first', type: 'number', default: '0' },
      { name: 'keepEnd', label: 'Keep last', type: 'number', default: '4' },
      { name: 'char', label: 'Mask character', type: 'text', default: '*' },
    ],
    run(v, p) {
      const a = Number(p.keepStart) || 0;
      const b = Number(p.keepEnd ?? 4) || 0;
      if (v.length <= a + b) return v;
      return v.slice(0, a) + (p.char || '*').repeat(v.length - a - b) + (b ? v.slice(-b) : '');
    },
  },
  {
    id: 'template',
    label: 'Combine columns (template)',
    group: 'Text',
    description: 'Build a value from columns: {first} {last}. {value} is the current cell.',
    params: [{ name: 'template', label: 'Template', type: 'text', placeholder: '{first} {last}' }],
    run: (v, p, ctx) => (p.template ?? '').replace(/\{([^}]+)\}/g, (_, name: string) => (name === 'value' ? v : ctx.row[name] ?? '')),
  },
  // ---- Values
  {
    id: 'date-format',
    label: 'Reformat date',
    group: 'Values',
    description: 'Parse dates (ISO, d/m/y, m/d/y, epoch) and write them in a new format.',
    params: [
      { name: 'inputOrder', label: 'Input order', type: 'select', options: ['auto', 'ymd', 'dmy', 'mdy'], default: 'auto' },
      { name: 'format', label: 'Output format', type: 'text', default: 'YYYY-MM-DD', placeholder: 'YYYY-MM-DD HH:mm:ss.SSS Z, iso, epoch, epoch-ms' },
      ZONE_PARAM,
    ],
    run(v, p) {
      if (!v.trim()) return v;
      const ms = parseAnyDate(v, (p.inputOrder || 'auto') as DateOrder | 'auto');
      if (ms === null) throw new Error('Unrecognised date');
      return formatDate(ms, p.format || 'YYYY-MM-DD', p.zone === 'keep offset' ? dateTimeOffset(v) : 0);
    },
  },
  {
    id: 'to-datetime',
    label: 'Convert to datetime',
    group: 'Values',
    description: 'Turn date/time text (e.g. "2024-10-30 07:56:43.972 +0300", d/m/y, epoch) into a standard datetime.',
    params: [
      { name: 'format', label: 'Output format', type: 'select', options: ['iso', 'YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD HH:mm:ss.SSS', 'YYYY-MM-DD HH:mm:ssZ', 'epoch', 'epoch-ms'], default: 'iso' },
      { ...ZONE_PARAM, default: 'keep offset' },
      { name: 'inputOrder', label: 'Input order (d/m/y dates)', type: 'select', options: ['auto', 'ymd', 'dmy', 'mdy'], default: 'auto' },
    ],
    run(v, p) {
      if (!v.trim()) return v;
      const ms = parseAnyDate(v, (p.inputOrder || 'auto') as DateOrder | 'auto');
      if (ms === null) throw new Error('Unrecognised date/time');
      return formatDate(ms, p.format || 'iso', p.zone === 'UTC' ? 0 : dateTimeOffset(v));
    },
  },
  {
    id: 'number-format',
    label: 'Reformat number',
    group: 'Values',
    description: 'Strip currency/thousands separators and round.',
    params: [
      { name: 'decimals', label: 'Decimals', type: 'number', placeholder: 'keep', optional: true },
      { name: 'thousands', label: 'Thousands separator', type: 'select', options: ['none', ','], default: 'none' },
      { name: 'inputDecimal', label: 'Input decimal mark', type: 'select', options: ['.', ','], default: '.' },
    ],
    run(v, p) {
      if (!v.trim()) return v;
      let s = v.replace(/[^\d,.\-+eE]/g, '');
      s = p.inputDecimal === ',' ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
      const n = Number(s);
      if (!Number.isFinite(n)) throw new Error('Not a number');
      const fixed = p.decimals !== undefined && p.decimals !== '' ? n.toFixed(Number(p.decimals)) : String(n);
      if (p.thousands !== ',') return fixed;
      const [int, frac] = fixed.split('.');
      return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac !== undefined ? '.' + frac : '');
    },
  },
  {
    id: 'fill-down',
    label: 'Fill down',
    group: 'Values',
    description: 'Empty cells take the value from the row above (in file order).',
    params: [],
    run(v, _p, ctx) {
      if (v.trim()) {
        ctx.state.last = v;
        return v;
      }
      return (ctx.state.last as string | undefined) ?? v;
    },
  },
  {
    id: 'default',
    label: 'Default for empty',
    group: 'Values',
    description: 'Put a value into empty cells.',
    params: [{ name: 'value', label: 'Value', type: 'text' }],
    run: (v, p) => (v.trim() ? v : p.value ?? ''),
  },
];

export function presetInfo(p: Preset): TransformInfo {
  const { run: _run, ...info } = p;
  return info;
}

export function findPreset(id: string): Preset {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown transform "${id}"`);
  return p;
}

export function defaults(params: ParamSpec[]): Record<string, string> {
  return Object.fromEntries(params.filter((p) => p.default !== undefined).map((p) => [p.name, p.default!]));
}

