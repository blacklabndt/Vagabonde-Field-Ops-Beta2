// Where the next slice picks up: the run cursor, and the arithmetic that
// moves it.
//
// A backup is done in slices because a function invocation has a wall-clock
// ceiling. Nothing here talks to a drive or a database — this is the
// bookkeeping only, so it can be exercised by the node suite: how much of
// the invocation is left, which table part comes next, where the walk of a
// bucket's folders had got to, and whether the slice that wrote the last
// heartbeat is plausibly still running.
//
// Erasable TypeScript only, and no imports: vite-app/src/backupShared.test.mjs
// imports this file straight out of supabase/functions/ and node strips the
// types. The counts that belong to a table (LOAD_ORDER, BUCKETS, PAGE_ROWS)
// are passed in rather than imported for the same reason.
//
// The functions mutate the cursor they are given and return it, the way
// backupManifest's recorders do — a cursor is one object carried through a
// slice and written back to backup_runs at the end of every unit. Call them
// as `c = afterTablePart(c, …)` so that stays visible at the call site.

export interface PrefixFrame { prefix: string; offset: number }

export interface RunCursor {
  phase: string;
  tableIndex: number;
  partIndex: number;
  lastKey: string | null;
  offset: number;
  rows: Record<string, number>;
  parts: Record<string, string[]>;
  index: Record<string, Record<string, unknown>[]>;
  bucketIndex: number;
  prefixes: PrefixFrame[];
  pageDone: number;
  files: number;
  bytes: number;
  // Carrying unchanged files over: whether this run has looked for a base
  // folder yet, the id of that folder's files/ (null when there is none),
  // and how many files were copied on the drive rather than pulled
  // through Supabase.
  baseLooked: boolean;
  baseFilesFolderId: string | null;
  reused: number;
  removed?: string[];
  startedAt: string;
}

// A slice's share of the invocation. The platform's ceiling is higher; the
// margin is for the upload already in flight when the budget runs out.
export const BUDGET_MS = 100_000;

// How recent a heartbeat has to be for the slice that wrote it to be
// treated as still running. Longer than any single unit can take — one part
// uploaded, or one page of files, with three retries and their backoff
// behind it — and shorter than the five minutes between cron ticks, so a
// slice whose self-kick was lost is picked up by the next tick rather than
// waiting out a ten-minute staleness window. Two slices of one run at once
// would upload the same part twice and fight over the cursor, which costs
// repeated work rather than a hole; a run left sitting costs the schedule.
export const SLICE_ALIVE_MS = 3 * 60_000;

// A failed unit is tried this many times over before the run fails with the
// last reason — and only when the drive said the refusal was worth
// retrying. The gaps widen; the total is under half a slice's budget.
export const RETRIES = 3;
export const BACKOFF_MS = [1_000, 4_000, 10_000];

export function newRunCursor(startedAt: string): RunCursor {
  return {
    phase: "tables",
    tableIndex: 0,
    partIndex: 0,
    lastKey: null,
    offset: 0,
    rows: {},
    parts: {},
    // The jobs index the per-job restore picks from, folded out of rows the
    // tables phase is reading anyway. Emptied once the manifest holds it.
    index: { jobs: [], clients: [], tickets: [], jhas: [], reports: [] },
    bucketIndex: 0,
    prefixes: [],
    pageDone: 0,
    files: 0,
    bytes: 0,
    baseLooked: false,
    baseFilesFolderId: null,
    reused: 0,
    startedAt
  };
}

// A cursor read back out of jsonb has whatever shape the slice that wrote it
// left behind, and a run created before a field existed has none at all. Fill
// the gaps rather than trusting them: a missing `parts` array read as
// undefined would throw halfway through a table.
export function reviveCursor(raw: unknown, startedAt: string): RunCursor {
  const c = (raw ?? {}) as Record<string, unknown>;
  const base = newRunCursor(String(c.startedAt ?? startedAt));
  const index = (c.index ?? {}) as Record<string, unknown>;
  return {
    ...base,
    phase: typeof c.phase === "string" && c.phase ? c.phase : base.phase,
    tableIndex: num(c.tableIndex),
    partIndex: num(c.partIndex),
    lastKey: c.lastKey === null || c.lastKey === undefined ? null : String(c.lastKey),
    offset: num(c.offset),
    rows: (c.rows ?? {}) as Record<string, number>,
    parts: (c.parts ?? {}) as Record<string, string[]>,
    index: {
      jobs: arr(index.jobs), clients: arr(index.clients),
      tickets: arr(index.tickets), jhas: arr(index.jhas), reports: arr(index.reports)
    },
    bucketIndex: num(c.bucketIndex),
    prefixes: Array.isArray(c.prefixes)
      ? (c.prefixes as PrefixFrame[]).map(p => ({ prefix: String(p?.prefix ?? ""), offset: num(p?.offset) }))
      : [],
    pageDone: num(c.pageDone),
    files: num(c.files),
    bytes: num(c.bytes),
    // A cursor from before these existed looks for its base again, which
    // costs one listing and nothing else.
    baseLooked: c.baseLooked === true,
    baseFilesFolderId: typeof c.baseFilesFolderId === "string" && c.baseFilesFolderId ? c.baseFilesFolderId : null,
    reused: num(c.reused)
  };
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v as Record<string, unknown>[] : []);

