import { lint } from '../core/csv/lint';
import type { Dialect } from '../core/csv/dialect';
import { profileColumn, distinctValues } from '../core/profile';
import { quoteIdent, SqlEngine, isMutating, tableNameFor, type SqlResult } from '../core/sql/engine';
import { loadTable, type Table } from '../core/table';
import { findPreset, PRESETS, defaults } from '../core/transforms/presets';
import type { UserTransform } from '../core/transforms/sandbox';
import type { TransformContext } from '../core/transforms/types';
import { inferType, type ColType, type ColumnType } from '../core/types';
import { computeView, FILTER_LABELS, NumericCache, type ViewSpec } from '../core/view';
import type { ColumnMeta, Meta, RowData } from '../shared/messages';

export interface VirtualColumn {
  name: string;
  values: string[];
}

export interface ExtraTable {
  name: string;
  fileName: string;
  table: Table;
  types: ColumnType[];
}

/** Everything known about one open CSV: parsed rows, types, the current view and the SQL engine. */
export class Session {
  table!: Table;
  inferred: ColumnType[] = [];
  types: ColumnType[] = [];
  view: Uint32Array = new Uint32Array();
  viewSpec: ViewSpec = { filters: [], sorts: [] };
  viewVersion = 0;
  virtual: VirtualColumn[] = [];
  readonly extraTables = new Map<string, ExtraTable>();
  private nums!: NumericCache;
  private sql: SqlEngine | null = null;
  private sqlKey = '';
  private text = '';
  private dialectOverride: Partial<Dialect> = {};
  private issueSummary: Meta['issues'] = { errors: 0, warnings: 0 };

  constructor(
    readonly fileName: string,
    private overrides: (ColType | null)[],
    private readonly sampleSize: number,
    private readonly wasmDir: string,
  ) {}

  /** Re-parses after the document changed. Keeps the view spec (dropping filters on vanished columns). */
  load(text: string) {
    this.text = text;
    this.table = loadTable(text, this.fileName, this.dialectOverride);
    const issues = lint(text, this.table);
    this.issueSummary = {
      errors: issues.filter((i) => i.severity === 'error').length,
      warnings: issues.filter((i) => i.severity === 'warning').length,
      first: issues.find((i) => i.severity !== 'info')?.message,
    };
    const n = this.table.columns.length;
    this.inferred = this.table.columns.map((_, i) => inferType(this.sample(i)));
    this.overrides = Array.from({ length: n }, (_, i) => this.overrides[i] ?? null);
    this.types = this.inferred.map((t, i) => this.effectiveType(t, i));
    this.virtual = this.virtual.filter((v) => v.values.length === this.table.rows.length);
    this.viewSpec = {
      ...this.viewSpec,
      filters: this.viewSpec.filters.filter((f) => f.col < this.width),
      sorts: this.viewSpec.sorts.filter((s) => s.col < this.width),
    };
    this.refreshView();
    this.sqlKey = '';
  }

  setDialect(d: Partial<Dialect>) {
    this.dialectOverride = { ...this.dialectOverride, ...d };
    this.load(this.text);
  }

  getText() {
    return this.text;
  }

  /** Columns in the file plus virtual columns. */
  get width() {
    return this.table.columns.length + this.virtual.length;
  }

  get columnNames(): string[] {
    return [...this.table.columns, ...this.virtual.map((v) => v.name)];
  }

  /** Rows including virtual column values (built on demand; used for filtering, SQL and transforms). */
  allRows(): string[][] {
    if (!this.virtual.length) return this.table.rows;
    return this.table.rows.map((r, i) => [...padTo(r, this.table.columns.length), ...this.virtual.map((v) => v.values[i] ?? '')]);
  }

  private allTypes(): ColumnType[] {
    return [...this.types, ...this.virtual.map((v) => inferType(sampleOf(v.values, this.sampleSize)))];
  }

  private sample(col: number): string[] {
    const rows = this.table.rows;
    const out: string[] = [];
    const step = Math.max(1, Math.floor(rows.length / this.sampleSize));
    for (let i = 0; i < rows.length; i += step) out.push(rows[i][col] ?? '');
    return out;
  }

