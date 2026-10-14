import type { Dialect, Eol } from './dialect';

export interface WriteOptions {
  delimiter: string;
  quote: string;
  eol: Eol;
  /** 'minimal' quotes only when needed; 'all' quotes every field; 'nonNumeric' quotes text fields. */
  quoting: 'minimal' | 'all' | 'nonNumeric';
  header: boolean;
}

export function writeOptions(d: Dialect, overrides: Partial<WriteOptions> = {}): WriteOptions {
  return { delimiter: d.delimiter, quote: d.quote, eol: d.eol, quoting: 'minimal', header: true, ...overrides };
}

const NUMBER = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

export function formatField(value: unknown, o: Pick<WriteOptions, 'delimiter' | 'quote' | 'quoting'>): string {
  const s = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const needs =
    o.quoting === 'all' ||
    (o.quoting === 'nonNumeric' && s !== '' && !NUMBER.test(s)) ||
    s.includes(o.delimiter) ||
    s.includes(o.quote) ||
    s.includes('\n') ||
    s.includes('\r') ||
    s !== s.trim();
  return needs ? o.quote + s.split(o.quote).join(o.quote + o.quote) + o.quote : s;
}

export function formatRecord(values: unknown[], o: Pick<WriteOptions, 'delimiter' | 'quote' | 'quoting'>): string {
  return values.map((v) => formatField(v, o)).join(o.delimiter);
}

export function writeCsv(header: string[] | null, rows: unknown[][], o: WriteOptions): string {
  const lines: string[] = [];
  if (header && o.header) lines.push(formatRecord(header, o));
  for (const r of rows) lines.push(formatRecord(r, o));
  return lines.join(o.eol) + (lines.length ? o.eol : '');
}
