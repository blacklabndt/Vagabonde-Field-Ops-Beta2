import test from "node:test";
import assert from "node:assert/strict";
import * as context from "../../supabase/functions/_shared/askContext.ts";

test("read context retains references and filters without amounts or contact data", () => {
  assert.equal(typeof context.readContext, "function");
  const entry = context.readContext("search_tickets", { date_from: "2026-08-01", q: "Acme" }, [{ id: "T-1", job_number: "J-1", total: 90, total_count: 2, email: "private" }]);
  assert.equal(entry.coverage, "partial");
  assert.deepEqual(entry.references, [{ id: "T-1", job_number: "J-1" }]);
  assert.equal(entry.filters.date_from, "2026-08-01");
  assert.doesNotMatch(JSON.stringify(entry), /private|90/);
});

test("coverage never treats a later empty page or capped list as complete", () => {
  assert.equal(context.readContext("search_tickets", { page: 1 }, []).coverage, "partial");
  assert.equal(context.readContext("search_tickets", {}, []).coverage, "complete");
  assert.equal(context.readContext("list_tickets", {}, Array.from({ length: 50 }, () => ({ id: "x" }))).coverage, "partial");
  assert.equal(context.readContext("find_job", {}, []).coverage, "unknown");
  assert.equal(context.readContext("draft_job", {}, {}), null);
});

test("historical context is bounded, scrubbed, permission filtered, and explicitly untrusted", () => {
  const entry = { tool: "search_tickets", filters: { q: "x".repeat(999), secret: "DROP" }, references: [{ id: "T-1", total: 10 }], coverage: "complete" };
  const thread = [{ role: "assistant", followUp: Array(100).fill(entry) }];
  assert.equal(context.followUpLines(thread, []).length, 0);
  const lines = context.followUpLines(thread, ["search_tickets"]);
  assert.match(lines, /untrusted historical/);
  assert.match(lines, /fresh authorized reads/);
  assert.doesNotMatch(lines, /DROP|"total"/);
  assert.ok(lines.length < 6500);
});
