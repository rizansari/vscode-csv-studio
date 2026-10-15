import * as crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { diffAsRows, diffByKey, mergeTables, splitRows } from '../../src/core/compare';
import { detectDialect } from '../../src/core/csv/dialect';
import { lint, repairCsv } from '../../src/core/csv/lint';
import { fieldRanges, parseCsv } from '../../src/core/csv/parse';
import { formatField, writeCsv, writeOptions } from '../../src/core/csv/serialize';
import { applyEdit } from '../../src/core/edit';
import { exportRows, fromJson } from '../../src/core/export';
import { profileColumn } from '../../src/core/profile';
import { SqlEngine, isMutating, tableNameFor } from '../../src/core/sql/engine';
import { loadTable } from '../../src/core/table';
import { aesDecrypt, aesEncrypt, deriveKey, fernetDecrypt, findPreset } from '../../src/core/transforms/presets';
import { runTransform } from '../../src/core/transforms/run';
import { compileUserTransform } from '../../src/core/transforms/sandbox';
import { inferType, parseDateTime, toNumber, toSqlValue } from '../../src/core/types';
import { computeView } from '../../src/core/view';

const SAMPLE = 'id,name,price,joined,active\n1,"Smith, Ann",9.50,2024-01-05,true\n2,"Bob ""B""",12,2023-12-31,false\n3,Cara,,2024-02-29,yes\n';

describe('parse', () => {
  it('handles quotes, escaped quotes, embedded newlines and CRLF with offsets', () => {
    const text = 'a,b\r\n"x\r\ny","q""q"\r\n3,\r\n';
    const p = parseCsv(text, { delimiter: ',', quote: '"' });
    expect(p.records).toEqual([['a', 'b'], ['x\r\ny', 'q"q'], ['3', '']]);
    expect(p.records.map((_, i) => text.slice(p.starts[i], p.ends[i]))).toEqual(['a,b', '"x\r\ny","q""q"', '3,']);
    expect(p.issues).toEqual([]);
  });
  it('skips BOM and blank lines, reports ragged rows and unterminated quotes leniently', () => {
    const p = parseCsv('﻿a,b\n\n1,2,3\n"open,4\n', { delimiter: ',', quote: '"' });
    expect(p.records).toEqual([['a', 'b'], ['1', '2', '3'], ['"open', '4']]);
    expect(p.issues.map((i) => i.kind).sort()).toEqual(['blankLine', 'fieldCount', 'unterminatedQuote']);
  });
  it('returns raw field ranges', () => {
    const text = 'a,"b,c",,d';
    expect(fieldRanges(text, 0, text.length, { delimiter: ',', quote: '"' }).map(([s, e]) => text.slice(s, e))).toEqual(['a', '"b,c"', '', 'd']);
  });
});

describe('dialect', () => {
  it.each([
    ['a;b;c\n1;2,5;3\n4;5;6\n', ';'],
    ['a\tb\n1\t2\n', '\t'],
    ['a|b\n1|2\n', '|'],
    ['name,desc\n"x","a;b;c"\n"y","d;e"\n', ','],
  ])('detects the delimiter of %j', (text, delimiter) => {
    expect(detectDialect(text).delimiter).toBe(delimiter);
  });
  it('detects headers and line endings', () => {
    expect(loadTable(SAMPLE).dialect.header).toBe(true);
    expect(loadTable('1,2\n3,4\n').dialect.header).toBe(false);
    expect(detectDialect('a,b\r\n1,2\r\n').eol).toBe('\r\n');
  });
  it('makes column names unique', () => {
    expect(loadTable('a,,A\n1,2,3\n').columns).toEqual(['a', 'column_2', 'A_2']);
  });
});

describe('serialize', () => {
  it('quotes only when needed', () => {
    const o = { delimiter: ',', quote: '"', quoting: 'minimal' as const };
    expect(['plain', 'a,b', 'say "hi"', 'line\nbreak', ' pad'].map((v) => formatField(v, o))).toEqual(['plain', '"a,b"', '"say ""hi"""', '"line\nbreak"', '" pad"']);
    expect(writeCsv(['x', 'y'], [['1', 'two']], { ...writeOptions(loadTable(SAMPLE).dialect), quoting: 'nonNumeric' })).toBe('"x","y"\n1,"two"\n');
  });
});