  private effectiveType(t: ColumnType, col: number): ColumnType {
    const o = this.overrides[col];
    return o && o !== t.type ? { ...t, type: o } : t;
  }

  setType(col: number, type: ColType | null) {
    this.overrides[col] = type;
    this.types[col] = this.effectiveType(this.inferred[col], col);
    this.refreshView();
    this.sqlKey = '';
  }

  get typeOverrides() {
    return this.overrides;
  }

  setView(spec: ViewSpec) {
    this.viewSpec = spec;
    this.refreshView();
  }

  private refreshView() {
    const rows = this.allRows();
    const types = this.allTypes();
    this.nums = new NumericCache(rows, types);
    this.view = computeView(rows, types, this.viewSpec, this.nums);
    this.viewVersion++;
  }

  rows(start: number, count: number): RowData[] {
    const out: RowData[] = [];
    const end = Math.min(this.view.length, start + count);
    const w = this.table.columns.length;
    for (let i = start; i < end; i++) {
      const r = this.view[i];
      const cells = padTo(this.table.rows[r], w);
      out.push({ row: r, cells: this.virtual.length ? [...cells, ...this.virtual.map((v) => v.values[r] ?? '')] : cells });
    }
    return out;
  }

  /** Position of a file row inside the current view, or -1 when it is filtered out. */
  viewIndexOf(row: number): number {
    return this.view.indexOf(row);
  }

  columnValues(col: number, onlyView = true): string[] {
    const get = col < this.table.columns.length ? (r: number) => this.table.rows[r][col] ?? '' : (r: number) => this.virtual[col - this.table.columns.length].values[r] ?? '';
    return onlyView ? Array.from(this.view, get) : this.table.rows.map((_, r) => get(r));
  }

  distinct(col: number) {
    return distinctValues(this.columnValues(col, false), 2000);
  }

  profile(col: number) {
    return profileColumn(this.columnValues(col), this.allTypes()[col]);
  }

  addVirtual(name: string, values: string[]) {
    this.virtual = [...this.virtual.filter((v) => v.name !== name), { name, values }];
    this.refreshView();
    this.sqlKey = '';
  }

  removeVirtual(name: string) {
    this.virtual = this.virtual.filter((v) => v.name !== name);
    this.viewSpec = { ...this.viewSpec, filters: this.viewSpec.filters.filter((f) => f.col < this.width), sorts: this.viewSpec.sorts.filter((s) => s.col < this.width) };
    this.refreshView();
    this.sqlKey = '';
  }

  meta(readOnly: boolean, readOnlyReason: string | undefined, trusted: boolean): Meta {
    const columns: ColumnMeta[] = this.table.columns.map((name, i) => ({
      name,
      type: this.types[i].type,
      inferred: this.inferred[i].type,
      confidence: this.inferred[i].confidence,
      overridden: !!this.overrides[i],
      dateOrder: this.types[i].dateOrder,
    }));
    const vTypes = this.allTypes().slice(this.table.columns.length);
    this.virtual.forEach((v, i) => columns.push({ name: v.name, type: vTypes[i].type, inferred: vTypes[i].type, confidence: vTypes[i].confidence, overridden: false, virtual: true }));
    return {
      fileName: this.fileName,
      readOnly,
      readOnlyReason,
      dialect: this.table.dialect,
      hasHeader: !!this.table.rawHeader,
      columns,
      rowCount: this.table.rows.length,
      viewCount: this.view.length,
      viewVersion: this.viewVersion,
      issues: this.issueSummary,
      tables: ['data', this.mainAlias(), ...this.extraTables.keys()].filter((t, i, a) => a.indexOf(t) === i),
      trusted,
    };
  }

  mainAlias() {
    return tableNameFor(this.fileName);
  }

