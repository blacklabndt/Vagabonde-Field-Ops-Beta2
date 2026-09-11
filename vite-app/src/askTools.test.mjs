// Ask's tools: every one sits behind a tab the app has, toolsFor offers
// exactly the ones behind the tabs (and roles) held, the arguments the
// model sends are cleaned into what the RPC takes, and the templates and
// hazard names are data.js's word for word.

import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { TABS, JHA_TEMPLATES as DATA_TEMPLATES, SEED_HAZARDS } from "./data.js";
import {
  ASK_TOOLS, toolsFor, toolDefinitions, traceLine, searchArgs, TRACKER_STATUSES, JHA_TEMPLATES, HAZARD_NAMES, SEND_KINDS
} from "../../supabase/functions/_shared/askTools.ts";
import { KINDS } from "../../supabase/functions/_shared/scheduledSends.ts";

test("every tool sits behind a tab the app has", () => {
  const keys = new Set(TABS.map(t => t.key));
  // "any" is a tool for anyone holding a tab at all (make_file).
  for (const t of ASK_TOOLS) assert.ok(keys.has(t.tab) || t.tab === "any", `${t.name} names tab ${t.tab}`);
  assert.equal(new Set(ASK_TOOLS.map(t => t.name)).size, ASK_TOOLS.length);
});

test("toolsFor offers exactly the tools behind the tabs held, and the price roles for a ticket", () => {
  assert.deepEqual(toolsFor(["tracker"]).map(t => t.name), ["tracker_stats", "ticket_aging", "search_tickets", "make_file", "set_reminder", "my_hours", "my_dose"]);
  assert.ok(toolsFor(["tracker"], "Admin").some(t => t.name === "chase_unsigned"));
  assert.ok(!toolsFor(["tracker"], "Coordinator").some(t => t.name === "chase_unsigned"));
  assert.deepEqual(toolsFor(["board", "job", "jha", "ticket"], "Helper").map(t => t.name),
    ["find_client", "find_job", "job_record", "draft_job", "draft_jha", "list_jhas", "list_tickets", "send_jha", "list_reports", "schedule_send", "list_scheduled", "cancel_scheduled", "reschedule_send", "make_file", "list_learned", "forget_learned", "day_check", "set_reminder", "my_hours", "my_dose", "open_record", "cancel_approval"]);
  assert.ok(toolsFor(["ticket"], "Technician").some(t => t.name === "draft_ticket"));
  assert.ok(toolsFor(["ticket"], "Admin").some(t => t.name === "draft_ticket"));
  assert.ok(!toolsFor(["ticket"], "Coordinator").some(t => t.name === "draft_ticket"));
  assert.ok(!toolsFor(["ticket"]).some(t => t.name === "draft_ticket"));
  assert.deepEqual(toolsFor(["chat"]).map(t => t.name), ["make_file", "set_reminder", "my_hours", "my_dose"]);
  assert.deepEqual(toolsFor(null), []);
});

test("the lists and the JHA send sit behind job; the ticket send behind ticket and a price role", () => {
  const job = toolsFor(["job"], "Helper").map(t => t.name);
  for (const n of ["list_jhas", "list_tickets", "send_jha"]) assert.ok(job.includes(n), n);
  assert.ok(!job.includes("send_ticket_approval"));
  assert.ok(toolsFor(["ticket"], "Technician").map(t => t.name).includes("send_ticket_approval"));
  assert.ok(!toolsFor(["ticket"], "Coordinator").map(t => t.name).includes("send_ticket_approval"));
  assert.ok(!toolsFor(["tracker", "board"], "Admin").map(t => t.name).includes("send_jha"));
  assert.equal(traceLine("list_jhas", { job_number: "S-10113" }), "listed the JHAs on S-10113");
  assert.equal(traceLine("list_tickets", { job_number: "S-10113" }), "listed the tickets on S-10113");
  assert.equal(traceLine("send_jha", { jha_id: "x", recipients: ["Dave"] }), "proposed sending a JHA");
  assert.equal(traceLine("send_ticket_approval", { ticket_id: "T-10231" }), "proposed sending T-10231 for approval");
});