describe('types', () => {
  it('infers column types', () => {
    expect(inferType(['1', '2', '-30', '1,000']).type).toBe('integer');
    expect(inferType(['1.5', '2', '3.25']).type).toBe('decimal');
    expect(inferType(['007', '010']).type).toBe('string');
    expect(inferType(['4111111111111111', '5500005555555559']).type).toBe('string');
    expect(inferType(['yes', 'no', 'Y']).type).toBe('boolean');
    expect(inferType(['12.5%', '3%']).type).toBe('percent');
    expect(inferType(['$1,200.00', '$3']).type).toBe('currency');
    expect(inferType(['2024-01-05', '2023-12-31']).type).toBe('date');
    expect(inferType(['25/12/2024', '01/02/2024'])).toMatchObject({ type: 'date', dateOrder: 'dmy' });
    expect(inferType(['12/25/2024', '01/02/2024'])).toMatchObject({ type: 'date', dateOrder: 'mdy' });
    expect(inferType(['2024-01-05T10:00:00Z', '2024-01-05 11:30']).type).toBe('datetime');
    expect(inferType(['a@b.co', 'x@y.org']).type).toBe('email');
    expect(inferType(['{"a":1}', '[1,2]']).type).toBe('json');
    expect(inferType(['1', 'two', '3']).type).toBe('string');
  });
  it('coerces values', () => {
    expect(toNumber('1.234,5', { type: 'decimal', confidence: 1, decimalComma: true })).toBe(1234.5);
    expect(toNumber('$1,200', { type: 'currency', confidence: 1 })).toBe(1200);
    expect(toSqlValue('25/12/2024', { type: 'date', confidence: 1, dateOrder: 'dmy' })).toBe('2024-12-25');
  });
  it('reads date-times with a spaced, colon-less zone offset', () => {
    const v = '2024-10-30 07:56:43.972 +0300';
    expect(inferType([v, '2024-10-31 18:00:01.005 +0300']).type).toBe('datetime');
    expect(parseDateTime(v)).toBe(Date.UTC(2024, 9, 30, 4, 56, 43, 972));
    expect(parseDateTime('2024-10-30T07:56:43-05:30')).toBe(Date.UTC(2024, 9, 30, 13, 26, 43));
    expect(parseDateTime('2024-10-30 07:56 UTC')).toBe(Date.UTC(2024, 9, 30, 7, 56));
    expect(parseDateTime('2024-02-30 07:56:43')).toBeNull();
    expect(parseDateTime('2024-10-30 25:00:00')).toBeNull();
    const dt = { type: 'datetime' as const, confidence: 1 };
    expect(toNumber(v, dt)).toBe(Date.UTC(2024, 9, 30, 4, 56, 43, 972));
    // SQLite's date functions need "+03:00"; already-valid values are left untouched.
    expect(toSqlValue(v, dt)).toBe('2024-10-30 07:56:43.972+03:00');
    expect(toSqlValue('2024-10-30 07:56:43 UTC', dt)).toBe('2024-10-30 07:56:43Z');
    expect(toSqlValue('2024-10-30T07:56:43+03:00', dt)).toBe('2024-10-30T07:56:43+03:00');
  });
});

