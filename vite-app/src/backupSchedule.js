// When the project next copies itself to the drive.
//
// Pure, so it can be tested and so the panel and the Edge Function can both
// hold it. Everything below the marker is duplicated into
// supabase/functions/_shared/backupSchedule.ts, the same code with type
// annotations added — the tick that starts a run and the line that tells
// the Admin when it is due must never disagree — and
// backupSchedule.test.mjs reads both files back, strips the types from the
// function's copy and compares them.
//
// The zone is Grande Prairie's, and it is done with Intl rather than a
// fixed offset because Alberta moves twice a year: an offset baked in in
// January runs an hour early all summer.

// ═══ shared core · keep identical with the other backupSchedule, types aside ═══
export const BACKUP_ZONE = "America/Edmonton";

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const FIELDS = new Intl.DateTimeFormat("en-CA", {
  timeZone: BACKUP_ZONE, hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short"
});

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// The wall clock in Grande Prairie at a given UTC instant. hour12:false
// answers midnight as "24" in some ICU builds and "00" in others, so it is
// taken modulo 24 rather than trusted.
export function zonedFields(ms) {
  const out = {};
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
export function instantAt(year, month, day, hour) {
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

export function matchesDay(frequency, weekday, fields) {
  if (frequency === "daily") return true;
  if (frequency === "weekdays") return fields.dow >= 1 && fields.dow <= 5;
  if (frequency === "weekly") return fields.dow === (Number(weekday) || 0);
  if (frequency === "monthly") return fields.day === 1;
  return false;
}

const cleanHour = (value) => {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(23, Math.max(0, n));
};

// The next moment after `now` that the schedule calls for, as an ISO string
// in UTC — which is what app_settings.backup_next_run_at holds and what the
// tick compares against. Strictly after: asked at exactly the scheduled
// instant it answers the following one, so a run cannot restart itself.
export function nextRunAt(settings, now) {
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

export function describeSchedule(settings) {
  const s = settings || {};
  const at = `${String(cleanHour(s.hour)).padStart(2, "0")}:00`;
  const when = s.frequency === "weekdays" ? "Weekdays"
    : s.frequency === "weekly" ? `Every ${WEEKDAY_NAMES[Number(s.weekday) || 0]}`
    : s.frequency === "monthly" ? "On the 1st of each month"
    : "Every day";
  return `${when} at ${at}, Grande Prairie time`;
}
// ═══ end shared core ═══
