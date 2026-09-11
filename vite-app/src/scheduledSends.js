// What Job detail's "Scheduled sends" strip says about a row — pure, so
// the wording is tested and the screen only renders it. The time is Grande
// Prairie's clock, the same words the function's card summary used, so the
// strip and the card agree.

const ZONE = "America/Edmonton";

export function whenWords(ms, zone = ZONE) {
  const d = new Date(ms);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: zone, weekday: "short", day: "numeric", month: "short" }).format(d);
  const time = new Intl.DateTimeFormat("en-CA", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return `${day.replace(/\.$/, "").replace(/\.,/, ",")}, ${time}`;
}

// The floor the insert policy keeps (`run_at > now() - interval '1
// minute'`), asked on THIS device at the moment the button is pressed.
// A card can sit on screen for minutes, and moving a send is a cancel and
// then an insert: an insert refused for its time would take the only copy
// of the send with it. So the card is re-read against the clock BEFORE
// anything is cancelled, and a send whose time has gone is refused with
// the words that ask for a new one. The database is still the authority;
// this only keeps us from destroying a row we cannot replace.
// scheduledSends.client.test.mjs holds this to MAX_PAST_MS in the
// function's own module, which is deliberately tighter than the minute.
export const SCHEDULE_FLOOR_MS = 60_000;

export function tooLateToSchedule(runAtIso, nowMs = Date.now()) {
  const at = Date.parse(runAtIso);
  if (!Number.isFinite(at)) return "That send has no time on it. Ask for a new time.";
  if (at > nowMs - SCHEDULE_FLOOR_MS) return null;
  return `${whenWords(at)} has already passed, so it cannot be scheduled. Ask for a time still to come.`;
}

// row: { label, to_list, run_at, status, error }. Answers the line the
// strip shows, whether the row failed (Dismiss rather than Cancel), and
// the error to show under it. A queued row whose time has passed is
// "due" — the tick has up to five minutes to take it.
export function describeScheduled(row, nowMs = Date.now()) {
  const at = Date.parse(row.run_at);
  const when = Number.isFinite(at) ? whenWords(at) : "an unknown time";
  const failed = row.status === "failed";
  const due = row.status === "queued" && Number.isFinite(at) && at <= nowMs;
  // A reminder names no addresses: its label is the text, and it "fires"
  // rather than sends.
  const reminder = row.kind === "reminder";
  const line = reminder
    ? (failed ? `Reminder: ${row.label} — was due ${when}, not delivered`
      : `Reminder: ${row.label} — ${due ? "due now, within five minutes" : when}`)
    : failed
      ? `${row.label} to ${row.to_list} — was due ${when}, not sent`
      : `${row.label} to ${row.to_list} — ${due ? "due now, sending within five minutes" : `sends ${when}`}`;
  return { line, failed, due, error: failed ? (row.error || (reminder ? "The reminder was not delivered." : "The send failed.")) : "" };
}
