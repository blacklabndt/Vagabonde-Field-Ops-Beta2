import test from "node:test";
import assert from "node:assert/strict";
import * as investigation from "../../supabase/functions/_shared/askInvestigation.ts";
import { searchArgs } from "../../supabase/functions/_shared/askTools.ts";

test("investigation normalization preserves the authorized runner's search arguments", async () => {
  for (const input of [{}, { status: "Bogus", date_to: "yesterday", page: -2 }, { status: "Approved", q: " Pembina ", date_from: "2026-08-01", date_to: "2026-08-31", page: 2, page_size: 500 }]) {
    const run = investigation.createInvestigation(async (_name, normalized) => {
      assert.deepEqual(searchArgs(normalized), searchArgs(input));
      return [];
    });
    await run.runTool("search_tickets", input);
  }
});

test("partial search pages preserve server aggregates without allowing row totals", async () => {
  for (const filtered_total of [90, null]) {
    const rows = [{ id: "T-1", total: filtered_total === null ? null : 30, total_count: 3, filtered_total }];
    const run = investigation.createInvestigation(async () => rows);
    const read = await run.runTool("search_tickets", {});
    assert.deepEqual(read.records, rows);
    assert.equal(read.calculation.coverage, "partial");
    assert.ok((await run.runTool("calculate", { source_id: read.calculation.source_id, field: "total", operation: "sum" })).error);
  }
});

test("successful authorized reads become calculation sources and follow-up references", async () => {
  assert.equal(typeof investigation.createInvestigation, "function");
  const run = investigation.createInvestigation(async () => [{ id: "T-1", total: 30, total_count: 1 }]);
  const read = await run.runTool("search_tickets", { date_from: "2026-08-01", date_to: "2026-08-31" });
  assert.equal(read.calculation.source_id, "read-1");
  const calc = await run.runTool("calculate", { source_id: "read-1", field: "total", operation: "sum" });
  assert.equal(calc.value, 30);
  assert.equal(run.followUp()[0].filters.date_to, "2026-08-31");
});

test("failed reads never enter context and sources cannot cross requests", async () => {
  const run = investigation.createInvestigation(async () => { throw new Error("denied"); });
  await assert.rejects(run.runTool("search_tickets", {}), /denied/);
  assert.deepEqual(run.followUp(), []);
  const calc = await run.runTool("calculate", { source_id: "read-1", field: "total", operation: "sum" });
  assert.ok(calc.error);
});

test("partial pages and restricted money cannot produce a total", async () => {
  for (const row of [{ id: "T-1", total: 30, total_count: 2 }, { id: "T-1", total: null, total_count: 1 }]) {
    const run = investigation.createInvestigation(async () => [row]);
    const read = await run.runTool("search_tickets", {});
    const calc = await run.runTool("calculate", { source_id: read.calculation.source_id, field: "total", operation: "sum" });
    assert.ok(calc.error);
  }
});

test("calculation periods describe sanitized query filters rather than invalid model dates", async () => {
  const run = investigation.createInvestigation(async () => [{ id: "T-1", total: 10, total_count: 1 }]);
  const read = await run.runTool("search_tickets", { date_from: "yesterday", status: "bogus", page: -1 });
  assert.match(read.calculation.period, /unbounded start/);
  assert.equal(run.followUp()[0].filters.status, "All");
  assert.equal(run.followUp()[0].coverage, "complete");
});

test("tools outside the caller's offered list never execute or populate sources", async () => {
  let reads = 0;
  const run = investigation.createInvestigation(async () => { reads++; return []; }, ["calculate"]);
  assert.ok((await run.runTool("search_tickets", {})).error);
  assert.equal(reads, 0);
  assert.deepEqual(run.followUp(), []);
});
