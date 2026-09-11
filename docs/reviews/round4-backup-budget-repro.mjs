import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const source = readFileSync(new URL('../../supabase/functions/backup-run/index.ts', import.meta.url), 'utf8');
const constants = readFileSync(new URL('../../supabase/functions/_shared/backupTables.ts', import.meta.url), 'utf8');
const constant = name => Number(new RegExp(`export const ${name} = (\\d+)`).exec(constants)[1]);
const start = source.indexOf('async function stepTables(');
const end = source.indexOf('\n}', start) + 2;
const make = new Function('LOAD_ORDER', 'CURSOR_COLUMN', 'TABLE_KEYS', 'MAX_PART_ROWS', 'PAGE_ROWS', 'addAuthEmails', 'foldIntoIndex', 'partFileName', 'gzip', 'stripSecrets', 'withRetry', 'afterTablePart',
  `return (${stripTypeScriptTypes(source.slice(start, end))});`);
for (const cap of [1000, 250, 1]) {
  let calls = 0;
  let uploadedAfter = null;
  const db = { from() {
    let after = -1, limit;
    return {
      select() { return this; }, order() { return this; },
      limit(n) { limit = n; return this; },
      gt(_column, key) { after = Number(key); return this; },
      then(resolve) {
        calls++;
        resolve({ data: Array.from({ length: Math.min(cap, limit) }, (_, i) => ({ id: String(after + i + 1).padStart(6, '0') })), error: null });
      }
    };
  } };
  const readPart = make(['tickets'], { tickets: 'id' }, {}, constant('MAX_PART_ROWS'), constant('PAGE_ROWS'),
    async () => {}, c => c, () => 'part', async b => b, (_, rows) => rows,
    async (_, fn) => fn(), (_, result) => result);
  const result = await readPart(db, { upload: async () => { uploadedAfter = calls; } }, 'folder',
    { tableIndex: 0, lastKey: null, offset: 0, partIndex: 0 });
  assert.equal(result.rows, constant('MAX_PART_ROWS'));
  assert.equal(calls, Math.ceil(constant('MAX_PART_ROWS') / cap));
  assert.equal(uploadedAfter, calls);
  assert.equal(result.exhausted, false);
  console.log(JSON.stringify({ cap, callsBeforeUploadOrReturn: calls, rows: result.rows, estimatedSecondsAt100msPerRequest: calls / 10 }));
}
