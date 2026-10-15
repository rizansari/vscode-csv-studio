import { fieldRanges } from './csv/parse';
import { formatField, formatRecord } from './csv/serialize';
import { recordIndex, type Table } from './table';

export type CsvEditOp =
  | { kind: 'setCell'; row: number; col: number; value: string }
  | { kind: 'setCells'; cells: { row: number; col: number; value: string }[] }
  | { kind: 'insertRows'; at: number; rows: string[][] }
  | { kind: 'deleteRows'; rows: number[] }
  | { kind: 'addColumn'; name: string; at?: number; values?: string[] }
  /** Several columns in one edit; each `at` refers to the column positions before the edit. */
  | { kind: 'addColumns'; columns: { name: string; at: number; values?: string[] }[] }
  | { kind: 'deleteColumn'; col: number }
  | { kind: 'renameColumn'; col: number; name: string }
  | { kind: 'moveColumn'; from: number; to: number }
  | { kind: 'reorderRows'; order: ArrayLike<number> };

interface Splice {
  start: number;
  end: number;
  text: string;
}

/**
 * Applies an edit and returns the new document text. Untouched fields keep their exact original
 * text (quoting, spacing), and the file's delimiter and line endings are preserved.
 */
export function applyEdit(text: string, t: Table, op: CsvEditOp): string {
  const d = t.dialect;
  const fmt = { delimiter: d.delimiter, quote: d.quote, quoting: 'minimal' as const };
  const { starts, ends, records } = t.parsed;
  const splices: Splice[] = [];
  const recordText = (r: number) => text.slice(starts[r], ends[r]);
  const rawFields = (r: number) => fieldRanges(text, starts[r], ends[r], d).map(([s, e]) => text.slice(s, e));

  /** Replace one field of a record, padding the record with empty fields when it is too short. */
  const setField = (rec: number, col: number, value: string) => {
    const ranges = fieldRanges(text, starts[rec], ends[rec], d);
    if (col < ranges.length) splices.push({ start: ranges[col][0], end: ranges[col][1], text: formatField(value, fmt) });
    else splices.push({ start: ends[rec], end: ends[rec], text: d.delimiter.repeat(col - ranges.length + 1) + formatField(value, fmt) });
  };

  switch (op.kind) {
    case 'setCell':
      setField(recordIndex(t, op.row), op.col, op.value);
      break;
    case 'setCells':
      // Several cells can land in the same record; merge them per record to keep splices disjoint.
      {
        const byRecord = new Map<number, Map<number, string>>();
        for (const c of op.cells) {
          const rec = recordIndex(t, c.row);
          if (!byRecord.has(rec)) byRecord.set(rec, new Map());
          byRecord.get(rec)!.set(c.col, c.value);
        }
        for (const [rec, cols] of byRecord) {
          if (cols.size === 1) {
            const [[col, value]] = [...cols];
            setField(rec, col, value);
          } else {
            const fields = rawFields(rec);
            for (const [col, value] of cols) {
              while (fields.length <= col) fields.push('');
              fields[col] = formatField(value, fmt);
            }
            splices.push({ start: starts[rec], end: ends[rec], text: fields.join(d.delimiter) });
          }
        }
      }
      break;
    case 'renameColumn':
      if (!t.rawHeader) throw new Error('This file has no header row');
      setField(0, op.col, op.name);
      break;
    case 'insertRows': {
      const lines = op.rows.map((r) => formatRecord(r, fmt));
      const dataRecords = records.length - (t.rawHeader ? 1 : 0);
      if (op.at < dataRecords) {
        const rec = recordIndex(t, op.at);
        splices.push({ start: starts[rec], end: starts[rec], text: lines.map((l) => l + d.eol).join('') });
      } else if (!records.length) {
        splices.push({ start: text.length, end: text.length, text: lines.map((l) => l + d.eol).join('') });
      } else {
        // Append after the last record, adding a terminator first if the file lacks a final newline.
        const lastEnd = ends[records.length - 1];
        if (lastEnd < text.length) splices.push({ start: text.length, end: text.length, text: lines.map((l) => l + d.eol).join('') });
        else splices.push({ start: lastEnd, end: lastEnd, text: d.eol + lines.join(d.eol) });
      }
      break;
    }
    case 'deleteRows': {
      // Contiguous runs become one splice so neighbouring deletions never overlap.
      const recs = [...new Set(op.rows)].map((r) => recordIndex(t, r)).sort((x, y) => x - y);
      const last = records.length - 1;
      for (let k = 0; k < recs.length; ) {
        const a = recs[k];
        let b = a;
        while (recs[k + 1] === b + 1) b = recs[++k];
        k++;
        if (b < last) splices.push({ start: starts[a], end: starts[b + 1], text: '' });
        else if (a > 0) splices.push({ start: ends[a - 1], end: ends[b], text: '' }); // keep the file's final newline as-is
        else splices.push({ start: starts[a], end: text.length, text: '' });
      }
      break;
    }
    case 'addColumn':
    case 'addColumns': {
      const added = op.kind === 'addColumn' ? [{ name: op.name, at: op.at ?? t.columns.length, values: op.values }] : op.columns;
      // Insert right-to-left so earlier positions stay valid; equal positions keep their given order.
      const order = added.map((c, i) => ({ ...c, i })).sort((a, b) => b.at - a.at || b.i - a.i);
      records.forEach((_, rec) => {
        const isHeader = !!t.rawHeader && rec === 0;
        const dataRow = t.rawHeader ? rec - 1 : rec;
        const fields = rawFields(rec);
        for (const c of order) {
          while (fields.length < c.at) fields.push('');
          fields.splice(c.at, 0, formatField(isHeader ? c.name : c.values?.[dataRow] ?? '', fmt));
        }
        splices.push({ start: starts[rec], end: ends[rec], text: fields.join(d.delimiter) });
      });
      break;
    }
    case 'deleteColumn':
      records.forEach((_, rec) => {
        const fields = rawFields(rec);
        if (op.col >= fields.length) return;
        fields.splice(op.col, 1);
        splices.push({ start: starts[rec], end: ends[rec], text: fields.join(d.delimiter) });
      });
      break;
    case 'moveColumn':
      records.forEach((_, rec) => {
        const fields = rawFields(rec);
        while (fields.length <= Math.max(op.from, op.to)) fields.push('');
        const [f] = fields.splice(op.from, 1);
        fields.splice(op.to, 0, f);
        splices.push({ start: starts[rec], end: ends[rec], text: fields.join(d.delimiter) });
      });
      break;
    case 'reorderRows': {
      const first = t.rawHeader ? 1 : 0;
      if (records.length <= first) return text;
      const body = Array.from(op.order, (row) => recordText(row + first));
      splices.push({ start: starts[first], end: ends[records.length - 1], text: body.join(d.eol) });
      break;
    }
  }
  return applySplices(text, splices);
}

function applySplices(text: string, splices: Splice[]): string {
  if (!splices.length) return text;
  splices.sort((a, b) => a.start - b.start || a.end - b.end);
  const out: string[] = [];
  let pos = 0;
  for (const s of splices) {
    if (s.start < pos) throw new Error('Overlapping edits');
    out.push(text.slice(pos, s.start), s.text);
    pos = s.end;
  }
  out.push(text.slice(pos));
  return out.join('');
}

/** Smallest single replacement turning `before` into `after`. */
export function minimalEdit(before: string, after: string): { offset: number; length: number; content: string } | undefined {
  if (before === after) return undefined;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before.charCodeAt(endB - 1) === after.charCodeAt(endA - 1)) {
    endB--;
    endA--;
  }
  return { offset: start, length: endB - start, content: after.slice(start, endA) };
}
