// A send that waits for its time: the gate applied when it fires, the
// clock it was set by, and the words the card and the strip use. Pure —
// imports askSends.ts's gates and nothing else (backupShared.test.mjs
// guards that), so the node suite covers every refusal without a database
// or a cron.
//
// A live send is authorised once, by the person's session. A scheduled one
// has none at fire time, so it is authorised in two halves: the row was
// inserted through RLS as the person (the policy looks the record up under
// their own read policies), and fireGate here re-applies the send
// function's own gate against the person's CURRENT profile and the
// record's CURRENT state. Anything changed since — the account locked, a
// tab taken away, the PDF gone, the ticket signed meanwhile — fails the
// send with the reason, and nothing goes.

import { jhaSendGate, ticketSendGate, JHA_SEND_ROLES, type JhaToSend, type TicketToSend } from "./askSends.ts";

// A reminder is the fourth kind: a timer with no mail, fired as a push to
// the person's own devices (scheduled-sends' reminder branch); its label is
// the text, its record_id and to_list are empty, its job optional.
// A refusal written to be READ by whoever asked — see askSends.ts. These
// also reach the scheduled-sends tick, where they are written to the row and
// to function_errors as the reason a send did not go; marking them changes
// nothing there and keeps them readable in Ask.
function refuse(words: string): Error {
  const e = new Error(words);
  (e as Error & { plain?: boolean }).plain = true;
  return e;
}

export const KINDS = ["jha", "report", "ticket_approval", "reminder"] as const;
export type Kind = typeof KINDS[number];
export function isKind(v: unknown): v is Kind { return typeof v === "string" && (KINDS as readonly string[]).includes(v); }

// send-report's gate.
export const REPORT_SEND_ROLES = JHA_SEND_ROLES;
// The tabs each record's read policy names (the baseline's jhas read,
// reports select and tickets select).
export const READ_TABS: Record<Kind, readonly string[]> = {
  jha: ["jha", "job", "users"],
  report: ["upload", "job", "users"],
  ticket_approval: [], // is_staff(): any tab at all
  reminder: [] // the person's own, whatever they hold
};
// A row claimed and not reported back in this long died mid-send. It is
// failed, not retried: the email may well have gone, and twice is worse
// than once too few.
export const STUCK_MS = 15 * 60_000;
export const STUCK_WORDS = "The send did not report back — check whether it arrived before sending again.";
// How far ahead and how far behind a time may be set. The floor is
// DELIBERATELY tighter than the insert policy's `run_at > now() - interval
// '1 minute'`: what the app is willing to propose must be something the
// database will still accept when the person presses the button, and five
// minutes of slack proposed a card whose insert was already refused at the
// clock time it was drawn. Half a minute leaves the tap its room. The
// database stays the authority; this only keeps us from offering what it
// will refuse.
export const MAX_AHEAD_MS = 90 * 86_400_000;
export const MAX_PAST_MS = 30_000;
export const ZONE = "America/Edmonton";

// The words for a send that WENT and could not be marked. It must never be
// sent again on the strength of the row, so the log says so in its own
// sentence; the stale sweep will fail the row fifteen minutes later with
// STUCK_WORDS, and this is what tells the office which of the two it was.
export const sentUnrecorded = (label: string, why: string): string =>
  `${label} WAS SENT, but the record could not be marked sent: ${why}. Do not send it again.`;
// And one that did not go, where the failure itself could not be written.
export const failureUnrecorded = (label: string, why: string, writeWhy: string): string =>
  `${label} was not sent: ${why}. The row could not be marked failed either: ${writeWhy}.`;

export interface Person { id: string; role: string; tab_access: string[] | null; deactivated_at: string | null }
export interface ReportToSend { id: string; pdf_key: string | null; filename?: string | null }
export interface SendWords { summary: string; done: string }

