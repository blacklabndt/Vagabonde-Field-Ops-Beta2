import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { periodFrom, periodWords, payPeriodFor, todayIn, sumHours } from "../../supabase/functions/_shared/hoursDose.ts";

const read = name => readFileSync(new URL(`../../supabase/functions/${name}`, import.meta.url), "utf8");

// A paged external data source: honor the reader's key and requested limit,
// with a configurable server cap. Assertions below cover production results.
function cappedDb(records, cap, maxCalls = 30) {
  let calls = 0;
  return {
    get calls() { return calls; },
    from() {
      let after = null;
      let limit = Infinity;
      return {
        select() { return this; }, eq() { return this; }, gte() { return this; }, lte() { return this; },
        order(column) { assert.equal(column, "id"); return this; },
        limit(n) { limit = n; return this; },
        gt(column, key) { assert.equal(column, "id"); after = key; return this; },
        // biome-ignore lint/suspicious/noThenProperty: models the awaited PostgREST query builder.
        then(resolve) {
          calls++;
          assert.ok(calls <= maxCalls, "reader must advance rather than loop forever");
          resolve({ data: records.filter(r => after == null || r.id > after).slice(0, Math.min(limit, cap)), error: null });
        }
      };
    }
  };
}

const ask = read("ask/index.ts");
const hoursBody = ask.split('} else if (name === "my_hours") {')[1].split('} else if (name === "my_dose") {')[0];

// The branch is lifted out of the function, so anything it reads from module
// scope has to be handed in — and handed in from the SOURCE, never typed
// here. A constant this file spelled for itself would keep passing after
// production changed the number, which is the one thing a budget test must
// not do. (It arrived that way: the first version of this harness did not
// know HOURS_MAX_ROWS existed at all, and the branch threw a ReferenceError.)
const constOf = name => {
  const m = new RegExp(`^const ${name} = (\\d+);`, "m").exec(ask);
  assert.ok(m, `${name} must be a plain number at the top level of ask/index.ts`);
  return Number(m[1]);
};
const HOURS_PAGE_ROWS = constOf("HOURS_PAGE_ROWS");
const HOURS_MAX_ROWS = constOf("HOURS_MAX_ROWS");
const HOURS_MAX_REQUESTS = constOf("HOURS_MAX_REQUESTS");

const hoursRunner = new Function("asUser", "whose", "periodFrom", "payPeriodFor", "todayIn", "sumHours", "periodWords",
  "HOURS_PAGE_ROWS", "HOURS_MAX_ROWS", "HOURS_MAX_REQUESTS",
  `return (${stripTypeScriptTypes(`async function run(input) { let out: unknown; ${hoursBody} return out; }`)});`);

// Every hours test drives the branch the same way; only the rows and the
// server's behaviour change.
const runHours = (records, cap, maxCalls) => {
  const db = cappedDb(records, cap, maxCalls);
  const run = hoursRunner(db, async () => ({ id: "person", name: "Worker" }), periodFrom, payPeriodFor, todayIn,
    sumHours, periodWords, HOURS_PAGE_ROWS, HOURS_MAX_ROWS, HOURS_MAX_REQUESTS);
  return run({}).then(result => ({ result, calls: db.calls }));
};

const crewRows = (count, workDate = "2026-09-11") => Array.from({ length: count }, (_, i) => ({
  id: String(i).padStart(6, "0"), straight_hours: 1, ot_hours: 0, solo_hours: 0, solo_ot_hours: 0, mileage_km: 2,
  tickets: { work_date: workDate, jobs: { job_number: "TEST" } }
}));

for (const cap of [250, 1000]) {
  test(`Ask hours includes all 1,001 rows with an API cap of ${cap}`, async () => {
    const { result } = await runHours(crewRows(1001), cap);
    assert.equal(result.total.straight, 1001);
    assert.equal(result.total.mileage_km, 2002);
    assert.equal(result.total.days, 1);
  });
}

// ── The two budgets ──────────────────────────────────────────────────────
// The walk is bounded twice over, and each bound exists because the other
// one leaves a way to run for ever. What matters as much as stopping is
// that a stopped walk SAYS SO: the rows come back in id order, which is a
// uuid and therefore not the order the days fall in, so a partial answer is
// an arbitrary slice of the period and never its first weeks. Handing that
// back unlabelled is handing somebody a figure they check their pay against.

test("a complete read shorter than the budgets is not called partial", async () => {
  const { result } = await runHours(crewRows(500), 250);
  assert.equal(result.partial, false);
  assert.equal(result.rows_read, 500);
  assert.equal(result.total.straight, 500);
  assert.doesNotMatch(result.note, /PARTIAL/);
});