// ── The budget ───────────────────────────────────────────────────────────

export function sliceDeadline(startedMs: number, budgetMs = BUDGET_MS): number {
  return startedMs + budgetMs;
}

export function budgetLeft(deadline: number, now: number): number {
  return Math.max(0, deadline - now);
}

export function outOfBudget(deadline: number, now: number): boolean {
  return now >= deadline;
}

// Is the slice that wrote this heartbeat plausibly still going? A run with
// no heartbeat at all was never started by anybody, so it is not alive.
export function sliceLooksAlive(heartbeatAt: string | null | undefined, now: number): boolean {
  if (!heartbeatAt) return false;
  const beat = Date.parse(String(heartbeatAt));
  if (!Number.isFinite(beat)) return false;
  return now - beat < SLICE_ALIVE_MS;
}

// Three goes at a unit the drive said was worth retrying, then the run
// fails with the last reason and the next scheduled one is unaffected. The
// flag on the error is asked, never its prose — a message that happens to
// contain the word "busy" is not evidence of anything.
export function isRetryable(e: unknown): boolean {
  return !!e && (e as { retryable?: boolean }).retryable === true;
}

export function shouldRetry(e: unknown, attempt: number, retries = RETRIES): boolean {
  return isRetryable(e) && attempt < retries;
}

// The same question asked of the token endpoint, which answers in two ways
// the drive's own API does not. A 5xx or a 429 carries `retryable` and is
// covered by the flag; a refusal that never arrived at all — the socket
// dropped, DNS blinked — throws a TypeError out of fetch with no status on
// it, and that is worth another go too. An invalid_grant is a 400 with the
// flag clear, and three tries at it only delay telling the Admin to
// reconnect; so is a plain Error raised by the module itself, which is why
// the absence of a status is not on its own enough.
export function worthAnotherGo(e: unknown): boolean {
  if (isRetryable(e)) return true;
  const err = (e ?? {}) as { status?: number; name?: string };
  return err.status === undefined && err.name === "TypeError";
}

export function retryDelayMs(attempt: number): number {
  const i = Math.max(0, Math.min(attempt, BACKOFF_MS.length - 1));
  return BACKOFF_MS[i];
}

// ── Phase: tables ────────────────────────────────────────────────────────

// One part of one table has been read and uploaded. `exhausted` means the
// last page came back short, so the table is finished and the next slice
// starts the one after it; otherwise the same table continues from the key
// or the offset the walk reached.
export function afterTablePart(c: RunCursor, done: {
  table: string;
  tableCount: number;
  rows: number;
  partName: string;
  exhausted: boolean;
  lastKey: string | null;
  offset: number;
}): RunCursor {
  c.rows[done.table] = num(c.rows[done.table]) + num(done.rows);
  c.parts[done.table] = [...(c.parts[done.table] ?? []), done.partName];

  if (done.exhausted) {
    c.tableIndex += 1;
    c.partIndex = 0;
    c.lastKey = null;
    c.offset = 0;
    if (c.tableIndex >= done.tableCount) c.phase = "files";
  } else {
    c.partIndex += 1;
    c.lastKey = done.lastKey;
    c.offset = done.offset;
  }
  return c;
}

// The index is built out of rows the tables phase is already reading — jobs
// load after clients and before tickets, so by the time the last of the five
// has gone by it has everything it needs. Only the columns the index shows
// are kept: the rest would put the whole database in the cursor.
export function foldIntoIndex(c: RunCursor, table: string, rows: Record<string, unknown>[]): RunCursor {
  if (table === "clients") {
    for (const r of rows) c.index.clients.push({ id: r.id, name: r.name });
  } else if (table === "jobs") {
    for (const r of rows) c.index.jobs.push({
      id: r.id, job_number: r.job_number, project: r.project,
      status: r.status, created_at: r.created_at, client_id: r.client_id
    });
  } else if (table === "tickets" || table === "jhas" || table === "reports") {
    for (const r of rows) c.index[table].push({ job_id: r.job_id });
  }
  return c;
}

export function forgetIndex(c: RunCursor): RunCursor {
  c.index = { jobs: [], clients: [], tickets: [], jhas: [], reports: [] };
  return c;
}

// ── Phase: manifest, and what comes after it ─────────────────────────────

// A scheduled backup ends by pruning the drive to backup_keep folders. A
// before-restore copy must not: it is taken with a restore already in
// flight, and retention counts folders without knowing which one that
// restore is about to read from — on the live keep of 1 the safety copy's
// own retention step would delete the very backup being restored, after the
// wipe and before the load, leaving an empty database and no source. So
// that kind stops at the manifest.
export function nextPhaseAfterManifest(kind: string): string {
  return String(kind ?? "") === "before_restore" ? "done" : "retention";
}

// ── Phase: files ─────────────────────────────────────────────────────────

