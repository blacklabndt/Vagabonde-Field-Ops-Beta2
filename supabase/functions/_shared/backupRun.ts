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
  // The base folder itself, for its files.json.gz — the hashes the
  // carry-over needs (a file with no recorded hash is read through).
  baseFolderId: string | null;
  reused: number;
  // The manifest phase's spot check: one carried-over file downloaded and
  // hashed against its record. Null until then; "ok", "re-stored" (the
  // hash did not match and the file was read through again), or the
  // reason it could not be checked.
  spot: string | null;
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
    baseFolderId: null,
    reused: 0,
    spot: null,
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
    baseFolderId: typeof c.baseFolderId === "string" && c.baseFolderId ? c.baseFolderId : null,
    reused: num(c.reused),
    spot: typeof c.spot === "string" && c.spot ? c.spot : null
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

// The shapes a passing Supabase-edge blip reaches a slice as, folded into one
// question the run's catch asks. worthAnotherGo already knows the socket that
// dropped mid-request — a TypeError with no status, which is the connection
// reset that threw a night's backup away — and the drive's own retryable flag.
// The rest is the edge answering for the API with a 5xx: either the HTML page
// supabase-js hands back whole (gatewayRefusal names it) or the bare phrase a
// 502/503/504 carries. A real answer — a permission error, a drive 5xx named
// as the drive's ("Drive answered 502…", which gatewayRefusal already declines)
// — is none of these and must still fail the run.
export function isTransientEdgeError(e: unknown): boolean {
  if (worthAnotherGo(e)) return true;
  const msg = String((e as { message?: unknown } | null)?.message ?? "");
  if (gatewayRefusal(msg)) return true;
  return /gateway time-?out|bad gateway|service unavailable/i.test(msg);
}

// How long a run whose slices keep hitting passing edge errors is left as it is
// for the next tick to reclaim and resume, before it is failed for good rather
// than sit running for ever and block every backup after it. Under a day on
// purpose: a run that could not finish today must have given up well before
// tomorrow's is due, so the ceiling never starves the schedule.
export const RUN_RETRY_WINDOW_MS = 6 * 60 * 60 * 1000;
export function withinRetryWindow(startedAtMs: number, now: number, windowMs = RUN_RETRY_WINDOW_MS): boolean {
  // No timestamp yet means the claim that writes started_at has not landed —
  // a blip at the very first slice — so the run has only just begun: keep it.
  if (!Number.isFinite(startedAtMs)) return true;
  return now - startedAtMs < windowMs;
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
// A gateway page in place of an answer. Supabase's API sits behind
// Cloudflare, and a passing blip at that edge answers a plain HTML page —
// "<title>502 Bad Gateway</title>" — which supabase-js hands back as the
// error's whole message. Named plainly, or the digest mailed the HTML.
// Null for anything else, so a real refusal keeps its own words.
export function gatewayRefusal(message: string): string | null {
  const m = /<title>\s*(5\d\d)\s*([^<]*)<\/title>/i.exec(String(message || ""));
  if (!m || !/<html/i.test(String(message))) return null;
  return `Supabase's API answered ${m[1]} ${m[2].trim()} — a passing outage at the edge, not the backup`;
}

export function stillHoldsRun(matched: unknown): boolean {
  if (matched === null || matched === undefined) return false;
  if (Array.isArray(matched)) return matched.length > 0;
  return true;
}

// ── What the panel counts ────────────────────────────────────────────────

export function countsOf(c: RunCursor): { rows: Record<string, number>; files: number; bytes: number; reused: number; spot: string | null } {
  return { rows: c.rows, files: num(c.files), bytes: num(c.bytes), reused: num(c.reused), spot: c.spot ?? null };
}

// The per-file index written beside manifest.json: every file the folder
// holds, with the SHA-256 of its bytes as read through Supabase the night
// it was first stored. A carried-over file keeps the hash of the copy it
// was made from. What the next night's carry-over and a restore read.
export const FILES_INDEX_NAME = "files.json.gz";

export interface FileRecord { name: string; bucket: string; key: string; size: number; sha256: string | null; reused: boolean }

// The fortnightly full check: every file in the newest complete backup
// folder downloaded off the drive, hashed against files.json.gz, and
// re-stored from Supabase when the two disagree. Its own run kind, worked in
// the same slices as a backup with the position in this cursor.
export const VERIFY_KIND = "verify";
export const MAX_VERIFY_NOTES = 40;

export interface VerifyCursor {
  // The folder being checked: the newest complete backup's, found by the
  // first slice and kept, and the backup run whose file records it holds.
  folderId: string | null;
  folderName: string | null;
  backupRunId: string | null;
  // The next entry of the folder's index (in name order) to check.
  offset: number;
  verified: number;
  repaired: number;
  unrepairable: number;
  // Files the drive would not hand over on this pass — a dropped socket, a
  // passing refusal. Nothing is known about them, so nothing is done to
  // them: the next check reads them again.
  unread: number;
  bytes: number;
  // Whether a repair changed a record, so the folder's index is rewritten
  // from the rows once the walk is done.
  indexDirty: boolean;
  done: boolean;
  notes: string[];
  startedAt: string;
}

export function newVerifyCursor(startedAt: string): VerifyCursor {
  return {
    folderId: null, folderName: null, backupRunId: null,
    offset: 0, verified: 0, repaired: 0, unrepairable: 0, unread: 0, bytes: 0,
    indexDirty: false, done: false, notes: [], startedAt
  };
}

export function reviveVerifyCursor(raw: unknown, startedAt: string): VerifyCursor {
  const c = (raw ?? {}) as Record<string, unknown>;
  const base = newVerifyCursor(String(c.startedAt ?? startedAt));
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    ...base,
    folderId: str(c.folderId), folderName: str(c.folderName), backupRunId: str(c.backupRunId),
    offset: num(c.offset), verified: num(c.verified), repaired: num(c.repaired),
    unrepairable: num(c.unrepairable), unread: num(c.unread), bytes: num(c.bytes),
    indexDirty: c.indexDirty === true, done: c.done === true,
    notes: Array.isArray(c.notes) ? (c.notes as unknown[]).map(String) : []
  };
}

