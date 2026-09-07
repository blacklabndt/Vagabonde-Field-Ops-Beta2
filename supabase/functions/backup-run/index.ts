// backup-run — the thing that actually copies the project to the drive.
//
// Called four ways, and it checks its own door before it reads a byte of
// anybody's body:
//
//   {action:"tick"}      the pg_cron job, on x-internal-secret (the database
//                        holds no user JWT), or an Admin keeping a run they
//                        are watching moving between cron ticks
//   {action:"advance"}   the internal secret, one slice of one named run —
//                        the chain's own next link
//   {action:"now"}       an Admin pressing "Back up now"
//   {action:"list"}      the backups in the drive, newest first
//   {action:"manifest"}  one backup's manifest, for the per-job restore
//
// A run is done in slices. A function invocation has a wall-clock ceiling,
// so no phase may need to finish inside one: the unit of work is one part
// of one table, or one page of one bucket, and backup_runs.cursor says
// where the next slice starts. Every unit is idempotent — an upload
// replaces a file of the same name — so a slice cut short costs at most one
// repeated unit and never leaves a hole.
//
// Five minutes between cron ticks would make a big backup take all night
// for a few minutes of work, so a slice that made progress kicks the next
// one itself and walks away from the answer. The cron is the safety net,
// not the engine: it starts what is due, picks up what the chain dropped,
// and reclaims a run whose heartbeat went quiet mid-slice.

// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  LOAD_ORDER, BUCKETS, CURSOR_COLUMN, TABLE_KEYS,
  PAGE_ROWS, MAX_PART_ROWS, stripSecrets, partFileName
} from "../_shared/backupTables.ts";
import {
  MANIFEST_NAME, TABLES_FOLDER, FILES_FOLDER,
  newManifest, recordTable, recordFiles, finishManifest, jobsIndex,
  folderStamp, foldersToDelete, fileEntryName, beforeRestoreName
} from "../_shared/backupManifest.ts";
import type { DriveClient } from "../_shared/drive.ts";
import {
  adminClient, backupDoor, connectDrive, corsHeaders, ensureFolder, ensureFolders, mapLimit,
  internalSecret, json, kick, logError, readManifest
} from "../_shared/backupCommon.ts";
import type { Connection } from "../_shared/backupCommon.ts";

// How many backup folders listBackups reads the manifests of at once.
const MANIFEST_READS = 4;
import {
  BUDGET_MS, RETRIES, afterFilesPage, afterTablePart, countsOf, foldIntoIndex,
  forgetIndex, newRunCursor, nextPhaseAfterManifest, outOfBudget, pausePage,
  retryDelayMs, reviveCursor, shouldRetry, sliceDeadline, sliceLooksAlive,
  startPrefixWalk, stillHoldsRun
} from "../_shared/backupRun.ts";
import { carryOverId, chooseBaseFolder } from "../_shared/backupRun.ts";
import type { RunCursor } from "../_shared/backupRun.ts";
import { gzip } from "../_shared/gzip.ts";
import { nextRunAt } from "../_shared/backupSchedule.ts";

const APP_VERSION = "0.92-beta 2";

const RUN_COLUMNS = "id, kind, status, phase, cursor, counts, folder_id, folder_name, created_at, started_at, heartbeat_at";

type Run = Record<string, any>;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Retries what the drive says to retry — the flag on the error, never its
// prose. Three goes with a widening gap; after that the run fails with the
// last reason and the next scheduled one is unaffected.
async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let last: Error | null = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try { return await fn(); }
    catch (e) {
      last = e as Error;
      if (!shouldRetry(e, attempt)) break;
      await sleep(retryDelayMs(attempt));
    }
  }
  throw new Error(`${what}: ${last ? last.message : "failed"}`);
}

