import { findPreset } from './presets';
import type { UserTransform } from './sandbox';
import type { PreviewRow, TransformContext, TransformSpec } from './types';

export interface TransformInput {
  columns: string[];
  rows: string[][];
  /** Data rows to transform, in file order. */
  rowIndexes: ArrayLike<number>;
  secrets: Record<string, string>;
  user: Map<string, UserTransform>;
  timeoutMs?: number;
}

export interface TransformOutput {
  results: PreviewRow[];
  errors: number;
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Runs one transform over the given rows. Errors are collected per row; the cell keeps its value. */
export async function runTransform(spec: TransformSpec, input: TransformInput): Promise<TransformOutput> {
  const state: Record<string, unknown> = {};
  const secret = (name: string) => {
    if (!name) throw new Error('No secret selected');
    const s = input.secrets[name];
    if (s === undefined) throw new Error(`Secret "${name}" is not set (run "CSV Studio: Set Secret…")`);
    return s;
  };
  let apply: (value: string, ctx: TransformContext) => unknown;
  if (spec.kind === 'preset') {
    const preset = findPreset(spec.id);
    apply = (value, ctx) => preset.run(value, spec.params, ctx);
  } else {
    const user = input.user.get(spec.id);
    if (!user) throw new Error(`Transform "${spec.id}" not found`);
    apply = (value, ctx) => user.fn(value, ctx.row, ctx);
  }

  const results: PreviewRow[] = [];
  let errors = 0;
  const timeout = input.timeoutMs ?? 2000;
  for (let k = 0; k < input.rowIndexes.length; k++) {
    const r = input.rowIndexes[k];
    const cells = input.rows[r] ?? [];
    const row = Object.fromEntries(input.columns.map((c, i) => [c, cells[i] ?? '']));
    const before = cells[spec.col] ?? '';
    try {
      let out = apply(before, { row, rowIndex: r, secret, state });
      if (out instanceof Promise) out = await withTimeout(out, timeout);
      results.push({ row: r, before, after: stringify(out) });
    } catch (e) {
      errors++;
      results.push({ row: r, before, after: before, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { results, errors };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}
