// Ask's tools: every one sits behind a tab the app has, toolsFor offers
// exactly the ones behind the tabs (and roles) held, the arguments the
// model sends are cleaned into what the RPC takes, and the templates and
// hazard names are data.js's word for word.

import test from "node:test";
import assert from "node:assert/strict";
import { TABS, JHA_TEMPLATES as DATA_TEMPLATES, SEED_HAZARDS } from "./data.js";
import {
  ASK_TOOLS, toolsFor, toolDefinitions, traceLine, searchArgs, TRACKER_STATUSES, JHA_TEMPLATES, HAZARD_NAMES
} from "../../supabase/functions/_shared/askTools.ts";

test("every tool sits behind a tab the app has", () => {
  const keys = new Set(TABS.map(t => t.key));
  for (const t of ASK_TOOLS) assert.ok(keys.has(t.tab), `${t.name} names tab ${t.tab}`);
  assert.equal(new Set(ASK_TOOLS.map(t => t.name)).size, ASK_TOOLS.length);
});

test("toolsFor offers exactly the tools behind the tabs held, and the price roles for a ticket", () => {
  assert.deepEqual(toolsFor(["tracker"]).map(t => t.name), ["tracker_stats", "ticket_aging", "search_tickets"]);
  assert.deepEqual(toolsFor(["board", "job", "jha", "ticket"], "Helper").map(t => t.name),
    ["find_client", "find_job", "job_record", "draft_job", "draft_jha"]);
  assert.ok(toolsFor(["ticket"], "Technician").some(t => t.name === "draft_ticket"));
  assert.ok(toolsFor(["ticket"], "Admin").some(t => t.name === "draft_ticket"));
  assert.ok(!toolsFor(["ticket"], "Coordinator").some(t => t.name === "draft_ticket"));
  assert.ok(!toolsFor(["ticket"]).some(t => t.name === "draft_ticket"));
  assert.deepEqual(toolsFor(["chat"]), []);
  assert.deepEqual(toolsFor(null), []);
});

test("the definitions carry only what the API takes", () => {
  for (const d of toolDefinitions(ASK_TOOLS)) {
    assert.deepEqual(Object.keys(d).sort(), ["description", "input_schema", "name"]);
    assert.equal(d.input_schema.type, "object");
  }
});

test("the templates and hazard names are data.js's, word for word", () => {
  assert.deepEqual(JHA_TEMPLATES, DATA_TEMPLATES);
  assert.deepEqual(HAZARD_NAMES, SEED_HAZARDS.map(h => h.name));
});

test("searchArgs cleans what the model sends", () => {
  assert.deepEqual(searchArgs({ status: "Over 7 days", q: " Pembina ", date_from: "2026-08-01", page_size: 500 }),
    { status_filter: "Over 7 days", q: "Pembina", date_from: "2026-08-01", date_to: null, page_num: 0, page_size: 50 });
  assert.deepEqual(searchArgs({ status: "Bogus", date_to: "yesterday", page: -2 }),
    { status_filter: "All", q: "", date_from: null, date_to: null, page_num: 0, page_size: 25 });
  assert.ok(TRACKER_STATUSES.includes("Awaiting approval"));
});

test("a trace line says what was read or drafted, in words", () => {
  assert.equal(traceLine("tracker_stats", {}), "read the tracker's totals");
  assert.equal(traceLine("ticket_aging", {}), "read how old the money is, by client");
  assert.equal(traceLine("search_tickets", { status: "Approved", q: "Pembina", date_from: "2026-08-01" }),
    "searched tickets: Approved, \"Pembina\", from 2026-08-01");
  assert.equal(traceLine("search_tickets", {}), "searched tickets: All");
  assert.equal(traceLine("find_client", { q: "Pemb" }), "looked up client \"Pemb\"");
  assert.equal(traceLine("job_record", { job_number: "S-10113" }), "read job S-10113's record");
  assert.equal(traceLine("draft_job", { client_name: "Pembina Pipeline" }), "drafted a job for Pembina Pipeline");
  assert.equal(traceLine("draft_jha", { job_number: "S-10113" }), "drafted a JHA on S-10113");
});