  /**
   * (Re)loads tables into SQLite when needed. Data, type and virtual-column changes reset `sqlKey`;
   * filtering and sorting do not, since SQL always sees the whole file.
   */
  private async ensureSql(secrets: Record<string, string>, user: Map<string, UserTransform>): Promise<SqlEngine> {
    const key = `loaded|${[...this.extraTables.keys()].join(',')}`;
    if (!this.sql) this.sql = await SqlEngine.create(this.wasmDir);
    registerTransformFunctions(this.sql, secrets, user);
    if (this.sqlKey !== key) {
      const rows = this.allRows();
      this.sql.load({ name: 'data', columns: this.columnNames, types: this.allTypes(), rows }, [this.mainAlias()]);
      for (const t of this.extraTables.values()) this.sql.load({ name: t.name, columns: t.table.columns, types: t.types, rows: t.table.rows });
      this.sqlKey = key;
    }
    return this.sql;
  }

  async runSql(query: string, limit: number, secrets: Record<string, string>, user: Map<string, UserTransform>): Promise<SqlResult> {
    const db = await this.ensureSql(secrets, user);
    try {
      return db.run(query, limit);
    } finally {
      // Statements that change data only affect the in-memory copy; reload before the next query.
      if (isMutating(query)) this.sqlKey = '';
    }
  }

  addTable(fileName: string, text: string) {
    const table = loadTable(text, fileName);
    let name = tableNameFor(fileName);
    if (name === 'data' || name === this.mainAlias()) name = `${name}_2`;
    const types = table.columns.map((_, i) => inferType(table.rows.slice(0, this.sampleSize).map((r) => r[i] ?? '')));
    this.extraTables.set(name, { name, fileName, table, types });
    return name;
  }

