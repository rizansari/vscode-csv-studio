import { isNumericType, matches, toNumber, type ColumnType } from './types';

export interface ValueCount {
  value: string;
  count: number;
}

export interface ColumnProfile {
  count: number;
  empty: number;
  distinct: number;
  invalid: number;
  top: ValueCount[];
  numeric?: { min: number; max: number; mean: number; median: number; p95: number; sum: number };
  length: { min: number; max: number; mean: number };
}

/** Distinct values with counts, most frequent first. */
export function distinctValues(values: Iterable<string>, limit = 1000): { values: ValueCount[]; total: number } {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { numeric: true }));
  return { values: sorted.slice(0, limit).map(([value, count]) => ({ value, count })), total: counts.size };
}

export function profileColumn(values: string[], t: ColumnType): ColumnProfile {
  let empty = 0;
  let invalid = 0;
  let lenMin = Infinity;
  let lenMax = 0;
  let lenSum = 0;
  const nums: number[] = [];
  for (const v of values) {
    if (v.trim() === '') {
      empty++;
      continue;
    }
    lenMin = Math.min(lenMin, v.length);
    lenMax = Math.max(lenMax, v.length);
    lenSum += v.length;
    if (!matches(t.type, v, t)) invalid++;
    if (isNumericType(t.type)) {
      const n = toNumber(v, t);
      if (n !== null) nums.push(n);
    }
  }
  const filled = values.length - empty;
  const { values: top, total } = distinctValues(values.filter((v) => v.trim() !== ''), 10);
  const profile: ColumnProfile = {
    count: values.length,
    empty,
    distinct: total,
    invalid,
    top,
    length: { min: filled ? lenMin : 0, max: lenMax, mean: filled ? lenSum / filled : 0 },
  };
  if (nums.length) {
    nums.sort((a, b) => a - b);
    const q = (p: number) => nums[Math.min(nums.length - 1, Math.floor(p * (nums.length - 1)))];
    const sum = nums.reduce((s, n) => s + n, 0);
    profile.numeric = { min: nums[0], max: nums[nums.length - 1], mean: sum / nums.length, median: q(0.5), p95: q(0.95), sum };
  }
  return profile;
}
