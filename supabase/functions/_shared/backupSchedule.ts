// When the project next copies itself to the drive — the Edge Function's
// copy. Everything between the markers is the same code as
// vite-app/src/backupSchedule.js — the same, types aside: this copy is
// annotated because Deno's checker reads it, and its twin is JavaScript —
// so the tick that starts a run and the line the Admin reads on the panel
// cannot drift apart; vite-app/src/backupSchedule.test.mjs reads both
// files, strips the types from this one and compares them. Change one,
// change the other, in the same commit. The types themselves live above
// the marker, where the twin has nothing to match.
//
// Erasable TypeScript only, and no imports: the node suite imports this
// file directly to prove it matches its twin.

// What the panel saves about the schedule, as nextRunAt reads it: the
// frequency is daily, weekdays, weekly or monthly, the hour and weekday
// whatever the row holds (cleanHour makes a number of the hour), and any
// of them may be missing.
export interface BackupSchedule {
  frequency?: string | null;
  weekday?: number | string | null;
  hour?: number | string | null;
}

// The wall clock in Grande Prairie broken into its fields.
export interface ZonedFields {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
  dow: number;
}

// ═══ shared core · keep identical with the other backupSchedule, types aside ═══
export const BACKUP_ZONE = "America/Edmonton";

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const FIELDS = new Intl.DateTimeFormat("en-CA", {
  timeZone: BACKUP_ZONE, hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short"
});

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// The wall clock in Grande Prairie at a given UTC instant. hour12:false
// answers midnight as "24" in some ICU builds and "00" in others, so it is
// taken modulo 24 rather than trusted.
export function zonedFields(ms: number): ZonedFields {
  const out: Record<string, string> = {};
  for (const p of FIELDS.formatToParts(new Date(ms))) out[p.type] = p.value;
  return {
    year: Number(out.year), month: Number(out.month), day: Number(out.day),
    hour: Number(out.hour) % 24, minute: Number(out.minute), second: Number(out.second),
    dow: DOW[out.weekday]
  };
}

// The instant at which Grande Prairie's wall clock reads y-m-d hour:00.
// Guess as though the zone were UTC, look at what that instant actually
// reads, and correct by the difference; two passes settle it anywhere but a
// changeover morning. On the morning 02:00 does not exist the correction
// oscillates by an hour, so the loop is capped and returns the last guess —
// 03:00 local, the first real moment at or after the missing hour. On the
// morning 01:00 happens twice it settles on the first of the two.
export function instantAt(year: number, month: number, day: number, hour: number): number {
  const wall = Date.UTC(year, month - 1, day, hour, 0, 0);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const f = zonedFields(guess);
    const seen = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
    const corrected = guess + (wall - seen);
    if (corrected === guess) return guess;
    guess = corrected;
  }
  return guess;
}

export function matchesDay(frequency: string, weekday: number | string | null | undefined, fields: ZonedFields): boolean {
  if (frequency === "daily") return true;
  if (frequency === "weekdays") return fields.dow >= 1 && fields.dow <= 5;
  if (frequency === "weekly") return fields.dow === (Number(weekday) || 0);
  if (frequency === "monthly") return fields.day === 1;
  return false;
}

const cleanHour = (value: unknown): number => {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(23, Math.max(0, n));
};

// The next moment after `now` that the schedule calls for, as an ISO string
// in UTC — which is what app_settings.backup_next_run_at holds and what the
// tick compares against. Strictly after: asked at exactly the scheduled
// instant it answers the following one, so a run cannot restart itself.
export function nextRunAt(settings: BackupSchedule | null | undefined, now: number | string | Date | null | undefined): string | null {
  const s = settings || {};
  const frequency = s.frequency || "daily";
  const hour = cleanHour(s.hour);
  const from = typeof now === "number" ? now : new Date(now || Date.now()).getTime();
  if (!Number.isFinite(from)) return null;
  let day = zonedFields(from);
  for (let i = 0; i < 400; i++) {
    const at = instantAt(day.year, day.month, day.day, hour);
    if (at > from && matchesDay(frequency, s.weekday, zonedFields(at))) {
      return new Date(at).toISOString();
    }
    const nextDay = new Date(Date.UTC(day.year, day.month - 1, day.day) + 86400000);
    day = {
      year: nextDay.getUTCFullYear(), month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(), dow: nextDay.getUTCDay(), hour: 0, minute: 0, second: 0
    };
  }
  return null;
}

export function describeSchedule(settings: BackupSchedule | null | undefined): string {
  const s = settings || {};
  const at = `${String(cleanHour(s.hour)).padStart(2, "0")}:00`;
  const when = s.frequency === "weekdays" ? "Weekdays"
    : s.frequency === "weekly" ? `Every ${WEEKDAY_NAMES[Number(s.weekday) || 0]}`
    : s.frequency === "monthly" ? "On the 1st of each month"
    : "Every day";
  return `${when} at ${at}, Grande Prairie time`;
}
// ═══ end shared core ═══
