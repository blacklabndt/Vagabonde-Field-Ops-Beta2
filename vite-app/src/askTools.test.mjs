// Ask's tools: every one sits behind a tab the app has, toolsFor offers
// exactly the ones behind the tabs held, and the arguments the model
// sends are cleaned into what the RPC takes.

import test from "node:test";
import assert from "node:assert/strict";
import { TABS } from "./data.js";
import { ASK_TOOLS, toolsFor, toolDefinitions, traceLine, searchArgs, TRACKER_STATUSES }
  from "../../supabase/functions/_shared/askTools.ts";

test("every tool sits behind a tab the app has", () => {
  const keys = new Set(TABS.map(t => t.key));
  for (const t of ASK_TOOLS) assert.ok(keys.has(t.tab), `${t.name} names tab ${t.tab}`);
  assert.equal(new Set(ASK_TOOLS.map(t => t.name)).size, ASK_TOOLS.length);
});

test("toolsFor offers exactly the tools behind the tabs held", () => {
  assert.deepEqual(toolsFor(["tracker"]).map(t => t.name), ["tracker_stats", "ticket_aging", "search_tickets"]);
  assert.deepEqual(toolsFor(["board", "chat"]), []);
  assert.deepEqual(toolsFor(null), []);
});

test("the definitions carry only what the API takes", () => {
  for (const d of toolDefinitions(ASK_TOOLS)) {
    assert.deepEqual(Object.keys(d).sort(), ["description", "input_schema", "name"]);
    assert.equal(d.input_schema.type, "object");
  }
});

test("searchArgs cleans what the model sends", () => {
  assert.deepEqual(searchArgs({ status: "Over 7 days", q: " Pembina ", date_from: "2026-08-01", page_size: 500 }),
    { status_filter: "Over 7 days", q: "Pembina", date_from: "2026-08-01", date_to: null, page_num: 0, page_size: 50 });
  assert.deepEqual(searchArgs({ status: "Bogus", date_to: "yesterday", page: -2 }),
    { status_filter: "All", q: "", date_from: null, date_to: null, page_num: 0, page_size: 25 });
  assert.ok(TRACKER_STATUSES.includes("Awaiting approval"));
});

test("a trace line says what was read, in words", () => {
  assert.equal(traceLine("tracker_stats", {}), "read the tracker's totals");
  assert.equal(traceLine("ticket_aging", {}), "read how old the money is, by client");
  assert.equal(traceLine("search_tickets", { status: "Approved", q: "Pembina", date_from: "2026-08-01" }),
    "searched tickets: Approved, \"Pembina\", from 2026-08-01");
  assert.equal(traceLine("search_tickets", {}), "searched tickets: All");
});