describe('view', () => {
  const t = loadTable(SAMPLE);
  const types = t.columns.map((_, i) => inferType(t.rows.map((r) => r[i] ?? '')));
  it('filters with typed operators and sorts empties last', () => {
    expect([...computeView(t.rows, types, { filters: [{ col: 2, op: 'gt', value: '10' }], sorts: [] })]).toEqual([1]);
    expect([...computeView(t.rows, types, { filters: [{ col: 3, op: 'between', value: '2024-01-01', value2: '2024-12-31' }], sorts: [] })]).toEqual([0, 2]);
    expect([...computeView(t.rows, types, { filters: [], sorts: [{ col: 2, dir: -1 }] })]).toEqual([1, 0, 2]);
    expect([...computeView(t.rows, types, { filters: [{ col: 1, op: 'in', values: ['Cara'] }], sorts: [] })]).toEqual([2]);
    expect([...computeView(t.rows, types, { filters: [], sorts: [], search: { text: 'smith' } })]).toEqual([0]);
  });
  it('multi-sorts and finds invalid cells', () => {
    const rows = [['b', '2'], ['a', '2'], ['c', '1'], ['d', 'x']];
    const ty = [inferType(rows.map((r) => r[0])), { type: 'integer' as const, confidence: 0.75 }];
    expect([...computeView(rows, ty, { filters: [], sorts: [{ col: 1, dir: 1 }, { col: 0, dir: 1 }] })]).toEqual([2, 1, 0, 3]);
    expect([...computeView(rows, ty, { filters: [{ col: 1, op: 'invalid' }], sorts: [] })]).toEqual([3]);
  });
});

describe('edit', () => {
  const text = 'id,name\r\n1,"Smith, Ann"\r\n2,Bob\r\n';
  const t = loadTable(text);
  it('changes only the touched field and keeps line endings', () => {
    expect(applyEdit(text, t, { kind: 'setCell', row: 1, col: 1, value: 'Rob, Jr' })).toBe('id,name\r\n1,"Smith, Ann"\r\n2,"Rob, Jr"\r\n');
    expect(applyEdit(text, t, { kind: 'setCells', cells: [{ row: 0, col: 0, value: '10' }, { row: 0, col: 1, value: 'Z' }] })).toBe('id,name\r\n10,Z\r\n2,Bob\r\n');
  });
  it('inserts, deletes and appends rows', () => {
    expect(applyEdit(text, t, { kind: 'insertRows', at: 1, rows: [['9', 'New']] })).toBe('id,name\r\n1,"Smith, Ann"\r\n9,New\r\n2,Bob\r\n');
    expect(applyEdit(text, t, { kind: 'insertRows', at: 99, rows: [['3', 'C']] })).toBe(text + '3,C\r\n');
    expect(applyEdit('a\n1', loadTable('a\n1'), { kind: 'insertRows', at: 9, rows: [['2']] })).toBe('a\n1\n2');
    expect(applyEdit(text, t, { kind: 'deleteRows', rows: [0] })).toBe('id,name\r\n2,Bob\r\n');
    expect(applyEdit(text, t, { kind: 'deleteRows', rows: [0, 1] })).toBe('id,name\r\n');
  });
  it('adds, deletes, renames and moves columns', () => {
    expect(applyEdit(text, t, { kind: 'addColumn', name: 'age', values: ['30', ''] })).toBe('id,name,age\r\n1,"Smith, Ann",30\r\n2,Bob,\r\n');
    expect(
      applyEdit(text, t, {
        kind: 'addColumns',
        columns: [
          { name: 'id2', at: 1, values: ['a', 'b'] },
          { name: 'name2', at: 2, values: ['c', 'd'] },
          { name: 'x', at: 2 },
        ],
      }),
    ).toBe('id,id2,name,name2,x\r\n1,a,"Smith, Ann",c,\r\n2,b,Bob,d,\r\n');
    expect(applyEdit(text, t, { kind: 'deleteColumn', col: 0 })).toBe('name\r\n"Smith, Ann"\r\nBob\r\n');
    expect(applyEdit(text, t, { kind: 'renameColumn', col: 1, name: 'full name' })).toBe('id,full name\r\n1,"Smith, Ann"\r\n2,Bob\r\n');
    expect(applyEdit(text, t, { kind: 'moveColumn', from: 1, to: 0 })).toBe('name,id\r\n"Smith, Ann",1\r\nBob,2\r\n');
    expect(applyEdit(text, t, { kind: 'reorderRows', order: [1, 0] })).toBe('id,name\r\n2,Bob\r\n1,"Smith, Ann"\r\n');
  });
});

