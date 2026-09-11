// A send that waits for its time: the clock it is set by is Grande
// Prairie's and DST-correct, the fire-time gate is the send function's own
// against the person's current profile and the record's current state, a
// row that never reported back is failed and not retried, and the words
// name the record, the addresses and the time.

import test from "node:test";
import assert from "node:assert/strict";
import {
  localToUtc, checkRunAt, whenWords, fireGate, isStuck, labelFor, scheduleWords, cancelWords, isKind,
  rescheduleWords, resultPushWords, splitList, reminderText, reminderWords, REMINDER_MAX, NO_DEVICE_WORDS,
  STUCK_MS, MAX_AHEAD_MS, MAX_PAST_MS, KINDS
} from "../../supabase/functions/_shared/scheduledSends.ts";

const ACTIVE = { id: "u1", role: "Technician", tab_access: ["board", "job", "jha", "upload", "ticket"], deactivated_at: null };
const JHA = { id: "a1", signed_by: "u2", pdf_key: "jhas/j1/RT-Shop.pdf", template: "RT — Shop radiography v1", work_date: "2026-09-08" };
const REPORT = { id: "r1", pdf_key: "reports/j1/tie-in.pdf", filename: "tie-in.pdf" };
const TICKET = { id: "T-10231", status: "Draft", total: 1250, technician_id: "u1" };

