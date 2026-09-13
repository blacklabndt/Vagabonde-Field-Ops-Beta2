import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fetchAllKeyset } from "./paging.js";

// db.js's own rate-card reader, lifted out and run against a server that
// silently caps its answers — not a stub of the method. The cap is the bug
// being guarded, and a hand-written fake of allRateLines could not meet it.
const source = readFileSync(new URL("./db.js", import.meta.url), "utf8");
const region = source.slice(
  source.indexOf("const allRateLines ="),
  source.indexOf("\n});", source.indexOf("const byCardOrder =")) + 4
);
assert.match(region, /fetchAllKeyset/, "the rate-card reader must still walk by key");

const build = ({ sbClient, cap }) =>
  new Function("sbClient", "fetchAllKeyset", "RESPONSE_ROW_CAP",
    region + "\nreturn { allRateLines, byCardOrder };"
  )(sbClient, fetchAllKeyset, cap);

const CAP = 3;

// A PostgREST that answers at most CAP rows however many were asked for,
// honours .gt("id"), and can be told to refuse one particular page.
function cappedServer(rows, { failAtCall = 0 } = {}) {
  let calls = 0;
  return {
    get calls() { return calls; },
    from(table) {
      assert.equal(table, "rate_lines");
      let after = null, schedule = null;
      return {
        select() { return this; },
        eq(col, v) { assert.equal(col, "schedule_id"); schedule = v; return this; },
        gt(col, key) { assert.equal(col, "id"); after = key; return this; },
        order(col) { assert.equal(col, "id"); return this; },
        async limit(n) {
          calls++;
          assert.ok(calls < 40, "the walk must advance rather than loop");
          if (calls === failAtCall) return { data: null, error: new Error(`page ${calls} refused`) };
          const mine = rows.filter(r => r.schedule_id === schedule && (after == null || r.id > after))
            .sort((a, b) => a.id - b.id);
          return { data: mine.slice(0, Math.min(n, CAP)), error: null };
        }
      };
    }
  };
}

const card = (schedule, n, from = 1) => Array.from({ length: n }, (_, i) => ({
  id: from + i, schedule_id: schedule, kind: "rt_film",
  label: `L${String(from + i).padStart(3, "0")}`, rate: 1, position: from + i
}));

test("a card with more lines than the server will answer at once comes back whole", async () => {
  const rows = [...card("S1", 7), ...card("S2", 4, 100)];
  const { allRateLines } = build({ sbClient: cappedServer(rows), cap: CAP });
  // Unpaged, this answered 3 of 7: four items missing from the ticket
  // dropdowns, and in copyDefaultInto four lines inserted a second time.
  const got = await allRateLines("S1");
  assert.equal(got.length, 7);
  assert.deepEqual(got.map(r => r.id), [1, 2, 3, 4, 5, 6, 7]);
});

test("a card whose other schedule is larger is not mixed into it", async () => {
  const rows = [...card("S1", 2), ...card("S2", 9, 100)];
  const { allRateLines } = build({ sbClient: cappedServer(rows), cap: CAP });
  assert.deepEqual((await allRateLines("S2")).map(r => r.id).length, 9);
  assert.deepEqual((await allRateLines("S1")).map(r => r.id), [1, 2]);
});

test("a page that refuses is the read's failure, never a short card", async () => {
  const rows = card("S1", 7);
  const { allRateLines } = build({ sbClient: cappedServer(rows, { failAtCall: 2 }), cap: CAP });
  await assert.rejects(() => allRateLines("S1"), /page 2 refused/);
});

test("byCardOrder answers what the database's ORDER BY did", () => {
  const { byCardOrder } = build({ sbClient: cappedServer([]), cap: CAP });
  const rows = [
    { id: 5, position: null, label: "zeta" },
    { id: 1, position: 2, label: "b" },
    { id: 2, position: null, label: "alpha" },
    { id: 3, position: 1, label: "c" },
    { id: 4, position: 2, label: "a" }
  ];
  // position ascending, nulls last, label breaking the tie.
  assert.deepEqual(byCardOrder(rows).map(r => r.id), [3, 4, 1, 2, 5]);
});

test("byCardOrder is stable for a full tie and does not touch its input", () => {
  const { byCardOrder } = build({ sbClient: cappedServer([]), cap: CAP });
  const rows = [{ id: 9, position: 1, label: "a" }, { id: 2, position: 1, label: "a" }];
  assert.deepEqual(byCardOrder(rows).map(r => r.id), [2, 9]);
  assert.deepEqual(byCardOrder(rows.slice().reverse()).map(r => r.id), [2, 9]);
  assert.deepEqual(rows.map(r => r.id), [9, 2]);
});