// "YYYY-MM-DD HH:MM" (a T between is fine) in Grande Prairie's clock → the
// instant, DST-correct: the offset is read back from Intl for the guessed
// instant and applied, twice, so a time on either side of a change lands
// right. A nonsense string is refused in words.
export function localToUtc(local: unknown, zone = ZONE): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(String(local ?? "").trim());
  if (!m) throw refuse("The time must be given as YYYY-MM-DD HH:MM in Grande Prairie's clock.");
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) throw refuse("That is not a real date and time.");
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  // A day the month does not have: Date.UTC rolls 2026-11-31 into the 1st of
  // December without a word, and the card then shows a date nobody asked
  // for — inside the ninety days, so no other guard catches it. Reading the
  // parts back is the whole test.
  const back = new Date(wanted);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    throw refuse("That is not a real date and time.");
  }
  let guess = wanted;
  for (let i = 0; i < 2; i++) guess = wanted - (asLocalMs(guess, zone) - guess);
  if (!Number.isFinite(guess)) throw refuse("That is not a real date and time.");
  // An hour the clock skips: 02:30 on the March morning does not exist, and
  // the two passes land on 01:30 — an hour earlier than the person said,
  // silently. Reading the instant back in the zone proves it is the
  // wall-clock time that was asked for. (On the autumn morning an hour
  // happens TWICE and both readings are true; the passes converge on the
  // FIRST, still on daylight time, which is the one a person means by "the
  // clocks go back tonight, remind me at 01:30".)
  if (asLocalMs(guess, zone) !== wanted) {
    throw refuse("That time does not exist on that day — the clocks go forward. Ask the person for another time.");
  }
  return guess;
}

// The wall-clock reading of an instant in the zone, as if it were UTC.
function asLocalMs(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? "0");
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
}

export function checkRunAt(ms: number, nowMs: number): void {
  if (ms < nowMs - MAX_PAST_MS) throw refuse(`${whenWords(ms)} has already passed. Ask the person for a time still to come, or send it now.`);
  if (ms > nowMs + MAX_AHEAD_MS) throw refuse(`${whenWords(ms)} is more than ninety days away — ask the person to schedule it nearer the time.`);
}

// "Fri, Sep 11, 07:00" in Grande Prairie's clock.
export function whenWords(ms: number, zone = ZONE): string {
  const d = new Date(ms);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: zone, weekday: "short", day: "numeric", month: "short" }).format(d);
  const time = new Intl.DateTimeFormat("en-CA", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return `${day.replace(/\.$/, "").replace(/\.,/, ",")}, ${time}`;
}

// The send function's own gate, applied at fire time to the person who
// scheduled it and the record as it stands now.
export function fireGate(kind: Kind, person: Person, record: Record<string, unknown>): void {
  const tabs = person.tab_access ?? [];
  if (person.deactivated_at || !tabs.length) throw refuse("The account that scheduled this send is locked.");
  const needs = READ_TABS[kind];
  if (needs.length && !needs.some(t => tabs.includes(t))) throw refuse("The account that scheduled this send no longer holds a tab that can read the record.");
  // A reminder has no record and no recipient: an active account is the
  // whole gate.
  if (kind === "reminder") return;
  if (kind === "jha") {
    jhaSendGate(record as unknown as JhaToSend, { id: person.id, role: person.role });
  } else if (kind === "report") {
    const r = record as unknown as ReportToSend;
    if (!r.pdf_key) throw refuse("This report has no PDF on file — nothing was sent.");
    if (!REPORT_SEND_ROLES.includes(person.role)) throw refuse("Only a Technician, Coordinator or Admin can email a report.");
  } else {
    ticketSendGate(record as unknown as TicketToSend, { id: person.id, role: person.role });
  }
}

export function isStuck(row: { status: string; fired_at: string | null }, nowMs: number): boolean {
  if (row.status !== "sending" || !row.fired_at) return false;
  const at = Date.parse(row.fired_at);
  return Number.isFinite(at) && nowMs - at > STUCK_MS;
}

// What the strip and the card call the record.
export function labelFor(kind: Kind, record: { id?: string; pdf_key?: string | null; template?: string | null; filename?: string | null; work_date?: string | null }): string {
  if (kind === "jha") {
    const file = record.pdf_key ? (record.pdf_key.split("/").pop() || "jha.pdf")
      : record.template ? `${record.template.replace(/\s+/g, "-")}.pdf` : "jha.pdf";
    return `JHA ${file}${record.work_date ? ` (${record.work_date})` : ""}`;
  }
  if (kind === "report") return `Report ${record.filename || "(no file name)"}`;
  return `Ticket ${record.id ?? ""}`.trim();
}

export function scheduleWords(kind: Kind, label: string, job: { job_number: string }, to: string[], runAtMs: number): SendWords {
  const what = kind === "ticket_approval" ? `${label} on ${job.job_number} for approval` : `${label} on ${job.job_number}`;
  const list = to.join(", ");
  const when = whenWords(runAtMs);
  return {
    summary: `Send ${what} to ${list} at ${when}?`,
    done: `Scheduled: ${what} goes to ${list} at ${when}. It sends whether or not the app is open; Job detail lists it, and it can be cancelled there or here.`
  };
}