// ── The door ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Not found" }, 404);

  const db = adminClient();

  // Who is asking, before anything is parsed and before anything is
  // written down. A stranger's POST leaves no line in function_errors.
  const caller = await backupDoor(db, req, "Only an Admin can run a backup");
  if (caller instanceof Response) return caller;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* an empty body is a tick */ }
  const action = String(body.action ?? "tick");

  try {
    if (action === "tick") {
      return json(await tick(db, caller.secret || await internalSecret(db)));
    }
    if (action === "advance") {
      // The next link of a chain this function started. Not an Admin's to
      // call — an Admin's nudge is a tick, which decides for itself what is
      // worth advancing.
      if (!caller.internal) return json({ error: "Not authorized" }, 401);
      return json(await advanceById(db, String(body.runId ?? ""), caller.secret, body.chain === true));
    }
    if (action === "now") {
      return json(await backUpNow(db, caller.userId, caller.secret || await internalSecret(db)));
    }
    if (action === "list") return json({ backups: await listBackups(db) });
    if (action === "manifest") {
      const conn = await connectDrive(db);
      return json({ manifest: await readManifest(conn.drive, String(body.folderId ?? "")) });
    }
    return json({ error: `Unknown action "${action}"` }, 400);
  } catch (e) {
    await logError("backup-run", (e as Error).message, { action });
    return json({ error: (e as Error).message }, 400);
  }
});

// ── The tick ─────────────────────────────────────────────────────────────

// The two kinds this function copies. A restore is backup-restore's work;
// the tick still has to poke it, but it never claims it.
const MY_KINDS = ["backup", "before_restore"];
const RESTORE_KINDS = ["restore_all", "restore_jobs"];

async function openRun(db: SupabaseClient, status: string, kinds = MY_KINDS): Promise<Run | null> {
  const { data, error } = await db.from("backup_runs")
    .select(RUN_COLUMNS).eq("status", status).in("kind", kinds)
    .order("created_at").limit(1).maybeSingle();
  if (error) throw error;
  return (data ?? null) as Run | null;
}

async function tick(db: SupabaseClient, secret: string): Promise<Record<string, unknown>> {
  // This function's own kinds first, always. A restore's safety backup is a
  // before_restore run raised AFTER the restore itself, and a tick that took
  // the restore first would leave that backup unstarted and the restore
  // waiting on it for ever.
  //
  // A run in flight comes first among them, and the same run is picked up
  // again after a slice that died: a stale heartbeat is a reason to reclaim
  // this run, never to start a second one alongside it.
  const running = await openRun(db, "running");
  if (running) {
    if (sliceLooksAlive(running.heartbeat_at, Date.now())) {
      // Another slice of this same run is still going. Two at once would
      // upload the same part twice and fight over the cursor.
      await tend(db, running, secret);
      return { ok: true, busy: true, runId: running.id };
    }
    const moved = await advance(db, running, secret);
    await tend(db, running, secret);
    return moved;
  }

  const queued = await openRun(db, "queued");
  if (queued) {
    const moved = await advance(db, queued, secret);
    await tend(db, queued, secret);
    return moved;
  }

  // A restore in flight is somebody else's job; it still needs the poke,
  // and only when the chain of slices driving it has gone quiet.
  const restore = await openRun(db, "running", RESTORE_KINDS);
  if (restore) {
    if (!sliceLooksAlive(restore.heartbeat_at, Date.now())) {
      kick("backup-restore", { action: "advance", runId: restore.id }, secret);
    }
    return { ok: true, restoring: restore.id };
  }

  // Nothing in flight: is one due?
  const { data: s, error } = await db.from("app_settings")
    .select("backup_refresh_token, backup_next_run_at, backup_frequency, backup_weekday, backup_hour")
    .maybeSingle();
  if (error) throw error;
  if (!s || !s.backup_refresh_token || !s.backup_next_run_at) return { ok: true, idle: true };
  if (Date.parse(String(s.backup_next_run_at)) > Date.now()) {
    return { ok: true, idle: true, next: s.backup_next_run_at };
  }

  // The clock moves the moment the run is created, not when it finishes —
  // a run that takes two hours must not make the next one two hours late,
  // and a failed run must not stop the next one happening at all.
  const { error: nErr } = await db.from("app_settings").update({
    backup_next_run_at: nextRunAt({
      frequency: String(s.backup_frequency ?? "daily"),
      weekday: Number(s.backup_weekday ?? 0),
      hour: Number(s.backup_hour ?? 2)
    }, Date.now())
  }).eq("id", true);
  if (nErr) throw nErr;

  const created = await queueRun(db, "backup", null);
  return await advance(db, created, secret);
}

