import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./db.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");

function harness(total) {
  const calls = [];
  const row = { id: "QA-TICKET", job_id: "QA-JOB", work_date: "2026-09-12", status: "Draft", total,
    technician_id: "QA-TECH", profiles: { name: "QA" }, ticket_lines: [], created_at: "2026-09-12" };
  const sbClient = { from(table) {
    const call = { table, columns: "" };
    calls.push(call);
    const result = single => ({ data: single ? row : [row], error: table === "tickets" && /\btotal\b/.test(call.columns)
      ? new Error("permission denied for total") : null });
    return {
      select(columns) { call.columns = columns; return this; }, eq() { return this; }, in() { return this; },
      order() { return this; }, single: async () => result(true), maybeSingle: async () => result(true),
      // biome-ignore lint/suspicious/noThenProperty: models the awaited PostgREST builder.
      then(resolve) { resolve(result(false)); }
    };
  } };
  const Db = new Function("sbClient", "OfflineCache", "localDate", "dayMonth", "ageInDays", "isNetworkError", "Toasts", `${source}; return Db;`)(
    sbClient, { readThrough: (_key, read) => read() }, x => x, x => x, () => 0, () => false, { show() {} });
  return { Db, calls };
}

test("Helper job tickets keep metadata and null money when base total SELECT is denied", async () => {
  const { Db, calls } = harness(null);
  const rows = await Db.listTicketsForJob("QA-JOB");
  assert.equal(rows[0].id, "QA-TICKET");
  assert.equal(rows[0].amount, null);
  assert.equal(calls[0].table, "tickets_read");
});

test("priced ticket and archive readers retain money after direct total SELECT is revoked", async () => {
  const { Db, calls } = harness("123.45");
  assert.equal((await Db.getTicket("QA-TICKET")).total, "123.45");
  assert.equal((await Db.listTicketsForArchive(["QA-TICKET"])).get("QA-TICKET").total, 123.45);
  assert.ok(calls.every(call => call.table === "tickets_read"));
});

test("idempotent ticket retry reads the existing amount through the masked relation", async () => {
  const { Db, calls } = harness("123.45");
  Db.nextTicketNumber = async () => "QA-NEXT";
  Db.assertJobOpen = async () => {};
  const result = await Db.createTicket({ initials: "QA", jobDbId: "QA-JOB", lines: [], clientKey: "QA-KEY" });
  assert.equal(result.existing, true);
  assert.equal(result.id, "QA-TICKET");
  assert.equal(calls[0].table, "tickets_read");
});
