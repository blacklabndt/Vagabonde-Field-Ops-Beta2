import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fetchAllPages } from "./paging.js";
import { localDate, dayMonth, ageInDays } from "./data.js";

const source = readFileSync(new URL("./db.js", import.meta.url), "utf8");
function method(name) {
  const start = source.indexOf(`  async ${name}(`);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/^  (?:async )?\w+\(/m) + 1;
  return rest.slice(0, end);
}
const row = {
  id: "KK-0913-26-01", total: "125.00", gst_rate: 5, status: "Draft",
  work_date: "2026-09-13", created_at: "2026-09-13T12:00:00Z",
  jobs: { job_number: "S-12105", project: "Site", clients: { name: "Client" } },
  ticket_lines: [{ kind: "Labour", quantity: 1, unit_rate: 125 }],
};
function load(name, { collision = false } = {}) {
  let lookups = 0;
  const client = { from(table) {
    let columns = "", single = false, insert = false;
    const query = {
      select(value) { columns = value; return this; },
      eq() { return this; }, in() { return this; }, order() { return this; }, range() { return this; },
      single() { single = true; return this; }, maybeSingle() { single = true; return this; },
      insert() { insert = true; return this; },
      // biome-ignore lint/suspicious/noThenProperty: Supabase query builders are intentionally awaitable.
      then(resolve, reject) {
        let result;
        if (insert) result = { error: { code: "23505", message: "client_key already exists" } };
        else if (table === "tickets" && /\btotal\b/.test(columns)) result = { error: { code: "42501", message: "permission denied for table tickets" } };
        else if (collision && columns === "id, total" && lookups++ === 0) result = { data: null };
        else result = { data: single ? row : [row], count: 1 };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return query;
  } };
  const dependencies = {
    sbClient: client, fetchAllPages, localDate, dayMonth, ageInDays,
    rememberTicketPart() {}, cleanLine: line => line, totalOf: () => 125, assertBillable() {},
    assertJobRowOpen() {}, ticketStatusWriteRefusal: () => "Already approved", plainError: message => new Error(message),
  };
  const helpers = source.slice(source.indexOf("function startKeyLookup("), source.indexOf("// Thin data-access"));
  const archive = source.slice(source.indexOf("const ARCHIVE_TICKET_COLUMNS"), source.indexOf("// One ticket's crew"));
  const db = new Function(...Object.keys(dependencies), `${helpers}\n${archive}\nreturn {${method(name)}};`)(...Object.values(dependencies));
  db.nextTicketNumber = async () => "unused-number";
  db.assertJobOpen = async () => {};
  return db;
}

test("archive loads totals and embedded ticket lines under column grants", async () => {
  const result = await load("listTicketsForArchive").listTicketsForArchive([row.id]);
  assert.equal(result.get(row.id).total, 125);
  assert.equal(result.get(row.id).gstRate, 5);
  assert.deepEqual(result.get(row.id).lines, row.ticket_lines);
});
test("draft list loads the ticket and embedded client under column grants", async () => {
  const result = await load("listMyTickets").listMyTickets("technician");
  assert.equal(result[0].amount, 125);
  assert.equal(result[0].client, "Client");
});
test("reopening a draft loads its tax and lines under column grants", async () => {
  assert.deepEqual(await load("getTicket").getTicket(row.id), row);
});
for (const collision of [false, true]) {
  test(`idempotent ticket save recovers existing ticket ${collision ? "after a collision" : "before insert"} under column grants`, async () => {
    const result = await load("createTicket", { collision }).createTicket({ lines: [], clientKey: "key" });
    assert.deepEqual(result, { id: row.id, total: 125, existing: true });
  });
}
test("draft update reaches the status guard under column grants", async () => {
  await assert.rejects(load("updateTicket").updateTicket({ ticketId: row.id }), /Already approved/);
});