// A restore's first phase is a before_restore run raised by backup-restore
// and driven here, and while it is in flight this tick returns above without
// ever reaching the branch that forwards to a restore. So the restore
// waiting on it goes unread for as long as the copy takes: its heartbeat
// ages, the panel reads a run doing exactly what it was told to as a run
// that died, and when the copy finishes nothing tells the restore — it waits
// for the next cron tick, up to five minutes later, to be forwarded to.
//
// Both halves are this function. While the copy is going the waiting
// restore's heartbeat is kept fresh; the moment the copy is finished with —
// complete or failed — the restore is kicked so it can go on (or fail with
// the reason, which is the same urgency: nothing has been deleted yet and
// somebody is watching a dialog).
//
// The restore is found by the safety run's own id, which stepSafety wrote on
// the restore's cursor as `safetyRunId` before its first slice returned —
// read off the cursor here rather than asked for as a filter, because at
// most one restore is ever in flight and the comparison is this function's
// to make.
// Tending the waiting restore is a courtesy the tick pays on its way past,
// and it must never cost the tick the work it actually came to do — the
// backup or the safety copy it has just advanced. So a failure here is
// written down and swallowed: the restore's own five-minute forward is the
// backstop, and a tick that threw on this would leave the run it advanced
// unreported and its next slice unkicked.
async function tend(db: SupabaseClient, safety: Run, secret: string): Promise<void> {
  try { await tendWaitingRestore(db, safety, secret); }
  catch (e) { await logError("backup-run", `Tending the waiting restore failed: ${(e as Error).message}`, { runId: safety.id }); }
}

async function tendWaitingRestore(db: SupabaseClient, safety: Run, secret: string): Promise<void> {
  if (String(safety.kind) !== "before_restore") return;
  const safetyId = String(safety.id);
  const waiting = await openRun(db, "running", RESTORE_KINDS);
  // Only the restore this copy was raised for. There is at most one restore
  // in flight, but a before_restore run left over from one that failed is
  // not the waiting one, and kicking a restore that is already past its
  // safety phase would put a second slice beside the one driving it.
  if (!waiting) return;
  if (String(((waiting.cursor ?? {}) as Record<string, unknown>).safetyRunId ?? "") !== safetyId) return;

  // The copy's status now, not the one this tick read before advancing it.
  const { data: now, error: sErr } = await db.from("backup_runs")
    .select("status").eq("id", safetyId).maybeSingle();
  if (sErr) throw sErr;
  const finished = !now || now.status === "complete" || now.status === "failed";
  if (finished) {
    // chain: true, and it has to be: the heartbeat this very function has
    // been keeping fresh would make the restore's own aliveness gate refuse
    // an unchained slice as "busy". There is nothing to collide with — a
    // restore waiting on its safety copy has no slice in flight, which is
    // the whole reason its heartbeat needed keeping.
    kick("backup-restore", { action: "advance", runId: waiting.id, chain: true }, secret);
    return;
  }
  const { error: bErr } = await db.from("backup_runs")
    .update({ heartbeat_at: new Date().toISOString() })
    .eq("id", waiting.id).eq("status", "running");
  if (bErr) throw bErr;
}

// One slice of one named run: the link the last slice asked for.
//
// This exists because the chain used to say {action:"tick"}, and a tick
// reads the running run and finds the heartbeat the slice that kicked it
// wrote a moment earlier — always alive, by definition. Every kicked
// invocation answered "busy" and advanced nothing, so a backup only ever
// moved on the five-minute cron: an hour's work took all night.
//
// The exemption is addressed at this run and no other. A slice the chain
// did not start — the cron picking up what the chain dropped — still waits
// for the heartbeat to go quiet, because two slices of one run would upload
// the same part twice and fight over the cursor.
//
// What stands behind that gate is not the conditional claim: `advance`
// claims on the status the run was read at, and two slices of a run that is
// already `running` both read `running` and both match, so the claim stops a
// second slice only where the first has yet to take a queued run. The
// protection here is that every unit is idempotent — a part re-uploaded
// replaces the file of the same name, a page re-walked lands on the same
// keys — so the cost of two slices overlapping is repeated work and never a
// hole. The stale-slice case is caught at the other end instead, by
// stillHoldsRun on every write a slice makes after its claim.
async function advanceById(
  db: SupabaseClient, runId: string, secret: string, chained: boolean
): Promise<Record<string, unknown>> {
  if (!runId) throw new Error("runId is required");
  const { data, error } = await db.from("backup_runs")
    .select(RUN_COLUMNS).eq("id", runId).maybeSingle();
  if (error) throw error;
  const run = (data ?? null) as Run | null;
  // Finished, failed, or a restore — none of them this chain's to move.
  if (!run || !MY_KINDS.includes(String(run.kind))) return { ok: true, runId, idle: true };
  if (run.status !== "running" && run.status !== "queued") return { ok: true, runId, idle: true };
  if (!(chained && String(run.id) === runId) && sliceLooksAlive(run.heartbeat_at, Date.now())) {
    return { ok: true, runId, busy: true };
  }
  const moved = await advance(db, run, secret);
  // The waiting restore is tended here as well as in the tick, and for the
  // same reason it is tended there: a safety copy is somebody's restore held
  // up, and the only thing that ever tells that restore the copy is done is
  // whichever slice finishes it. Slices reach this function too — the copy's
  // own chain comes through here, and so does the restore's kick that starts
  // it — so a copy that took more than one slice used to finish with nobody
  // to tell, and the restore sat until the cron came round. On a project
  // whose cron is missing that is for ever, which is the whole thing this
  // hand-off exists to prevent.
  await tend(db, run, secret);
  return moved;
}

