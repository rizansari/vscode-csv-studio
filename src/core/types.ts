export type ColType = 'integer' | 'decimal' | 'percent' | 'currency' | 'boolean' | 'date' | 'datetime' | 'uuid' | 'email' | 'url' | 'json' | 'string';

export const COL_TYPES: ColType[] = ['string', 'integer', 'decimal', 'percent', 'currency', 'boolean', 'date', 'datetime', 'uuid', 'email', 'url', 'json'];

/** Date component order for dates written with separators. */
export type DateOrder = 'ymd' | 'dmy' | 'mdy';

export interface ColumnType {
  type: ColType;
  /** Share of non-empty sampled values that match the type (0–1). */
  confidence: number;
  dateOrder?: DateOrder;
  /** Numbers written with a comma as decimal separator ("1.234,5"). */
  decimalComma?: boolean;
}

const RE = {
  // Leading zeros (zip codes, IDs like 007) are not integers: converting them would lose data.
  integer: /^[-+]?[1-9]\d{0,2}(?:,\d{3})+$|^[-+]?(?:0|[1-9]\d*)$/,
  decimal: /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d*)\.\d+(?:[eE][-+]?\d+)?$|^[-+]?\d+(?:\.\d*)?[eE][-+]?\d+$/,
  decimalComma: /^[-+]?(?:\d{1,3}(?:\.\d{3})+|\d+),\d+$/,
  percent: /^[-+]?\d+(?:[.,]\d+)?\s?%$/,
  currency: /^[-+]?\s?(?:[$€£¥₹]|USD|EUR|GBP|INR|QAR|AED)\s?[-+]?[\d,]+(?:\.\d+)?$|^[-+]?[\d,]+(?:\.\d+)?\s?(?:[$€£¥₹]|USD|EUR|GBP|INR|QAR|AED)$/i,
  boolean: /^(?:true|false|yes|no|y|n|t|f)$/i,
  dateYmd: /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/,
  dateOther: /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/,
  datetime: /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  url: /^(?:https?|ftp):\/\/[^\s]+$/i,
};