test("a server cap that does not divide the budget stops ON it, never past it", async () => {
  // The regression: the ceiling was checked AFTER the page was pushed, so a
  // server answering 300 at a time read 25,200 rows where the budget said
  // 25,000. The request now asks for no more than what is left.
  const cap = 700; // does not divide HOURS_MAX_ROWS
  const { result, calls } = await runHours(crewRows(HOURS_MAX_ROWS + 100), cap, HOURS_MAX_REQUESTS);
  assert.equal(result.rows_read, HOURS_MAX_ROWS, "not one row past the budget");
  assert.equal(result.partial, true);
  assert.match(result.note, /PARTIAL/);
  assert.ok(calls <= HOURS_MAX_REQUESTS, `stopped within the request budget (${calls})`);
});

test("a server handing back one row at a time stops on the request budget, not on rows", async () => {
  // Rows alone are not a budget: a gateway capping pages at one turns
  // 25,000 rows into 25,000 sequential requests, and the invocation dies
  // before it can say the answer was partial — which is the whole reason
  // for stopping.
  const { result, calls } = await runHours(crewRows(HOURS_MAX_ROWS), 1, HOURS_MAX_REQUESTS);
  assert.equal(calls, HOURS_MAX_REQUESTS);
  assert.equal(result.rows_read, HOURS_MAX_REQUESTS);
  assert.equal(result.partial, true);
  assert.match(result.note, /PARTIAL/);
});

test("exactly the row budget is reported partial, which is the safe way to be wrong", async () => {
  // A person with exactly HOURS_MAX_ROWS rows has been read completely, and
  // is told the answer may be short anyway. Proving otherwise costs another
  // round trip to watch an empty page come back; over-warning is cheaper
  // than a total that quietly is not one.
  const { result } = await runHours(crewRows(HOURS_MAX_ROWS), HOURS_PAGE_ROWS, HOURS_MAX_REQUESTS);
  assert.equal(result.rows_read, HOURS_MAX_ROWS);
  assert.equal(result.partial, true);
});

test("the partial note names the period and says the slice is not chronological", async () => {
  const { result } = await runHours(crewRows(HOURS_MAX_ROWS + 1), HOURS_PAGE_ROWS, HOURS_MAX_REQUESTS);
  assert.match(result.note, /NOT a total/);
  assert.match(result.note, /id order/);
  assert.match(result.note, /shorter period/);
  assert.ok(result.note.includes(result.period), "the note quotes the period it is short of");
});

const backup = read("backup-run/index.ts");
const start = backup.indexOf("async function stepTables(");
const end = backup.indexOf("\n}", start) + 2;
const makeBackup = new Function("LOAD_ORDER", "CURSOR_COLUMN", "TABLE_KEYS", "MAX_PART_ROWS", "PAGE_ROWS", "addAuthEmails", "foldIntoIndex", "partFileName", "gzip", "stripSecrets", "withRetry", "afterTablePart",
  `return (${stripTypeScriptTypes(backup.slice(start, end))});`);

test("a reduced server cap still respects the backup part's row budget", async () => {
  const records = Array.from({ length: 1500 }, (_, i) => ({ id: String(i).padStart(6, "0") }));
  const db = cappedDb(records, 300);
  const readPart = makeBackup(["tickets"], { tickets: "id" }, {}, 1000, 1000,
    async () => {}, c => c, () => "part", async bytes => bytes, (_, rows) => rows,
    async (_, fn) => fn(), (_, result) => result);
  const result = await readPart(db, { upload: async () => {} }, "folder", { tableIndex: 0, lastKey: null, offset: 0, partIndex: 0 });
  assert.equal(result.rows, 1000);
  assert.equal(result.offset, 1000);
  assert.equal(result.lastKey, "000999");
  assert.equal(result.exhausted, false);
});

for (const cap of [250, 1000]) {
  for (const count of [0, 1000, 1001]) {
    test(`backup reads ${count} rows completely with an API cap of ${cap}`, async () => {
      const records = Array.from({ length: count }, (_, i) => ({ id: String(i).padStart(6, "0") }));
      const db = cappedDb(records, cap);
      const readPart = makeBackup(["tickets"], { tickets: "id" }, {}, 25000, 1000,
        async () => {}, c => c, () => "part", async bytes => bytes, (_, rows) => rows,
        async (_, fn) => fn(), (_, result) => result);
      let written;
      const result = await readPart(db, { upload: async (_folder, _name, bytes) => { written = JSON.parse(new TextDecoder().decode(bytes)); } }, "folder",
        { tableIndex: 0, lastKey: null, offset: 0, partIndex: 0 });
      assert.deepEqual(written, records);
      assert.equal(result.rows, count);
      assert.equal(result.exhausted, true);
    });
  }
}
