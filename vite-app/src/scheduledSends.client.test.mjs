import test from "node:test";
import assert from "node:assert/strict";
import { describeScheduled, whenWords } from "./scheduledSends.js";

test("the strip names the record, the addresses and the time in Grande Prairie's clock", () => {
  const now = Date.UTC(2026, 8, 10, 20, 0);
  const row = { label: "JHA RT-Shop.pdf (2026-09-08)", to_list: "dave@pembina.com", run_at: "2026-09-11T13:00:00Z", status: "queued", error: null };
  assert.deepEqual(describeScheduled(row, now), {
    line: "JHA RT-Shop.pdf (2026-09-08) to dave@pembina.com — sends Fri, Sep 11, 07:00", failed: false, due: false, error: ""
  });
  assert.equal(whenWords(Date.UTC(2027, 0, 15, 14, 5)), "Fri, Jan 15, 07:05");
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
