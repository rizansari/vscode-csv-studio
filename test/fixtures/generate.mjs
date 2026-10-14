// Generates demo fixtures: node test/fixtures/generate.mjs [rows]
//   sales.csv      – typed columns, dd/mm/yyyy dates, currency, a few invalid cells, and an
//                    AES-256-GCM encrypted "card" column (base64 of IV | ciphertext | tag)
//   customers.csv  – lookup table for SQL JOINs
//   broken.csv     – ragged rows, blank line, unterminated quote
// Demo key (hex) for the card column — store it with "CSV Studio: Set Secret…" as "demo-key":
export const DEMO_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

import { createCipheriv, randomBytes } from 'crypto';
import { writeFileSync } from 'fs';

const rows = Number(process.argv[2] ?? 20000);
const key = Buffer.from(DEMO_KEY, 'hex');
const encrypt = (s) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
};
const regions = ['North', 'South', 'East', 'West'];
const products = ['Widget', 'Gadget', 'Doohickey', 'Gizmo', 'Thingamajig'];
const out = ['order_id,order_date,customer_id,region,product,qty,unit_price,discount,email,card,notes'];
for (let i = 1; i <= rows; i++) {
  const d = new Date(Date.UTC(2023, 0, 1) + ((i * 7919) % 730) * 86400000);
  const date = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
  const card = '4' + String(100000000000000 + ((i * 2654435761) % 899999999999999)).padStart(15, '0');
  const price = (((i * 37) % 9000) / 100 + 1).toFixed(2);
  const qty = i % 997 === 0 ? 'n/a' : String((i % 12) + 1);
  const notes = i % 50 === 0 ? `"Gift, wrap ""please"""` : i % 9 === 0 ? 'repeat customer' : '';
  out.push([i, date, 1000 + (i % 250), regions[i % 4], products[(i * 3) % 5], qty, `$${price}`, `${(i % 4) * 5}%`, `user${i % 250}@example.com`, encrypt(card), notes].join(','));
}
writeFileSync(new URL('./sales.csv', import.meta.url), out.join('\n') + '\n');

const tiers = ['bronze', 'silver', 'gold'];
const cust = ['customer_id,name,tier,since'];
for (let c = 1000; c < 1250; c++) cust.push(`${c},Customer ${c},${tiers[c % 3]},${2015 + (c % 9)}-0${(c % 9) + 1}-15`);
writeFileSync(new URL('./customers.csv', import.meta.url), cust.join('\n') + '\n');

writeFileSync(
  new URL('./broken.csv', import.meta.url),
  'id,name,amount,\n1,Ann,10,\n2,Bob\n\n3,"Cara, Jr",30,,extra\n4,"Dan,40,\n5,Eve,50,\n',
);
console.log(`wrote sales.csv (${rows} rows), customers.csv, broken.csv`);
