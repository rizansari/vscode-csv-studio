import * as yaml from 'js-yaml';
import { writeCsv, type WriteOptions } from './csv/serialize';

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'ndjson' | 'yaml' | 'markdown' | 'html' | 'sql';

export const EXPORT_FORMATS: { id: ExportFormat; label: string; ext: string; language: string }[] = [
  { id: 'csv', label: 'CSV', ext: 'csv', language: 'csv' },
  { id: 'tsv', label: 'TSV', ext: 'tsv', language: 'tsv' },
  { id: 'json', label: 'JSON (array of objects)', ext: 'json', language: 'json' },
  { id: 'ndjson', label: 'NDJSON / JSON Lines', ext: 'jsonl', language: 'jsonl' },
  { id: 'yaml', label: 'YAML', ext: 'yaml', language: 'yaml' },
  { id: 'markdown', label: 'Markdown table', ext: 'md', language: 'markdown' },
  { id: 'html', label: 'HTML table', ext: 'html', language: 'html' },
  { id: 'sql', label: 'SQL INSERT statements', ext: 'sql', language: 'sql' },
];

export interface ExportOptions extends WriteOptions {
  tableName: string;
  /** Unflatten "a.b" columns into nested objects for JSON/YAML. */
  nest: boolean;
}

type Cell = string | number | null | Uint8Array | boolean | undefined;

function text(v: Cell): string {
  if (v === null || v === undefined) return '';
  // SQL blobs: hex keeps this module free of Node APIs (it is also type-checked for the webview).
  if (v instanceof Uint8Array) return Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('');
  return String(v);
}

function objects(columns: string[], rows: Cell[][], nest: boolean): Record<string, unknown>[] {
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      const v = r[i] instanceof Uint8Array ? text(r[i]) : (r[i] ?? null);
      if (!nest || !c.includes('.')) {
        o[c] = v;
        return;
      }
      const parts = c.split('.');
      let cur = o;
      parts.forEach((p, j) => {
        if (j === parts.length - 1) cur[p] = v;
        else cur = (cur[p] && typeof cur[p] === 'object' ? cur[p] : (cur[p] = {})) as Record<string, unknown>;
      });
    });
    return o;
  });
}

const mdEscape = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
const htmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sqlIdent = (s: string) => '"' + s.replace(/"/g, '""') + '"';
const sqlLiteral = (v: Cell) => (v === null || v === undefined || v === '' ? 'NULL' : typeof v === 'number' ? String(v) : `'${text(v).replace(/'/g, "''")}'`);

export function exportRows(columns: string[], rows: Cell[][], format: ExportFormat, o: ExportOptions): string {
  switch (format) {
    case 'csv':
      return writeCsv(columns, rows.map((r) => r.map(text)), o);
    case 'tsv':
      return writeCsv(columns, rows.map((r) => r.map(text)), { ...o, delimiter: '\t' });
    case 'json':
      return JSON.stringify(objects(columns, rows, o.nest), null, 2) + '\n';
    case 'ndjson':
      return objects(columns, rows, o.nest).map((x) => JSON.stringify(x)).join('\n') + '\n';
    case 'yaml':
      return yaml.dump(objects(columns, rows, o.nest), { lineWidth: -1, noRefs: true });
    case 'markdown': {
      const head = `| ${columns.map(mdEscape).join(' | ')} |`;
      const sep = `| ${columns.map(() => '---').join(' | ')} |`;
      return [head, sep, ...rows.map((r) => `| ${columns.map((_, i) => mdEscape(text(r[i]))).join(' | ')} |`)].join('\n') + '\n';
    }
    case 'html':
      return (
        '<table>\n  <thead><tr>' +
        columns.map((c) => `<th>${htmlEscape(c)}</th>`).join('') +
        '</tr></thead>\n  <tbody>\n' +
        rows.map((r) => '    <tr>' + columns.map((_, i) => `<td>${htmlEscape(text(r[i]))}</td>`).join('') + '</tr>').join('\n') +
        '\n  </tbody>\n</table>\n'
      );
    case 'sql': {
      const cols = columns.map(sqlIdent).join(', ');
      return rows.map((r) => `INSERT INTO ${sqlIdent(o.tableName)} (${cols}) VALUES (${columns.map((_, i) => sqlLiteral(r[i])).join(', ')});`).join('\n') + '\n';
    }
  }
}

/** JSON (array of objects, or an object holding one) → columns + rows, flattening nested objects to a.b. */
export function fromJson(value: unknown): { columns: string[]; rows: string[][] } {
  let items: unknown[] = Array.isArray(value) ? value : [value];
  if (!Array.isArray(value) && value && typeof value === 'object') {
    const arr = Object.values(value).find((v) => Array.isArray(v) && v.some((x) => x && typeof x === 'object'));
    if (arr) items = arr as unknown[];
  }
  const flat = items.map((it) => {
    const out: Record<string, unknown> = {};
    const walk = (v: unknown, prefix: string) => {
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) for (const [k, c] of Object.entries(v)) walk(c, prefix ? `${prefix}.${k}` : k);
      else out[prefix || 'value'] = v;
    };
    walk(it, '');
    return out;
  });
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const r of flat) for (const k of Object.keys(r)) if (!seen.has(k)) seen.add(k), columns.push(k);
  const rows = flat.map((r) => columns.map((c) => (r[c] === undefined || r[c] === null ? '' : typeof r[c] === 'object' ? JSON.stringify(r[c]) : String(r[c]))));
  return { columns, rows };
}