async function queueRun(db: SupabaseClient, kind: string, requestedBy: string | null): Promise<Run> {
  const { data, error } = await db.from("backup_runs")
    .insert({ kind, status: "queued", requested_by: requestedBy || null })
    .select(RUN_COLUMNS).single();
  if (error) throw error;
  return data as Run;
}

// "Back up now" queues the run and answers immediately: the first slice is
// a hundred seconds of work and the browser is not going to wait for it.
// The kick starts that slice and is abandoned; the five-minute tick is the
// backstop if it never arrives.
async function backUpNow(db: SupabaseClient, requestedBy: string, secret: string): Promise<Record<string, unknown>> {
  // Every kind, not only this function's: a backup taken while a restore is
  // emptying and refilling the tables would be a copy of a half-restored
  // database, filed under tonight's date and offered back as if it were one.
  const kinds = [...MY_KINDS, ...RESTORE_KINDS];
  const running = await openRun(db, "running", kinds);
  const queued = running ?? await openRun(db, "queued", kinds);
  if (queued) {
    // Something is already going. Nudge it rather than starting a second
    // pile beside it.
    kick("backup-run", { action: "tick" }, secret);
    return { ok: true, runId: queued.id, alreadyRunning: true };
  }

  const created = await queueRun(db, "backup", requestedBy || null);
  kick("backup-run", { action: "tick" }, secret);
  return { ok: true, runId: created.id };
}

// ── Starting a run ───────────────────────────────────────────────────────

// Taking the run for this slice. The update is conditional on the status it
// was read at, and zero rows back means another slice got there first —
// "Back up now" kicks a slice at the same moment the cron may be ticking,
// and two slices of one run would upload the same part twice and fight over
// the cursor.
//
// Reclaiming a run whose heartbeat went quiet is deliberately NOT also
// conditional on that heartbeat. A compare-and-swap on a timestamptz is a
// string comparison across PostgREST, and getting it wrong once would wedge
// the schedule for ever with a run nobody could pick up — which is far worse
// than the thing it would prevent, two slices repeating a unit that replaces
// rather than appends.
//
// The cost of that is paid at the other end instead: every write the
// superseded slice goes on to make is conditional on `status = running`, and
// a write that matches no row stops it dead (stillHoldsRun). Repeating a
// unit is cheap; a slice that hung inside one unit past SLICE_ALIVE_MS,
// woke after the run it lost had already finished, and then wrote its stale
// cursor over a complete run — or threw and marked it failed — is not.
async function claim(db: SupabaseClient, run: Run): Promise<Run | null> {
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { heartbeat_at: now };
  if (String(run.status) === "queued") {
    patch.status = "running";
    patch.phase = "tables";
    patch.cursor = newRunCursor(now);
    patch.started_at = now;
    patch.error = null;
  }
  const { data, error } = await db.from("backup_runs").update(patch)
    .eq("id", run.id).eq("status", run.status).select(RUN_COLUMNS).maybeSingle();
  if (error) throw error;
  return (data ?? null) as Run | null;
}

