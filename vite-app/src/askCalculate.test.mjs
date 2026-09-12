import test from "node:test";
import assert from "node:assert/strict";
import { createCalculationStore } from "../../supabase/functions/_shared/askCalculate.ts";

const setup = (rows = [{ amount: 10 }, { amount: 20 }], complete = true) => {
  const store = createCalculationStore();
  store.capture({ id: "current", rows, complete, period: "September", units: { amount: "CAD" } });
  return store;
};
const args = { operation: "sum", source_id: "current", field: "amount" };

test("calculates captured rows with provenance and metadata", () => {
  const store = setup();
  assert.equal(store.calculate(args).value, 30);
  assert.equal(store.calculate({ ...args, operation: "average" }).value, 15);
  assert.deepEqual(store.calculate(args).sources, [{ source_id: "current", count: 2, complete: true, period: "September" }]);
  assert.equal(store.calculate(args).unit, "CAD");
});
test("compares captured totals against a baseline", () => {
  const store = setup();
  store.capture({ id: "previous", rows: [{ amount: 20 }], complete: true, units: { amount: "CAD" } });
  assert.equal(store.calculate({ ...args, operation: "difference", compare_source_id: "previous" }).value, 10);
  assert.equal(store.calculate({ ...args, operation: "percent_change", compare_source_id: "previous" }).value, 50);
});
test("rejects missing, restricted, non-numeric, unsafe and partial results", () => {
  for (const rows of [[{}], [{ amount: null }], [{ amount: "10" }], [{ amount: Infinity }], [{ amount: Number.MAX_VALUE }], []]) {
    assert.ok(setup(rows).calculate(args).error);
  }
  assert.ok(setup(undefined, false).calculate(args).error);
  assert.ok(setup().calculate({ ...args, source_id: "invented" }).error);
  assert.ok(setup().calculate({ ...args, values: [999] }).error);
  assert.ok(setup().calculate({ ...args, field: "constructor" }).error);
});
test("rejects zero baseline and mismatched units", () => {
  const store = setup();
  store.capture({ id: "zero", rows: [{ amount: 0 }], complete: true, units: { amount: "CAD" } });
  assert.ok(store.calculate({ ...args, operation: "percent_change", compare_source_id: "zero" }).error);
  store.capture({ id: "other", rows: [{ amount: 5 }], complete: true, units: { amount: "hours" } });
  assert.ok(store.calculate({ ...args, operation: "difference", compare_source_id: "other" }).error);
});
test("snapshot is immutable and source ids cannot be replaced", () => {
  const store = createCalculationStore();
  const rows = [{ amount: 10 }];
  assert.equal(store.capture({ id: "current", rows, complete: true }), true);
  rows[0].amount = 999;
  assert.equal(store.calculate(args).value, 10);
  assert.equal(store.capture({ id: "current", rows, complete: true }), false);
});

test("rejects duplicate record identifiers and overflowing sums", () => {
  const store = createCalculationStore();
  assert.equal(store.capture({ id: "duplicates", rows: [{ id: "a", amount: 10 }, { id: "a", amount: 10 }], complete: true }), false);
  assert.ok(setup([{ amount: Number.MAX_SAFE_INTEGER }, { amount: 1 }]).calculate(args).error);
});