function isJson(v: string): boolean {
  const t = v.trim();
  if (!((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')))) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Types tried in order; the first that fits (almost) all values wins. */
const ORDER: ColType[] = ['boolean', 'integer', 'decimal', 'percent', 'currency', 'datetime', 'date', 'uuid', 'email', 'url', 'json'];

/** More than 15 significant digits cannot round-trip through a JS number (card numbers, long IDs). */
const tooLong = (s: string) => s.replace(/\D/g, '').replace(/^0+/, '').length > 15;

export function matches(type: ColType, v: string, t: Partial<ColumnType> = {}): boolean {
  const s = v.trim();
  switch (type) {
    case 'string':
      return true;
    case 'integer':
      return RE.integer.test(s) && !tooLong(s);
    case 'decimal':
      return !tooLong(s) && (t.decimalComma ? RE.decimalComma.test(s) || RE.integer.test(s) : RE.decimal.test(s) || RE.integer.test(s));
    case 'percent':
      return RE.percent.test(s);
    case 'currency':
      return RE.currency.test(s);
    case 'boolean':
      return RE.boolean.test(s);
    case 'datetime':
      return RE.datetime.test(s) && !Number.isNaN(Date.parse(s.replace(' ', 'T')));
    case 'date':
      return parseDate(s, t.dateOrder ?? 'ymd') !== null;
    case 'uuid':
      return RE.uuid.test(s);
    case 'email':
      return RE.email.test(s);
    case 'url':
      return RE.url.test(s);
    case 'json':
      return isJson(s);
  }
}

/** Picks the date order that fits the values: a day above 12 disambiguates dd/mm from mm/dd. */
function detectDateOrder(values: string[]): DateOrder | null {
  let ymd = 0;
  let other = 0;
  let firstOver12 = false;
  let secondOver12 = false;
  for (const v of values) {
    const s = v.trim();
    if (RE.dateYmd.test(s)) ymd++;
    const m = RE.dateOther.exec(s);
    if (m) {
      other++;
      if (+m[1] > 12) firstOver12 = true;
      if (+m[2] > 12) secondOver12 = true;
    }
  }
  if (ymd && !other) return 'ymd';
  if (other && !ymd) return secondOver12 && !firstOver12 ? 'mdy' : 'dmy';
  return null;
}

export function inferType(values: string[], threshold = 0.95): ColumnType {
  const sample = values.filter((v) => v.trim() !== '');
  if (!sample.length) return { type: 'string', confidence: 1 };
  const order = detectDateOrder(sample.slice(0, 2000));
  const decimalComma = sample.some((v) => RE.decimalComma.test(v.trim())) && !sample.some((v) => RE.decimal.test(v.trim()));
  const ctx: Partial<ColumnType> = { dateOrder: order ?? 'ymd', decimalComma };
  for (const type of ORDER) {
    if (type === 'date' && !order) continue;
    let hits = 0;
    for (const v of sample) if (matches(type, v, ctx)) hits++;
    const confidence = hits / sample.length;
    if (confidence >= threshold) {
      // "1", "0" alone look boolean-ish only via integer; keep integers as integers.
      return { type, confidence, ...(type === 'date' ? { dateOrder: ctx.dateOrder } : {}), ...(type === 'decimal' && decimalComma ? { decimalComma } : {}) };
    }
  }
  return { type: 'string', confidence: 1 };
}

export function parseDate(s: string, order: DateOrder): number | null {
  let y: number, m: number, d: number;
  const a = RE.dateYmd.exec(s);
  if (a) [y, m, d] = [+a[1], +a[2], +a[3]];
  else {
    const b = RE.dateOther.exec(s);
    if (!b || order === 'ymd') return null;
    [d, m, y] = order === 'dmy' ? [+b[1], +b[2], +b[3]] : [+b[2], +b[1], +b[3]];
  }
  return validDate(y, m, d) ? Date.UTC(y, m - 1, d) : null;
}

/**
 * Numeric value used for sorting, range filters and SQL: numbers as numbers, dates as epoch ms,
 * booleans as 1/0. Returns null for empty or non-matching values.
 */
export function toNumber(v: string, t: ColumnType): number | null {
  const s = v.trim();
  if (!s) return null;
  switch (t.type) {
    case 'integer':
    case 'decimal':
    case 'percent':
    case 'currency': {
      let n = s.replace(/[$€£¥₹%\s]|USD|EUR|GBP|INR|QAR|AED/gi, '');
      n = t.decimalComma ? n.replace(/\./g, '').replace(',', '.') : n.replace(/,/g, '');
      const x = Number(n);
      return Number.isFinite(x) ? x : null;
    }
    case 'boolean':
      return RE.boolean.test(s) ? (/^(?:true|yes|y|t)$/i.test(s) ? 1 : 0) : null;
    case 'date':
      return parseDate(s, t.dateOrder ?? 'ymd');
    case 'datetime': {
      const x = Date.parse(s.replace(' ', 'T'));
      return Number.isNaN(x) ? null : x;
    }
    default:
      return null;
  }
}

export function isNumericType(t: ColType): boolean {
  return t === 'integer' || t === 'decimal' || t === 'percent' || t === 'currency' || t === 'boolean' || t === 'date' || t === 'datetime';
}

/** Value as stored in SQLite: typed numbers, ISO dates (so SQLite date functions work), text otherwise. */
export function toSqlValue(v: string, t: ColumnType): string | number | null {
  if (v.trim() === '') return null;
  if (t.type === 'date') {
    const ms = toNumber(v, t);
    return ms === null ? v : new Date(ms).toISOString().slice(0, 10);
  }
  if (t.type === 'datetime' || t.type === 'string' || t.type === 'uuid' || t.type === 'email' || t.type === 'url' || t.type === 'json') return v;
  const n = toNumber(v, t);
  return n === null ? v : n;
}

export function sqlType(t: ColType): string {
  switch (t) {
    case 'integer':
    case 'boolean':
      return 'INTEGER';
    case 'decimal':
    case 'percent':
    case 'currency':
      return 'REAL';
    default:
      return 'TEXT';
  }
}
