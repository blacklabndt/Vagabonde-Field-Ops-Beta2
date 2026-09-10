// A send that waits for its time: the clock it is set by is Grande
// Prairie's and DST-correct, the fire-time gate is the send function's own
// against the person's current profile and the record's current state, a
// row that never reported back is failed and not retried, and the words
// name the record, the addresses and the time.

import test from "node:test";
import assert from "node:assert/strict";
import {
  localToUtc, checkRunAt, whenWords, fireGate, isStuck, labelFor, scheduleWords, cancelWords, isKind,
  STUCK_MS, MAX_AHEAD_MS, MAX_PAST_MS, KINDS
} from "../../supabase/functions/_shared/scheduledSends.ts";

const ACTIVE = { id: "u1", role: "Technician", tab_access: ["board", "job", "jha", "upload", "ticket"], deactivated_at: null };
const JHA = { id: "a1", signed_by: "u2", pdf_key: "jhas/j1/RT-Shop.pdf", template: "RT — Shop radiography v1", work_date: "2026-09-08" };
const REPORT = { id: "r1", pdf_key: "reports/j1/tie-in.pdf", filename: "tie-in.pdf" };
const TICKET = { id: "T-10231", status: "Draft", total: 1250, technician_id: "u1" };

test("the kinds are the three sends", () => {
  assert.deepEqual([...KINDS], ["jha", "report", "ticket_approval"]);
  assert.equal(isKind("jha"), true);
  assert.equal(isKind("email"), false);
});

test("a local time becomes the instant, on either side of the clock change", () => {
  // 11 Sept 2026 07:00 MDT is 13:00 UTC; 15 Jan 2027 07:00 MST is 14:00 UTC.
  assert.equal(localToUtc("2026-09-11 07:00"), Date.UTC(2026, 8, 11, 13, 0));
  assert.equal(localToUtc("2026-09-11T07:00"), Date.UTC(2026, 8, 11, 13, 0));
  assert.equal(localToUtc("2027-01-15 07:00"), Date.UTC(2027, 0, 15, 14, 0));
  // The night the clocks go back (1 Nov 2026): 06:00 is MST, 13:00 UTC.
  assert.equal(localToUtc("2026-11-01 06:00"), Date.UTC(2026, 10, 1, 13, 0));
  assert.throws(() => localToUtc("tomorrow morning"), /YYYY-MM-DD HH:MM/);
  assert.throws(() => localToUtc("2026-13-40 25:61"), /not a real date/);
  assert.throws(() => localToUtc(null), /YYYY-MM-DD HH:MM/);
});

test("a time already passed, or more than ninety days away, is refused in words", () => {
  const now = Date.UTC(2026, 8, 10, 20, 0);
  assert.doesNotThrow(() => checkRunAt(now - MAX_PAST_MS + 1000, now));
  assert.doesNotThrow(() => checkRunAt(now + 3_600_000, now));
  assert.throws(() => checkRunAt(now - MAX_PAST_MS - 1000, now), /has already passed/);
  assert.throws(() => checkRunAt(now + MAX_AHEAD_MS + 1000, now), /more than ninety days away/);
});

test("the time is said in Grande Prairie's clock", () => {
  assert.equal(whenWords(Date.UTC(2026, 8, 11, 13, 0)), "Fri, Sep 11, 07:00");
  assert.equal(whenWords(Date.UTC(2027, 0, 15, 14, 5)), "Fri, Jan 15, 07:05");
});

test("the fire-time gate refuses a locked account or one that lost the tab", () => {
  assert.throws(() => fireGate("jha", { ...ACTIVE, deactivated_at: "2026-09-10T00:00:00Z" }, JHA), /is locked/);
  assert.throws(() => fireGate("jha", { ...ACTIVE, tab_access: [] }, JHA), /is locked/);
  assert.throws(() => fireGate("jha", { ...ACTIVE, tab_access: ["chat"] }, JHA), /no longer holds a tab/);
  assert.throws(() => fireGate("report", { ...ACTIVE, tab_access: ["jha"] }, REPORT), /no longer holds a tab/);
  // Tickets are readable by any staff account; the send gate is the test.
  assert.doesNotThrow(() => fireGate("ticket_approval", { ...ACTIVE, tab_access: ["chat"] }, TICKET));
});

