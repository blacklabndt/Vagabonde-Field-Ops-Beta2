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

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  LOAD_ORDER, BUCKETS, CURSOR_COLUMN, TABLE_KEYS,
  PAGE_ROWS, MAX_PART_ROWS, stripSecrets, partFileName
} from "../_shared/backupTables.ts";
import {
  MANIFEST_NAME, TABLES_FOLDER, FILES_FOLDER,
  newManifest, recordTable, recordFiles, recordFileIndex, finishManifest, jobsIndex,
  folderStamp, foldersToDelete, fileEntryName, beforeRestoreName
} from "../_shared/backupManifest.ts";
import type { DriveClient } from "../_shared/drive.ts";
import {
  adminClient, backupDoor, connectDrive, corsHeaders, ensureFolder, ensureFolders, mapLimit,
  internalSecret, json, kick, logError, readFileIndex, readManifest
} from "../_shared/backupCommon.ts";
import type { Connection } from "../_shared/backupCommon.ts";

// How many backup folders listBackups reads the manifests of at once.
const MANIFEST_READS = 4;
import {
  BUDGET_MS, RETRIES, afterFilesPage, afterTablePart, countsOf, foldIntoIndex,
  forgetIndex, newRunCursor, nextPhaseAfterManifest, outOfBudget, pausePage,
  retryDelayMs, reviveCursor, shouldRetry, sliceDeadline, sliceLooksAlive,
  startPrefixWalk, stillHoldsRun, gatewayRefusal, isTransientEdgeError, withinRetryWindow
} from "../_shared/backupRun.ts";
import { FILES_INDEX_NAME, VERIFY_KIND, addVerifyNote, carryOverId, chooseBaseFolder, hashBytes, nextVerifyAt, reviveVerifyCursor, verifyCounts } from "../_shared/backupRun.ts";
import type { RunCursor } from "../_shared/backupRun.ts";
import { gzip } from "../_shared/gzip.ts";
import { nextRunAt } from "../_shared/backupSchedule.ts";

const APP_VERSION = "0.92-beta 2";

const RUN_COLUMNS = "id, kind, status, phase, cursor, counts, folder_id, folder_name, created_at, started_at, heartbeat_at";

// A backup_runs row as the tick and the slices read it. cursor and counts
// are JSON the phases own (RunCursor, VerifyCursor), revived by their own
// readers, so they stay unknown here.
interface Run {
  id: string; kind: string; status: string; phase: string | null;
  cursor: unknown; counts: unknown; notes: unknown; error: string | null;
  folder_id: string | null; folder_name: string | null;
  created_at: string; started_at: string | null; heartbeat_at: string | null; finished_at: string | null;
}

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
      const secret = caller.secret || await internalSecret(db);
      try { return json(await tick(db, secret)); }
      catch (e) {
        // A gateway page from the edge is a blink, not a fault: one more go
        // after a moment, and a tick is safe to repeat — every claim it
        // makes is conditional. Two in a row is worth the one line the
        // outer catch writes, in plain words.
        if (!gatewayRefusal((e as Error).message)) throw e;
        await sleep(2000);
        return json(await tick(db, secret));
      }
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
    const plain = gatewayRefusal((e as Error).message);
    const message = plain ? `${plain}; the next tick retries in five minutes.` : (e as Error).message;
    await logError("backup-run", message, { action });
    return json({ error: message }, 400);
  }
});

// ── The tick ─────────────────────────────────────────────────────────────

// The two kinds this function copies. A restore is backup-restore's work;
// the tick still has to poke it, but it never claims it.
// The fortnightly file check is this function's too: found, claimed and
// advanced by the tick like a backup, though it makes no folder of its own.
const MY_KINDS = ["backup", "before_restore", VERIFY_KIND];
const RESTORE_KINDS = ["restore_all", "restore_jobs"];

async function openRun(db: SupabaseClient, status: string, kinds = MY_KINDS): Promise<Run | null> {
  const { data, error } = await db.from("backup_runs")
    .select(RUN_COLUMNS).eq("status", status).in("kind", kinds)
    .order("created_at").limit(1).maybeSingle();
  if (error) throw error;
  return (data ?? null) as Run | null;
}

