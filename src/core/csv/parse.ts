import type { Dialect } from './dialect';

export interface CsvIssue {
  kind: 'unterminatedQuote' | 'fieldCount' | 'blankLine' | 'strayQuote';
  /** Record index (0 = first line, including the header). */
  record: number;
  offset: number;
  message: string;
}

/** A parsed file. Records include the header (when present) as record 0. */
export interface ParsedCsv {
  records: string[][];
  /** Text offset where each record starts. */
  starts: number[];
  /** Text offset where each record ends (before its line terminator). */
  ends: number[];
  issues: CsvIssue[];
}

const CR = 13;
const LF = 10;

/**
 * One-pass RFC 4180 parser that keeps record offsets so edits can touch only the changed text.
 * Lenient: an opening quote that never closes is treated as a literal character instead of
 * swallowing the rest of the file.
 */
export function parseCsv(text: string, dialect: Pick<Dialect, 'delimiter' | 'quote'>): ParsedCsv {
  const delim = dialect.delimiter.charCodeAt(0);
  const quote = dialect.quote.charCodeAt(0);
  const len = text.length;
  const records: string[][] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const issues: CsvIssue[] = [];

  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < len) {
    const recordStart = i;
    const fields: string[] = [];
    let end = -1;
    for (;;) {
      let value: string;
      if (text.charCodeAt(i) === quote) {
        // Quoted field.
        let j = i + 1;
        let out = '';
        let closed = false;
        let segStart = j;
        while (j < len) {
          const q = text.indexOf(dialect.quote, j);
          if (q < 0) break;
          if (text.charCodeAt(q + 1) === quote) {
            out += text.slice(segStart, q + 1);
            j = q + 2;
            segStart = j;
            continue;
          }
          out += text.slice(segStart, q);
          j = q + 1;
          closed = true;
          break;
        }
        if (!closed) {
          issues.push({ kind: 'unterminatedQuote', record: records.length, offset: i, message: 'Quote is never closed; treated as a literal character' });
          ({ value, next: i } = unquotedField(text, i, delim));
        } else {
          // Anything between the closing quote and the delimiter is kept (lenient), but reported.
          const rest = unquotedField(text, j, delim);
          if (rest.value) issues.push({ kind: 'strayQuote', record: records.length, offset: j, message: 'Characters after a closing quote' });
          value = out + rest.value;
          i = rest.next;
        }
      } else {
        ({ value, next: i } = unquotedField(text, i, delim));
      }
      fields.push(value);
      const c = text.charCodeAt(i);
      if (c === delim) {
        i++;
        if (i >= len) {
          fields.push('');
          end = i;
          break;
        }
        continue;
      }
      end = i;
      if (c === CR) i += text.charCodeAt(i + 1) === LF ? 2 : 1;
      else if (c === LF) i++;
      break;
    }
    if (fields.length === 1 && fields[0] === '' && end === recordStart) {
      // Blank line: keep it out of the data but remember it for lint.
      issues.push({ kind: 'blankLine', record: records.length, offset: recordStart, message: 'Blank line' });
      continue;
    }
    records.push(fields);
    starts.push(recordStart);
    ends.push(end);
  }

  const width = records[0]?.length ?? 0;
  records.forEach((r, idx) => {
    if (r.length !== width) issues.push({ kind: 'fieldCount', record: idx, offset: starts[idx], message: `Expected ${width} fields but found ${r.length}` });
  });
  return { records, starts, ends, issues };
}

function unquotedField(text: string, i: number, delim: number): { value: string; next: number } {
  const start = i;
  const len = text.length;
  while (i < len) {
    const c = text.charCodeAt(i);
    if (c === delim || c === LF || c === CR) break;
    i++;
  }
  return { value: text.slice(start, i), next: i };
}

/** Raw [start, end) ranges of each field inside one record (quotes included). */
export function fieldRanges(text: string, start: number, end: number, dialect: Pick<Dialect, 'delimiter' | 'quote'>): [number, number][] {
  const ranges: [number, number][] = [];
  let i = start;
  for (;;) {
    const fieldStart = i;
    if (text[i] === dialect.quote) {
      let j = i + 1;
      while (j < end) {
        if (text[j] === dialect.quote) {
          if (text[j + 1] === dialect.quote) j += 2;
          else break;
        } else j++;
      }
      i = j < end ? j + 1 : fieldStart; // unterminated: fall back to unquoted scan
    }
    while (i < end && text[i] !== dialect.delimiter) i++;
    ranges.push([fieldStart, i]);
    if (i >= end) break;
    i++;
    if (i === end) {
      ranges.push([end, end]);
      break;
    }
  }
  return ranges;
}
