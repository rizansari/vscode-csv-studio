import { createCipheriv, randomBytes } from 'crypto';
import { describe, expect, it } from 'vitest';
import { runTransform } from '../../src/core/transforms/run';
import { Session } from '../../src/extension/session';

const KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

function encrypt(s: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(KEY, 'hex'), iv);
  const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

function sales(n: number) {
  const lines = ['id,region,amount,card'];
  for (let i = 1; i <= n; i++) lines.push(`${i},${['North', 'South'][i % 2]},${(i * 1.5).toFixed(2)},${i <= 3 ? encrypt(`41111111111111${String(i).padStart(2, '0')}`) : ''}`);
  return lines.join('\n') + '\n';
}

describe('Session', () => {
  it('decrypts a column through SQL using a secret', async () => {
    const s = new Session('/x/sales.csv', [], 1000, '');
    s.load(sales(10));
    const r = await s.runSql(`SELECT id, decrypt(card, 'demo') AS card FROM sales WHERE card IS NOT NULL ORDER BY id`, 100, { demo: KEY }, new Map());
    expect(r.rows).toEqual([
      [1, '4111111111111101'],
      [2, '4111111111111102'],
      [3, '4111111111111103'],
    ]);
    const bad = await s.runSql(`SELECT decrypt(card, 'missing') FROM data LIMIT 1`, 1, {}, new Map());
    expect(bad.rows[0][0]).toMatch(/#ERROR: Secret "missing" is not set/);
  });

  it('adds virtual columns that SQL and filters can use', async () => {
    const s = new Session('/x/sales.csv', [], 1000, '');
    s.load(sales(10));
    const out = await runTransform({ col: 3, kind: 'preset', id: 'aes-decrypt', params: { key: 'demo', keyFormat: 'hex' }, target: 'virtual' }, { columns: s.columnNames, rows: s.allRows(), rowIndexes: [0, 1, 2], secrets: { demo: KEY }, user: new Map() });
    const values = s.table.rows.map((r) => r[3]);
    out.results.forEach((r) => (values[r.row] = r.after));
    s.addVirtual('card_plain', values);
    expect(s.meta(false, undefined, true).columns.at(-1)).toMatchObject({ name: 'card_plain', virtual: true });
    expect((await s.runSql('SELECT card_plain FROM data WHERE id = 2', 10, {}, new Map())).rows).toEqual([['4111111111111102']]);
    s.setView({ filters: [{ col: 4, op: 'startsWith', value: '4111' }], sorts: [{ col: 0, dir: -1 }] });
    expect(s.rows(0, 10).map((r) => r.row)).toEqual([2, 1, 0]);
    expect(s.viewIndexOf(0)).toBe(2);
  });

  it('builds SQL from the current view', () => {
    const s = new Session('/x/sales.csv', [], 1000, '');
    s.load(sales(10));
    s.setView({ filters: [{ col: 2, op: 'gt', value: '5' }, { col: 1, op: 'in', values: ["O'Neil", 'North'] }], sorts: [{ col: 2, dir: -1 }] });
    expect(s.buildQuery()).toBe(`SELECT *\nFROM data\nWHERE "amount" > 5\n  AND "region" IN ('O''Neil', 'North')\nORDER BY "amount" DESC`);
  });

  it('keeps type overrides and survives reloads', () => {
    const s = new Session('/x/sales.csv', [], 1000, '');
    s.load(sales(5));
    s.setType(0, 'string');
    s.load(sales(6));
    expect(s.meta(false, undefined, true).columns[0]).toMatchObject({ type: 'string', inferred: 'integer', overridden: true });
  });

  it('handles 200k rows quickly', async () => {
    const lines = ['id,name,amount,day'];
    for (let i = 0; i < 200_000; i++) lines.push(`${i},"name ${i % 977}",${(i % 5000) / 3},2024-${String((i % 12) + 1).padStart(2, '0')}-15`);
    const text = lines.join('\n');
    const s = new Session('/x/big.csv', [], 100_000, '');
    let t = Date.now();
    s.load(text);
    const loadMs = Date.now() - t;
    t = Date.now();
    s.setView({ filters: [{ col: 2, op: 'gt', value: '1000' }], sorts: [{ col: 1, dir: 1 }, { col: 2, dir: -1 }] });
    const viewMs = Date.now() - t;
    t = Date.now();
    const r = await s.runSql('SELECT strftime(\'%m\', day) m, COUNT(*) FROM data GROUP BY m', 100, {}, new Map());
    const sqlMs = Date.now() - t;
    expect(r.rows).toHaveLength(12);
    expect(s.view.length).toBeGreaterThan(0);
    console.log(`200k rows: load ${loadMs} ms, filter+sort ${viewMs} ms, first SQL (incl. table load) ${sqlMs} ms`);
    expect(loadMs + viewMs).toBeLessThan(8000);
  });
});
