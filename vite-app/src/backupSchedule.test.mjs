// The clock behind the automatic backup. It is pure, it is small, and it
// decides at what moment the project copies itself to a drive — so the
// interesting cases are the two mornings a year when Alberta's wall clock
// skips or repeats an hour, and the month ends where "the 1st" is the next
// month rather than this one.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import {
  BACKUP_ZONE, WEEKDAY_NAMES, zonedFields, instantAt, matchesDay,
  nextRunAt, describeSchedule
} from "./backupSchedule.js";

const wall = iso => {
  const f = zonedFields(new Date(iso).getTime());
  return `${f.year}-${String(f.month).padStart(2, "0")}-${String(f.day).padStart(2, "0")} ${String(f.hour).padStart(2, "0")}:${String(f.minute).padStart(2, "0")}`;
};

test("the zone is the crew's own", () => {
  assert.equal(BACKUP_ZONE, "America/Edmonton");
  assert.equal(WEEKDAY_NAMES[0], "Sunday");
  assert.equal(WEEKDAY_NAMES[6], "Saturday");
});

test("zonedFields reads Grande Prairie's wall clock, not UTC's", () => {
  // 2026-01-15 09:00 UTC is 02:00 MST the same morning.
  const f = zonedFields(Date.parse("2026-01-15T09:00:00Z"));
  assert.deepEqual(
    { y: f.year, m: f.month, d: f.day, h: f.hour, dow: f.dow },
    { y: 2026, m: 1, d: 15, h: 2, dow: 4 }
  );
});

test("zonedFields calls midnight hour 0, never 24", () => {
  const f = zonedFields(Date.parse("2026-01-15T07:00:00Z")); // 00:00 MST
  assert.equal(f.hour, 0);
  assert.equal(f.day, 15);
});

test("instantAt lands on the wall clock in winter and in summer", () => {
  assert.equal(instantAt(2026, 1, 15, 2), Date.parse("2026-01-15T09:00:00Z")); // MST, -7
  assert.equal(instantAt(2026, 7, 15, 2), Date.parse("2026-07-15T08:00:00Z")); // MDT, -6
});

test("instantAt on the spring-forward morning gives the first real moment", () => {
  // 2026-03-08: 02:00 MST becomes 03:00 MDT, so 02:00 never happens.
  // The answer must still be a single, definite instant on that morning.
  const at = instantAt(2026, 3, 8, 2);
  assert.equal(new Date(at).toISOString(), "2026-03-08T09:00:00.000Z");
  assert.equal(wall("2026-03-08T09:00:00Z"), "2026-03-08 03:00");
});

test("instantAt on the fall-back morning takes the first of the two 01:00s", () => {
  // 2026-11-01: 02:00 MDT becomes 01:00 MST, so 01:00 happens twice.
  const at = instantAt(2026, 11, 1, 1);
  assert.equal(new Date(at).toISOString(), "2026-11-01T07:00:00.000Z");
});

test("matchesDay knows each frequency", () => {
  const sunday = zonedFields(Date.parse("2026-08-16T12:00:00Z"));
  const monday = zonedFields(Date.parse("2026-08-17T12:00:00Z"));
  const first = zonedFields(Date.parse("2026-09-01T12:00:00Z"));
  assert.equal(matchesDay("daily", 0, sunday), true);
  assert.equal(matchesDay("weekdays", 0, sunday), false);
  assert.equal(matchesDay("weekdays", 0, monday), true);
  assert.equal(matchesDay("weekly", 1, monday), true);
  assert.equal(matchesDay("weekly", 2, monday), false);
  assert.equal(matchesDay("monthly", 0, first), true);
  assert.equal(matchesDay("monthly", 0, monday), false);
  assert.equal(matchesDay("nonsense", 0, monday), false);
});

test("daily rolls to tomorrow once today's hour has gone", () => {
  const settings = { frequency: "daily", weekday: 0, hour: 2 };
  // 01:00 Edmonton on the 15th — today's 02:00 is still ahead.
  assert.equal(nextRunAt(settings, Date.parse("2026-01-15T08:00:00Z")), "2026-01-15T09:00:00.000Z");
  // 03:00 Edmonton — today's has gone.
  assert.equal(nextRunAt(settings, Date.parse("2026-01-15T10:00:00Z")), "2026-01-16T09:00:00.000Z");
});

test("daily never returns the instant it was asked at", () => {
  const settings = { frequency: "daily", weekday: 0, hour: 2 };
  const exactly = Date.parse("2026-01-15T09:00:00Z");
  assert.equal(nextRunAt(settings, exactly), "2026-01-16T09:00:00.000Z");
});