// The folder is made before the first unit rather than inside it, so
// backup_runs carries a name the panel can show from the very first poll —
// and separately from the claim, so a slice that dies between the two
// leaves a running row the next tick can pick up and finish the job for.
async function ensureRunFolder(db: SupabaseClient, conn: Connection, run: Run): Promise<string> {
  if (run.folder_id) return String(run.folder_id);
  const stamp = folderStamp(Date.now());
  const name = run.kind === "before_restore" ? beforeRestoreName(stamp) : stamp;
  const folderId = await withRetry("Making the backup folder",
    () => ensureFolder(conn.drive, conn.rootFolderId, name));
  const { error } = await db.from("backup_runs")
    .update({ folder_id: folderId, folder_name: name })
    .eq("id", run.id).eq("status", "running");
  if (error) throw error;
  return folderId;
}

// ── One slice ────────────────────────────────────────────────────────────

async function advance(db: SupabaseClient, run: Run, secret: string): Promise<Record<string, unknown>> {
  const deadline = sliceDeadline(Date.now(), BUDGET_MS);
  const runId = String(run.id);

  // The status this slice believes it holds the run at. Until the claim goes
  // through that is whatever the row was read at; after it, running. Every
  // write below is conditional on it, so a slice that has been superseded
  // writes nothing at all — including its own failure.
  let guard = String(run.status);

  // The drive first: with none connected there is nothing to do but say so
  // on the run itself, so the panel has a written reason rather than a run
  // that sits queued for ever and a tick that complains every five minutes.
  let conn: Connection;
  try {
    conn = await connectDrive(db);
  } catch (e) {
    return await fail(db, runId, (e as Error).message, guard);
  }

  let cursor: RunCursor;
  try {
    const current = await claim(db, run);
    if (!current) return { ok: true, runId, busy: true };
    guard = "running";
    cursor = reviveCursor(current.cursor, String(current.started_at ?? new Date().toISOString()));

    const folderId = await ensureRunFolder(db, conn, current);
    // One listing of the run's folder for both children.
    const [tablesFolder, filesFolder] = await withRetry("Opening the backup's folders",
      () => ensureFolders(conn.drive, folderId, [TABLES_FOLDER, FILES_FOLDER]));

    let units = 0;
    while (!outOfBudget(deadline, Date.now()) && cursor.phase !== "done") {
      if (cursor.phase === "tables") cursor = await stepTables(db, conn.drive, tablesFolder, cursor);
      else if (cursor.phase === "files") cursor = await stepFiles(db, conn.drive, filesFolder, cursor, deadline, conn.rootFolderId, String(current.folder_name ?? ""));
      else if (cursor.phase === "manifest") cursor = await stepManifest(db, conn.drive, folderId, cursor, String(current.kind));
      else if (cursor.phase === "retention") cursor = await stepRetention(db, conn.drive, conn.rootFolderId, conn.keep, cursor);
      else cursor.phase = "done";
      units += 1;
      // The cursor is persisted after every unit, not at the end of the
      // slice: a slice that dies here has to be resumable from what is on
      // the row, and the heartbeat is how the next tick knows it died.
      //
      // And it is the point at which a superseded slice finds out. A slice
      // that hung inside one unit past SLICE_ALIVE_MS was reclaimed while it
      // hung; the run may since have been finished by somebody else. Zero
      // rows matched means exactly that, and the answer is to stop — not to
      // write a stale cursor over a complete run.
      const { data: held, error } = await db.from("backup_runs").update({
        phase: cursor.phase, cursor, heartbeat_at: new Date().toISOString(), counts: countsOf(cursor)
      }).eq("id", runId).eq("status", "running").select("id");
      if (error) throw error;
      if (!stillHoldsRun(held)) return { ok: true, runId, superseded: true };
    }

    if (cursor.phase === "done") {
      const finished = new Date().toISOString();
      const { data: held, error } = await db.from("backup_runs").update({
        status: "complete", phase: "done", finished_at: finished,
        heartbeat_at: finished, counts: countsOf(cursor)
      }).eq("id", runId).eq("status", "running").select("id");
      if (error) throw error;
      if (!stillHoldsRun(held)) return { ok: true, runId, superseded: true };
      return { ok: true, runId, complete: true, counts: countsOf(cursor) };
    }

    // The next link, named. Not a tick: a tick would read the heartbeat this
    // slice has just written, call the run alive and advance nothing.
    if (units > 0) kick("backup-run", { action: "advance", runId, chain: true }, secret);
    return { ok: true, runId, phase: cursor.phase, continuing: true };
  } catch (e) {
    return await fail(db, runId, (e as Error).message, guard);
  }
}

