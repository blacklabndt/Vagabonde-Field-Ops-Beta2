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

// row: { label, to_list, run_at, status, error }. Answers the line the
// strip shows, whether the row failed (Dismiss rather than Cancel), and
// the error to show under it. A queued row whose time has passed is
// "due" — the tick has up to five minutes to take it.
export function describeScheduled(row, nowMs = Date.now()) {
  const at = Date.parse(row.run_at);
  const when = Number.isFinite(at) ? whenWords(at) : "an unknown time";
  const failed = row.status === "failed";
  const due = row.status === "queued" && Number.isFinite(at) && at <= nowMs;
  const line = failed
    ? `${row.label} to ${row.to_list} — was due ${when}, not sent`
    : `${row.label} to ${row.to_list} — ${due ? "due now, sending within five minutes" : `sends ${when}`}`;
  return { line, failed, due, error: failed ? (row.error || "The send failed.") : "" };
}