test("the kinds are the three sends and a reminder", () => {
  assert.deepEqual([...KINDS], ["jha", "report", "ticket_approval", "reminder"]);
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
  // A reminder has no record: an active account holding any tab is the gate.
  assert.doesNotThrow(() => fireGate("reminder", { ...ACTIVE, tab_access: ["chat"] }, {}));
  assert.throws(() => fireGate("reminder", { ...ACTIVE, tab_access: [] }, {}), /is locked/);
  assert.throws(() => fireGate("reminder", { ...ACTIVE, deactivated_at: "2026-09-10T00:00:00Z" }, {}), /is locked/);
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

test("moving a send says what moves — the time, the addresses, or both", () => {
  const was = Date.UTC(2026, 8, 11, 13, 0);
  const now = Date.UTC(2026, 8, 11, 15, 0);
  const job = { job_number: "S-10113" };
  const time = rescheduleWords("jha", "JHA RT-Shop.pdf (2026-09-08)", job, ["dave@pembina.com"], was, now, false);
  assert.equal(time.summary, "Move the send of JHA RT-Shop.pdf (2026-09-08) on S-10113 to Fri, Sep 11, 09:00 (was Fri, Sep 11, 07:00)?");
  assert.match(time.done, /^Rescheduled: JHA RT-Shop\.pdf \(2026-09-08\) on S-10113 goes to dave@pembina\.com at Fri, Sep 11, 09:00\./);
  const who = rescheduleWords("report", "Report tie-in.pdf", job, ["a@x.com", "b@y.com"], was, was, true);
  assert.equal(who.summary, "Send Report tie-in.pdf on S-10113 to a@x.com, b@y.com instead, at Fri, Sep 11, 07:00?");
  const both = rescheduleWords("jha", "JHA RT-Shop.pdf (2026-09-08)", job, ["a@x.com"], was, now, true);
  assert.equal(both.summary, "Send JHA RT-Shop.pdf (2026-09-08) on S-10113 to a@x.com instead, at Fri, Sep 11, 09:00 (was Fri, Sep 11, 07:00)?");
  const t = rescheduleWords("ticket_approval", "Ticket T-10231", job, ["t@p.com"], was, now, false);
  assert.equal(t.summary, "Move the send of Ticket T-10231 on S-10113 for approval to Fri, Sep 11, 09:00 (was Fri, Sep 11, 07:00)?");
  assert.deepEqual(splitList("a@x.com,b@y.com, c@z.com"), ["a@x.com", "b@y.com", "c@z.com"]);
  assert.deepEqual(splitList(null), []);
});

test("the push the scheduler's devices get names the result, the record and the job, and points at the job", () => {
  const row = { id: "abc", label: "JHA RT-Shop.pdf (2026-09-08)", to_list: "dave@pembina.com,ann@c.ca", run_at: new Date(Date.UTC(2026, 8, 11, 13, 0)).toISOString() };
  const ok = resultPushWords(row, "S-10113", null);
  assert.equal(ok.kind, "scheduled_send");
  assert.equal(ok.ok, true);
  assert.equal(ok.id, "abc");
  assert.equal(ok.title, "Sent: JHA RT-Shop.pdf (2026-09-08) on S-10113");
  assert.equal(ok.body, "To dave@pembina.com, ann@c.ca · Fri, Sep 11, 07:00");
  assert.equal(ok.job_number, "S-10113");
  assert.equal(ok.url, "/#/job/S-10113");
  assert.equal(ok.tag, "scheduled-send-abc");
  const bad = resultPushWords(row, "S-10113", "The ticket has been signed meanwhile.");
  assert.equal(bad.ok, false);
  assert.equal(bad.title, "Not sent: JHA RT-Shop.pdf (2026-09-08) on S-10113");
  assert.equal(bad.body, "The ticket has been signed meanwhile.");
  assert.equal(bad.tag, "scheduled-send-abc");
});

test("a reminder's push is the reminder itself, on the job's page or the app's", () => {
  const row = { id: "r1", kind: "reminder", label: "Call Pembina about the AFE", to_list: "", run_at: "2026-09-11T13:00:00Z" };
  const onJob = resultPushWords(row, "S-10113", null);
  assert.equal(onJob.title, "Reminder on S-10113");
  assert.equal(onJob.body, "Call Pembina about the AFE");
  assert.equal(onJob.url, "/#/job/S-10113");
  assert.equal(onJob.ok, true);
  assert.equal(onJob.tag, "scheduled-send-r1");
  const plain = resultPushWords(row, "", null);
  assert.equal(plain.title, "Reminder");
  assert.equal(plain.url, "/");
  assert.equal(plain.job_number, "");
  const bad = resultPushWords(row, "", NO_DEVICE_WORDS);
  assert.equal(bad.ok, false);
  assert.equal(bad.title, "Reminder not delivered");
  assert.equal(bad.body, NO_DEVICE_WORDS);
});

test("a reminder's text is one line of a few to three hundred characters, and its words name the time and the job", () => {
  assert.equal(reminderText("  Call   Pembina\nabout the AFE "), "Call Pembina about the AFE");
  assert.throws(() => reminderText("ok"), /needs a few words/);
  assert.throws(() => reminderText(null), /needs a few words/);
  assert.throws(() => reminderText("x".repeat(REMINDER_MAX + 1)), /at most 300 characters/);
  const at = Date.UTC(2026, 8, 11, 13, 0);
  const w = reminderWords("Call Pembina about the AFE", { job_number: "S-10113" }, at);
  assert.equal(w.summary, 'Set a reminder on S-10113 for Fri, Sep 11, 07:00: "Call Pembina about the AFE"?');
  assert.match(w.done, /^Set: "Call Pembina about the AFE" comes as a notification at Fri, Sep 11, 07:00 on S-10113, on the devices where notifications are turned on/);
  assert.match(w.done, /Job detail lists it and can cancel it\.$/);
  const alone = reminderWords("Order film", null, at);
  assert.equal(alone.summary, 'Set a reminder for Fri, Sep 11, 07:00: "Order film"?');
  assert.match(alone.done, /Ask me to list or cancel it\.$/);
  const c = cancelWords("Order film", at, "reminder");
  assert.equal(c.summary, 'Cancel the reminder "Order film" set for Fri, Sep 11, 07:00?');
  assert.equal(c.done, 'Cancelled: the reminder "Order film" will not fire at Fri, Sep 11, 07:00.');
});