describe('lint & repair', () => {
  it('reports problems and repairs to a rectangular file', () => {
    const text = 'a,b,\n1,2,\n\n3\n4,5,6,7\n';
    const t = loadTable(text);
    expect(lint(text, t).map((i) => i.kind)).toEqual(expect.arrayContaining(['blankLine', 'fieldCount']));
    expect(repairCsv(t)).toBe('a,b,,extra_1\n1,2,,\n3,,,\n4,5,6,7\n');
    expect(repairCsv(loadTable('a,b,\n1,2,\n'))).toBe('a,b\n1,2\n');
  });
});

describe('profile', () => {
  it('computes stats', () => {
    const p = profileColumn(['1', '2', '', '3', 'x'], { type: 'integer', confidence: 0.75 });
    expect(p).toMatchObject({ count: 5, empty: 1, distinct: 4, invalid: 1, numeric: { min: 1, max: 3, mean: 2, median: 2 } });
  });
});

describe('sql', () => {
  it('loads typed tables, joins, aliases and runs UDFs', async () => {
    const t = loadTable(SAMPLE);
    const types = t.columns.map((_, i) => inferType(t.rows.map((r) => r[i] ?? '')));
    const db = await SqlEngine.create();
    db.load({ name: 'data', columns: t.columns, types, rows: t.rows }, ['products']);
    db.load({ name: 'tags', columns: ['id', 'tag'], types: [{ type: 'integer', confidence: 1 }, { type: 'string', confidence: 1 }], rows: [['1', 'sale'], ['3', 'new']] });
    db.register('shout', (v) => (v === null ? null : String(v).toUpperCase()));
    const r = db.run(`SELECT p.name, t.tag, shout(t.tag) AS s, p.price * 2 AS dbl FROM products p JOIN tags t ON t.id = p.id WHERE p.name REGEXP '^[CS]' ORDER BY p.id`);
    expect(r.columns).toEqual(['name', 'tag', 's', 'dbl']);
    expect(r.rows).toEqual([['Smith, Ann', 'sale', 'SALE', 19], ['Cara', 'new', 'NEW', null]]);
    expect(db.run(`SELECT strftime('%Y', joined) y, count(*) FROM data GROUP BY y ORDER BY y`).rows).toEqual([['2023', 1], ['2024', 2]]);
    expect(db.run('SELECT * FROM data', 2)).toMatchObject({ rowCount: 3, truncated: true });
    expect(db.run(`SELECT regexp_extract('ab-12', '(\\d+)', 1)`).rows[0][0]).toBe('12');
    expect(isMutating("SELECT 'delete' FROM data")).toBe(false);
    expect(isMutating('UPDATE data SET x = 1')).toBe(true);
    expect(tableNameFor('/x/Sales 2024.csv')).toBe('sales_2024');
    expect(tableNameFor('2024.csv')).toBe('t_2024');
  });
});

