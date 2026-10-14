export interface CsvSide {
  columns: string[];
  rows: string[][];
}

export interface RowChange {
  key: string;
  cells: { column: string; before: string; after: string }[];
}

export interface CsvDiff {
  keyColumns: string[];
  added: string[][];
  removed: string[][];
  changed: RowChange[];
  /** Columns only present on one side. */
  addedColumns: string[];
  removedColumns: string[];
  duplicateKeys: string[];
}

function keyOf(row: string[], idx: number[]): string {
  return JSON.stringify(idx.map((i) => row[i] ?? ''));
}

/** Compares two tables by key columns; column order does not matter. */
export function diffByKey(a: CsvSide, b: CsvSide, keyColumns: string[]): CsvDiff {
  const ka = keyColumns.map((k) => a.columns.indexOf(k));
  const kb = keyColumns.map((k) => b.columns.indexOf(k));
  if (ka.includes(-1) || kb.includes(-1)) throw new Error(`Key column(s) must exist in both files: ${keyColumns.join(', ')}`);
  const shared = a.columns.filter((c) => b.columns.includes(c));
  const duplicateKeys = new Set<string>();
  const index = (side: CsvSide, idx: number[]) => {
    const m = new Map<string, string[]>();
    for (const r of side.rows) {
      const k = keyOf(r, idx);
      if (m.has(k)) duplicateKeys.add(k);
      else m.set(k, r);
    }
    return m;
  };
  const ma = index(a, ka);
  const mb = index(b, kb);
  const added: string[][] = [];
  const removed: string[][] = [];
  const changed: RowChange[] = [];
  for (const [k, ra] of ma) {
    const rb = mb.get(k);
    if (!rb) {
      removed.push(ra);
      continue;
    }
    const cells = shared
      .map((c) => ({ column: c, before: ra[a.columns.indexOf(c)] ?? '', after: rb[b.columns.indexOf(c)] ?? '' }))
      .filter((x) => x.before !== x.after);
    if (cells.length) changed.push({ key: k, cells });
  }
  for (const [k, rb] of mb) if (!ma.has(k)) added.push(rb);
  return {
    keyColumns,
    added,
    removed,
    changed,
    addedColumns: b.columns.filter((c) => !a.columns.includes(c)),
    removedColumns: a.columns.filter((c) => !b.columns.includes(c)),
    duplicateKeys: [...duplicateKeys],
  };
}

/** One row per difference: status, key columns, column, before, after. */
export function diffAsRows(d: CsvDiff, a: CsvSide, b: CsvSide): { columns: string[]; rows: string[][] } {
  const columns = ['status', ...d.keyColumns, 'column', 'before', 'after'];
  const keyVals = (side: CsvSide, r: string[]) => d.keyColumns.map((k) => r[side.columns.indexOf(k)] ?? '');
  const rows: string[][] = [
    ...d.removed.map((r) => ['removed', ...keyVals(a, r), '', JSON.stringify(Object.fromEntries(a.columns.map((c, i) => [c, r[i] ?? '']))), '']),
    ...d.added.map((r) => ['added', ...keyVals(b, r), '', '', JSON.stringify(Object.fromEntries(b.columns.map((c, i) => [c, r[i] ?? ''])))]),
    ...d.changed.flatMap((c) => c.cells.map((x) => ['changed', ...(JSON.parse(c.key) as string[]), x.column, x.before, x.after])),
  ];
  return { columns, rows };
}

/** Groups rows by a column's value (file name safe), or into chunks of `size` rows. */
export function splitRows(rows: string[][], by: { column: number } | { size: number }): Map<string, string[][]> {
  const out = new Map<string, string[][]>();
  if ('size' in by) {
    for (let i = 0; i < rows.length; i += by.size) out.set(String(i / by.size + 1).padStart(3, '0'), rows.slice(i, i + by.size));
    return out;
  }
  for (const r of rows) {
    const key = (r[by.column] ?? '').trim().replace(/[^\w.-]+/g, '_') || 'empty';
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push(r);
  }
  return out;
}

/** Appends tables, matching columns by name (case-insensitive); missing values become empty. */
export function mergeTables(tables: CsvSide[], addSourceColumn?: string[]): CsvSide {
  const columns: string[] = [];
  const lower = new Map<string, number>();
  for (const t of tables)
    for (const c of t.columns)
      if (!lower.has(c.toLowerCase())) {
        lower.set(c.toLowerCase(), columns.length);
        columns.push(c);
      }
  const rows: string[][] = [];
  tables.forEach((t, ti) => {
    const map = t.columns.map((c) => lower.get(c.toLowerCase())!);
    for (const r of t.rows) {
      const out = Array<string>(columns.length).fill('');
      r.forEach((v, i) => {
        if (map[i] !== undefined) out[map[i]] = v;
      });
      if (addSourceColumn) out.push(addSourceColumn[ti]);
      rows.push(out);
    }
  });
  return { columns: addSourceColumn ? [...columns, 'source_file'] : columns, rows };
}