// The run failed, as far as this slice knows. Conditional on the status the
// slice holds for the same reason every other write is: a slice reclaimed
// out from under itself, throwing its way out an hour later, must not turn
// somebody else's complete run into a failed one. The reason is still logged
// either way — the error happened, whoever owns the run now.
async function fail(
  db: SupabaseClient, runId: string, message: string, guard: string
): Promise<Record<string, unknown>> {
  const { data: held } = await db.from("backup_runs").update({
    status: "failed", error: message, finished_at: new Date().toISOString()
  }).eq("id", runId).eq("status", guard).select("id");
  const superseded = !stillHoldsRun(held);
  await logError("backup-run", message, superseded ? { runId, superseded } : { runId });
  return superseded
    ? { ok: false, runId, error: message, superseded: true }
    : { ok: false, runId, error: message };
}

// ── Phase: tables ────────────────────────────────────────────────────────

async function stepTables(
  db: SupabaseClient, drive: DriveClient, tablesFolder: string, c: RunCursor
): Promise<RunCursor> {
  if (c.tableIndex >= LOAD_ORDER.length) { c.phase = "files"; return c; }
  const table = LOAD_ORDER[c.tableIndex];
  const cursorColumn = CURSOR_COLUMN[table];
  const keys = TABLE_KEYS[table] ?? [];

  // One part: up to MAX_PART_ROWS rows, read a PostgREST page at a time.
  // Keyset where there is a single unique column — "the next thousand after
  // this id" cannot skip a row when one is inserted mid-walk — and OFFSET
  // for the two composite-key tables, which hold reactions and high scores.
  const rows: Record<string, unknown>[] = [];
  let lastKey: string | null = c.lastKey;
  let offset = c.offset;
  let exhausted = false;

  while (rows.length < MAX_PART_ROWS) {
    let q = db.from(table).select("*").limit(PAGE_ROWS);
    if (cursorColumn) {
      q = q.order(cursorColumn);
      if (lastKey !== null) q = q.gt(cursorColumn, lastKey);
    } else {
      for (const k of keys) q = q.order(k);
      q = q.range(offset, offset + PAGE_ROWS - 1);
    }
    const { data, error } = await q;
    if (error) throw error;
    const page = (data ?? []) as Record<string, unknown>[];
    rows.push(...page);
    if (cursorColumn && page.length) lastKey = String(page[page.length - 1][cursorColumn]);
    offset += page.length;
    if (page.length < PAGE_ROWS) { exhausted = true; break; }
  }

  if (table === "profiles") await addAuthEmails(db, rows);
  c = foldIntoIndex(c, table, rows);

  // An empty part is still written, so the manifest can say "clients: 0"
  // and a restore does not have to tell "no rows" from "never read".
  const name = partFileName(table, c.partIndex);
  const payload = await gzip(new TextEncoder().encode(JSON.stringify(stripSecrets(table, rows))));
  await withRetry(`Uploading ${name}`, () => drive.upload(tablesFolder, name, payload, "application/gzip"));

  return afterTablePart(c, {
    table, tableCount: LOAD_ORDER.length, rows: rows.length, partName: name,
    exhausted, lastKey, offset
  });
}

// Auth holds the email addresses; profiles does not. Without them a restore
// into an empty project could re-create the crew's rows but would have
// nowhere to send anybody a set-password link — the account would exist
// with no way in. So each profile row carries auth_email into the backup,
// as a field of the JSON rather than a column of the table; the restore
// takes it off again before it inserts. It is the one place a backup holds
// something the table it came from does not.
async function addAuthEmails(db: SupabaseClient, rows: Record<string, unknown>[]): Promise<void> {
  if (!rows.length) return;
  const email = new Map<string, string>();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const users = data?.users ?? [];
    for (const u of users) email.set(u.id, u.email ?? "");
    // An empty page is the end of the list. Stopping on a short one instead
    // would trust the server to honour perPage: a gateway that caps at 100
    // answers the first page short and every account after the hundredth
    // would quietly lose its address, and a profile with no auth_email is a
    // person a restore cannot mail a way back in to.
    if (!users.length) break;
  }
  for (const r of rows) r.auth_email = email.get(String(r.id)) ?? null;
}

// ── Phase: files ─────────────────────────────────────────────────────────