// Whether a due time already has its run. The clock moves before the run
// row exists, and queueRunOrUnmove puts it back when the insert's reply was
// lost and the read after it is refused too — it cannot tell a row that
// landed from one that did not, and putting the clock back is the choice
// that never costs a night. The ticks in between then take the row that did
// land and finish it, and the next tick to read the clock finds it still
// due. A run of this kind created since that due time IS the due time's run
// — bar one that failed, which the schedule gives no second go and this
// guard need not either — so the clock moves on and nothing is queued, or
// one night stands in the drive twice and a night of history falls off the
// far end of backup_keep. A minute of slack: the row's created_at is the
// database's clock and the due-time test was this function's, and no
// schedule the panel offers repeats inside a day.
const SERVED_SLACK_MS = 60 * 1000;
async function servedSince(db: SupabaseClient, kind: string, due: unknown): Promise<boolean> {
  const dueMs = Date.parse(String(due ?? ""));
  if (!Number.isFinite(dueMs)) return false;
  const since = new Date(dueMs - SERVED_SLACK_MS).toISOString();
  const { data, error } = await db.from("backup_runs").select("id")
    .eq("kind", kind).neq("status", "failed").gte("created_at", since).limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
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
    .select("backup_refresh_token, backup_next_run_at, backup_frequency, backup_weekday, backup_hour, backup_verify_next_at, backup_verify_every_days")
    .maybeSingle();
  if (error) throw error;
  if (!s || !s.backup_refresh_token || !s.backup_next_run_at) return { ok: true, idle: true };
  if (Date.parse(String(s.backup_next_run_at)) > Date.now()) {
    // No backup due: is the fortnightly file check? After the backups
    // always — a backup that is due goes first, and this branch is only
    // reached when none is. The same conditional move of the clock is the
    // claim on it.
    if (s.backup_verify_next_at && Date.parse(String(s.backup_verify_next_at)) <= Date.now()) {
      const movedV = nextVerifyAt(Date.now(), Number(s.backup_verify_every_days ?? 14));
      const { data: wonV, error: vErr } = await db.from("app_settings")
        .update({ backup_verify_next_at: movedV })
        .eq("id", true).eq("backup_verify_next_at", s.backup_verify_next_at).select("id");
      if (vErr) throw vErr;
      if (!stillHoldsRun(wonV)) return { ok: true, idle: true };
      const verify = await queueRunOrUnmove(db, VERIFY_KIND, "backup_verify_next_at", s.backup_verify_next_at, movedV);
      if (!verify) return { ok: true, idle: true, served: true, next: movedV };
      return await advance(db, verify, secret);
    }
    return { ok: true, idle: true, next: s.backup_next_run_at };
  }

  // The clock moves the moment the run is created, not when it finishes —
  // a run that takes two hours must not make the next one two hours late,
  // and a failed run must not stop the next one happening at all.
  //
  // Conditional on the due time this tick read: moving the clock IS the
  // claim on tonight's run. Two ticks that read the same due time — the
  // cron and a kick landing together — would otherwise both move it and
  // both queue a run, and two runs made in the same minute share a folder.
  const moved = nextRunAt({
    frequency: String(s.backup_frequency ?? "daily"),
    weekday: Number(s.backup_weekday ?? 0),
    hour: Number(s.backup_hour ?? 2)
  }, Date.now());
  const { data: won, error: nErr } = await db.from("app_settings").update({ backup_next_run_at: moved })
    .eq("id", true).eq("backup_next_run_at", s.backup_next_run_at).select("id");
  if (nErr) throw nErr;
  if (!stillHoldsRun(won)) return { ok: true, idle: true };

  const created = await queueRunOrUnmove(db, "backup", "backup_next_run_at", s.backup_next_run_at, moved);
  if (!created) return { ok: true, idle: true, served: true, next: moved };
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

// The clock moves before the run row exists, because moving it is the claim
// on the run. When the insert then fails, the clock is put back — conditional
// on the value this tick wrote, so a tick that moved it again meanwhile keeps
// its own move — and the failure is rethrown for the log. Without this a
// refused insert cost the file check a fortnight (the first one, on a kind
// the table had not been taught) and would cost the backup a night, and the
// tick's own gateway-page retry could not get either back: it re-read a
// clock already moved and went idle.
// The due time's run may already be there (servedSince), and that is asked
// only once the move is won, never before it: the row that landed under an
// earlier claim was there before that claim put the clock back, so the
// claim that wins the clock afterwards sees it. Asked ahead of the move, a
// tick could read "nothing yet", lose the race to that whole sequence, win
// the move over the clock it had put back, and queue the night twice after
// all. Null says the due time is served: the clock stays moved and nothing
// is queued.
async function queueRunOrUnmove(
  db: SupabaseClient, kind: string, column: string, was: unknown, moved: unknown
): Promise<Run | null> {
  try {
    if (await servedSince(db, kind, was)) return null;
    return await queueRun(db, kind, null);
  } catch (e) {
    // A reply the radio lost may sit on a row that did land. The next tick
    // takes a queued run before it reads the clock, so when one of this
    // kind is there the clock stays moved and nothing is run twice. A read
    // that is refused too says nothing either way, and the clock goes back
    // all the same: a row that did NOT land under a clock left moved is a
    // night lost, while a row that did land under a clock put back is met
    // by servedSince, which queues nothing for a due time that has its run.
    const landed = await openRun(db, "queued", [kind]).catch(() => null);
    if (!landed) await db.from("app_settings").update({ [column]: was }).eq("id", true).eq(column, moved);
    throw e;
  }
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
//
// Null back means this slice lost the folder: it was reclaimed while it hung
// inside the folder call, the next slice has made one and written it, and
// this one must stop rather than write a second folder over it — one backup
// split across two folders, neither complete. The claim and the cursor
// writes cannot see that reclaim (both slices believe "running"); the
// folder_id-is-null condition is what can.
async function ensureRunFolder(db: SupabaseClient, conn: Connection, run: Run): Promise<string | null> {
  if (run.folder_id) return String(run.folder_id);
  const stamp = folderStamp(Date.now());
  const name = run.kind === "before_restore" ? beforeRestoreName(stamp) : stamp;
  const folderId = await withRetry("Making the backup folder",
    () => ensureFolder(conn.drive, conn.rootFolderId, name));
  const { data: mine, error } = await db.from("backup_runs")
    .update({ folder_id: folderId, folder_name: name })
    .eq("id", run.id).eq("status", "running").is("folder_id", null).select("id");
  if (error) throw error;
  if (stillHoldsRun(mine)) return folderId;
  // The folder this slice made is nobody's: take it back out of the drive
  // so it is neither counted by retention nor picked as tomorrow's base —
  // unless the winner wrote down this very folder. ensureFolder finds a
  // folder of the name rather than making a second, so two slices inside
  // one minute hold one id, and deleting it would take the winner's backup
  // with it.
  // A read that failed says nothing about whose folder this is, and no row
  // back means the same: leave it. A stray folder costs retention a slot;
  // deleting the winner's costs the night's backup.
  const { data: owner, error: ownErr } = await db.from("backup_runs")
    .select("folder_id").eq("id", run.id).maybeSingle();
  if (ownErr || !owner || String(owner.folder_id ?? "") === folderId) return null;
  try { await conn.drive.delete(folderId); } catch (e) { console.error("Couldn't remove a stray backup folder:", (e as Error).message); }
  return null;
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
    return await failOrLeave(db, runId, run, guard, e);
  }

  let cursor: RunCursor;
  try {
    const current = await claim(db, run);
    if (!current) return { ok: true, runId, busy: true };
    guard = "running";
    // A file check has no folder of its own and no phases: its own slice,
    // inside the same claim, the same heartbeat and the same catch below.
    if (String(current.kind) === VERIFY_KIND) return await verifySlice(db, conn, current, runId, secret, deadline);
    cursor = reviveCursor(current.cursor, String(current.started_at ?? new Date().toISOString()));

    const folderId = await ensureRunFolder(db, conn, current);
    if (!folderId) return { ok: true, runId, superseded: true };
    // One listing of the run's folder for both children.
    const [tablesFolder, filesFolder] = await withRetry("Opening the backup's folders",
      () => ensureFolders(conn.drive, folderId, [TABLES_FOLDER, FILES_FOLDER]));

    let units = 0;
    while (!outOfBudget(deadline, Date.now()) && cursor.phase !== "done") {
      if (cursor.phase === "tables") cursor = await stepTables(db, conn.drive, tablesFolder, cursor);
      else if (cursor.phase === "files") cursor = await stepFiles(db, conn.drive, filesFolder, cursor, deadline, conn.rootFolderId, folderId, runId);
      else if (cursor.phase === "manifest") cursor = await stepManifest(db, conn.drive, folderId, cursor, String(current.kind), runId);
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
    return await failOrLeave(db, runId, run, guard, e);
  }
}

// The run failed, as far as this slice knows. Conditional on the status the
// slice holds for the same reason every other write is: a slice reclaimed
// out from under itself, throwing its way out an hour later, must not turn
// somebody else's complete run into a failed one. The reason is still logged
// either way — the error happened, whoever owns the run now.
// The fortnightly file check, one slice of it. Every entry in the newest
// complete backup folder's index, in name order from the cursor's offset:
// downloaded off the drive, hashed, compared with its record. A file that
// does not match, or is not in the folder at all, is read again from the
// bucket it came from and re-stored under the same name, its row updated;
// for reports and chat pictures that is the same bytes, for a re-rendered
// assessment or timesheet it is today's, and the note says which. A file
// whose source has gone is counted unrepairable and named. The folder's
// files.json.gz is rewritten from the rows at the end of ANY slice in which
// a repair changed a record — not only at the end of the walk, so a run that
// fails halfway never leaves the index naming a hash the file no longer has.
async function verifySlice(
  db: SupabaseClient, conn: Connection, run: Run, runId: string, secret: string, deadline: number
): Promise<Record<string, unknown>> {
  const c = reviveVerifyCursor(run.cursor, String(run.started_at ?? new Date().toISOString()));
  const persist = async (): Promise<boolean> => {
    const { data: held, error } = await db.from("backup_runs").update({
      phase: c.done ? "done" : "files", cursor: c, heartbeat_at: new Date().toISOString(), counts: verifyCounts(c)
    }).eq("id", runId).eq("status", "running").select("id");
    if (error) throw error;
    return stillHoldsRun(held);
  };
  const finish = async (): Promise<Record<string, unknown>> => {
    c.done = true;
    const finished = new Date().toISOString();
    const { data: held, error } = await db.from("backup_runs").update({
      status: "complete", phase: "done", finished_at: finished, heartbeat_at: finished,
      cursor: c, counts: verifyCounts(c), folder_id: c.folderId, folder_name: c.folderName
    }).eq("id", runId).eq("status", "running").select("id");
    if (error) throw error;
    if (!stillHoldsRun(held)) return { ok: true, runId, superseded: true };
    return { ok: true, runId, complete: true, counts: verifyCounts(c) };
  };

  if (!c.folderId) {
    const { data: newest, error } = await db.from("backup_runs")
      .select("id, folder_id, folder_name").eq("kind", "backup").eq("status", "complete")
      .not("folder_id", "is", null).order("finished_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    if (!newest) {
      addVerifyNote(c, "There is no complete backup to check yet.");
      return await finish();
    }
    c.folderId = String(newest.folder_id);
    c.folderName = String(newest.folder_name ?? "");
    c.backupRunId = String(newest.id);
  }

  const index = await withRetry("Reading the backup's file index", () => readFileIndex(conn.drive, c.folderId!));
  if (!index.size) {
    addVerifyNote(c, `${c.folderName} has no file index — it is from before files were hashed, or its records could not be squared with the folder the night it was made — so there is nothing to check it against. The next backup's folder will have one.`);
    return await finish();
  }
  const filesFolder = (await withRetry("Opening the backup's files folder", () => conn.drive.listFolders(c.folderId!))).find(f => f.name === FILES_FOLDER);
  if (!filesFolder) {
    addVerifyNote(c, `${c.folderName} has no files folder.`);
    return await finish();
  }
  const byName = new Map<string, string>();
  for (const e of await withRetry("Listing the backup's files", () => conn.drive.listFiles(filesFolder.id))) byName.set(e.name, e.id);
  const names = [...index.keys()].sort();

  let units = 0;
  for (let i = c.offset; i < names.length; i++) {
    if (outOfBudget(deadline, Date.now())) break;
    const name = names[i];
    const rec = index.get(name)!;
    const id = byName.get(name) ?? null;
    let bytes: Uint8Array<ArrayBuffer> | null = null;
    let unread = "";
    if (id) {
      try { bytes = await withRetry(`Reading ${name} off the drive`, () => conn.drive.download(id)); }
      catch (e) { unread = (e as Error).message; bytes = null; }
    }
    if (bytes && await hashBytes(bytes) === rec.sha256) {
      c.verified += 1;
      c.bytes += bytes.byteLength;
    } else if (unread) {
      // A read that never arrived says nothing about the file. Re-storing on
      // it would clear the name off the drive before the upload and put
      // today's copy where a good historical assessment or timesheet was —
      // and if the re-store then failed, the folder would have lost it. The
      // nightly spot check already calls an unread file "not checked" rather
      // than damage; so does this, and the next check reads it again.
      c.unread += 1;
      addVerifyNote(c, `${rec.bucket}/${rec.key} could not be read off the drive on this pass and was left alone (${unread}); the next check reads it again.`);
    } else {
      const why = !id ? "was missing from the folder" : "did not hash to its record";
      try {
        const blob = await withRetry(`Re-reading ${rec.bucket}/${rec.key}`, async () => {
          const { data, error } = await db.storage.from(rec.bucket).download(rec.key);
          if (error) throw error;
          return data as Blob;
        });
        const payload = new Uint8Array(await blob.arrayBuffer());
        const newId = await withRetry(`Re-storing ${name}`, () =>
          conn.drive.upload(filesFolder.id, name, payload, blob.type || "application/octet-stream"));
        const sha = await hashBytes(payload);
        const { error } = await db.from("backup_run_files")
          .update({ sha256: sha, size: payload.byteLength, drive_id: newId, reused: false })
          .eq("run_id", c.backupRunId!).eq("name", name);
        if (error) throw error;
        c.repaired += 1;
        c.bytes += payload.byteLength;
        if (sha !== rec.sha256) c.indexDirty = true;
        addVerifyNote(c, `${rec.bucket}/${rec.key} ${why} and was re-stored from the app${sha !== rec.sha256 ? " — the app's copy has changed since that backup, and the record now carries the new hash" : ""}.`);
      } catch (e) {
        c.unrepairable += 1;
        addVerifyNote(c, `${rec.bucket}/${rec.key} ${why} and could not be re-stored: ${(e as Error).message}`);
      }
    }
    c.offset = i + 1;
    units += 1;
    if (units % 25 === 0 && !(await persist())) return { ok: true, runId, superseded: true };
  }

  // A record that changed makes the folder's index stale the moment it
  // changes, and a restore in between reads the old hash off the drive and
  // calls the repaired file damaged — a good file left out and blamed on
  // damage. So it is rewritten at the end of the slice that changed it, not
  // only at the end of the walk: a run that fails halfway must never leave
  // one behind. The flag comes off with it, and the cursor write below (or
  // finish's) is what remembers that.
  if (c.indexDirty) {
    const rows = await listFileRows(db, c.backupRunId!);
    const fresh = rows.map(r => ({ name: r.name, bucket: r.bucket, key: r.key, size: r.size, sha256: r.sha256, reused: r.reused }));
    await withRetry("Rewriting the file index", async () =>
      conn.drive.upload(c.folderId!, FILES_INDEX_NAME, await gzip(new TextEncoder().encode(JSON.stringify(fresh))), "application/gzip"));
    c.indexDirty = false;
  }
  if (c.offset >= names.length) {
    return await finish();
  }
  if (!(await persist())) return { ok: true, runId, superseded: true };
  if (units > 0) kick("backup-run", { action: "advance", runId, chain: true }, secret);
  return { ok: true, runId, phase: "files", continuing: true, checked: c.offset, of: names.length };
}

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

// A slice's error is not always the run's failure. A passing edge blip — the
// reset socket that lost a whole night's backup, a gateway page from the edge —
// is not something to mark the run failed over: doing that makes the run
// terminal and defeats the reclaim path built for exactly this, so the day's
// backup is thrown away with no retry until tomorrow. Left alone, the run stays
// running with its heartbeat ageing, and the next tick reclaims it and resumes
// from the cursor once the edge recovers. Only a real error — or a run too old
// to still finish before tomorrow's is due — is failed for good, so a sustained
// outage cannot wedge the schedule with a run nobody can complete.
async function failOrLeave(
  db: SupabaseClient, runId: string, run: Run, guard: string, e: unknown
): Promise<Record<string, unknown>> {
  if (isTransientEdgeError(e) && withinRetryWindow(Date.parse(String(run.created_at ?? "")), Date.now())) {
    console.warn(`backup-run: a passing edge error left ${runId} for the next tick to resume: ${(e as Error).message}`);
    return { ok: false, runId, transient: true, retrying: true };
  }
  return await fail(db, runId, (e as Error).message, guard);
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
    const pageSize = Math.min(PAGE_ROWS, MAX_PART_ROWS - rows.length);
    let q = db.from(table).select("*").limit(pageSize);
    if (cursorColumn) {
      q = q.order(cursorColumn);
      if (lastKey !== null) q = q.gt(cursorColumn, lastKey);
    } else {
      for (const k of keys) q = q.order(k);
      q = q.range(offset, offset + pageSize - 1);
    }
    const { data, error } = await q;
    if (error) throw error;
    const page = (data ?? []) as Record<string, unknown>[];
    rows.push(...page);
    if (cursorColumn && page.length) lastKey = String(page[page.length - 1][cursorColumn]);
    offset += page.length;
    // A short page may be the server's max-rows cap, not exhaustion.
    // Only an empty response proves this table has no more records.
    if (!page.length) { exhausted = true; break; }
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

// One row per file this run stored, kept in backup_run_files between slices
// and folded into files.json.gz by the manifest phase. Upserted, so a page
// re-listed after a pause writes the same records again harmlessly.
type FileRow = { run_id: string; name: string; bucket: string; key: string; size: number; sha256: string | null; reused: boolean; drive_id: string | null };
async function flushFileRows(db: SupabaseClient, rows: FileRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await db.from("backup_run_files").upsert(rows.slice(i, i + 200), { onConflict: "run_id,name" });
    if (error) throw error;
  }
  rows.length = 0;
}

async function stepFiles(
  db: SupabaseClient, drive: DriveClient, filesFolder: string, c: RunCursor, deadline: number,
  rootFolderId: string, ownFolderId: string, runId: string
): Promise<RunCursor> {
  if (c.bucketIndex >= BUCKETS.length) { c.phase = "manifest"; return c; }
  const bucket = BUCKETS[c.bucketIndex];

  // The base: last night's folder, whose unchanged files are copied over
  // on the drive rather than pulled through Supabase again (carryOverId in
  // backupRun.ts says which). Chosen once per run and kept on the cursor,
  // "none" included. A base is a saving and never a requirement: any
  // trouble finding or listing it means every object goes the long way
  // round, which is what every object did before.
  //
  // The run's own folder is set aside by ID, never by the row's
  // folder_name: the first slice reads its row before it makes the folder,
  // and on a small database the tables phase finishes inside that same
  // slice — so the name was "" here, the newest stamped folder was the
  // run's own, and its files/ was empty until the run filled it.
  if (!c.baseLooked) {
    try {
      const folders = (await withRetry("Looking for last night's folder", () => drive.listFolders(rootFolderId)))
        .filter(f => f.id !== ownFolderId);
      const baseName = chooseBaseFolder(folders.map(f => f.name), "");
      const base = baseName ? folders.find(f => f.name === baseName) : undefined;
      const sub = base
        ? (await withRetry("Opening last night's folder", () => drive.listFolders(base.id))).find(f => f.name === FILES_FOLDER)
        : undefined;
      c.baseFilesFolderId = sub ? sub.id : null;
      c.baseFolderId = base ? base.id : null;
    } catch (e) {
      console.warn(`No base folder for carrying files over: ${(e as Error).message}`);
      c.baseFilesFolderId = null;
      c.baseFolderId = null;
    }
    c.baseLooked = true;
  }
  // Listed once per slice — a few calls for thousands of names — and the
  // base's own index read with it, for the hash each copy will carry. A
  // name the index does not hold is read through: a copy nothing could
  // ever verify is not a saving worth having.
  const baseFiles = new Map<string, { id: string; size: number; sha256: string | null }>();
  if (c.baseFilesFolderId) {
    try {
      for (const e of await withRetry("Listing last night's files", () => drive.listFiles(c.baseFilesFolderId!))) {
        baseFiles.set(e.name, { id: e.id, size: e.size, sha256: null });
      }
      const index = await withRetry("Reading last night's file index", () => readFileIndex(drive, c.baseFolderId ?? ""));
      for (const [name, held] of baseFiles) {
        const rec = index.get(name);
        if (rec) held.sha256 = rec.sha256;
      }
    } catch (e) {
      console.warn(`Last night's files could not be listed; copying everything through: ${(e as Error).message}`);
      baseFiles.clear();
    }
  }
  const rows: FileRow[] = [];

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
      // first pageDone objects are skipped. The records so far go first.
      await flushFileRows(db, rows);
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
        const id = await withRetry(`Carrying over ${bucket}/${key}`, () => drive.copy(from, filesFolder, name));
        // The copy carries the hash of the copy it was made from.
        rows.push({ run_id: runId, name, bucket, key, size, sha256: baseFiles.get(name)?.sha256 ?? null, reused: true, drive_id: id });
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
    const id = await withRetry(`Uploading ${bucket}/${key}`, () =>
      drive.upload(filesFolder, name, payload, blob.type || "application/octet-stream"));
    // Hashed from the bytes as they were read through Supabase: the record
    // of what was stored, for every night after and for a restore.
    rows.push({ run_id: runId, name, bucket, key, size: payload.byteLength, sha256: await hashBytes(payload), reused: false, drive_id: id });
    copied += 1;
    bytes += payload.byteLength;
  }
  await flushFileRows(db, rows);

  // Depth first: sub-prefixes go on the stack, and this prefix advances.
  return afterFilesPage(c, {
    bucketCount: BUCKETS.length, pageLength: page.length, pageRows: PAGE_ROWS,
    folderNames: folders.map(f => f.name), files: copied, bytes, reused
  });
}

// ── Phase: manifest, then retention ──────────────────────────────────────

// Every file record this run wrote, in name order, a page at a time past
// PostgREST's cap.
async function listFileRows(db: SupabaseClient, runId: string): Promise<FileRow[]> {
  const out: FileRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("backup_run_files")
      .select("run_id, name, bucket, key, size, sha256, reused, drive_id")
      .eq("run_id", runId).order("name").range(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as FileRow[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// One carried-over file a night, downloaded off the drive and hashed
// against its record: the copy is the provider's and never passed through
// here, and this is the one thing that would notice the drive's own copy
// drifting from what was stored. Rotates through the reused files by day.
// A mismatch is read through again from Supabase and re-stored, and the
// record updated, so the folder is still complete on its own. Never a
// failure of the run: the answer goes on the manifest and the row.
async function spotCheck(
  db: SupabaseClient, drive: DriveClient, folderId: string, runId: string, records: FileRow[]
): Promise<string> {
  const reusedRows = records.filter(r => r.reused && r.drive_id && r.sha256);
  if (!reusedRows.length) return "nothing carried over to check";
  const pick = reusedRows[Math.floor(Date.now() / 86400000) % reusedRows.length];
  // Whether the drive's copy was read and agreed with its record. Past a
  // disagreement "not checked" is no longer true of it: it WAS checked and
  // it is wrong, and the index this run is about to write names a hash its
  // own file does not have — a restore refuses that file outright.
  let matched = true;
  try {
    const bytes = await withRetry(`Spot-checking ${pick.name}`, () => drive.download(pick.drive_id!));
    if (await hashBytes(bytes) === pick.sha256) return `ok: ${pick.name}`;
    matched = false;
    const filesFolder = (await drive.listFolders(folderId)).find(f => f.name === FILES_FOLDER);
    if (!filesFolder) throw new Error("there is no files folder to re-store it in");
    const blob = await withRetry(`Re-reading ${pick.bucket}/${pick.key}`, async () => {
      const { data, error } = await db.storage.from(pick.bucket).download(pick.key);
      if (error) throw error;
      return data as Blob;
    });
    const payload = new Uint8Array(await blob.arrayBuffer());
    const id = await withRetry(`Re-storing ${pick.name}`, () =>
      drive.upload(filesFolder.id, pick.name, payload, blob.type || "application/octet-stream"));
    const sha = await hashBytes(payload);
    const { error } = await db.from("backup_run_files")
      .update({ sha256: sha, reused: false, drive_id: id, size: payload.byteLength })
      .eq("run_id", runId).eq("name", pick.name);
    if (error) throw error;
    pick.sha256 = sha; pick.reused = false; pick.drive_id = id; pick.size = payload.byteLength;
    return `re-stored: ${pick.name} did not hash to its record`;
  } catch (e) {
    if (!matched) {
      // The one answer no screen draws: `spot` goes to the manifest and the
      // run's counts and nowhere else, so a file this backup is known to hold
      // wrong goes in the error log, where the office's digest reads it.
      const words = `${pick.bucket}/${pick.key} is damaged in this backup — the drive's copy does not hash to its record — and could not be re-stored: ${(e as Error).message}`;
      await logError("backup-run", words, { runId, file: pick.name });
      return `damaged: ${words}`;
    }
    return `not checked: ${(e as Error).message}`;
  }
}

// Two slices of one run alive at once — one reclaimed while the other still
// hung inside a download — can each upload one name and upsert its row, in
// either order. The folder keeps the last upload and the row keeps the last
// upsert, and an object re-rendered between the two reads (a JHA closed out,
// a timesheet re-filed) hashes differently each time, so the index built
// from the rows can name a hash the folder's file has not got — and a
// restore then refuses that good file as damaged, for as long as the folder
// is kept: the file check reads only the newest complete folder, so an
// older folder's index is never put right. The folder is the truth: a record whose drive id is no longer
// the folder's file of that name was written over, and the file is hashed
// again from what is there. One listing a night — the size of the one the
// carry-over already pays for — and a download only for the rare loser.
async function reconcileFileRows(
  db: SupabaseClient, drive: DriveClient, folderId: string, runId: string, records: FileRow[]
): Promise<void> {
  if (!records.length) return;
  const filesFolder = (await withRetry("Opening the backup's files folder", () => drive.listFolders(folderId)))
    .find(f => f.name === FILES_FOLDER);
  if (!filesFolder) return;
  const live = new Map<string, string>();
  for (const e of await withRetry("Listing the files folder", () => drive.listFiles(filesFolder.id))) live.set(e.name, e.id);
  for (const r of records) {
    const id = live.get(r.name);
    if (!id || id === r.drive_id) continue;
    const bytes = await withRetry(`Re-hashing ${r.name}`, () => drive.download(id));
    const sha = await hashBytes(bytes);
    const { error } = await db.from("backup_run_files")
      .update({ sha256: sha, size: bytes.byteLength, drive_id: id })
      .eq("run_id", runId).eq("name", r.name);
    if (error) throw error;
    r.sha256 = sha; r.size = bytes.byteLength; r.drive_id = id;
  }
}

async function stepManifest(
  db: SupabaseClient, drive: DriveClient, folderId: string, c: RunCursor, kind: string, runId: string
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
  // The per-file index, beside the manifest: what every file in files/
  // hashed to when it was stored. The spot check goes first, so a file it
  // re-stores is in the index under its new hash.
  const records = await listFileRows(db, runId);
  // Never the run's failure: a refusal thrown from here would throw away a
  // night of tables and files that are already whole in the folder. But
  // rows that could not be squared with the folder are worse than none — a
  // restore would refuse a good file as damaged, and the file check reads
  // only the NEWEST complete folder, so nothing would ever come back to put
  // this one right. So that night the folder gets an EMPTY index and
  // behaves like one from before files were hashed: a restore puts its
  // files back unchecked and says so, tomorrow's carry-over reads through
  // once, and the office reads why in the error log, which is where the
  // digest looks — no screen draws this. Empty rather than absent, so a
  // manifest attempt that wrote a full one before a blip is replaced.
  let reconciled = true;
  try { await reconcileFileRows(db, drive, folderId, runId, records); }
  catch (e) {
    reconciled = false;
    await logError("backup-run", `The file records could not be squared with the folder, so this backup carries no file index and its files go back unchecked: ${(e as Error).message}`, { runId, folderId });
  }
  c.spot = await spotCheck(db, drive, folderId, runId, records);
  const index = reconciled
    ? records.map(r => ({ name: r.name, bucket: r.bucket, key: r.key, size: r.size, sha256: r.sha256, reused: r.reused }))
    : [];
  await withRetry("Uploading the file index", async () =>
    drive.upload(folderId, FILES_INDEX_NAME, await gzip(new TextEncoder().encode(JSON.stringify(index))), "application/gzip"));
  m = recordFileIndex(m, reconciled ? records.filter(r => r.sha256).length : 0, FILES_INDEX_NAME, c.spot);
  m.jobs = jobsIndex(c.index as Parameters<typeof jobsIndex>[0]);
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
  return (data ?? []).map((r: Pick<Run, "folder_name">) => String(r.folder_name ?? "")).filter(Boolean);
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
