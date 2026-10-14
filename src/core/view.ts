import { isNumericType, matches, toNumber, type ColumnType } from './types';

export type FilterOp =
  | 'contains'
  | 'notContains'
  | 'equals'
  | 'notEquals'
  | 'startsWith'
  | 'endsWith'
  | 'regex'
  | 'empty'
  | 'notEmpty'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'in'
  | 'notIn'
  | 'invalid';

export interface Filter {
  col: number;
  op: FilterOp;
  value?: string;
  value2?: string;
  values?: string[];
  caseSensitive?: boolean;
}

export interface Sort {
  col: number;
  dir: 1 | -1;
}

export interface Search {
  text: string;
  regex?: boolean;
  caseSensitive?: boolean;
}

export interface ViewSpec {
  filters: Filter[];
  sorts: Sort[];
  search?: Search | null;
}

export const FILTER_LABELS: Record<FilterOp, string> = {
  contains: 'contains',
  notContains: 'does not contain',
  equals: '=',
  notEquals: '≠',
  startsWith: 'starts with',
  endsWith: 'ends with',
  regex: 'matches regex',
  empty: 'is empty',
  notEmpty: 'is not empty',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  between: 'between',
  in: 'is one of',
  notIn: 'is not one of',
  invalid: 'does not match its type',
};

/** Lazily computed numeric version of each column (dates → epoch ms), invalidated per parse. */
export class NumericCache {
  private readonly cache = new Map<number, Float64Array>();
  constructor(
    private readonly rows: string[][],
    private readonly types: ColumnType[],
  ) {}

  get(col: number): Float64Array {
    let a = this.cache.get(col);
    if (!a) {
      a = new Float64Array(this.rows.length);
      const t = this.types[col];
      for (let i = 0; i < this.rows.length; i++) a[i] = toNumber(this.rows[i][col] ?? '', t) ?? NaN;
      this.cache.set(col, a);
    }
    return a;
  }
}

type RowTest = (row: number) => boolean;

function compileFilter(f: Filter, rows: string[][], types: ColumnType[], nums: NumericCache): RowTest {
  const t = types[f.col] ?? { type: 'string', confidence: 1 };
  const text = (r: number) => rows[r][f.col] ?? '';
  const fold = (s: string) => (f.caseSensitive ? s : s.toLowerCase());
  const needle = fold(f.value ?? '');

  if (['gt', 'gte', 'lt', 'lte', 'between'].includes(f.op) && isNumericType(t.type)) {
    const a = toNumber(f.value ?? '', t) ?? Number(f.value);
    const b = toNumber(f.value2 ?? '', t) ?? Number(f.value2);
    const col = nums.get(f.col);
    switch (f.op) {
      case 'gt': return (r) => col[r] > a;
      case 'gte': return (r) => col[r] >= a;
      case 'lt': return (r) => col[r] < a;
      case 'lte': return (r) => col[r] <= a;
      default: return (r) => col[r] >= a && col[r] <= b;
    }
  }
  const cmp = (r: number) => text(r).localeCompare(f.value ?? '', undefined, { numeric: true });
  switch (f.op) {
    case 'contains': return (r) => fold(text(r)).includes(needle);
    case 'notContains': return (r) => !fold(text(r)).includes(needle);
    case 'equals': return (r) => fold(text(r)) === needle;
    case 'notEquals': return (r) => fold(text(r)) !== needle;
    case 'startsWith': return (r) => fold(text(r)).startsWith(needle);
    case 'endsWith': return (r) => fold(text(r)).endsWith(needle);
    case 'regex': {
      const re = new RegExp(f.value ?? '', f.caseSensitive ? '' : 'i');
      return (r) => re.test(text(r));
    }
    case 'empty': return (r) => text(r).trim() === '';
    case 'notEmpty': return (r) => text(r).trim() !== '';
    case 'gt': return (r) => cmp(r) > 0;
    case 'gte': return (r) => cmp(r) >= 0;
    case 'lt': return (r) => cmp(r) < 0;
    case 'lte': return (r) => cmp(r) <= 0;
    case 'between': return (r) => cmp(r) >= 0 && text(r).localeCompare(f.value2 ?? '', undefined, { numeric: true }) <= 0;
    case 'in': {
      const set = new Set(f.values ?? []);
      return (r) => set.has(text(r));
    }
    case 'notIn': {
      const set = new Set(f.values ?? []);
      return (r) => !set.has(text(r));
    }
    case 'invalid': return (r) => text(r).trim() !== '' && !matches(t.type, text(r), t);
  }
}

/** Row numbers (into `rows`) that pass the filters, in sort order. Never copies row data. */
export function computeView(rows: string[][], types: ColumnType[], spec: ViewSpec, nums = new NumericCache(rows, types)): Uint32Array {
  const tests = spec.filters.map((f) => compileFilter(f, rows, types, nums));
  if (spec.search?.text) {
    const s = spec.search;
    const re = s.regex ? new RegExp(s.text, s.caseSensitive ? '' : 'i') : null;
    const needle = s.caseSensitive ? s.text : s.text.toLowerCase();
    tests.push((r) => rows[r].some((c) => (re ? re.test(c) : (s.caseSensitive ? c : c.toLowerCase()).includes(needle))));
  }
  const out: number[] = [];
  for (let r = 0; r < rows.length; r++) if (tests.every((t) => t(r))) out.push(r);

  if (spec.sorts.length) {
    const keys = spec.sorts.map((s) => {
      const t = types[s.col];
      return { dir: s.dir, col: s.col, nums: t && isNumericType(t.type) ? nums.get(s.col) : null };
    });
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    out.sort((a, b) => {
      for (const k of keys) {
        let c: number;
        if (k.nums) {
          const x = k.nums[a];
          const y = k.nums[b];
          // Empty/invalid values always sort last.
          c = Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : Number.isNaN(y) ? -1 : (x - y) * k.dir;
        } else {
          const x = rows[a][k.col] ?? '';
          const y = rows[b][k.col] ?? '';
          c = !x ? (!y ? 0 : 1) : !y ? -1 : collator.compare(x, y) * k.dir;
        }
        if (c) return c;
      }
      return a - b;
    });
  }
  return Uint32Array.from(out);
}