describe('crypto presets', () => {
  it('AES-256-GCM matches the NIST test vector (IV | ct | tag)', () => {
    const data = Buffer.concat([Buffer.alloc(12), Buffer.from('cea7403d4d606b6e074ec5d3baf39d18', 'hex'), Buffer.from('d0d1c8a799996bf0265b98b5d48ab919', 'hex')]);
    expect(aesDecrypt(data, { algorithm: 'aes-256-gcm', key: Buffer.alloc(32) })).toEqual(Buffer.alloc(16));
    expect(() => aesDecrypt(data, { algorithm: 'aes-256-gcm', key: Buffer.alloc(32, 1) })).toThrow(/Authentication failed/);
  });
  it('round-trips CBC/CTR and matches an IV supplied by a column', () => {
    for (const algorithm of ['aes-256-cbc', 'aes-128-ctr', 'aes-128-gcm']) {
      const key = crypto.randomBytes(algorithm.includes('256') ? 32 : 16);
      expect(aesDecrypt(aesEncrypt(Buffer.from('secret ✓'), { algorithm, key }), { algorithm, key }).toString()).toBe('secret ✓');
    }
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv('aes-256-cbc', key, iv);
    const ct = Buffer.concat([c.update('4111111111111111'), c.final()]).toString('base64');
    const preset = findPreset('aes-decrypt');
    const out = preset.run(ct, { algorithm: 'aes-256-cbc', key: 'k', keyFormat: 'hex', inputFormat: 'base64', ivSource: 'column', ivColumn: 'iv' }, { row: { iv: iv.toString('hex') }, rowIndex: 0, state: {}, secret: () => key.toString('hex') });
    expect(out).toBe('4111111111111111');
  });
  it('derives keys and validates their length', () => {
    expect(deriveKey('pass', 'passphrase', 'aes-128-cbc')).toHaveLength(16);
    expect(() => deriveKey('00', 'hex', 'aes-256-gcm')).toThrow(/32-byte key/);
  });
  it('decrypts the Fernet spec token', () => {
    const token = 'gAAAAAAdwJ6wAAECAwQFBgcICQoLDA0ODy021cpGVWKZ_eEwCGM4BLLF_5CV9dOPmrhuVUPgJobwOz7JcbmrR64jVmpU4IwqDA==';
    expect(fernetDecrypt(token, 'cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4=')).toBe('hello');
  });
  it('runs encoding / text presets', () => {
    const ctx = { row: { first: 'Ann', last: 'Lee' }, rowIndex: 0, state: {}, secret: () => '' };
    const run = (id: string, v: string, p: Record<string, string> = {}) => findPreset(id).run(v, p, ctx);
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.sig';
    expect(run('jwt-decode', jwt, { part: 'payload', claim: 'name' })).toBe('John Doe');
    expect(run('base64-decode', 'aGVsbG8=')).toBe('hello');
    expect(run('mask', '4111111111111111', { keepEnd: '4' })).toBe('************1111');
    expect(run('template', 'x', { template: '{first} {last} ({value})' })).toBe('Ann Lee (x)');
    expect(run('date-format', '25/12/2024', { inputOrder: 'auto', format: 'YYYY-MM-DD' })).toBe('2024-12-25');
    expect(run('date-format', '1735084800', { format: 'iso' })).toBe('2024-12-25T00:00:00.000Z');
    const dt = '2024-10-30 07:56:43.972 +0300';
    expect(run('date-format', dt, { format: 'YYYY-MM-DD HH:mm:ss' })).toBe('2024-10-30 04:56:43');
    expect(run('date-format', dt, { format: 'YYYY-MM-DD HH:mm:ss.SSS Z', zone: 'keep offset' })).toBe('2024-10-30 07:56:43.972 +03:00');
    expect(run('to-datetime', dt, { format: 'iso', zone: 'keep offset' })).toBe('2024-10-30T07:56:43.972+03:00');
    expect(run('to-datetime', dt, { format: 'iso', zone: 'UTC' })).toBe('2024-10-30T04:56:43.972Z');
    expect(run('to-datetime', dt, { format: 'epoch-ms' })).toBe(String(Date.UTC(2024, 9, 30, 4, 56, 43, 972)));
    expect(run('to-datetime', '25/12/2024', { format: 'YYYY-MM-DD HH:mm:ss', zone: 'UTC' })).toBe('2024-12-25 00:00:00');
    expect(() => run('to-datetime', 'soon', {})).toThrow(/Unrecognised/);
    expect(run('number-format', '$1,234.567', { decimals: '2', thousands: ',' })).toBe('1,234.57');
    expect(run('hash', 'a', { algorithm: 'sha256' })).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
  });
});

