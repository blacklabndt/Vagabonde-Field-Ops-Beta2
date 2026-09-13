import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fetchAllKeyset } from "./paging.js";

// db.js's own archive reader, lifted out and run against a server that caps
// its answers — not a stub of the method. archive.test.mjs fakes these three
// methods wholesale, so nothing there can see a truncation: the cap is the
// bug being guarded, and only the real walk can meet it.
const source = readFileSync(new URL("./db.js", import.meta.url), "utf8");
const region = source.slice(
  source.indexOf("const archiveJobRows ="),
  source.indexOf("\n});", source.indexOf("const newestFirst =")) + 4
);
assert.match(region, /fetchAllKeyset/, "the archive reader must still walk by key");

const build = ({ sbClient, cap }) =>
  new Function("sbClient", "fetchAllKeyset", "RESPONSE_ROW_CAP",
    region + "\nreturn { archiveJobRows, newestFirst };"
  )(sbClient, fetchAllKeyset, cap);

// A PostgREST that silently answers at most `cap` rows, honours .gt("id"),
// and can be told to fail one particular page.
function cappedServer(rows, { failAtCall = 0 } = {}) {
  let calls = 0;
  return {
    get calls() { return calls; },
    from(table) {
      let after = null, limit = Infinity, job = null;
      const q = {
        select() { return this; },
        eq(col, v) { assert.equal(col, "job_id"); job = v; return this; },
        gt(col, key) { assert.equal(col, "id"); after = key; return this; },
        order(col) { assert.equal(col, "id"); return this; },
        async limit(n) {
          limit = n; calls++;
          assert.ok(calls < 40, "the walk must advance rather than loop");
          if (calls === failAtCall) return { data: null, error: new Error(`${table} page ${calls} refused`) };
          const mine = rows.filter(r => r.job_id === job && (after == null || r.id > after))
            .sort((a, b) => (a.id < b.id ? -1 : 1));
          return { data: mine.slice(0, Math.min(limit, CAP)), error: null };
        }
      };
      return q;
    }
  };
}
const CAP = 3;
const rowsFor = (job, n, from = 1) =>
  Array.from({ length: n }, (_, i) => ({ id: from + i, job_id: job, created_at: `2026-09-${String(30 - ((from + i) % 28)).padStart(2, "0")}T00:00:00Z` }));

test("a job with more rows than the server will answer at once comes back whole", async () => {
  const rows = [...rowsFor("J1", 7), ...rowsFor("J2", 4, 100)];
  const sb = cappedServer(rows);
  const { archiveJobRows } = build({ sbClient: sb, cap: CAP });
  const got = await archiveJobRows("tickets_read", "*", "J1");
  // Unpaged, this answered 3 of 7 — and the drift check compared 3 against 3
  // and let the clear delete all 7.
  assert.equal(got.length, 7);
  assert.deepEqual(got.map(r => r.id), [1, 2, 3, 4, 5, 6, 7]);
});

test("the walk reads only this job's rows", async () => {
  const sb = cappedServer([...rowsFor("J1", 5), ...rowsFor("J2", 9, 100)]);
  const { archiveJobRows } = build({ sbClient: sb, cap: CAP });
  assert.deepEqual((await archiveJobRows("jhas", "*", "J2")).map(r => r.id), [100, 101, 102, 103, 104, 105, 106, 107, 108]);
});

test("a page that fails throws — it is never a short list", async () => {
  const sb = cappedServer(rowsFor("J1", 9), { failAtCall: 2 });
  const { archiveJobRows } = build({ sbClient: sb, cap: CAP });
  // The second page is the dangerous one: a swallowed failure there returns
  // the first three rows, which reads as a complete short answer, and the
  // clear proceeds on it. archive.js turns this rejection into a `missing`
  // entry, which blocks the clear.
  await assert.rejects(archiveJobRows("reports", "*", "J1"), /page 2 refused/);
});

test("the first page failing throws too", async () => {
  const sb = cappedServer(rowsFor("J1", 9), { failAtCall: 1 });
  const { archiveJobRows } = build({ sbClient: sb, cap: CAP });
  await assert.rejects(archiveJobRows("reports", "*", "J1"), /page 1 refused/);
});

test("newestFirst restores the screens' order and breaks ties by id", async () => {
  const { newestFirst } = build({ sbClient: cappedServer([]), cap: CAP });
  const rows = [
    { id: 1, at: "2026-09-01T00:00:00Z" },
    { id: 2, at: "2026-09-03T00:00:00Z" },
    { id: 3, at: "2026-09-03T00:00:00Z" },
    { id: 4, at: "" }
  ];
  // Tied timestamps order by id descending, and a row with no timestamp
  // sorts last — deterministic in both cases, which an unpaged heap-order
  // read never was.
  assert.deepEqual(newestFirst(rows, "at").map(r => r.id), [3, 2, 1, 4]);
  assert.deepEqual(newestFirst(rows, "at"), newestFirst(rows.slice().reverse(), "at"));
});
