// Audit probe: reports mismatches without changing application code.
// Run: node docs/reviews/round3-decimal-parity.mjs
import { lineTotal, storedNumber } from '../../vite-app/src/data.js';
import { readFileSync } from 'node:fs';
// Optional: node docs/reviews/round3-decimal-parity.mjs export.json
// Export query 3 as a JSON array. SQL emits decimal strings to preserve digits.
const oldLineTotal = (q, r) => Math.round(Math.round(Number(q) * 1000) * Math.round(Number(r) * 100) / 1000) / 100;
export const lines = [
  ['ordinary half cent', '1.5', '60.05', '90.08'],
  ['legacy quantity', '1.2345', '100', '123.45'],
  ['legacy rate', '100', '1.234', '123.40'],
  ['small quantity', '0.0004', '100', '0.04'],
  ['round product only', '2', '1.005', '2.01'],
  ['exponent notation', '1e-7', '100000', '0.01'],
  ['zero', '0', '60.05', '0.00'],
];
export const stored = [
  ['1.005', 2, '1.01'], ['2.675', 2, '2.68'], ['1.15', 1, '1.2'],
  ['2.25', 2, '2.25'],
];
if (process.argv[2]) {
  const rows = JSON.parse(readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(rows)) throw new Error('Expected a JSON array from query 3.');
  let oldMismatches = 0, textMismatches = 0, numberMismatches = 0, conversionSensitiveRows = 0;
  for (const row of rows) {
    for (const key of ['quantity', 'unit_rate', 'stored']) {
      if (typeof row[key] !== 'string' || !/^\d+(?:\.\d+)?$/.test(row[key])) {
        throw new Error(`${key} must be a nonnegative decimal string; use the updated SQL export.`);
      }
    }
    const [whole, fraction = ''] = row.stored.split('.');
    if (fraction.length > 2) throw new Error('stored must be rounded to cents by PostgreSQL.');
    const expected = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    const old = oldLineTotal(row.quantity, row.unit_rate);
    // Separate exact SQL-text inputs from the number-input path. The export
    // alone cannot establish the live API response type or later coercions.
    const fromNumber = lineTotal(Number(row.quantity), Number(row.unit_rate));
    const fromText = lineTotal(row.quantity, row.unit_rate);
    const matches = value => {
      const cents = Math.round(value * 100);
      if (!Number.isSafeInteger(cents)) throw new Error('Result exceeds safe integer cents; manual review required.');
      return BigInt(cents) === expected;
    };
    const oldMatches = matches(old), textMatches = matches(fromText), numberMatches = matches(fromNumber);
    const conversionSensitive = fromText !== fromNumber;
    oldMismatches += Number(!oldMatches);
    textMismatches += Number(!textMatches);
    numberMismatches += Number(!numberMatches);
    conversionSensitiveRows += Number(conversionSensitive);
    console.log(JSON.stringify({ ...row, old, fromText, fromNumber, oldMatches, textMatches, numberMatches, conversionSensitive }));
  }
  console.log(JSON.stringify({ replayed: rows.length, oldMismatches, textMismatches, numberMismatches, conversionSensitiveRows,
    scope: 'Supplied current rows only; does not prove historical invoice amounts, export completeness, or live API input types. Conversion-sensitive rows need a transport/coercion audit.' }));
  // Either input path failing needs review; do not silently accept conversion loss.
  if (textMismatches || numberMismatches) process.exitCode = 1;
} else {
for (const [label, q, r, expected] of lines) {
  const actual = lineTotal(Number(q), Number(r));
  console.log(JSON.stringify({ label, q, r, expected, actual, matches: actual === Number(expected) }));
}
for (const [value, decimals, expected] of stored) {
  const actual = storedNumber(Number(value), decimals);
  console.log(JSON.stringify({ value, decimals, expected, actual, matches: actual === Number(expected) }));
}
}