// Storage lists one prefix at a time, so the walk carries a stack of
// prefixes still to visit. An empty stack means this bucket has not been
// started yet — the stack is emptied and the bucket advanced together at
// the end of a bucket, so the two cannot be confused.
export function startPrefixWalk(c: RunCursor): PrefixFrame {
  if (!Array.isArray(c.prefixes) || !c.prefixes.length) {
    c.prefixes = [{ prefix: "", offset: 0 }];
    c.pageDone = 0;
  }
  return c.prefixes[c.prefixes.length - 1];
}

// A slice ran out of budget partway through a page of objects. Nothing else
// moves: the same page is listed again next slice, at the same offset, and
// the first `pageDone` objects are skipped.
export function pausePage(c: RunCursor, at: number, files: number, bytes: number, reused = 0): RunCursor {
  c.pageDone = at;
  c.files += files;
  c.bytes += bytes;
  c.reused += num(reused);
  return c;
}

// A page of one prefix has been copied in full. Depth first: sub-prefixes go
// on the stack, and this prefix advances past what was just listed — a short
// page is the end of it. When the stack empties, so does the bucket.
export function afterFilesPage(c: RunCursor, done: {
  bucketCount: number;
  pageLength: number;
  pageRows: number;
  folderNames: string[];
  files: number;
  bytes: number;
  reused?: number;
}): RunCursor {
  const top = c.prefixes[c.prefixes.length - 1];
  c.files += num(done.files);
  c.bytes += num(done.bytes);
  c.reused += num(done.reused);
  c.pageDone = 0;

  top.offset += num(done.pageLength);
  if (done.pageLength < done.pageRows) c.prefixes.pop();
  for (const name of done.folderNames) c.prefixes.push({ prefix: top.prefix + name + "/", offset: 0 });

  if (!c.prefixes.length) {
    c.bucketIndex += 1;
    if (c.bucketIndex >= done.bucketCount) c.phase = "manifest";
  }
  return c;
}

// ── Whether this slice still holds the run ───────────────────────────────

// Every write a slice makes to its own run is conditional on the run still
// being `running` — the status it was claimed at — and PostgREST answers a
// conditional update with the rows it matched, so zero rows back is the
// whole answer: another slice reclaimed this run after its heartbeat went
// quiet and has since written an outcome of its own. Reclaiming deliberately
// has no compare-and-swap on the heartbeat (a CAS on a timestamptz across
// PostgREST that failed to match would wedge the schedule for ever), which
// is exactly why the superseded slice has to be the one that notices: it
// stops where it is rather than overwriting a finished run's cursor, or
// flipping a complete run to failed on its way out.
export function stillHoldsRun(matched: unknown): boolean {
  if (matched === null || matched === undefined) return false;
  if (Array.isArray(matched)) return matched.length > 0;
  return true;
}

// ── What the panel counts ────────────────────────────────────────────────

export function countsOf(c: RunCursor): { rows: Record<string, number>; files: number; bytes: number; reused: number } {
  return { rows: c.rows, files: num(c.files), bytes: num(c.bytes), reused: num(c.reused) };
}

// ── Carrying unchanged files over ────────────────────────────────────────
//
// Every night's folder is complete on its own — the restore reads one
// folder and retention deletes whole ones — but the bytes of a report PDF
// do not change between nights, only the folder they sit in. So an object
// whose key can never be reused is copied from last night's folder ON the
// drive when that folder holds a file of the same name and size, and only
// what the previous folder lacks is pulled through Supabase. That turns the
// nightly egress from the whole store into what is new.
//
// Same name and same size is the whole test, which is why only buckets
// whose keys are written once qualify: reports keys carry Date.now() and
// chat-media keys are UUIDs. jhas are re-rendered at close-out and
// timesheets at approval, both at the same key; a shared file deleted and
// re-uploaded has the same key. Those are copied fresh every night.
export const WRITE_ONCE_BUCKETS: readonly string[] = ["reports", "chat-media"];

export function carryOverId(
  bucket: string, entryName: string, size: number,
  base: Map<string, { id: string; size: number }>
): string | null {
  if (!WRITE_ONCE_BUCKETS.includes(bucket)) return null;
  if (!Number.isFinite(size) || size < 0) return null;
  const held = base.get(entryName);
  if (!held || !held.id) return null;
  return num(held.size) === size ? held.id : null;
}

// The base is the newest stamped folder in the drive's root other than this
// run's own. A partial folder from a failed run is a fine base — every file
// in it is whole, uploads being atomic, and anything it lacks is simply
// downloaded — so nothing here reads a manifest. The stamp shape is
// backupManifest's STAMP; repeated here because this module imports nothing.
const BASE_STAMP = /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}$/;

export function chooseBaseFolder(names: string[], ownName: string): string | null {
  const stamps = (names || []).map(String).filter(n => BASE_STAMP.test(n) && n !== ownName).sort();
  return stamps.length ? stamps[stamps.length - 1] : null;
}

export function totalRows(counts: unknown): number {
  const rows = ((counts ?? {}) as { rows?: Record<string, unknown> }).rows ?? {};
  let n = 0;
  for (const v of Object.values(rows)) n += num(v);
  return n;
}