describe('transforms', () => {
  const columns = ['id', 'v'];
  const rows = [['1', 'a'], ['2', ''], ['3', 'c']];
  it('runs presets with per-row errors and state', async () => {
    const out = await runTransform({ col: 1, kind: 'preset', id: 'fill-down', params: {}, target: 'inPlace' }, { columns, rows, rowIndexes: [0, 1, 2], secrets: {}, user: new Map() });
    expect(out.results.map((r) => r.after)).toEqual(['a', 'a', 'c']);
    const bad = await runTransform({ col: 1, kind: 'preset', id: 'aes-decrypt', params: { key: 'missing' }, target: 'inPlace' }, { columns, rows, rowIndexes: [0], secrets: {}, user: new Map() });
    expect(bad).toMatchObject({ errors: 1, results: [{ after: 'a', error: expect.stringMatching(/not set/) }] });
  });
  it('compiles user transforms in a sandbox', async () => {
    const t = compileUserTransform('upper_id', "export const label = 'Upper + id';\nexport default (value, row, ctx) => value.toUpperCase() + '-' + row.id + ctx.secret('s');");
    expect(t.label).toBe('Upper + id');
    const out = await runTransform({ col: 1, kind: 'user', id: 'upper_id', params: {}, target: 'inPlace' }, { columns, rows, rowIndexes: [0, 2], secrets: { s: '!' }, user: new Map([['upper_id', t]]) });
    expect(out.results.map((r) => r.after)).toEqual(['A-1!', 'C-3!']);
  });
  it('blocks require, eval and runaway loops', () => {
    expect(() => compileUserTransform('x', "const fs = require('fs'); export default v => v")).toThrow(/require is not defined/);
    expect(() => compileUserTransform('x', "export default v => eval('1')").fn('a', {}, {} as never)).toThrow(/Code generation from strings disallowed/);
    const slow = compileUserTransform('slow', 'export default v => { for(;;){} }', 50);
    expect(() => slow.fn('a', {}, {} as never)).toThrow(/timed out/);
  });
});

describe('export & compare', () => {
  const columns = ['id', 'user.name', 'note'];
  const rows = [['1', 'Ann', 'a|b'], ['2', 'Bob', null]] as (string | null)[][];
  const o = { ...writeOptions(loadTable(SAMPLE).dialect), tableName: 'people', nest: true };
  it('exports to many formats', () => {
    expect(exportRows(columns, rows, 'json', o)).toContain('"user": {\n      "name": "Ann"');
    expect(exportRows(columns, rows, 'markdown', o).split('\n')[2]).toBe('| 1 | Ann | a\\|b |');
    expect(exportRows(columns, rows, 'sql', o).split('\n')[1]).toBe(`INSERT INTO "people" ("id", "user.name", "note") VALUES ('2', 'Bob', NULL);`);
    expect(exportRows(columns, rows, 'tsv', o)).toBe('id\tuser.name\tnote\n1\tAnn\ta|b\n2\tBob\t\n');
  });
  it('converts JSON to rows', () => {
    expect(fromJson({ items: [{ a: 1, b: { c: 2 } }, { a: 3, d: [1] }] })).toEqual({ columns: ['a', 'b.c', 'd'], rows: [['1', '2', ''], ['3', '', '[1]']] });
  });
  it('diffs by key, splits and merges', () => {
    const a = { columns: ['id', 'name', 'x'], rows: [['1', 'Ann', 'q'], ['2', 'Bob', 'q']] };
    const b = { columns: ['name', 'id', 'y'], rows: [['Anne', '1', ''], ['Cy', '3', '']] };
    const d = diffByKey(a, b, ['id']);
    expect(d).toMatchObject({ removedColumns: ['x'], addedColumns: ['y'], changed: [{ cells: [{ column: 'name', before: 'Ann', after: 'Anne' }] }] });
    expect(d.added).toHaveLength(1);
    expect(d.removed).toHaveLength(1);
    expect(diffAsRows(d, a, b).rows.map((r) => r[0])).toEqual(['removed', 'added', 'changed']);
    expect([...splitRows(a.rows, { column: 1 }).keys()]).toEqual(['Ann', 'Bob']);
    expect([...splitRows([['1'], ['2'], ['3']], { size: 2 }).values()]).toEqual([[['1'], ['2']], [['3']]]);
    expect(mergeTables([a, { columns: ['NAME', 'z'], rows: [['Zed', '1']] }])).toEqual({ columns: ['id', 'name', 'x', 'z'], rows: [['1', 'Ann', 'q', ''], ['2', 'Bob', 'q', ''], ['', 'Zed', '', '1']] });
  });
});