test("weekdays skips Saturday and Sunday", () => {
  const settings = { frequency: "weekdays", weekday: 0, hour: 2 };
  // Friday 2026-08-21, after the hour, so the next one is Monday the 24th.
  assert.equal(wall(nextRunAt(settings, Date.parse("2026-08-21T10:00:00Z"))), "2026-08-24 02:00");
});

test("weekly waits for its own day", () => {
  const settings = { frequency: "weekly", weekday: 3, hour: 23 }; // Wednesday
  assert.equal(wall(nextRunAt(settings, Date.parse("2026-08-20T12:00:00Z"))), "2026-08-26 23:00");
});

test("weekly asked on its own day before the hour keeps today", () => {
  const settings = { frequency: "weekly", weekday: 1, hour: 22 }; // Monday
  assert.equal(wall(nextRunAt(settings, Date.parse("2026-08-17T12:00:00Z"))), "2026-08-17 22:00");
});

test("monthly means the 1st, across a month end and a year end", () => {
  const settings = { frequency: "monthly", weekday: 0, hour: 2 };
  assert.equal(wall(nextRunAt(settings, Date.parse("2026-01-31T23:00:00Z"))), "2026-02-01 02:00");
  assert.equal(wall(nextRunAt(settings, Date.parse("2026-02-28T23:00:00Z"))), "2026-03-01 02:00");
  assert.equal(wall(nextRunAt(settings, Date.parse("2026-12-31T23:00:00Z"))), "2027-01-01 02:00");
});

test("a daily 02:00 still fires on the morning 02:00 does not exist", () => {
  const settings = { frequency: "daily", weekday: 0, hour: 2 };
  const at = nextRunAt(settings, Date.parse("2026-03-07T12:00:00Z"));
  assert.equal(wall(at), "2026-03-08 03:00");
});

test("a daily 01:00 fires once on the morning 01:00 happens twice", () => {
  const settings = { frequency: "daily", weekday: 0, hour: 1 };
  assert.equal(nextRunAt(settings, Date.parse("2026-10-31T20:00:00Z")), "2026-11-01T07:00:00.000Z");
});

test("rubbish settings fall back to a daily midnight rather than throwing", () => {
  assert.equal(wall(nextRunAt({}, Date.parse("2026-08-17T12:00:00Z"))), "2026-08-18 00:00");
  assert.equal(wall(nextRunAt({ frequency: "daily", hour: "9" }, Date.parse("2026-08-17T12:00:00Z"))), "2026-08-17 09:00");
  assert.equal(wall(nextRunAt({ frequency: "daily", hour: 99 }, Date.parse("2026-08-17T12:00:00Z"))), "2026-08-17 23:00");
});

test("describeSchedule says it in words a person reads", () => {
  assert.equal(describeSchedule({ frequency: "daily", hour: 2 }), "Every day at 02:00, Grande Prairie time");
  assert.equal(describeSchedule({ frequency: "weekdays", hour: 23 }), "Weekdays at 23:00, Grande Prairie time");
  assert.equal(describeSchedule({ frequency: "weekly", weekday: 5, hour: 0 }), "Every Friday at 00:00, Grande Prairie time");
  assert.equal(describeSchedule({ frequency: "monthly", hour: 6 }), "On the 1st of each month at 06:00, Grande Prairie time");
});

// ── The mirror ───────────────────────────────────────────────────────────
// The tick inside backup-run computes the next run the same way the panel
// does, and the two live in different runtimes. Rather than trust that,
// both files carry the same block between the same markers, and this
// reads them off disk and insists they are the same code. The function's
// copy carries type annotations, because Deno's checker reads it, so its
// block is compared with the types stripped (Node's own stripper, which
// leaves whitespace where they were) and every run of whitespace folded.

const CORE = /\/\/ ═══ shared core[^\n]*\n([\s\S]*?)\/\/ ═══ end shared core ═══/;

const coreOf = path => {
  const m = CORE.exec(readFileSync(new URL(path, import.meta.url), "utf8"));
  assert.ok(m, `${path} has no shared-core block`);
  return m[1];
};

// A stripped annotation leaves its spaces behind — `(ms: number): Fields {`
// becomes `(ms        )         {` — so each line's whitespace is folded to
// one space and the space left before a closing bracket or a comma dropped.
const shapeOf = code => code.split("\n")
  .map(l => l.replace(/\s+/g, " ").replace(/ (?=[),;])/g, "").trim())
  .filter(Boolean).join("\n");

test("the panel's schedule and the function's are the same code", () => {
  const js = coreOf("./backupSchedule.js");
  const ts = coreOf("../../supabase/functions/_shared/backupSchedule.ts");
  assert.ok(js.includes("export function nextRunAt"), "the core must hold nextRunAt itself");
  assert.ok(/zonedFields\(ms: number\)/.test(ts), "the function's copy is the typed one");
  assert.equal(shapeOf(stripTypeScriptTypes(ts)), shapeOf(js));
});