test("the fire-time gate is the send function's own, on the record as it stands now", () => {
  // A JHA: the signer or a sending role, and a PDF.
  assert.doesNotThrow(() => fireGate("jha", ACTIVE, JHA));
  assert.throws(() => fireGate("jha", { ...ACTIVE, role: "Helper" }, JHA), /Only the technician who filed/);
  assert.doesNotThrow(() => fireGate("jha", { ...ACTIVE, role: "Helper", id: "u2" }, JHA));
  assert.throws(() => fireGate("jha", ACTIVE, { ...JHA, pdf_key: null }), /no PDF yet/);
  // A report: a PDF and a sending role.
  assert.doesNotThrow(() => fireGate("report", ACTIVE, REPORT));
  assert.throws(() => fireGate("report", { ...ACTIVE, role: "Helper" }, REPORT), /Only a Technician, Coordinator or Admin/);
  assert.throws(() => fireGate("report", ACTIVE, { ...REPORT, pdf_key: null }), /no PDF on file/);
  // A ticket: unsigned, something on it, own or the office.
  assert.doesNotThrow(() => fireGate("ticket_approval", ACTIVE, TICKET));
  assert.throws(() => fireGate("ticket_approval", ACTIVE, { ...TICKET, status: "Approved" }), /already signed it/);
  assert.throws(() => fireGate("ticket_approval", { ...ACTIVE, id: "u9" }, TICKET), /another technician's/);
  assert.doesNotThrow(() => fireGate("ticket_approval", { ...ACTIVE, id: "u9", role: "Coordinator" }, TICKET));
});

test("a row claimed and silent for fifteen minutes is stuck; a queued one never is", () => {
  const now = Date.UTC(2026, 8, 10, 20, 0);
  const at = ms => new Date(now - ms).toISOString();
  assert.equal(isStuck({ status: "sending", fired_at: at(STUCK_MS + 1000) }, now), true);
  assert.equal(isStuck({ status: "sending", fired_at: at(STUCK_MS - 1000) }, now), false);
  assert.equal(isStuck({ status: "queued", fired_at: null }, now), false);
  assert.equal(isStuck({ status: "sending", fired_at: null }, now), false);
});

test("the label names the record the way Job detail does", () => {
  assert.equal(labelFor("jha", JHA), "JHA RT-Shop.pdf (2026-09-08)");
  assert.equal(labelFor("jha", { ...JHA, pdf_key: null, work_date: null }), "JHA RT-—-Shop-radiography-v1.pdf");
  assert.equal(labelFor("report", REPORT), "Report tie-in.pdf");
  assert.equal(labelFor("report", { id: "r2", pdf_key: null, filename: "" }), "Report (no file name)");
  assert.equal(labelFor("ticket_approval", TICKET), "Ticket T-10231");
});

test("the words name the record, the job, every address and the time", () => {
  const at = Date.UTC(2026, 8, 11, 13, 0);
  const w = scheduleWords("jha", "JHA RT-Shop.pdf (2026-09-08)", { job_number: "S-10113" }, ["dave@pembina.com", "ann@c.ca"], at);
  assert.equal(w.summary, "Send JHA RT-Shop.pdf (2026-09-08) on S-10113 to dave@pembina.com, ann@c.ca at Fri, Sep 11, 07:00?");
  assert.match(w.done, /^Scheduled: JHA RT-Shop\.pdf \(2026-09-08\) on S-10113 goes to dave@pembina\.com, ann@c\.ca at Fri, Sep 11, 07:00\./);
  assert.match(w.done, /whether or not the app is open/);
  const t = scheduleWords("ticket_approval", "Ticket T-10231", { job_number: "S-10113" }, ["t@p.com"], at);
  assert.equal(t.summary, "Send Ticket T-10231 on S-10113 for approval to t@p.com at Fri, Sep 11, 07:00?");
  const c = cancelWords("Ticket T-10231", at);
  assert.equal(c.summary, "Cancel the send of Ticket T-10231 set for Fri, Sep 11, 07:00?");
  assert.equal(c.done, "Cancelled: Ticket T-10231 will not be sent at Fri, Sep 11, 07:00.");
});