test("the timer tools sit behind job, and the kinds are scheduledSends.ts's", () => {
  const job = toolsFor(["job"], "Helper").map(t => t.name);
  for (const n of ["list_reports", "schedule_send", "list_scheduled", "cancel_scheduled", "reschedule_send"]) assert.ok(job.includes(n), n);
  assert.deepEqual([...SEND_KINDS, "reminder"], [...KINDS]);
  assert.equal(traceLine("list_reports", { job_number: "S-10113" }), "listed the reports on S-10113");
  assert.equal(traceLine("schedule_send", { kind: "jha", run_at: "2026-09-11 07:00" }), "proposed a send at 2026-09-11 07:00");
  assert.equal(traceLine("list_scheduled", {}), "listed the scheduled sends");
  assert.equal(traceLine("list_scheduled", { job_number: "S-10113" }), "listed the scheduled sends on S-10113");
  assert.equal(traceLine("cancel_scheduled", { id: "x" }), "proposed cancelling a scheduled send");
  assert.equal(traceLine("reschedule_send", { id: "x", run_at: "2026-09-11 09:00" }), "proposed moving a scheduled send");
  assert.equal(traceLine("list_learned", {}), "read what it has learned");
  assert.equal(traceLine("make_file", { name: "Unsigned tickets", kind: "csv" }), "made Unsigned tickets (csv)");
  assert.equal(traceLine("make_file", {}), "made a file");
  assert.equal(traceLine("forget_learned", { id: "x" }), "proposed forgetting a learned note");
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

test("make_file is for anyone holding a tab, never an account with none, and its kinds are askFiles.ts's", async () => {
  const { FILE_KINDS: shared } = await import("../../supabase/functions/_shared/askFiles.ts");
  const { FILE_KINDS: tools } = await import("../../supabase/functions/_shared/askTools.ts");
  assert.deepEqual(tools, [...shared]);
  assert.deepEqual(toolsFor([]).map(t => t.name), []);
  assert.ok(toolsFor(["files"]).some(t => t.name === "make_file"));
});

test("the six helpers sit behind their screens, and the equipment filters are the screen's own", async () => {
  const { EQUIPMENT_FILTERS, EQUIPMENT_TYPES } = await import("../../supabase/functions/_shared/askTools.ts");
  const screen = readFileSync(new URL("./components/equipment.jsx", import.meta.url), "utf8");
  const types = /const EQUIPMENT_TYPES = (\[[^\]]*\]);/.exec(screen);
  const filters = /const EQUIPMENT_FILTERS = (\[[^\]]*\]);/.exec(screen);
  assert.ok(types && filters, "equipment.jsx names its types and filters");
  assert.deepEqual(EQUIPMENT_TYPES, JSON.parse(types[1]));
  assert.equal(filters[1].replace(/\s+/g, ""), '["All",...EQUIPMENT_TYPES,"Duesoon","Overdue"]');
  assert.deepEqual(EQUIPMENT_FILTERS, ["All", ...EQUIPMENT_TYPES, "Due soon", "Overdue"]);
  const contacts = toolsFor(["contacts"], "Helper").map(t => t.name);
  for (const n of ["draft_contact", "draft_organisation", "find_contact"]) assert.ok(contacts.includes(n), n);
  assert.ok(toolsFor(["equipment"], "Helper").some(t => t.name === "find_equipment"));
  assert.ok(toolsFor(["job"], "Helper").some(t => t.name === "day_check"));
  assert.ok(!toolsFor(["board"], "Helper").some(t => t.name === "day_check"));
  assert.equal(traceLine("chase_unsigned", {}), "proposed a chase");
  assert.equal(traceLine("chase_unsigned", { client: "Pembina", older_than_days: 14 }), "proposed a chase for Pembina, older than 14 days");
  assert.equal(traceLine("draft_contact", { organisation: "Pembina Pipeline", name: "Dana" }), "drafted a contact at Pembina Pipeline");
  assert.equal(traceLine("draft_organisation", { name: "Acme Welding", type: "contractor" }), "drafted a new contractor: Acme Welding");
  assert.equal(traceLine("find_contact", { q: "Dana" }), 'looked up contact "Dana"');
  assert.equal(traceLine("find_contact", { q: "Dana", organisation: "Pembina" }), 'looked up contact "Dana" at Pembina');
  assert.equal(traceLine("day_check", {}), "checked the day");
  assert.equal(traceLine("day_check", { date: "2026-09-09" }), "checked the day (2026-09-09)");
  assert.equal(traceLine("set_reminder", { text: "x", run_at: "2026-09-11 07:00" }), "proposed a reminder at 2026-09-11 07:00");
  assert.equal(traceLine("my_hours", {}), "read own hours");
  assert.equal(traceLine("my_dose", { person: "Dave" }), "read Dave's dose");
  assert.equal(traceLine("find_equipment", {}), "looked up equipment");
  assert.equal(traceLine("find_equipment", { search: "SN-1", filter: "Overdue" }), 'looked up equipment "SN-1" (Overdue)');
  assert.equal(traceLine("find_equipment", { filter: "All" }), "looked up equipment");
});

test("the five more sit behind their screens and roles", async () => {
  const { OPEN_KINDS } = await import("../../supabase/functions/_shared/askTools.ts");
  assert.deepEqual(OPEN_KINDS, ["job", "ticket", "jha", "report"]);
  assert.ok(toolsFor(["job"], "Helper").some(t => t.name === "open_record"));
  assert.ok(toolsFor(["ticket"], "Technician").some(t => t.name === "check_ticket"));
  assert.ok(!toolsFor(["ticket"], "Coordinator").some(t => t.name === "check_ticket"));
  assert.ok(toolsFor(["rates"], "Admin").some(t => t.name === "rate_card"));
  assert.ok(!toolsFor(["rates"], "Helper").some(t => t.name === "rate_card"));
  assert.ok(toolsFor(["board"], "Admin").some(t => t.name === "needs_attention"));
  assert.ok(!toolsFor(["board"], "Coordinator").some(t => t.name === "needs_attention"));
  assert.ok(toolsFor(["ticket"], "Helper").some(t => t.name === "cancel_approval"));
  assert.ok(!toolsFor(["job"], "Helper").some(t => t.name === "cancel_approval"));
  assert.equal(traceLine("open_record", { kind: "ticket", id: "T-10231" }), "proposed opening ticket T-10231");
  assert.equal(traceLine("open_record", {}), "proposed opening a record");
  assert.equal(traceLine("check_ticket", { ticket_id: "T-10231" }), "checked T-10231");
  assert.equal(traceLine("rate_card", { client: "Pembina" }), "read Pembina's rate card");
  assert.equal(traceLine("rate_card", { client: "Pembina", search: "standby" }), 'read Pembina\'s rate card for "standby"');
  assert.equal(traceLine("needs_attention", {}), "read what needs attention");
  assert.equal(traceLine("cancel_approval", { ticket_id: "T-10231" }), "proposed cancelling T-10231's approval");
});
