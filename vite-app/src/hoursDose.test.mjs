// Hours and dose for a period: the pay period and the quarter a day falls
// in, the range the model may ask for, and sums that never float.

import test from "node:test";
import assert from "node:assert/strict";
import { todayIn, isDay, payPeriodFor, quarterFor, periodFrom, periodWords, sumHours, MAX_PERIOD_MS } from "../../supabase/functions/_shared/hoursDose.ts";

test("today is Grande Prairie's date, not UTC's", () => {
  // 2026-09-11 03:30 UTC is still 10 Sept in Alberta.
  assert.equal(todayIn(Date.UTC(2026, 8, 11, 3, 30)), "2026-09-10");
  assert.equal(todayIn(Date.UTC(2026, 8, 11, 12, 0)), "2026-09-11");
  assert.equal(isDay("2026-09-10"), true);
  assert.equal(isDay("2026-9-10"), false);
  assert.equal(isDay("2026-13-40"), false);
  assert.equal(isDay(20260910), false);
});

test("a pay period is the 1st to the 15th or the 16th to the month's end, February included", () => {
  assert.deepEqual(payPeriodFor("2026-09-10"), { start: "2026-09-01", end: "2026-09-15" });
  assert.deepEqual(payPeriodFor("2026-09-15"), { start: "2026-09-01", end: "2026-09-15" });
  assert.deepEqual(payPeriodFor("2026-09-16"), { start: "2026-09-16", end: "2026-09-30" });
  assert.deepEqual(payPeriodFor("2026-02-20"), { start: "2026-02-16", end: "2026-02-28" });
  assert.deepEqual(payPeriodFor("2028-02-20"), { start: "2028-02-16", end: "2028-02-29" });
  assert.deepEqual(payPeriodFor("2026-12-31"), { start: "2026-12-16", end: "2026-12-31" });
});

test("a quarter is the calendar quarter", () => {
  assert.deepEqual(quarterFor("2026-09-10"), { start: "2026-07-01", end: "2026-09-30" });
  assert.deepEqual(quarterFor("2026-01-01"), { start: "2026-01-01", end: "2026-03-31" });
  assert.deepEqual(quarterFor("2026-12-31"), { start: "2026-10-01", end: "2026-12-31" });
  assert.deepEqual(quarterFor("2026-04-15"), { start: "2026-04-01", end: "2026-06-30" });
});

test("the range is both ends or neither; half a range, a backwards one or more than a year is refused", () => {
  const fallback = { start: "2026-09-01", end: "2026-09-15" };
  assert.deepEqual(periodFrom(undefined, undefined, fallback), fallback);
  assert.deepEqual(periodFrom("", null, fallback), fallback);
  assert.deepEqual(periodFrom("2026-08-01", "2026-08-31", fallback), { start: "2026-08-01", end: "2026-08-31" });
  assert.throws(() => periodFrom("2026-08-01", undefined, fallback), /both start and end/);
  assert.throws(() => periodFrom("Aug 1", "2026-08-31", fallback), /both start and end/);
  assert.throws(() => periodFrom("2026-08-31", "2026-08-01", fallback), /start is after the end/);
  assert.throws(() => periodFrom("2025-01-01", "2026-02-01", fallback), /A year is the most/);
  assert.equal(MAX_PERIOD_MS, 366 * 86400000);
  assert.equal(periodWords(fallback), "2026-09-01 to 2026-09-15");
});

test("hours sum per job and in total in whole hundredths, days as distinct work dates", () => {
  const rows = [
    { job_number: "S-1", work_date: "2026-09-01", straight_hours: "0.1", ot_hours: 0.2, solo_hours: 0, solo_ot_hours: 0, mileage_km: "120.5" },
    { job_number: "S-1", work_date: "2026-09-01", straight_hours: 0.2, ot_hours: "0.1", solo_hours: 1.5, solo_ot_hours: 0.5, mileage_km: 0 },
    { job_number: "S-2", work_date: "2026-09-02", straight_hours: 8, ot_hours: 2, solo_hours: 0, solo_ot_hours: 0, mileage_km: 60.3 },
    { job_number: "S-1", work_date: "2026-09-03", straight_hours: 10, ot_hours: 0, solo_hours: 0, solo_ot_hours: 0, mileage_km: "garbage" }
  ];
  const s = sumHours(rows);
  assert.deepEqual(s.per_job, [
    { job_number: "S-1", days: 2, straight: 10.3, ot: 0.3, solo: 1.5, solo_ot: 0.5, mileage_km: 120.5 },
    { job_number: "S-2", days: 1, straight: 8, ot: 2, solo: 0, solo_ot: 0, mileage_km: 60.3 }
  ]);
  assert.deepEqual(s.total, { days: 3, straight: 18.3, ot: 2.3, solo: 1.5, solo_ot: 0.5, mileage_km: 180.8 });
  assert.deepEqual(sumHours([]), { per_job: [], total: { days: 0, straight: 0, ot: 0, solo: 0, solo_ot: 0, mileage_km: 0 } });
});
