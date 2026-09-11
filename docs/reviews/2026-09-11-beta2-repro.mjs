// Baseline diagnostics for d3b4b18, retained as review evidence. These assert
// the OLD faulty behavior and intentionally fail after the fixes. Current
// correctness regressions live in vite-app/src/*.test.mjs.
// Read-only reproductions of review findings. Run with Node 22+:
// node docs/reviews/2026-09-11-beta2-repro.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { lineTotal, gstOn, nonNegative } from '../../vite-app/src/data.js';
import { acceptsNumberText } from '../../vite-app/src/numberInput.js';
import { isDay, periodFrom, sumHours } from '../../supabase/functions/_shared/hoursDose.ts';

// Load the real invoice arithmetic without its unrelated network imports.
const source = readFileSync(new URL('../../supabase/functions/_shared/invoice.ts', import.meta.url), 'utf8');
const arithmetic = source.slice(0, source.indexOf('export const invoiceCss'))
  .replace(/^import .*;\r?\n/gm, '');
const invoice = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(arithmetic)).toString('base64'));
const bill = { lines: [{ quantity: 1, unit_rate: 1000 }], job: { clients: { gst_rate: 5 } } };
assert.equal(invoice.invoiceTotals(bill).grand, 105000);
bill.job.clients.gst_rate = 0;
assert.equal(invoice.invoiceTotals(bill).grand, 100000);
console.log('F1: unchanged $1,000 invoice lines yield $1,050 or $1,000 when the joined client rate changes.');

assert.equal(acceptsNumberText('1.2345', '0.1'), true);
assert.equal(acceptsNumberText('1.234', '0.01'), true);
assert.equal(nonNegative('1.2345'), 1.2345);
assert.equal(lineTotal(1.2345, 100), 123.5);
assert.equal(invoice.lineCents({ quantity: 1.2345, unit_rate: 100 }), 12350);
assert.equal(lineTotal(100, 1.234), 123);
// Exact products: 1.2345 * 100 = 123.45; 100 * 1.234 = 123.40.
console.log('F2: accepted quantity 1.2345 at $100 renders $123.50, exact product $123.45.');
console.log('F2: accepted rate $1.234 at quantity 100 renders $123.00, exact product $123.40.');

const rows = Array.from({ length: 1001 }, () => ({ job_number: 'TEST', work_date: '2026-09-11', straight_hours: 1 }));
assert.equal(sumHours(rows).total.straight, 1001);
assert.equal(sumHours(rows.slice(0, 1000)).total.straight, 1000);
console.log('F3: synthetic 1,001-row input totals 1,001 hours; the runner\'s 1,000-row slice totals 1,000. Query behavior confirmed by source, not a live API test.');

// Extract the actual backup table reader, supply only the dependencies used
// by this path, and simulate a server returning 250 rows despite limit(1000).
const backup = readFileSync(new URL('../../supabase/functions/backup-run/index.ts', import.meta.url), 'utf8');
const marker = backup.lastIndexOf('async function ', backup.indexOf('// One part: up to MAX_PART_ROWS'));
const end = backup.indexOf('\n}', marker) + 2;
let fn = stripTypeScriptTypes(backup.slice(marker, end)).replace(/^async function \w+/, 'async function readPart');
const factory = new Function('LOAD_ORDER', 'CURSOR_COLUMN', 'TABLE_KEYS', 'MAX_PART_ROWS', 'PAGE_ROWS', 'addAuthEmails', 'foldIntoIndex', 'partFileName', 'gzip', 'stripSecrets', 'withRetry', 'afterTablePart', `return (${fn});`);
const readPart = factory(['tickets'], { tickets: 'id' }, {}, 25000, 1000, async () => {}, c => c, () => 'part', async x => x, (_, x) => x, async (_, f) => f(), (_, result) => result);
let calls = 0;
const records = Array.from({ length: 1001 }, (_, i) => ({ id: String(i).padStart(6, '0') }));
const db = { from() { let after = null; return { select() { return this; }, limit() { return this; }, order() { return this; }, gt(_, key) { after = key; return this; }, then(resolve) { calls++; resolve({ data: records.filter(r => after == null || r.id > after).slice(0, 250), error: null }); } }; } };
const result = await readPart(db, { upload: async () => {} }, 'folder', { tableIndex: 0, lastKey: null, offset: 0, partIndex: 0 });
assert.equal(calls, 1);
assert.equal(result.exhausted, true);
assert.equal(result.rows, 250);
console.log('F4: real backup reader marks 1,001-row table exhausted after 250 rows with a simulated lower API cap.');

assert.equal(isDay('2026-02-31'), true);
assert.deepEqual(periodFrom('2026-02-31', '2026-03-03', { start: '2026-09-01', end: '2026-09-15' }), { start: '2026-02-31', end: '2026-03-03' });
console.log('F5: date validation accepts and forwards nonexistent 2026-02-31.');

// Positive controls: preserve common billing half-cent rounding and 5% GST.
assert.equal(lineTotal(1.5, 60.05), 90.08);
assert.equal(gstOn(0.70, 5), 0.04);
for (let cents = 1; cents <= 500000; cents++) {
  const expected = Number((BigInt(cents) * 5n + 50n) / 100n);
  assert.equal(Math.round(gstOn(cents / 100, 5) * 100), expected);
}
console.log('Positive controls: standard line rounding and all 500,000 cent subtotals through $5,000 at 5% pass.');
