import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describeScheduled, whenWords, tooLateToSchedule, SCHEDULE_FLOOR_MS } from "./scheduledSends.js";

test("the strip names the record, the addresses and the time in Grande Prairie's clock", () => {
  const now = Date.UTC(2026, 8, 10, 20, 0);
  const row = { label: "JHA RT-Shop.pdf (2026-09-08)", to_list: "dave@pembina.com", run_at: "2026-09-11T13:00:00Z", status: "queued", error: null };
  assert.deepEqual(describeScheduled(row, now), {
    line: "JHA RT-Shop.pdf (2026-09-08) to dave@pembina.com — sends Fri, Sep 11, 07:00", failed: false, due: false, error: ""
  });
  assert.equal(whenWords(Date.UTC(2026, 0, 15, 14, 5)), "Thu, Jan 15, 07:05");
});

test("a queued row past its time is due; a failed one says so and carries its error", () => {
  const now = Date.UTC(2026, 8, 11, 13, 2);
  const row = { label: "Ticket T-10231", to_list: "t@p.com", run_at: "2026-09-11T13:00:00Z", status: "queued", error: null };
  const d = describeScheduled(row, now);
  assert.equal(d.due, true);
  assert.match(d.line, /due now, sending within five minutes/);
  const f = describeScheduled({ ...row, status: "failed", error: "That ticket is already approved — nothing to send." }, now);
  assert.equal(f.failed, true);
  assert.equal(f.line, "Ticket T-10231 to t@p.com — was due Fri, Sep 11, 07:00, not sent");
  assert.equal(f.error, "That ticket is already approved — nothing to send.");
  assert.equal(describeScheduled({ ...row, status: "failed", error: "" }, now).error, "The send failed.");
  assert.match(describeScheduled({ ...row, run_at: "junk" }, now).line, /an unknown time/);
});

test("a reminder row names its text and its time, and no addresses", () => {
  const now = Date.UTC(2026, 8, 10, 20, 0);
  const row = { kind: "reminder", label: "Call Pembina about the AFE", to_list: "", run_at: "2026-09-11T13:00:00Z", status: "queued", error: null };
  assert.deepEqual(describeScheduled(row, now), {
    line: "Reminder: Call Pembina about the AFE — Fri, Sep 11, 07:00", failed: false, due: false, error: ""
  });
  assert.match(describeScheduled(row, Date.UTC(2026, 8, 11, 13, 1)).line, /due now, within five minutes/);
  const f = describeScheduled({ ...row, status: "failed", error: "" }, now);
  assert.equal(f.line, "Reminder: Call Pembina about the AFE — was due Fri, Sep 11, 07:00, not delivered");
  assert.equal(f.error, "The reminder was not delivered.");
});

// ── Round 5, F3: what the button may act on ──────────────────────────────
// Moving a send is a cancel and then an insert. A card that has been on
// screen a while — or a failed send from yesterday moved to another
// address, which keeps yesterday's time — meets the insert policy's floor
// AFTER the only copy has been cancelled. The question is therefore asked
// before anything is destroyed.
test("a time the insert policy would refuse is refused here first, in plain words", () => {
  const now = Date.UTC(2026, 8, 11, 20, 0);
  const at = ms => new Date(now + ms).toISOString();
  assert.equal(tooLateToSchedule(at(60 * 60_000), now), null, "an hour from now is fine");
  assert.equal(tooLateToSchedule(at(-30_000), now), null, "half a minute past is inside the floor");
  assert.match(tooLateToSchedule(at(-90_000), now), /has already passed/);
  assert.match(tooLateToSchedule(at(-86_400_000), now), /Ask for a time still to come/);
  assert.match(tooLateToSchedule("junk", now), /no time on it/);
  // Yesterday's failed send, its time kept because only the addresses moved.
  assert.match(tooLateToSchedule("2026-09-10T13:00:00Z", now), /Thu, Sep 10, 07:00 has already passed/);
});

test("the floor the device keeps is the insert policy's own minute", () => {
  const sql = readFileSync(new URL(
    "../../supabase/migrations/20260911010317_a_reminder_is_a_timer_with_no_mail.sql", import.meta.url), "utf8");
  const m = /run_at > now\(\) - interval '(\d+) minute'/.exec(sql);
  assert.ok(m, "the insert policy still states its floor as an interval of whole minutes");
  assert.equal(SCHEDULE_FLOOR_MS, Number(m[1]) * 60_000);
});

test("App asks before it cancels, for both the move and the plain schedule", () => {
  const app = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  // From the branch, not from the top of the file: App reads a job by
  // number in more than one place, and the first of them is above this
  // branch — searching from zero sliced backwards and read as an empty
  // string, which passed nothing and failed everything.
  const from = app.indexOf('action.kind === "reschedule_send"');
  assert.ok(from > -1, "the move branch is still there to read");
  const move = app.slice(from, app.indexOf("const job = await Db.getJobByNumber", from));
  assert.ok(move.length > 0, "the slice reaches from the branch to the end of it");
  const guard = move.indexOf("tooLateToSchedule");
  const cancel = move.indexOf("Db.cancelScheduledSend");
  assert.ok(guard > -1 && cancel > -1, "the move both asks and cancels");
  assert.ok(guard < cancel, "it asks BEFORE it cancels");
  const plainFrom = app.indexOf('action.kind === "schedule_send"');
  const plain = app.slice(plainFrom, app.indexOf('action.kind === "cancel_scheduled"', plainFrom));
  assert.ok(plain.length > 0, "the plain schedule branch reads end to end");
  assert.match(plain, /tooLateToSchedule\(action\.run_at\)/);
});