// A to_list as the row stores it ("a@x,b@y") back into addresses.
export function splitList(list: string | null | undefined): string[] {
  return String(list ?? "").split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
}

// What moving a send says: the time, the addresses, or both.
export function rescheduleWords(kind: Kind, label: string, job: { job_number: string }, to: string[], oldRunAtMs: number, newRunAtMs: number, toChanged: boolean): SendWords {
  const what = kind === "ticket_approval" ? `${label} on ${job.job_number} for approval` : `${label} on ${job.job_number}`;
  const list = to.join(", ");
  const was = whenWords(oldRunAtMs);
  const now = whenWords(newRunAtMs);
  const timeChanged = newRunAtMs !== oldRunAtMs;
  const summary = timeChanged && toChanged ? `Send ${what} to ${list} instead, at ${now} (was ${was})?`
    : timeChanged ? `Move the send of ${what} to ${now} (was ${was})?`
    : `Send ${what} to ${list} instead, at ${now}?`;
  return {
    summary,
    done: `Rescheduled: ${what} goes to ${list} at ${now}. It sends whether or not the app is open; Job detail lists it.`
  };
}

// The push the person's own devices get when their scheduled send went or
// failed — the payload push-sw.js tells from a chat push by `kind` and App
// turns into a toast when the app is on screen. The url is the job's own
// address, which the app honours at boot; the tag is the row's own, so two
// results never collapse into one and never into the chat's.
export interface ResultPush {
  kind: "scheduled_send"; id: string; ok: boolean; title: string; body: string; job_number: string; url: string; tag: string;
}
export function resultPushWords(row: { id: string; kind?: string; label: string; to_list: string; run_at: string }, jobNumber: string, error: string | null): ResultPush {
  const failed = !!error;
  const url = jobNumber ? `/#/job/${encodeURIComponent(jobNumber)}` : "/";
  const tag = `scheduled-send-${row.id}`;
  // A reminder's push IS the reminder: the text is the body, the title says
  // which job if one was named, and a failure says why it did not reach a device.
  if (row.kind === "reminder") {
    return {
      kind: "scheduled_send", id: row.id, ok: !failed,
      title: failed ? "Reminder not delivered" : `Reminder${jobNumber ? ` on ${jobNumber}` : ""}`,
      body: error ? error : row.label,
      job_number: jobNumber, url, tag
    };
  }
  return {
    kind: "scheduled_send", id: row.id, ok: !failed,
    title: `${failed ? "Not sent" : "Sent"}: ${row.label} on ${jobNumber}`,
    body: error ? error : `To ${splitList(row.to_list).join(", ")} · ${whenWords(Date.parse(row.run_at))}`,
    job_number: jobNumber, url, tag
  };
}

export function cancelWords(label: string, runAtMs: number, kind?: string): SendWords {
  const when = whenWords(runAtMs);
  if (kind === "reminder") {
    return {
      summary: `Cancel the reminder "${label}" set for ${when}?`,
      done: `Cancelled: the reminder "${label}" will not fire at ${when}.`
    };
  }
  return {
    summary: `Cancel the send of ${label} set for ${when}?`,
    done: `Cancelled: ${label} will not be sent at ${when}.`
  };
}

// A reminder's text: one line, three to three hundred characters, the
// label the row carries and the push's body.
export const REMINDER_MAX = 300;
export function reminderText(v: unknown): string {
  const text = String(v ?? "").replace(/\s+/g, " ").trim();
  if (text.length < 3) throw refuse("A reminder needs a few words — what should it say?");
  if (text.length > REMINDER_MAX) throw refuse(`A reminder is at most ${REMINDER_MAX} characters — shorten it.`);
  return text;
}

// Why a reminder could not go: the tick found no device subscribed for the
// person, or none that would take the push. The strip and the push say it.
export const NO_DEVICE_WORDS = "No device of yours is set up for notifications — turn them on in the drawer, then set the reminder again.";
export const NO_DEVICE_TOOK_IT = "No device of yours accepted the notification — open the app and turn notifications on again, then set the reminder again.";

export function reminderWords(text: string, job: { job_number: string } | null, runAtMs: number): SendWords {
  const when = whenWords(runAtMs);
  const on = job ? ` on ${job.job_number}` : "";
  return {
    summary: `Set a reminder${on} for ${when}: "${text}"?`,
    done: `Set: "${text}" comes as a notification at ${when}${on}, on the devices where notifications are turned on, whether or not the app is open.${job ? " Job detail lists it and can cancel it." : " Ask me to list or cancel it."}`
  };
}
