export type Eol = '\n' | '\r\n' | '\r';

export interface Dialect {
  delimiter: string;
  quote: string;
  header: boolean;
  eol: Eol;
  bom: boolean;
}

export const DEFAULT_DIALECT: Dialect = { delimiter: ',', quote: '"', header: true, eol: '\n', bom: false };

const CANDIDATES = [',', ';', '\t', '|'];

export function delimiterName(d: string): string {
  return d === '\t' ? 'Tab' : d === ',' ? 'Comma' : d === ';' ? 'Semicolon' : d === '|' ? 'Pipe' : JSON.stringify(d);
}

export function detectEol(text: string): Eol {
  const n = text.indexOf('\n');
  if (n > 0 && text[n - 1] === '\r') return '\r\n';
  if (n >= 0) return '\n';
  return text.includes('\r') ? '\r' : '\n';
}

/** Splits the first lines respecting quotes, counting delimiter occurrences per record. */
function fieldCounts(text: string, delimiter: string, quote: string, maxRecords = 50): number[] {
  const counts: number[] = [];
  let fields = 1;
  let inQuotes = false;
  for (let i = 0; i < text.length && counts.length < maxRecords; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === quote) {
        if (text[i + 1] === quote) i++;
        else inQuotes = false;
      }
    } else if (c === quote) inQuotes = true;
    else if (c === delimiter) fields++;
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      counts.push(fields);
      fields = 1;
    }
  }
  if (counts.length < maxRecords && text.length) counts.push(fields);
  return counts.filter((_, i, a) => !(i === a.length - 1 && a.length > 1 && _ === 1));
}

function scoreDelimiter(text: string, delimiter: string): number {
  const counts = fieldCounts(text, delimiter, '"');
  if (!counts.length) return 0;
  const freq = new Map<number, number>();
  for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
  const [mode, hits] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
  if (mode < 2) return 0;
  // Consistency dominates; more columns breaks ties.
  return (hits / counts.length) * 1000 + Math.min(mode, 100);
}

const NUMERIC = /^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?([eE][-+]?\d+)?%?$/;

/** A header row has unique, non-empty, mostly non-numeric names that look different from the data. */
function looksLikeHeader(rows: string[][]): boolean {
  if (rows.length < 2) return true;
  const [first, ...rest] = rows;
  // Empty or duplicate names happen in real headers (e.g. an unnamed index column); numbers do not.
  if (first.every((c) => c.trim() === '')) return false;
  if (first.some((c) => NUMERIC.test(c.trim()) && c.trim() !== '')) return false;
  // A column that is numeric below a textual first cell is strong evidence of a header.
  for (let col = 0; col < first.length; col++) {
    const body = rest.map((r) => r[col] ?? '').filter((v) => v.trim() !== '');
    if (body.length && body.every((v) => NUMERIC.test(v.trim()))) return true;
  }
  // Otherwise, assume a header when the first row's values never repeat below it.
  return first.every((h, col) => rest.every((r) => r[col] !== h));
}

export function detectDialect(text: string, fileName = ''): Dialect {
  const bom = text.charCodeAt(0) === 0xfeff;
  const sample = (bom ? text.slice(1) : text).slice(0, 64 * 1024);
  const ext = fileName.toLowerCase().split('.').pop();
  let delimiter = ext === 'tsv' || ext === 'tab' ? '\t' : ext === 'psv' ? '|' : '';
  if (!delimiter) {
    let best = -1;
    for (const d of CANDIDATES) {
      const s = scoreDelimiter(sample, d);
      if (s > best) {
        best = s;
        delimiter = d;
      }
    }
    if (best <= 0) delimiter = ',';
  }
  const dialect: Dialect = { delimiter, quote: '"', header: true, eol: detectEol(sample), bom };
  return dialect;
}

/** Second step of detection, once the sample has been split with the chosen delimiter. */
export function detectHeader(sampleRows: string[][]): boolean {
  return looksLikeHeader(sampleRows.slice(0, 50));
}