  /** SQL equivalent of the current view (filters, sort), for users to edit further. */
  buildQuery(): string {
    const cols = this.columnNames;
    const types = this.allTypes();
    const where = this.viewSpec.filters.map((f) => {
      const c = quoteIdent(cols[f.col]);
      const lit = (v = '') => (types[f.col] && ['integer', 'decimal', 'percent', 'currency'].includes(types[f.col].type) && v.trim() !== '' && !Number.isNaN(Number(v)) ? v : `'${v.replace(/'/g, "''")}'`);
      switch (f.op) {
        case 'contains': return `${c} LIKE '%${(f.value ?? '').replace(/'/g, "''")}%'`;
        case 'notContains': return `${c} NOT LIKE '%${(f.value ?? '').replace(/'/g, "''")}%'`;
        case 'startsWith': return `${c} LIKE '${(f.value ?? '').replace(/'/g, "''")}%'`;
        case 'endsWith': return `${c} LIKE '%${(f.value ?? '').replace(/'/g, "''")}'`;
        case 'equals': return `${c} = ${lit(f.value)}`;
        case 'notEquals': return `${c} <> ${lit(f.value)}`;
        case 'regex': return `${c} REGEXP ${lit(f.value)}`;
        case 'empty': return `(${c} IS NULL OR ${c} = '')`;
        case 'notEmpty': return `(${c} IS NOT NULL AND ${c} <> '')`;
        case 'gt': return `${c} > ${lit(f.value)}`;
        case 'gte': return `${c} >= ${lit(f.value)}`;
        case 'lt': return `${c} < ${lit(f.value)}`;
        case 'lte': return `${c} <= ${lit(f.value)}`;
        case 'between': return `${c} BETWEEN ${lit(f.value)} AND ${lit(f.value2)}`;
        case 'in': return `${c} IN (${(f.values ?? []).map((v) => lit(v)).join(', ')})`;
        case 'notIn': return `${c} NOT IN (${(f.values ?? []).map((v) => lit(v)).join(', ')})`;
        case 'invalid': return `/* ${cols[f.col]} ${FILTER_LABELS.invalid}: no SQL equivalent */ 1`;
      }
    });
    if (this.viewSpec.search?.text) {
      const s = this.viewSpec.search.text.replace(/'/g, "''");
      where.push(`(${cols.map((c) => `${quoteIdent(c)} LIKE '%${s}%'`).join(' OR ')})`);
    }
    const order = this.viewSpec.sorts.map((s) => `${quoteIdent(cols[s.col])} ${s.dir === 1 ? 'ASC' : 'DESC'}`);
    return ['SELECT *', 'FROM data', where.length ? 'WHERE ' + where.join('\n  AND ') : '', order.length ? 'ORDER BY ' + order.join(', ') : ''].filter(Boolean).join('\n');
  }

  dispose() {
    this.sql?.close();
    this.sql = null;
  }
}

function padTo(r: string[], w: number): string[] {
  return r.length >= w ? r : [...r, ...Array<string>(w - r.length).fill('')];
}

function sampleOf(values: string[], n: number): string[] {
  const step = Math.max(1, Math.floor(values.length / n));
  const out: string[] = [];
  for (let i = 0; i < values.length; i += step) out.push(values[i]);
  return out;
}

/** Parameter order for SQL calls: required secrets first (decrypt(value, 'key')), column params skipped. */
function sqlParams(p: (typeof PRESETS)[number]) {
  const usable = p.params.filter((x) => x.type !== 'column');
  const required = usable.filter((x) => x.type === 'secret' && !x.optional);
  return [...required, ...usable.filter((x) => !required.includes(x))];
}

/**
 * Exposes transforms as SQL functions: presets as `name(value, param1, param2, …)` (see sqlParams
 * for the order), user transforms as `js_<file>(value)`.
 */
export function registerTransformFunctions(db: SqlEngine, secrets: Record<string, string>, user: Map<string, UserTransform>) {
  const secret = (name: string) => {
    const s = secrets[name];
    if (s === undefined) throw new Error(`Secret "${name}" is not set`);
    return s;
  };
  for (const p of PRESETS) {
    if (!p.sql) continue;
    const params = sqlParams(p);
    const base = defaults(p.params);
    const fn = (value: unknown, ...args: unknown[]) => {
      if (value === null || value === undefined) return null;
      const ps: Record<string, string> = { ...base };
      args.forEach((a, i) => {
        if (a !== null && a !== undefined && params[i]) ps[params[i].name] = String(a);
      });
      const ctx: TransformContext = { row: {}, rowIndex: 0, secret, state: {} };
      return findPreset(p.id).run(String(value), ps, ctx);
    };
    db.register(p.sql, fn as never, Array.from({ length: params.length + 1 }, (_, i) => i + 1));
  }
  for (const t of user.values()) {
    const name = 'js_' + t.id.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    db.register(
      name,
      ((value: unknown) => {
        const out = t.fn(value === null ? '' : String(value), {}, { row: {}, rowIndex: 0, secret, state: {} });
        return out === null || out === undefined ? null : typeof out === 'object' && !(out instanceof Promise) ? JSON.stringify(out) : (out as never);
      }) as never,
      [1],
    );
  }
}

/** Human-readable signatures of the SQL functions, for the SQL panel's help. */
export function sqlFunctionHelp(user: Map<string, UserTransform>): { name: string; signature: string; description: string }[] {
  const out = [
    { name: 'regexp', signature: "col REGEXP 'pattern'", description: 'Regular-expression match' },
    { name: 'regexp_replace', signature: "regexp_replace(value, 'pattern', 'replacement')", description: 'Replace every match' },
    { name: 'regexp_extract', signature: "regexp_extract(value, 'pattern' [, group])", description: 'First match or group' },
  ];
  for (const p of PRESETS) {
    if (!p.sql) continue;
    const params = sqlParams(p).map((x) => (x.type === 'secret' ? `'secret name'` : x.options ? `${x.name}: ${x.options.slice(0, 3).join('|')}${x.options.length > 3 ? '|…' : ''}` : x.name));
    out.push({ name: p.sql, signature: `${p.sql}(value${params.length ? ', ' + params.join(', ') : ''})`, description: p.description });
  }
  for (const t of user.values()) {
    const name = 'js_' + t.id.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    out.push({ name, signature: `${name}(value)`, description: `Your transform: ${t.label}` });
  }
  return out;
}