async function stepFiles(
  db: SupabaseClient, drive: DriveClient, filesFolder: string, c: RunCursor, deadline: number,
  rootFolderId: string, ownFolderName: string
): Promise<RunCursor> {
  if (c.bucketIndex >= BUCKETS.length) { c.phase = "manifest"; return c; }
  const bucket = BUCKETS[c.bucketIndex];

  // The base: last night's folder, whose unchanged files are copied over
  // on the drive rather than pulled through Supabase again (carryOverId in
  // backupRun.ts says which). Chosen once per run and kept on the cursor,
  // "none" included. A base is a saving and never a requirement: any
  // trouble finding or listing it means every object goes the long way
  // round, which is what every object did before.
  if (!c.baseLooked) {
    try {
      const folders = await withRetry("Looking for last night's folder", () => drive.listFolders(rootFolderId));
      const baseName = chooseBaseFolder(folders.map(f => f.name), ownFolderName);
      const base = baseName ? folders.find(f => f.name === baseName) : undefined;
      const sub = base
        ? (await withRetry("Opening last night's folder", () => drive.listFolders(base.id))).find(f => f.name === FILES_FOLDER)
        : undefined;
      c.baseFilesFolderId = sub ? sub.id : null;
    } catch (e) {
      console.warn(`No base folder for carrying files over: ${(e as Error).message}`);
      c.baseFilesFolderId = null;
    }
    c.baseLooked = true;
  }
  // Listed once per slice — a few calls for thousands of names.
  const baseFiles = new Map<string, { id: string; size: number }>();
  if (c.baseFilesFolderId) {
    try {
      for (const e of await withRetry("Listing last night's files", () => drive.listFiles(c.baseFilesFolderId!))) {
        baseFiles.set(e.name, { id: e.id, size: e.size });
      }
    } catch (e) {
      console.warn(`Last night's files could not be listed; copying everything through: ${(e as Error).message}`);
      baseFiles.clear();
    }
  }

  // An empty prefix stack means this bucket has not been started: the stack
  // and the bucket index are advanced together at the end of a bucket, so
  // an empty stack here is never a finished one.
  const top = startPrefixWalk(c);

  const { data: entries, error } = await db.storage.from(bucket).list(top.prefix, {
    limit: PAGE_ROWS, offset: top.offset, sortBy: { column: "name", order: "asc" }
  });
  if (error) throw error;
  const page = entries ?? [];

  // Storage marks a folder by having no id of its own.
  const folders = page.filter(e => !e.id);
  const objects = page.filter(e => !!e.id);

  let copied = 0;
  let bytes = 0;
  let reused = 0;
  for (let i = c.pageDone; i < objects.length; i++) {
    if (outOfBudget(deadline, Date.now())) {
      // Stop where we are: the same page is re-listed next slice and the
      // first pageDone objects are skipped.
      return pausePage(c, i, copied, bytes, reused);
    }
    const key = top.prefix + objects[i].name;
    const name = fileEntryName(bucket, key);
    // Storage's listing carries the object's size; a listing without one
    // is no match, and the object is read through.
    const size = Number((objects[i].metadata as { size?: unknown } | undefined)?.size ?? -1);
    const from = carryOverId(bucket, name, size, baseFiles);
    if (from) {
      try {
        await withRetry(`Carrying over ${bucket}/${key}`, () => drive.copy(from, filesFolder, name));
        copied += 1;
        reused += 1;
        bytes += size;
        continue;
      } catch (e) {
        console.warn(`Carry-over of ${bucket}/${key} failed; copying it through: ${(e as Error).message}`);
      }
    }
    const blob = await withRetry(`Reading ${bucket}/${key}`, async () => {
      const { data, error: dErr } = await db.storage.from(bucket).download(key);
      if (dErr) throw dErr;
      return data as Blob;
    });
    const payload = new Uint8Array(await blob.arrayBuffer());
    await withRetry(`Uploading ${bucket}/${key}`, () =>
      drive.upload(filesFolder, name, payload, blob.type || "application/octet-stream"));
    copied += 1;
    bytes += payload.byteLength;
  }

  // Depth first: sub-prefixes go on the stack, and this prefix advances.
  return afterFilesPage(c, {
    bucketCount: BUCKETS.length, pageLength: page.length, pageRows: PAGE_ROWS,
    folderNames: folders.map(f => f.name), files: copied, bytes, reused
  });
}

// ── Phase: manifest, then retention ──────────────────────────────────────