export function addVerifyNote(c: VerifyCursor, text: string): VerifyCursor {
  if (c.notes.length < MAX_VERIFY_NOTES) c.notes.push(text);
  else if (c.notes.length === MAX_VERIFY_NOTES) c.notes.push("… and more; the run's counts carry the rest.");
  return c;
}

// What the panel reads. `files` and `bytes` are what every other kind
// writes, so the earlier-runs row can print them the same way; the three
// tallies and the notes are this kind's own.
export function verifyCounts(c: VerifyCursor): Record<string, unknown> {
  return {
    rows: {},
    files: num(c.verified) + num(c.repaired) + num(c.unrepairable) + num(c.unread),
    bytes: num(c.bytes),
    verified: num(c.verified), repaired: num(c.repaired), unrepairable: num(c.unrepairable),
    unread: num(c.unread),
    folder: c.folderName ?? null,
    notes: c.notes ?? []
  };
}

// The next full check: a whole number of days on from now. Moved when a
// verify STARTS, the backups' own rule.
export function nextVerifyAt(nowMs: number, everyDays: number): string {
  const days = Number.isFinite(everyDays) && everyDays >= 1 ? Math.floor(everyDays) : 14;
  return new Date(nowMs + days * 86400000).toISOString();
}

// Lower-case hex SHA-256. Web Crypto, which node and the Edge runtime
// both carry, so this module stays import-free.
export async function hashBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

// The index read back: an array of records, or nothing usable. A folder
// from before the index existed has none, and every file in it is then
// read through once so the new folder's index is complete.
export function parseFileIndex(text: string): Map<string, FileRecord> {
  const out = new Map<string, FileRecord>();
  let rows: unknown;
  try { rows = JSON.parse(text); } catch { return out; }
  if (!Array.isArray(rows)) return out;
  for (const r of rows as Record<string, unknown>[]) {
    const name = String(r?.name ?? "");
    const sha = typeof r?.sha256 === "string" && /^[0-9a-f]{64}$/.test(r.sha256) ? r.sha256 : null;
    if (!name || !sha) continue;
    out.set(name, {
      name, bucket: String(r.bucket ?? ""), key: String(r.key ?? ""),
      size: num(r.size), sha256: sha, reused: r.reused === true
    });
  }
  return out;
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
  base: Map<string, { id: string; size: number; sha256?: string | null }>
): string | null {
  if (!WRITE_ONCE_BUCKETS.includes(bucket)) return null;
  if (!Number.isFinite(size) || size < 0) return null;
  const held = base.get(entryName);
  if (!held || !held.id) return null;
  // A copy with no recorded hash is a copy nothing can ever verify — the
  // file is read through instead, once, and hashed for every night after.
  if (!held.sha256) return null;
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
