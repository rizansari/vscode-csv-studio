import { writeCsv, writeOptions } from './serialize';
import type { Table } from '../table';

export interface LintIssue {
  kind: 'unterminatedQuote' | 'fieldCount' | 'blankLine' | 'strayQuote' | 'mixedLineEndings' | 'trailingDelimiter' | 'duplicateHeader' | 'emptyHeader';
  severity: 'error' | 'warning' | 'info';
  offset: number;
  length: number;
  message: string;
}

/** Issues worth fixing, with text offsets so the host can show them as diagnostics. */
export function lint(text: string, t: Table): LintIssue[] {
  const issues: LintIssue[] = [];
  const { starts, ends } = t.parsed;
  for (const p of t.issues) {
    const len = p.kind === 'blankLine' ? 0 : Math.max(1, (ends[p.record] ?? p.offset + 1) - p.offset);
    issues.push({
      kind: p.kind,
      severity: p.kind === 'blankLine' ? 'info' : p.kind === 'fieldCount' || p.kind === 'unterminatedQuote' ? 'error' : 'warning',
      offset: p.offset,
      length: p.kind === 'unterminatedQuote' ? 1 : len,
      message: p.message,
    });
  }
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf && lf) issues.push({ kind: 'mixedLineEndings', severity: 'warning', offset: 0, length: 0, message: `Mixed line endings (${crlf} CRLF, ${lf} LF)` });
  if (t.rawHeader) {
    const names = t.rawHeader.map((h) => h.trim().toLowerCase());
    t.rawHeader.forEach((h, i) => {
      if (!h.trim()) issues.push({ kind: 'emptyHeader', severity: 'warning', offset: starts[0], length: ends[0] - starts[0], message: `Column ${i + 1} has no name` });
      else if (names.indexOf(names[i]) !== i) issues.push({ kind: 'duplicateHeader', severity: 'warning', offset: starts[0], length: ends[0] - starts[0], message: `Duplicate column name "${h}"` });
    });
    if (t.rawHeader.length > 1 && !t.rawHeader[t.rawHeader.length - 1].trim() && t.rows.every((r) => !(r[r.length - 1] ?? '').trim())) {
      issues.push({ kind: 'trailingDelimiter', severity: 'info', offset: starts[0], length: ends[0] - starts[0], message: 'Every line ends with a delimiter (empty last column)' });
    }
  }
  return issues;
}

/** Blank lines are always dropped (the parser never turns them into rows). */
export interface RepairOptions {
  padShortRows: boolean;
  /** Extra non-empty fields become new columns named extra_1, extra_2… */
  keepExtraFields: boolean;
  dropTrailingEmptyColumn: boolean;
  trimWhitespace: boolean;
  removeBom: boolean;
}

export const DEFAULT_REPAIR: RepairOptions = {
  padShortRows: true,
  keepExtraFields: true,
  dropTrailingEmptyColumn: true,
  trimWhitespace: false,
  removeBom: true,
};

/** Rewrites the file as rectangular, consistently quoted CSV in the same dialect. */
export function repairCsv(t: Table, o: RepairOptions = DEFAULT_REPAIR): string {
  let header = t.rawHeader ? [...t.rawHeader] : null;
  let rows = t.rows.map((r) => [...r]);
  if (o.trimWhitespace) {
    header = header?.map((h) => h.trim()) ?? null;
    rows = rows.map((r) => r.map((c) => c.trim()));
  }
  if (o.dropTrailingEmptyColumn && header && header.length > 1 && !header[header.length - 1].trim() && rows.every((r) => !(r[r.length - 1] ?? '').trim())) {
    header.pop();
    rows = rows.map((r) => (r.length > header!.length ? r.slice(0, header!.length) : r));
  }
  let width = header?.length ?? Math.max(0, ...rows.map((r) => r.length));
  const longest = Math.max(width, ...rows.map((r) => r.length));
  if (longest > width) {
    const extraUsed = rows.some((r) => r.slice(width).some((c) => c.trim() !== ''));
    if (extraUsed && o.keepExtraFields) {
      if (header) for (let i = width; i < longest; i++) header.push(`extra_${i - width + 1}`);
      width = longest;
    }
    rows = rows.map((r) => r.slice(0, width));
  }
  if (o.padShortRows) rows = rows.map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill('')] : r));
  const out = writeCsv(header, rows, writeOptions(t.dialect));
  return t.dialect.bom && !o.removeBom ? '﻿' + out : out;
}