async function stepManifest(
  db: SupabaseClient, drive: DriveClient, folderId: string, c: RunCursor, kind: string
): Promise<RunCursor> {
  // The schema version is the newest migration this database has applied —
  // the one number that says whether a backup can be loaded back into it.
  let schemaVersion: string | null = null;
  try {
    const { data } = await db.rpc("backup_schema_version");
    schemaVersion = data ? String(data) : null;
  } catch { schemaVersion = null; }

  // recordTable, recordFiles and finishManifest all change the manifest
  // they are handed and give it back; assigning the result is how that
  // stays visible.
  let m = newManifest(APP_VERSION, schemaVersion, c.startedAt);
  for (const table of LOAD_ORDER) {
    m = recordTable(m, table, Number(c.rows[table] ?? 0), c.parts[table] ?? []);
  }
  m = recordFiles(m, c.files, c.bytes, c.reused);
  m.jobs = jobsIndex(c.index as any);
  m = finishManifest(m, new Date().toISOString());

  await withRetry("Uploading the manifest", () =>
    drive.upload(folderId, MANIFEST_NAME, new TextEncoder().encode(JSON.stringify(m, null, 2)), "application/json"));

  // The index has done its job and is the biggest thing in the cursor.
  c = forgetIndex(c);
  // A before-restore copy stops here: pruning the drive with a restore in
  // flight can delete the folder that restore is about to read from.
  c.phase = nextPhaseAfterManifest(kind);
  return c;
}

// The folder every restore that has not finished is reading from. Belt and
// braces beside the phase skip above: that one keeps a restore's own safety
// copy off the drive's throat, this one covers a scheduled backup that
// happens to come round while somebody is restoring, which is a different
// run of a different kind and would not be caught by the kind test.
async function restoreSources(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db.from("backup_runs").select("folder_name")
    .in("kind", RESTORE_KINDS).in("status", ["queued", "running"]);
  if (error) throw error;
  return (data ?? []).map((r: Run) => String(r.folder_name ?? "")).filter(Boolean);
}

async function stepRetention(
  db: SupabaseClient, drive: DriveClient, rootFolderId: string, keep: number, c: RunCursor
): Promise<RunCursor> {
  // The drive's folders and the restores in flight: two services, together.
  const [folders, sources] = await Promise.all([drive.listFolders(rootFolderId), restoreSources(db)]);
  // foldersToDelete only ever names a folder whose name is the stamp
  // exactly, so a before-restore copy — and anything the Admin put in the
  // same drive themselves — is not retention's business. The folder a
  // running restore is reading from is spared by name.
  const doomed = foldersToDelete(folders.map(f => f.name), keep, sources);
  for (const name of doomed) {
    const f = folders.find(x => x.name === name);
    if (f) await withRetry(`Removing ${name}`, () => drive.delete(f.id));
  }
  c.removed = doomed;
  c.phase = "done";
  return c;
}

// ── Reading the drive back ───────────────────────────────────────────────

async function listBackups(db: SupabaseClient): Promise<Record<string, unknown>[]> {
  const conn = await connectDrive(db);
  const folders = await conn.drive.listFolders(conn.rootFolderId);
  // Each folder's manifest is two provider calls; read a few folders at a
  // time rather than one after another, with an Admin waiting on the panel.
  // The sort below fixes the order whatever order the answers came in.
  const out = await mapLimit(folders, MANIFEST_READS, async folder => {
    const entry: Record<string, unknown> = { folderId: folder.id, name: folder.name };
    try {
      const m = await readManifest(conn.drive, folder.id);
      const tables = (m.tables ?? {}) as Record<string, { rows?: number }>;
      const files = (m.files ?? {}) as { count?: number; bytes?: number };
      entry.app_version = m.app_version ?? null;
      entry.schema_version = m.schema_version ?? null;
      entry.finished_at = m.finished_at ?? null;
      entry.rows = Object.values(tables).reduce((n, t) => n + Number(t?.rows ?? 0), 0);
      entry.files = files.count ?? 0;
      entry.bytes = files.bytes ?? 0;
      entry.jobs = ((m.jobs ?? []) as unknown[]).length;
    } catch (e) {
      // A folder with no manifest is a run that never finished. Say so
      // rather than offering it as something to restore from.
      entry.incomplete = true;
      entry.error = (e as Error).message;
    }
    return entry;
  });
  // Newest first: the stamp sorts into date order, so this is a reverse sort.
  return out.sort((a, b) => String(b.name).localeCompare(String(a.name)));
}
