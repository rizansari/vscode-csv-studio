import { detectDialect, detectHeader, type Dialect } from './csv/dialect';
import { parseCsv, type CsvIssue, type ParsedCsv } from './csv/parse';

/** A CSV document as rows of strings plus what is needed to edit its text in place. */
export interface Table {
  dialect: Dialect;
  /** Unique, non-empty column names (used for display and SQL). */
  columns: string[];
  /** The header exactly as written, or null when the file has no header row. */
  rawHeader: string[] | null;
  rows: string[][];
  parsed: ParsedCsv;
  issues: CsvIssue[];
}

export function loadTable(text: string, fileName = '', override: Partial<Dialect> = {}): Table {
  const detected = detectDialect(text, fileName);
  const base = { ...detected, ...override };
  const parsed = parseCsv(text, base);
  const header = override.header ?? (parsed.records.length ? detectHeader(parsed.records) : true);
  const dialect: Dialect = { ...base, header };
  const width = Math.max(0, ...parsed.records.slice(0, 1000).map((r) => r.length));
  const rawHeader = header && parsed.records.length ? parsed.records[0] : null;
  const rows = header ? parsed.records.slice(1) : parsed.records;
  return { dialect, columns: columnNames(rawHeader, width), rawHeader, rows, parsed, issues: parsed.issues };
}

/** Header names made unique and non-empty; generated names when there is no header. */
export function columnNames(raw: string[] | null, width: number): string[] {
  const n = Math.max(width, raw?.length ?? 0);
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let name = (raw?.[i] ?? '').trim() || `column_${i + 1}`;
    const count = seen.get(name.toLowerCase()) ?? 0;
    seen.set(name.toLowerCase(), count + 1);
    if (count) name = `${name}_${count + 1}`;
    out.push(name);
  }
  return out;
}

/** Record index in the parsed file for a data row. */
export function recordIndex(t: Table, row: number): number {
  return t.rawHeader ? row + 1 : row;
}

export function cell(t: Table, row: number, col: number): string {
  return t.rows[row]?.[col] ?? '';
}
