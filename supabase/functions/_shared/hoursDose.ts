// Hours and dose for a period, summed on the function side of Ask — pure, no
// imports (backupShared.test.mjs guards that), so the node suite covers the
// period arithmetic and the sums without a database.
//
// Integer hundredths, never float: a numeric(6,2) column arrives as a string
// or a number, and 0.1 + 0.2 is not 0.3. Every figure is turned into whole
// hundredths, summed as integers and turned back once, the way money is.

// A refusal written to be READ by whoever asked — see askSends.ts.
function refuse(words: string): Error {
  const e = new Error(words);
  (e as Error & { plain?: boolean }).plain = true;
  return e;
}

export const ZONE = "America/Edmonton";

export interface Period { start: string; end: string }

const iso = (y: number, m: number, d: number): string => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const lastDayOf = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// A year and a day, so a whole year is one question and not a paging problem.
export const MAX_PERIOD_MS = 366 * 86_400_000;

// Today's date in Grande Prairie's calendar.
export function todayIn(nowMs: number, zone = ZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(nowMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function isDay(v: unknown): v is string {
  if (typeof v !== "string" || !DAY.test(v)) return false;
  const date = new Date(v);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === v;
}

const ymd = (day: string): [number, number, number] => {
  const m = DAY.exec(day);
  if (!m) throw refuse("A date must be YYYY-MM-DD.");
  const [y, mo, d] = m.slice(1).map(Number);
  return [y, mo, d];
};

// The pay period a day falls in: the 1st to the 15th, or the 16th to the
// month's end — data.js's recentPayPeriods, for one day.
export function payPeriodFor(day: string): Period {
  const [y, mo, d] = ymd(day);
  return d <= 15 ? { start: iso(y, mo, 1), end: iso(y, mo, 15) } : { start: iso(y, mo, 16), end: iso(y, mo, lastDayOf(y, mo)) };
}

// The calendar quarter a day falls in — the dose ledger's period.
export function quarterFor(day: string): Period {
  const [y, mo] = ymd(day);
  const first = Math.floor((mo - 1) / 3) * 3 + 1;
  return { start: iso(y, first, 1), end: iso(y, first + 2, lastDayOf(y, first + 2)) };
}

const blank = (v: unknown): boolean => v === undefined || v === null || v === "";

// The range the model asked for: both ends, or neither and the default.
export function periodFrom(start: unknown, end: unknown, fallback: Period): Period {
  if (blank(start) && blank(end)) return fallback;
  if (!isDay(start) || !isDay(end)) throw refuse("Give both start and end as YYYY-MM-DD, or neither for the current period.");
  if (start > end) throw refuse("The start is after the end.");
  if (Date.parse(end) - Date.parse(start) > MAX_PERIOD_MS) throw refuse("A year is the most at once — ask for a shorter period.");
  return { start, end };
}

export function periodWords(p: Period): string { return `${p.start} to ${p.end}`; }

export interface CrewRow {
  job_number: string; work_date: string;
  straight_hours: unknown; ot_hours: unknown; solo_hours: unknown; solo_ot_hours: unknown; mileage_km: unknown;
}
export interface HoursTotal { days: number; straight: number; ot: number; solo: number; solo_ot: number; mileage_km: number }
export interface HoursByJob extends HoursTotal { job_number: string }

const hundredths = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
const back = (h: number): number => h / 100;

interface Acc { days: Set<string>; straight: number; ot: number; solo: number; solo_ot: number; mileage_km: number }
const acc = (): Acc => ({ days: new Set(), straight: 0, ot: 0, solo: 0, solo_ot: 0, mileage_km: 0 });
const add = (a: Acc, r: CrewRow): void => {
  a.days.add(r.work_date);
  a.straight += hundredths(r.straight_hours); a.ot += hundredths(r.ot_hours);
  a.solo += hundredths(r.solo_hours); a.solo_ot += hundredths(r.solo_ot_hours);
  a.mileage_km += hundredths(r.mileage_km);
};
const out = (a: Acc): HoursTotal => ({
  days: a.days.size, straight: back(a.straight), ot: back(a.ot), solo: back(a.solo), solo_ot: back(a.solo_ot), mileage_km: back(a.mileage_km)
});

// Per job in the order first met, and the total; days are distinct work
// dates, so two tickets on one day are one day.
export function sumHours(rows: CrewRow[]): { per_job: HoursByJob[]; total: HoursTotal } {
  const jobs = new Map<string, Acc>();
  const all = acc();
  for (const r of rows) {
    const j = jobs.get(r.job_number) ?? acc();
    add(j, r); add(all, r);
    jobs.set(r.job_number, j);
  }
  return { per_job: [...jobs.entries()].map(([job_number, j]) => ({ job_number, ...out(j) })), total: out(all) };
}
