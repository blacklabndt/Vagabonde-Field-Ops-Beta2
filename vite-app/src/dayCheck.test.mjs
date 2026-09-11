// "Am I done for the day?": the gaps a job's day can have, each as the
// phrase Ask repeats, and the one thing that is a note and never a gap.

import test from "node:test";
import assert from "node:assert/strict";
import { dayCheck } from "../../supabase/functions/_shared/dayCheck.ts";

const job = (over = {}) => ({
  job_number: "S-10113",
  jhas: [{ sent_at: "2026-09-10T14:00:00Z" }],
  tickets: [{ id: "T-10231", status: "Awaiting approval", approval_sent_at: "2026-09-10T23:00:00Z", helper: true }],
  reports: [{ sent_at: "2026-09-10T22:00:00Z" }],
  ...over
});

test("a day with everything filed and sent is done, with nothing missing", () => {
  const c = dayCheck(job());
  assert.equal(c.done, true);
  assert.deepEqual(c.missing, []);
  assert.deepEqual(c.notes, []);
  assert.deepEqual(c.jha, { filed: true, sent: true });
  assert.deepEqual(c.report, { uploaded: true, sent: true });
  assert.deepEqual(c.ticket, { exists: true, id: "T-10231", status: "Awaiting approval", sent: true, helper: true });
});

test("each gap is its own phrase, filed-but-not-sent apart from not filed", () => {
  assert.deepEqual(dayCheck(job({ jhas: [] })).missing, ["no JHA filed"]);
  assert.deepEqual(dayCheck(job({ jhas: [{ sent_at: null }] })).missing, ["JHA not sent"]);
  assert.deepEqual(dayCheck(job({ reports: [] })).missing, ["no report uploaded"]);
  assert.deepEqual(dayCheck(job({ reports: [{ sent_at: null }] })).missing, ["report not sent"]);
  assert.deepEqual(dayCheck(job({ tickets: [] })).missing, ["no ticket yet"]);
  const draft = dayCheck(job({ tickets: [{ id: "T-10232", status: "Draft", approval_sent_at: null, helper: true }] }));
  assert.deepEqual(draft.missing, ["ticket T-10232 not sent for approval"]);
  assert.equal(draft.done, false);
  const nothing = dayCheck(job({ jhas: [], reports: [], tickets: [] }));
  assert.deepEqual(nothing.missing, ["no JHA filed", "no report uploaded", "no ticket yet"]);
});

test("no helper on the ticket is a note, not a gap — working alone is a real day", () => {
  const c = dayCheck(job({ tickets: [{ id: "T-10231", status: "Awaiting approval", approval_sent_at: null, helper: false }] }));
  assert.equal(c.done, true);
  assert.deepEqual(c.missing, []);
  assert.deepEqual(c.notes, ["no helper on ticket T-10231 (fine if you worked alone)"]);
});

test("the day's furthest-along ticket is the one judged; a sent stamp on a draft counts as sent", () => {
  const c = dayCheck(job({ tickets: [
    { id: "T-1", status: "Draft", approval_sent_at: null, helper: false },
    { id: "T-2", status: "Approved", approval_sent_at: "2026-09-10T23:00:00Z", helper: true }
  ] }));
  assert.equal(c.ticket.id, "T-2");
  assert.equal(c.done, true);
  const stamped = dayCheck(job({ tickets: [{ id: "T-3", status: "Draft", approval_sent_at: "2026-09-10T23:00:00Z", helper: true }] }));
  assert.equal(stamped.ticket.sent, true);
});
