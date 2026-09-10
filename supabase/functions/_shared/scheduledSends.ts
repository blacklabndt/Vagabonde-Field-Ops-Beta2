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

export const KINDS = ["jha", "report", "ticket_approval"] as const;
export type Kind = typeof KINDS[number];
export function isKind(v: unknown): v is Kind { return typeof v === "string" && (KINDS as readonly string[]).includes(v); }

// send-report's gate.
export const REPORT_SEND_ROLES = JHA_SEND_ROLES;
// The tabs each record's read policy names (the baseline's jhas read,
// reports select and tickets select).
export const READ_TABS: Record<Kind, readonly string[]> = {
  jha: ["jha", "job", "users"],
  report: ["upload", "job", "users"],
  ticket_approval: [] // is_staff(): any tab at all
};
// A row claimed and not reported back in this long died mid-send. It is
// failed, not retried: the email may well have gone, and twice is worse
// than once too few.
export const STUCK_MS = 15 * 60_000;
export const STUCK_WORDS = "The send did not report back — check whether it arrived before sending again.";
// How far ahead and how far behind a time may be set.
export const MAX_AHEAD_MS = 90 * 86_400_000;
export const MAX_PAST_MS = 5 * 60_000;
export const ZONE = "America/Edmonton";

export interface Person { id: string; role: string; tab_access: string[] | null; deactivated_at: string | null }
export interface ReportToSend { id: string; pdf_key: string | null; filename?: string | null }
export interface SendWords { summary: string; done: string }

// "YYYY-MM-DD HH:MM" (a T between is fine) in Grande Prairie's clock → the
// instant, DST-correct: the offset is read back from Intl for the guessed
// instant and applied, twice, so a time on either side of a change lands
// right. A nonsense string is refused in words.
export function localToUtc(local: unknown, zone = ZONE): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(String(local ?? "").trim());
  if (!m) throw new Error("The time must be given as YYYY-MM-DD HH:MM in Grande Prairie's clock.");
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) throw new Error("That is not a real date and time.");
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wanted;
  for (let i = 0; i < 2; i++) guess = wanted - (asLocalMs(guess, zone) - guess);
  if (Number.isNaN(guess)) throw new Error("That is not a real date and time.");
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
  if (ms < nowMs - MAX_PAST_MS) throw new Error(`${whenWords(ms)} has already passed. Ask the person for a time still to come, or send it now.`);
  if (ms > nowMs + MAX_AHEAD_MS) throw new Error(`${whenWords(ms)} is more than ninety days away — ask the person to schedule it nearer the time.`);
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
  if (person.deactivated_at || !tabs.length) throw new Error("The account that scheduled this send is locked.");
  const needs = READ_TABS[kind];
  if (needs.length && !needs.some(t => tabs.includes(t))) throw new Error("The account that scheduled this send no longer holds a tab that can read the record.");
  if (kind === "jha") {
    jhaSendGate(record as unknown as JhaToSend, { id: person.id, role: person.role });
  } else if (kind === "report") {
    const r = record as unknown as ReportToSend;
    if (!r.pdf_key) throw new Error("This report has no PDF on file — nothing was sent.");
    if (!REPORT_SEND_ROLES.includes(person.role)) throw new Error("Only a Technician, Coordinator or Admin can email a report.");
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

export function cancelWords(label: string, runAtMs: number): SendWords {
  const when = whenWords(runAtMs);
  return {
    summary: `Cancel the send of ${label} set for ${when}?`,
    done: `Cancelled: ${label} will not be sent at ${when}.`
  };
}
