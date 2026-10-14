import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from 'sql.js';
import { sqlType, toSqlValue, type ColumnType } from '../types';

export interface SqlTable {
  name: string;
  columns: string[];
  types: ColumnType[];
  rows: string[][];
}

export interface SqlResult {
  columns: string[];
  rows: SqlValue[][];
  /** Total rows the query produced (rows may be truncated to the preview limit). */
  rowCount: number;
  truncated: boolean;
  ms: number;
  /** Rows changed by INSERT/UPDATE/DELETE (in-memory only). */
  changes?: number;
}

export type ScalarFunction = (...args: SqlValue[]) => SqlValue;

let sqlPromise: Promise<SqlJsStatic> | undefined;

export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/** A SQL-friendly table name derived from a file name ("Sales 2024.csv" → sales_2024). */
export function tableNameFor(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
  const name = base.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'table';
  return /^\d/.test(name) ? `t_${name}` : name;
}

const regexCache = new Map<string, RegExp>();
function re(pattern: string, flags = ''): RegExp {
  const key = flags + '/' + pattern;
  let r = regexCache.get(key);
  if (!r) {
    if (regexCache.size > 500) regexCache.clear();
    r = new RegExp(pattern, flags);
    regexCache.set(key, r);
  }
  return r;
}

const BUILTINS: Record<string, [ScalarFunction, number[]]> = {
  // SQLite's `x REGEXP y` calls regexp(y, x).
  regexp: [(pattern, value) => (value === null || pattern === null ? null : re(String(pattern)).test(String(value)) ? 1 : 0), [2]],
  regexp_replace: [(value, pattern, replacement) => (value === null ? null : String(value).replace(re(String(pattern), 'g'), String(replacement ?? ''))), [3]],
  regexp_extract: [
    (value, pattern, group) => {
      if (value === null) return null;
      const m = re(String(pattern)).exec(String(value));
      return m ? (m[Number(group ?? 0)] ?? null) : null;
    },
    [2, 3],
  ],
};

/** In-memory SQLite (sql.js) holding the CSV as typed tables. */
export class SqlEngine {
  private constructor(private readonly db: Database) {
    for (const [name, [fn, arities]] of Object.entries(BUILTINS)) this.register(name, fn, arities);
  }

  /** `wasmDir` is the folder containing sql-wasm.wasm (dist/ in the packaged extension). */
  static async create(wasmDir?: string): Promise<SqlEngine> {
    sqlPromise ??= initSqlJs(wasmDir ? { locateFile: (f: string) => `${wasmDir}/${f}` } : undefined);
    return new SqlEngine(new (await sqlPromise).Database());
  }

  /**
   * Registers a SQL function for each argument count in `arities` (sql.js takes the count from
   * the JS function's length, so optional arguments need one overload per count).
   */
  register(name: string, fn: ScalarFunction, arities: number[] = [fn.length]) {
    for (const n of arities) {
      const wrapper = (...args: SqlValue[]) => {
        try {
          const out = fn(...args);
          if (out instanceof Promise) throw new Error(`${name}() is async and cannot be used in SQL`);
          return out;
        } catch (e) {
          // Surface the message as the cell value rather than aborting the whole query.
          return `#ERROR: ${e instanceof Error ? e.message : String(e)}`;
        }
      };
      Object.defineProperty(wrapper, 'length', { value: n });
      this.db.create_function(name, wrapper);
    }
  }

  load(table: SqlTable, aliases: string[] = []) {
    const { db } = this;
    const name = quoteIdent(table.name);
    db.run(`DROP VIEW IF EXISTS ${name}`);
    db.run(`DROP TABLE IF EXISTS ${name}`);
    const cols = table.columns.map((c, i) => `${quoteIdent(c)} ${sqlType(table.types[i]?.type ?? 'string')}`);
    db.run(`CREATE TABLE ${name} (${cols.join(', ')})`);
    if (table.rows.length) {
      const stmt = db.prepare(`INSERT INTO ${name} VALUES (${table.columns.map(() => '?').join(', ')})`);
      db.run('BEGIN');
      try {
        for (const row of table.rows) stmt.run(table.columns.map((_, i) => toSqlValue(row[i] ?? '', table.types[i] ?? { type: 'string', confidence: 1 })));
        db.run('COMMIT');
      } catch (e) {
        db.run('ROLLBACK');
        throw e;
      } finally {
        stmt.free();
      }
    }
    for (const alias of aliases) {
      if (alias === table.name) continue;
      db.run(`DROP VIEW IF EXISTS ${quoteIdent(alias)}`);
      db.run(`DROP TABLE IF EXISTS ${quoteIdent(alias)}`);
      db.run(`CREATE VIEW ${quoteIdent(alias)} AS SELECT * FROM ${name}`);
    }
  }

  tables(): string[] {
    const r = this.db.exec(`SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`);
    return r[0]?.values.map((v) => String(v[0])) ?? [];
  }

  /** Runs every statement; returns the rows of the last one that produced columns. */
  run(sql: string, limit = Infinity): SqlResult {
    const start = Date.now();
    let result: SqlResult | null = null;
    let changes = 0;
    for (const stmt of this.db.iterateStatements(sql)) {
      try {
        const columns = stmt.getColumnNames();
        if (!columns.length) {
          stmt.step();
          changes += this.db.getRowsModified();
          continue;
        }
        const rows: SqlValue[][] = [];
        let count = 0;
        while (stmt.step()) {
          if (count < limit) rows.push(stmt.get());
          count++;
        }
        result = { columns, rows, rowCount: count, truncated: count > rows.length, ms: 0 };
      } finally {
        stmt.free();
      }
    }
    const ms = Date.now() - start;
    return result ? { ...result, ms, changes: changes || undefined } : { columns: [], rows: [], rowCount: 0, truncated: false, ms, changes };
  }

  close() {
    this.db.close();
  }
}

/** True when a statement can modify data (so the tables must be reloaded before the next run). */
export function isMutating(sql: string): boolean {
  return /\b(insert|update|delete|drop|alter|create|replace)\b/i.test(sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|--.*$/gm, ''));
}
