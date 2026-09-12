// backup-restore — putting it back.
//
// Two kinds live here, and they are not the same risk. restore_all is the
// dangerous one. It is the only thing in the app that empties tables it
// did not fill, so it is gated four times over: an Admin's own profile is
// read before anything else happens; a backup from a newer schema than this
// database is refused outright; the Admin types the backup's folder name;
// and the first phase of the restore itself is a complete backup of what is
// about to be replaced, into a "before-restore" folder retention will never
// tidy away. If that copy fails, nothing is deleted at all.
//
// restore_jobs is the everyday one — a job somebody deleted on Tuesday. It
// has none of those gates because it needs none of them: it deletes nothing
// and overwrites nothing, so the worst outcome of a mis-click is some old
// jobs that can be deleted again the ordinary way. The one gate it keeps is
// the schema check, because half a job restored is worse than none.
//
// Both run in slices for the same reason backup-run does, on the same
// cursor-in-the-row pattern, and both are driven by the same five-minute
// tick: backup-run handles its own two kinds and forwards a restore here.
//
//   {action:"preflight"}    an Admin, before the dialog offers anything
//   {action:"restore_all"}  an Admin, with the typed folder name
//   {action:"restore_jobs"} an Admin, with the job ids picked off the index
//   {action:"advance"}      the internal secret, one slice

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  LOAD_ORDER, WIPE_ORDER, TABLE_KEYS, PROFILE_REFS, LIVE_PARENT_REFS,
  APP_SETTINGS_SECRETS, APP_SETTINGS_NEVER_RESTORED, JOB_CHILD_TABLES
} from "../_shared/backupTables.ts";
import {
  TABLES_FOLDER, FILES_FOLDER, folderStamp, beforeRestoreName,
  fileEntryName, parseFileEntryName, schemaTooNew
} from "../_shared/backupManifest.ts";
import type { DriveClient } from "../_shared/drive.ts";
import {
  adminClient, backupDoor, connectDrive, corsHeaders,
  internalSecret, json, kick, logError, readFileIndex, readManifest
} from "../_shared/backupCommon.ts";
import { BUDGET_MS, hashBytes, outOfBudget, sliceDeadline, sliceLooksAlive, stillHoldsRun } from "../_shared/backupRun.ts";
import {
  WRITE_BATCH, CHAT_INSERT_PASS,
  newRestoreCursor, reviveRestoreCursor, restoreCounts,
  afterWipeStep, wipeKeepsCaller, afterPartLoaded, afterTableLoaded,
  afterWipeBatch, smallerWipeBatch, wipeTimedOut,
  SAFETY_REUSE_MS, safetyToReuse, reusedSafetyNote,
  partsForTable, withoutAuthEmail, chatInsertRows, chatReplyPatches,
  settingsRestorePatch, ticketsForLoad, approvedTotalPatches, activityPatches,
  contentTypeFor, typedNameMatches, tooNewRefusal, accountFailureNote,
  withoutMissingProfiles, wantsSetPasswordMail, droppedAccountsNote, setPasswordMailNote,
  quotesThatLanded,
  rowsWithLiveParent,
  JOB_RESTORE_KIND, newJobRestoreCursor, reviveJobRestoreCursor, isJobRestoreCursor,
  jobRestoreCounts, addRestoreNote, rowsForChosenJobs, jobsToRestore, ticketsToRestore,
  childRowsToRestore, crewWithLiveProfiles, matchOrganisation, matchContact, contactKey,
  blankUnknown, pdfKeysFor, onlyForIds, afterJobPart, afterJobTable,
  noRestorableJobs, withoutTakenClientKeys
} from "../_shared/backupRestore.ts";
import type { RestoreCursor, JobRestoreCursor } from "../_shared/backupRestore.ts";
import { gunzip } from "../_shared/gzip.ts";
import { sendSetPasswordLink } from "../_shared/setPassword.ts";
import { refuse, publicWords, loggedWords } from "../_shared/publicError.ts";
// The one sentence anything unmarked comes back as. The refusals this
// function writes itself — a name typed wrong, a backup from a newer
// version, something already running — say what to do and are shown as
// written. A message from Postgres or a drive is logged and not shown.
// Deny by default: the cost of forgetting is silence.
const TROUBLE = "The restore could not be started. Try again, and tell the office if it keeps happening.";

type Part = { id: string; name: string };

// ── The door ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Not found" }, 404);

  const db = adminClient();

  // Who is asking, before anything is parsed and before anything is written
  // down: the slice kick and the cron's forward come with the internal
  // secret and no JWT at all, and everything else is an Admin's own profile
  // read through RLS. A stranger's POST leaves no line in function_errors.
  const caller = await backupDoor(db, req, "Only an Admin can restore a backup");
  if (caller instanceof Response) return caller;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* an empty body is not an action */ }
  const action = String(body.action ?? "");

  try {
    if (action === "advance") {
      // One slice of a restore already under way. Not an Admin's to call:
      // an Admin starts a restore, and the machinery drives it.
      if (!caller.internal) return json({ error: "Not authorized" }, 401);
      return json(await advance(db, String(body.runId ?? ""), caller.secret, body.chain === true));
    }
    if (caller.internal) return json({ error: "Not authorized" }, 401);

    if (action === "preflight") return json(await preflight(db, String(body.folderId ?? "")));
    if (action === "restore_all") {
      return json(await startRestoreAll(db, body, caller.userId, await internalSecret(db)));
    }
    if (action === "restore_jobs") {
      return json(await startRestoreJobs(db, body, caller.userId, await internalSecret(db)));
    }
    return json({ error: `Unknown action "${action}"` }, 400);
  } catch (e) {
    await logError("backup-restore", loggedWords(e), { action });
    return json({ error: publicWords(e, TROUBLE) }, 400);
  }
});

// ── Before anything is offered ───────────────────────────────────────────

async function preflight(db: SupabaseClient, folderId: string): Promise<Record<string, unknown>> {
  if (!folderId) throw refuse("folderId is required");
  const conn = await connectDrive(db);
  // The folder's real name, from the drive. The request carries a copy of
  // it, but a restore's typed-name gate and retention's spare-by-name both
  // need the name the drive holds, not the one the browser was told.
  const folder = (await conn.drive.listFolders(conn.rootFolderId)).find(f => f.id === folderId);
  if (!folder) throw refuse("That backup is not in the drive any more.");
  const m = await readManifest(conn.drive, folderId);
  const { data: live } = await db.rpc("backup_schema_version");
  const liveVersion = live ? String(live) : null;
  const backupVersion = m.schema_version ? String(m.schema_version) : null;
  const tables = (m.tables ?? {}) as Record<string, { rows?: number }>;
  const files = (m.files ?? {}) as { count?: number; bytes?: number };
  return {
    name: folder.name,
    app_version: m.app_version ?? null,
    finished_at: m.finished_at ?? null,
    schema_version: backupVersion,
    live_schema_version: liveVersion,
    // Refused: it holds columns this database has not got.
    tooNew: schemaTooNew(backupVersion, liveVersion),
    // Allowed, but worth saying out loud: anything added since is not in it.
    older: !!(backupVersion && liveVersion && backupVersion < liveVersion),
    rows: Object.values(tables).reduce((n, t) => n + Number(t?.rows ?? 0), 0),
    files: files.count ?? 0,
    bytes: files.bytes ?? 0,
    jobs: ((m.jobs ?? []) as unknown[]).length
  };
}

// ── Starting a restore ───────────────────────────────────────────────────

async function startRestoreAll(
  db: SupabaseClient, body: Record<string, unknown>, adminId: string, secret: string
): Promise<Record<string, unknown>> {
  const folderId = String(body.folderId ?? "");
  if (!folderId) throw refuse("folderId is required");

  // The name is the drive's, read by preflight, never the request's: held
  // against a name the same caller supplied, the typed word checked nothing
  // — and the run row's folder_name is what retention spares a running
  // restore's source folder by.
  const check = await preflight(db, folderId);
  const folderName = String(check.name);
  // The typed name, character for character. The browser checks it too, but
  // the browser's copy of a gate is a courtesy and this one is the gate.
  if (!typedNameMatches(body.confirm, folderName)) {
    throw refuse(`To restore, type the backup's name exactly: ${folderName}`);
  }
  if (check.tooNew) {
    throw refuse(tooNewRefusal(
      check.schema_version as string | null, check.live_schema_version as string | null
    ));
  }

  const { data: open, error: openErr } = await db.from("backup_runs")
    .select("id, kind").in("status", ["queued", "running"]).limit(1).maybeSingle();
  if (openErr) throw openErr;
  if (open) throw refuse("Something is already running — wait for it to finish before starting a restore.");

  const now = new Date().toISOString();
  const cursor = newRestoreCursor({ folderId, folderName, keepProfileId: adminId });
  const { data: run, error } = await db.from("backup_runs").insert({
    kind: "restore_all", status: "running", phase: "safety",
    folder_id: folderId, folder_name: folderName, requested_by: adminId,
    started_at: now, heartbeat_at: now,
    cursor, counts: restoreCounts(cursor)
  }).select("id").single();
  if (error) throw error;

  // The row is in and the answer goes back now. The first slice is a
  // hundred seconds of work and the browser is not going to wait for it;
  // the kick starts it and is abandoned, and the five-minute tick is the
  // backstop if it never arrives.
  kick("backup-restore", { action: "advance", runId: run.id, chain: true }, secret);
  return { ok: true, runId: run.id };
}

// A few jobs, not the lot. There is no typed word to get past here and there
// is no safety backup taken first, and both follow from the same fact: this
// kind deletes nothing and overwrites nothing, so the worst outcome of a
// mis-click is some old jobs that can be deleted again the ordinary way.
//
// The schema check is the same one, though: a backup from a newer app holds
// columns this database has not got, and half a job restored is worse than
// none.
async function startRestoreJobs(
  db: SupabaseClient, body: Record<string, unknown>, adminId: string, secret: string
): Promise<Record<string, unknown>> {
  const folderId = String(body.folderId ?? "");
  const jobIds = Array.isArray(body.jobIds)
    ? [...new Set((body.jobIds as unknown[]).map(String).filter(Boolean))]
    : [];
  if (!folderId) throw refuse("folderId is required");
  if (!jobIds.length) throw refuse("Pick at least one job to restore.");

  const check = await preflight(db, folderId);
  if (check.tooNew) {
    throw refuse(tooNewRefusal(
      check.schema_version as string | null, check.live_schema_version as string | null
    ));
  }

  const { data: open, error: openErr } = await db.from("backup_runs")
    .select("id, kind").in("status", ["queued", "running"]).limit(1).maybeSingle();
  if (openErr) throw openErr;
  if (open) throw refuse("Something is already running — wait for it to finish before restoring anything.");

  const now = new Date().toISOString();
  // The drive's name for the folder, from preflight — see startRestoreAll.
  const folderName = String(check.name);
  const cursor = newJobRestoreCursor({ folderId, folderName, jobIds });
  const { data: run, error } = await db.from("backup_runs").insert({
    kind: JOB_RESTORE_KIND, status: "running", phase: "tables",
    folder_id: folderId, folder_name: folderName, requested_by: adminId,
    started_at: now, heartbeat_at: now,
    cursor, counts: jobRestoreCounts(cursor)
  }).select("id").single();
  if (error) throw error;

  kick("backup-restore", { action: "advance", runId: run.id, chain: true }, secret);
  return { ok: true, runId: run.id };
}

// ── One slice of a restore ───────────────────────────────────────────────

const RUN_COLUMNS = "id, kind, status, phase, cursor, counts, folder_id, folder_name, heartbeat_at";

async function advance(
  db: SupabaseClient, runId: string, secret: string, chained: boolean
): Promise<Record<string, unknown>> {
  if (!runId) throw refuse("runId is required");
  const { data: run, error } = await db.from("backup_runs")
    .select(RUN_COLUMNS).eq("id", runId).maybeSingle();
  if (error) throw error;
  if (!run || run.status !== "running") return { ok: true, runId, idle: true };

  // A slice this one did not follow on from — the cron's forward, or an
  // Admin's panel poking the machinery — must not run beside a chain that is
  // already going: two slices of one restore would fight over the cursor and
  // repeat a phase. The chain's own kick is exempt, because the heartbeat it
  // is following is by definition seconds old.
  if (!chained && sliceLooksAlive(run.heartbeat_at, Date.now())) {
    return { ok: true, runId, busy: true };
  }

  const deadline = sliceDeadline(Date.now(), BUDGET_MS);
  // Two kinds of restore share this function, this row and these guards, and
  // their cursors are different shapes. Which one is on the row is decided
  // by the run's own kind — the value the start wrote — and never guessed at
  // from the cursor's contents.
  const perJob = String(run.kind) === JOB_RESTORE_KIND;
  let c: RestoreCursor | JobRestoreCursor = perJob
    ? reviveJobRestoreCursor(run.cursor)
    : reviveRestoreCursor(run.cursor);
  // The status this slice holds the run at. Every write below is conditional
  // on it, so a slice that has been superseded writes nothing at all —
  // including its own failure. Same discipline as backup-run's, same reason:
  // a stale slice waking an hour later must not overwrite a finished run's
  // cursor or flip a complete run to failed on its way out.
  const guard = "running";

  try {
    // Nothing but the safety phase needs the drive, and the safety phase is
    // where a restore waits — so the connection is opened once the wait is
    // over rather than on every poll of it.
    let drive: DriveClient | null = null;
    const opened = async (): Promise<DriveClient> => {
      if (drive) return drive;
      const opening = (await connectDrive(db)).drive;
      drive = opening;
      return opening;
    };
    // The manifest names the parts; the drive holds them. Listed once per
    // slice rather than once per part, and deliberately not kept on the
    // cursor: it is a few hundred names that would be written back to the
    // row after every unit.
    let parts: Part[] | null = null;
    const partList = async (): Promise<Part[]> => {
      if (parts) return parts;
      const d = await opened();
      const tables = await subFolder(d, c.folderId, TABLES_FOLDER);
      if (!tables) throw refuse("That backup has no tables folder — there is nothing in it to restore.");
      const listed = (await d.listFiles(tables)).map(f => ({ id: f.id, name: f.name }));
      parts = listed;
      return listed;
    };

    // The organisations, contacts and people a per-job restore has to
    // resolve against. Read once per slice — the backup's own copies and the
    // live ones — rather than once per part, and only when a per-job restore
    // actually reaches its jobs table.
    let refs: JobRefs | null = null;
    const jobRefs = async (): Promise<JobRefs> => {
      if (refs) return refs;
      const built = await readJobRefs(db, await opened(), await partList());
      refs = built;
      return built;
    };

    let units = 0;
    while (!outOfBudget(deadline, Date.now()) && c.phase !== "done") {
      if (perJob) {
        // A per-job restore has no safety phase, no wipe and no accounts: it
        // deletes nothing, so there is nothing to take a copy of first, and
        // it never creates an Auth user — it works with the people this
        // database already has.
        const j = c as JobRestoreCursor;
        if (j.phase === "tables") await stepJobTables(db, await opened(), await partList(), j, jobRefs);
        else if (j.phase === "files") await stepJobFiles(db, await opened(), j, deadline);
        else if (j.phase === "activity") await stepJobActivity(db, await opened(), await partList(), j, deadline);
        else j.phase = "done";
        units += 1;
        if (!await persist(db, runId, j, guard)) return { ok: true, runId, superseded: true };
        continue;
      }
      const r = c as RestoreCursor;
      if (c.phase === "safety") {
        const ready = await stepSafety(db, r, runId, guard, secret);
        // The cursor was written inside stepSafety, before this returned:
        // the safety run's id has to be on the row before the slice ends or
        // the next tick raises a second one.
        if (!ready) {
          // A restore waiting on its safety copy is doing exactly what it
          // was told to, and it can wait an hour while a big backup runs.
          // Without a heartbeat here the row would look like a slice that
          // died the moment the second poll returned, so the wait writes one
          // and changes nothing else. It does not wedge the machinery: the
          // heartbeat is stale again inside SLICE_ALIVE_MS, which is shorter
          // than the gap between cron ticks, so the very tick that has to
          // poll this restore still finds it quiet and forwards to it.
          if (!await beat(db, runId, guard)) return { ok: true, runId, superseded: true };
          return { ok: true, runId, phase: "safety", waiting: true };
        }
      }
      else if (c.phase === "wipe") await stepWipe(db, r, deadline);
      else if (c.phase === "accounts") c = await stepAccounts(db, await opened(), await partList(), r, deadline);
      else if (c.phase === "tables") c = await stepLoad(db, await opened(), await partList(), r, deadline);
      else if (c.phase === "files") c = await stepFilesBack(db, await opened(), r, deadline);
      else if (c.phase === "activity") c = await stepActivity(db, await opened(), await partList(), r, deadline);
      else c.phase = "done";
      units += 1;

      if (!await persist(db, runId, c, guard)) return { ok: true, runId, superseded: true };
    }

    if (c.phase === "done") {
      const finished = new Date().toISOString();
      // A restore that had to leave people out finished — and there is still
      // something an Admin has to be told, so it is written on the run. The
      // panel shows `error` only on a run that failed, which is right: this
      // one did not, and the note is for whoever goes looking. A per-job
      // restore has no such list: it never touched an account.
      const left = perJob
        ? ""
        : droppedAccountsNote((c as RestoreCursor).droppedProfileIds, (c as RestoreCursor).accountsFailed);
      const { data: held, error: doneErr } = await db.from("backup_runs").update({
        status: "complete", phase: "done", finished_at: finished,
        heartbeat_at: finished, cursor: c, counts: countsOf(c),
        error: left || null
      }).eq("id", runId).eq("status", guard).select("id");
      if (doneErr) throw doneErr;
      if (!stillHoldsRun(held)) return { ok: true, runId, superseded: true };
      // An address that bounced is not a reason to fail a restore, but it is
      // a reason somebody has to be told about: it is one person with no way
      // into an account that exists.
      //
      // And that is a different sentence from the other thing on this list.
      // `accountsFailed` carries both outcomes — the account that could not
      // be made, and the account that was made and never got its link — and
      // writing "Account not restored" over all of them told an Admin that
      // every one of their people was gone when in fact none of them were.
      // So the ones that really are missing get a line each, named, because
      // each is a hand's work to put right; the bounced emails get one line
      // between them, because they are all the same piece of news.
      if (!perJob) {
        const r = c as RestoreCursor;
        const mailOnly = new Set(r.mailsFailed);
        for (const failure of r.accountsFailed) {
          if (mailOnly.has(failure)) continue;
          await logError("backup-restore", `Account not restored: ${failure}`, { runId });
        }
        const mails = setPasswordMailNote(r.mailsFailed);
        if (mails) await logError("backup-restore", mails, { runId });
      }
      return { ok: true, runId, complete: true, counts: countsOf(c) };
    }

    if (units > 0) kick("backup-restore", { action: "advance", runId, chain: true }, secret);
    return { ok: true, runId, phase: c.phase, continuing: true };
  } catch (e) {
    return await fail(db, runId, (e as Error).message, guard, c.phase, c);
  }
}

// What the panel reads, whichever kind of restore wrote it. The two shapes
// differ where they have to: restore-all counts the rows it left out, a
// per-job restore names them, because "two records were skipped" tells an
// office nothing and "ticket 24-118 is already in use here" tells them what
// to do.
function countsOf(c: RestoreCursor | JobRestoreCursor): Record<string, unknown> {
  return isJobRestoreCursor(c)
    ? jobRestoreCounts(c as JobRestoreCursor)
    : restoreCounts(c as RestoreCursor);
}

// The cursor after every unit, not at the end of the slice: a slice that
// dies here has to be resumable from what is on the row, and the heartbeat
// is how the next tick knows it died. Zero rows matched is this slice
// finding out it no longer holds the run.
async function persist(
  db: SupabaseClient, runId: string, c: RestoreCursor | JobRestoreCursor, guard: string
): Promise<boolean> {
  const { data: held, error } = await db.from("backup_runs").update({
    phase: c.phase, cursor: c, heartbeat_at: new Date().toISOString(), counts: countsOf(c)
  }).eq("id", runId).eq("status", guard).select("id");
  if (error) throw error;
  return stillHoldsRun(held);
}

// The heartbeat on its own, for the one place a slice ends without having
// moved anything: waiting for the safety backup. Same condition as every
// other write, so a superseded slice does not keep a run it no longer holds
// looking alive.
async function beat(db: SupabaseClient, runId: string, guard: string): Promise<boolean> {
  const { data: held, error } = await db.from("backup_runs")
    .update({ heartbeat_at: new Date().toISOString() })
    .eq("id", runId).eq("status", guard).select("id");
  if (error) throw error;
  return stillHoldsRun(held);
}

// The cursor goes down with the failure, in the same conditional write. A
// slice that throws has usually done some of its work first — most sharply
// in the wipe, where what it did was delete — and the run's own counts are
// the only place an Admin can read what the app has lost. Same guard as
// every other write, so a superseded slice still records nothing.
async function fail(
  db: SupabaseClient, runId: string, message: string, guard: string, phase: string,
  c: RestoreCursor | JobRestoreCursor
): Promise<Record<string, unknown>> {
  const { data: held } = await db.from("backup_runs").update({
    status: "failed", error: message, finished_at: new Date().toISOString(),
    phase: c.phase, cursor: c, counts: countsOf(c)
  }).eq("id", runId).eq("status", guard).select("id");
  const superseded = !stillHoldsRun(held);
  await logError("backup-restore", message, superseded ? { runId, phase, superseded } : { runId, phase });
  return superseded
    ? { ok: false, runId, error: message, superseded: true }
    : { ok: false, runId, error: message };
}

// ── Phase: safety ────────────────────────────────────────────────────────
// A complete backup of what is about to be replaced, taken by exactly the
// code that takes every other backup — a queued run of kind before_restore,
// which backup-run starts and drives. This phase does nothing but raise it,
// start it and wait for it, and it refuses to go on if it fails: the whole
// point of the copy is that it exists before anything is deleted.

async function stepSafety(
  db: SupabaseClient, c: RestoreCursor, runId: string, guard: string, secret: string
): Promise<boolean> {
  if (!c.safetyRunId) {
    // Before raising one: has the last attempt on this same backup already
    // finished a copy? Pressing Restore again after a failure is the first
    // thing anybody does, and the wipe it failed in had already emptied
    // tables — so a second copy is a copy of the damage, and it is the
    // newest folder in the drive, the one an Admin would reach for.
    const reuse = await reusableSafety(db, c);
    if (reuse) {
      c.safetyRunId = reuse.runId;
      c.safetyFolderName = reuse.folderName;
      c.notes.push(reusedSafetyNote(reuse.folderName));
      c.phase = "wipe";
      return true;
    }

    const name = beforeRestoreName(folderStamp(Date.now()));
    const { data, error } = await db.from("backup_runs")
      .insert({ kind: "before_restore", status: "queued", folder_name: name })
      .select("id").single();
    if (error) throw error;
    c.safetyRunId = String(data.id);
    // Written to the row here rather than when the slice returns. A tick
    // that read a cursor with no safetyRunId on it would raise a second
    // safety backup, and the one after that a third — the restore would sit
    // in this phase queueing backups for ever.
    if (!await persist(db, runId, c, guard)) {
      throw new Error("This restore was taken over by another slice while its safety backup was being raised.");
    }
    // Queued is not started. Nothing else in this function ever pokes
    // backup-run, so without this the copy waits for the five-minute cron —
    // an Admin who has just typed a folder name to confirm a destructive
    // operation watches a panel that says nothing is happening, and on a
    // project whose cron job is missing or aimed elsewhere the restore waits
    // there for ever. So the run that raised it starts it, by name, and the
    // cron stays the backstop it is documented to be.
    //
    // Deliberately NOT chained. The chain flag exists to let a slice follow
    // its own heartbeat, and this is not that: it is a queued run being
    // started, so there is no heartbeat to be exempt from, and the cron may
    // be picking up the very same row in the same second. Unchained, that
    // race is settled where it should be — backup-run's claim is conditional
    // on the status it read, so exactly one of the two turns this run into a
    // running one and the other is told it is busy. Chained, both would go
    // on and the copy would be taken twice over.
    kick("backup-run", { action: "advance", runId: c.safetyRunId }, secret);
    return false;
  }

  const { data: safety, error } = await db.from("backup_runs")
    .select("status, error, folder_name").eq("id", c.safetyRunId).maybeSingle();
  if (error) throw error;
  if (!safety) {
    throw new Error("The safety backup disappeared before the restore could start. Nothing has been changed.");
  }
  if (safety.status === "failed") {
    throw new Error(
      `The safety backup failed (${safety.error ?? "no reason recorded"}), so nothing has been ` +
      `restored and nothing has been deleted.`
    );
  }
  if (safety.status !== "complete") return false;
  c.safetyFolderName = safety.folder_name ? String(safety.folder_name) : null;
  c.phase = "wipe";
  return true;
}

// The failed attempts on this same backup, newest first, and whether one of
// them left a copy this attempt can stand on. A day's worth is asked for and
// the decision is made on the rows, not by the query: the cursor is what
// says whether a copy actually completed, and that is not something
// PostgREST can filter on.
async function reusableSafety(
  db: SupabaseClient, c: RestoreCursor
): Promise<{ folderName: string; runId: string | null } | null> {
  const now = Date.now();
  const { data, error } = await db.from("backup_runs")
    .select("id, kind, status, folder_id, cursor, started_at, finished_at")
    .eq("kind", "restore_all").eq("status", "failed").eq("folder_id", c.folderId)
    .gte("started_at", new Date(now - SAFETY_REUSE_MS).toISOString())
    .order("started_at", { ascending: false }).limit(10);
  if (error) throw error;
  return safetyToReuse((data ?? []) as unknown as Record<string, unknown>[], {
    folderId: c.folderId, now
  });
}

// ── Phase: wipe ──────────────────────────────────────────────────────────
// One table at a time, in the order the handover script established —
// children first, profiles last, and the error log and audit trail in there
// too because their foreign keys to profiles would otherwise refuse the
// delete. The service role is doing this, so RLS and the guard policies are
// not in the way, which is the point and also why nothing but this function
// may.
//
// A table goes in bounded batches and not in one statement. The role these
// functions reach the database through carries an eight-second cap on any
// one statement and cannot raise it, so the single DELETE this used to issue
// was cancelled and rolled back on ticket_lines every time — 111,777 rows,
// each firing the ticket-total trigger — leaving the app half emptied,
// ticket_crew gone, nothing put back, and a retry starting from the same
// 111,777. The batches are safe with the triggers WIPE_ORDER exists to
// manage: ticket_lines' sync trigger rewrites each ticket's total as its
// lines go, so the deferred balance check passes at every batch's commit,
// and every ticket is still deleted before the burn list is cleared.

async function stepWipe(db: SupabaseClient, c: RestoreCursor, deadline: number): Promise<void> {
  if (c.wipeIndex >= WIPE_ORDER.length) { c.phase = "accounts"; return; }
  const table = WIPE_ORDER[c.wipeIndex];
  // Everything except the Admin running this, on profiles alone. Their row
  // would take their own way into the API with it, and the session driving
  // the restore would lose its permissions in the middle of the job. The
  // load puts the backup's version of the row back over the top.
  const keep = wipeKeepsCaller(table) ? (c.keepProfileId || null) : null;

  // Batches until the table is empty or this slice is out of time. A batch
  // is committed on its own, so a slice that stops here has done real work
  // that the next one simply does not find again; only the counting has to
  // be written down, and the caller persists the cursor when this returns.
  while (!outOfBudget(deadline, Date.now())) {
    // Read against c.wipeBatch AFTER the call, never a size captured before
    // it: wipeBatch halves c.wipeBatch on a 57014 and retries, so a full
    // 1,000-row batch measured against an asked-for 2,000 looked short, the
    // phase moved to the next table, and most of ticket_lines stood.
    const deleted = afterWipeBatch(c, table, await wipeBatch(db, c, table, keep));
    if (deleted < c.wipeBatch) {
      // Short of what was asked for means there was no more to take.
      afterWipeStep(c, WIPE_ORDER.length);
      return;
    }
  }
}

// One batch of one table, through the definer RPC that does the bounded
// delete — PostgREST cannot express "delete some of them", and a limit
// pushed through a filter would be a different row set every call.
//
// A batch the database cancelled on the cap is halved and tried again rather
// than failed: the delete rolled back whole, so nothing is half done, and
// the size that works is kept on the cursor so the rest of the phase starts
// from it. Only a batch that times out at the floor is a real failure.
async function wipeBatch(
  db: SupabaseClient, c: RestoreCursor, table: string, keep: string | null
): Promise<number> {
  for (;;) {
    const { data, error } = await db.rpc("restore_wipe_batch", {
      p_table: table, p_limit: c.wipeBatch, p_keep_id: keep
    });
    if (!error) return Number(data ?? 0);
    const smaller = smallerWipeBatch(c.wipeBatch);
    if (!wipeTimedOut(error) || !smaller) {
      throw new Error(`Emptying ${table} failed: ${error.message}`);
    }
    c.wipeBatch = smaller;
  }
}

// ── Phase: accounts ──────────────────────────────────────────────────────
// Auth users are not in a backup — passwords never leave Supabase — so this
// re-creates the ones that are missing, from the profiles rows the backup
// does hold, using the auth_email each of them carries, and mails each
// person a set-password link through the app's own transport. The id is kept
// because every ticket, JHA and crew row in the backup names it: a new id
// would restore the work and lose whose it was.
//
// A failure here is listed, not fatal: one address that bounces must not
// leave the whole company's records unrestored. The list is on the run and
// in function_errors when it finishes.

async function stepAccounts(
  db: SupabaseClient, drive: DriveClient, parts: Part[], c: RestoreCursor, deadline: number
): Promise<RestoreCursor> {
  const profiles = await readTable(drive, parts, "profiles");

  const existing = new Set<string>();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const users = data?.users ?? [];
    for (const u of users) existing.add(String(u.id));
    // An empty page is the end of the list. Stopping on a short one instead
    // would trust the server to honour perPage, and a gateway that caps at
    // 100 would leave every account past the hundredth out of `existing` —
    // which here means trying to create an Auth user that is already there,
    // for every one of them.
    if (!users.length) break;
  }

  for (let i = c.accountIndex; i < profiles.length; i++) {
    if (outOfBudget(deadline, Date.now())) { c.accountIndex = i; return c; }
    const p = profiles[i] as Record<string, unknown>;
    const id = String(p.id ?? "");
    // The Admin driving this keeps their own Auth user throughout; it is
    // already in `existing` and is never touched here either way.
    if (!id || existing.has(id)) continue;

    const email = String(p.auth_email ?? "").trim();
    const name = String(p.name ?? "");
    if (!email) {
      c.accountsFailed.push(accountFailureNote(name || id,
        "the backup has no email address for this account, so it could not be re-created."));
      c.droppedProfileIds.push(id);
      continue;
    }
    try {
      const { error } = await db.auth.admin.createUser({
        id, email, email_confirm: true,
        password: crypto.randomUUID() + crypto.randomUUID(),
        user_metadata: { name }
      });
      if (error) throw error;
      c.accountsMade.push(email);
      // A deactivated account is put back deactivated — the profiles load
      // writes deactivated_at over the stub in a moment and RLS locks it
      // again — so it gets no invitation to come and set a password.
      if (!wantsSetPasswordMail(p)) continue;
      try { await sendSetPasswordLink(db, email, name, "invite"); }
      catch (e) {
        // The account is here and its rows will load; only the invitation
        // failed. It goes on the panel's list with the rest — and on
        // `mailsFailed` as well, which is how the error log tells this
        // outcome from an account that could not be made at all.
        const note = accountFailureNote(email,
          `the account was re-created but the set-password email did not go out (${(e as Error).message}).`);
        c.accountsFailed.push(note);
        c.mailsFailed.push(note);
      }
    } catch (e) {
      // The Auth user could not be made, so profiles.id has nothing to point
      // at: the profile row is refused however often it is retried, and so is
      // every row in every later table that cannot stand without this person.
      // Say who, drop them, and carry on — the rest of the company's records
      // are not this one account's to hold up.
      c.accountsFailed.push(accountFailureNote(email, (e as Error).message));
      c.droppedProfileIds.push(id);
    }
  }
  c.accountIndex = 0;
  c.phase = "tables";
  return c;
}

// ── Phase: tables ────────────────────────────────────────────────────────

async function stepLoad(
  db: SupabaseClient, drive: DriveClient, allParts: Part[], c: RestoreCursor, deadline: number
): Promise<RestoreCursor> {
  if (c.tableIndex >= LOAD_ORDER.length) { c.phase = "files"; return c; }
  const table = LOAD_ORDER[c.tableIndex];

  // The settings row is not replaced wholesale: it holds the drive
  // connection this restore is running through, and it holds live vendor
  // keys the backup deliberately blanked. Only the columns that are
  // genuinely the client's own settings come back, and only where the backup
  // actually has a value.
  if (table === "app_settings") {
    const rows = await readTable(drive, allParts, "app_settings");
    const patch = settingsRestorePatch(
      (rows[0] ?? {}) as Record<string, unknown>,
      APP_SETTINGS_NEVER_RESTORED, APP_SETTINGS_SECRETS
    );
    // An UPSERT of the one enforced row rather than an UPDATE of it: the
    // table ships with no row at all, so on a fresh project — the whole
    // point of a restore-from-scratch — an UPDATE matches nothing and the
    // mail addresses and the approval base URL are dropped in silence. The
    // rules above are unchanged by it: the payload is the same narrow patch,
    // so a backup_* column is neither inserted nor overwritten (a new row
    // takes the table's own defaults for them), and a credential the backup
    // blanked is not in the patch and so cannot be written over a live key.
    if (rows.length && Object.keys(patch).length) {
      const { error } = await db.from("app_settings")
        .upsert({ id: true, ...patch }, { onConflict: "id" });
      if (error) throw new Error(`Restoring the settings failed: ${error.message}`);
    }
    c.loaded.app_settings = rows.length;
    return afterTableLoaded(c, LOAD_ORDER.length, table);
  }

  // rate_lines' own insert trigger writes a history row for every line it
  // has just put back, so the history the load itself created has to go
  // before the backup's history file is read. Once per run — and in the
  // wipe's batches, through the same RPC, for the same reason: it is one row
  // per rate line and the statement cap does not care that this delete is in
  // the load rather than the wipe.
  if (table === "rate_line_history" && !c.historyCleared) {
    while (!outOfBudget(deadline, Date.now())) {
      // c.wipeBatch after the call, for the reason stepWipe gives: a halved
      // batch that came back full is not an empty table.
      const deleted = await wipeBatch(db, c, "rate_line_history", null);
      if (deleted < c.wipeBatch) {
        c.historyCleared = true;
        break;
      }
    }
    return c;
  }

  const parts = partsForTable(allParts, table);
  if (c.partIndex >= parts.length) return afterTableLoaded(c, LOAD_ORDER.length, table);

  const raw = await readPart(drive, parts[c.partIndex]);
  const lastPart = c.partIndex >= parts.length - 1;

  if (table === "chat_messages") {
    return await loadChatPart(db, c, raw, lastPart, deadline);
  }

  // Two tables go in altered, and both are put right later:
  //   · profiles — auth_email rides in the JSON, not in the table, and an
  //     insert that names it is one PostgREST refuses;
  //   · tickets — the deferred balance trigger re-adds a ticket's lines at
  //     the commit of its own insert, and ticket_lines cannot load first.
  const shaped = table === "profiles" ? withoutAuthEmail(raw)
    : table === "tickets" ? ticketsForLoad(raw)
    : raw;
  // And anyone the accounts phase could not put back is taken out here: a
  // row naming a profile that is not going in is a foreign key nothing will
  // ever satisfy, and one of them would fail the whole table's load.
  const missing = withoutMissingProfiles(shaped, table, c.droppedProfileIds, PROFILE_REFS);
  // Counted once per part, and the cursor is what remembers it: a slice that
  // ran out of budget before writing anything comes back with batchDone at
  // 0, so counting off that would add this part's figure a second time and
  // tell whoever reads it the wrong thing.
  if (!c.partSkipCounted) { c.skipped += missing.skipped; c.partSkipCounted = true; }
  const rows = missing.rows;
  const conflict = (TABLE_KEYS[table] ?? ["id"]).join(",");
  // And the orphans of the orphans. A row whose own NOT NULL foreign key
  // names a row this restore left out has nowhere to go either — a reaction
  // to a message written by an account that could not be re-created — and
  // one of them refuses the batch it rode in. Only when somebody was
  // dropped: with nobody dropped every parent in the backup is on the table.
  const parent = LIVE_PARENT_REFS[table];
  const checkParents = !!parent && c.droppedProfileIds.length > 0;

  for (let at = c.batchDone; at < rows.length; at += WRITE_BATCH) {
    if (outOfBudget(deadline, Date.now())) { c.batchDone = at; return c; }
    let batch = rows.slice(at, at + WRITE_BATCH);
    const targets = checkParents
      ? batch.map(r => String(r[parent.column] ?? "")).filter(Boolean)
      : [];
    // An empty `in` list is a filter PostgREST reads as a syntax error, and
    // a batch that names no parent has nothing to check anyway.
    if (targets.length) {
      const { data: there, error: thereErr } = await db.from(parent.parent).select("id").in("id", targets);
      if (thereErr) throw new Error(`Reading ${parent.parent} back failed: ${thereErr.message}`);
      const landed = rowsWithLiveParent(batch, parent.column, (there ?? []).map(r => String(r.id)));
      batch = landed.rows;
      // Counted per batch, and a batch is only walked once: the budget check
      // above persists batchDone at the boundary, so a resumed slice starts
      // after the batches whose drops are already on the cursor.
      c.skipped += landed.dropped;
      c.partDropped += landed.dropped;
      if (!batch.length) continue;
    }
    // Upsert rather than insert: the Admin's own profile row survived the
    // wipe and has to be replaced by the backup's version of it, and a
    // retried slice must not collide with itself.
    //
    // Triggers stay on all the way through. The guard triggers exempt the
    // service role, the ticket total trigger recomputes exactly the cents
    // the backup already holds, and the two values a trigger does overwrite
    // — jobs.last_activity_at and the price history — are put right in their
    // own steps.
    const { error } = await db.from(table).upsert(batch, { onConflict: conflict });
    if (error) throw new Error(`Restoring ${table} failed at row ${at + 1} of ${rows.length}: ${error.message}`);
  }

  // What went in, which is what the part held less what was left out of it.
  return afterPartLoaded(c, {
    table, rows: rows.length - c.partDropped, lastPart, tableCount: LOAD_ORDER.length
  });
}

// Chat history, in two passes over the same parts.
//
// Pass one inserts through restore_chat_messages, the definer RPC that turns
// the push trigger off around the insert — without it the crew's phones
// would buzz once per historical message. That RPC has no ON CONFLICT
// clause, so a row already on the table is a failed batch rather than a
// no-op, and the live ids are read first. Every quote goes in empty, because
// reply_to points back at chat_messages and a reply can sit in an earlier
// part than the message it quotes.
//
// Pass two walks the same parts again and puts the quotes back, through
// restore_patch_rows — an UPDATE and nothing else. It cannot be an upsert:
// a two-column row {id, reply_to} is checked against chat_messages' NOT NULL
// columns before Postgres ever looks for the conflict, so profile_id and
// body being absent refuses the write outright. An UPDATE also means the
// push trigger (AFTER INSERT) is never reached.
async function loadChatPart(
  db: SupabaseClient, c: RestoreCursor, raw: Record<string, unknown>[],
  lastPart: boolean, deadline: number
): Promise<RestoreCursor> {
  if (c.chatPass === CHAT_INSERT_PASS) {
    // A message written by somebody the accounts phase could not put back
    // has nowhere to go: chat_messages.profile_id is NOT NULL. A pin by one
    // of them is only a pin forgotten.
    const missing = withoutMissingProfiles(raw, "chat_messages", c.droppedProfileIds, PROFILE_REFS);
    // Once per part, off the cursor rather than off batchDone — see stepLoad.
    if (!c.partSkipCounted) { c.skipped += missing.skipped; c.partSkipCounted = true; }
    const kept = missing.rows;
    for (let at = c.batchDone; at < kept.length; at += WRITE_BATCH) {
      if (outOfBudget(deadline, Date.now())) { c.batchDone = at; return c; }
      const batch = kept.slice(at, at + WRITE_BATCH);
      const ids = batch.map(r => String(r.id ?? "")).filter(Boolean);
      const { data: live, error: liveErr } = await db.from("chat_messages").select("id").in("id", ids);
      if (liveErr) throw new Error(`Reading the chat back failed: ${liveErr.message}`);
      const { rows, collisions } = chatInsertRows(batch, (live ?? []).map(r => String(r.id)));
      c.collisions += collisions;
      if (rows.length) {
        const { error } = await db.rpc("restore_chat_messages", { p_rows: rows });
        if (error) throw new Error(`Restoring the chat failed at row ${at + 1} of ${kept.length}: ${error.message}`);
      }
    }
    return afterPartLoaded(c, {
      table: "chat_messages", rows: kept.length, lastPart, tableCount: LOAD_ORDER.length
    });
  }

  const patches = chatReplyPatches(raw);
  for (let at = c.batchDone; at < patches.length; at += WRITE_BATCH) {
    if (outOfBudget(deadline, Date.now())) { c.batchDone = at; return c; }
    let batch = patches.slice(at, at + WRITE_BATCH);
    // Only when somebody was left out. With nobody dropped every message in
    // the backup is on the table and the quotes cannot name a row that is
    // not; with somebody dropped, theirs are gone and a reply quoting one of
    // them would be refused by the foreign key and take the batch with it.
    if (c.droppedProfileIds.length) {
      const targets = batch.map(p => String(p.reply_to ?? "")).filter(Boolean);
      const { data: there, error: thereErr } = await db.from("chat_messages").select("id").in("id", targets);
      if (thereErr) throw new Error(`Reading the quoted messages back failed: ${thereErr.message}`);
      const landed = quotesThatLanded(batch, (there ?? []).map(r => String(r.id)));
      batch = landed.rows;
      c.skipped += landed.dropped;
    }
    if (!batch.length) continue;
    const { error } = await db.rpc("restore_patch_rows", { p_table: "chat_messages", p_rows: batch });
    if (error) throw new Error(`Restoring the chat's replies failed: ${error.message}`);
  }
  c.batchDone = 0;
  if (!lastPart) { c.partIndex += 1; return c; }
  return afterTableLoaded(c, LOAD_ORDER.length, "chat_messages");
}

// ── Phase: files ─────────────────────────────────────────────────────────
// Every PDF and picture back into the bucket it came out of, under the key
// it had. Overwriting, not adding beside: a restore run twice must land on
// the same objects.

async function stepFilesBack(
  db: SupabaseClient, drive: DriveClient, c: RestoreCursor, deadline: number
): Promise<RestoreCursor> {
  const folder = await subFolder(drive, c.folderId, FILES_FOLDER);
  if (!folder) { c.phase = "activity"; return c; }
  const entries = (await drive.listFiles(folder)).slice().sort((a, b) => a.name.localeCompare(b.name));
  // The backup's own record of what each file hashed to when it was stored.
  // Read once per slice; a folder from before the index existed has none,
  // and its files go back unchecked, as they always did.
  const index = await readFileIndex(drive, c.folderId);
  // Said once, as the phase starts. Without it a restore that could check
  // nothing still reports "damaged: 0", which reads as a clean bill of health
  // for files nobody has looked at. A first slice that died before its cursor
  // was written starts here again, so the note is not repeated.
  if (!index.size && c.fileOffset === 0) {
    const unchecked = `${c.folderName || "That backup"} has no file index — it is from before files were hashed, or its records could not be squared with the folder the night it was made — so none of its files could be checked against one on the way back.`;
    if (!c.notes.includes(unchecked)) addRestoreNote(c.notes, unchecked);
  }

  for (let i = c.fileOffset; i < entries.length; i++) {
    if (outOfBudget(deadline, Date.now())) { c.fileOffset = i; return c; }
    const parsed = parseFileEntryName(entries[i].name);
    if (!parsed) { c.skipped += 1; continue; }
    const bytes = await drive.download(entries[i].id);
    const rec = index.get(entries[i].name);
    if (rec && rec.sha256 && await hashBytes(bytes) !== rec.sha256) {
      // Not put back: a damaged PDF written over a good one is worse than
      // a missing one, and the note says which.
      c.damaged += 1;
      addRestoreNote(c.notes, `${parsed.bucket}/${parsed.key} is damaged in that backup — its bytes do not hash to what was stored — and was not put back.`);
      continue;
    }
    const { error } = await db.storage.from(parsed.bucket).upload(parsed.key, bytes, {
      upsert: true,
      // A backup holds the bytes and not the type the bucket served them as,
      // so the type is read back off the key: a report put back as
      // application/octet-stream is one the in-app viewer offers as a
      // download rather than drawing on the screen.
      contentType: contentTypeFor(parsed.key)
    });
    if (error) throw new Error(`Putting ${parsed.bucket}/${parsed.key} back failed: ${error.message}`);
    c.filesDone += 1;
    c.filesBytes += bytes.byteLength;
  }
  c.fileOffset = 0;
  c.phase = "activity";
  return c;
}

// ── Phase: activity ──────────────────────────────────────────────────────
// The two figures a trigger wrote over on the way in, put back now that
// nothing else is going to touch them.
//
//   · a signed ticket's total, which ticket_lines' sync trigger recomputed
//     from the lines. For consistent data that is the same number; for a
//     ticket whose lines and total once drifted it is not, and re-pricing a
//     ticket somebody has signed is not the restore's to do;
//   · jobs.last_activity_at, which orders the board and which the definer
//     triggers on tickets, JHAs and reports have just stamped with today for
//     every job the load touched.
//
// Both are UPDATEs through restore_patch_rows, not upserts. A row of two
// columns is checked against the table's NOT NULL columns before Postgres
// looks for a conflict — tickets.job_id, jobs.job_number — so an upsert of
// {id, total} or {id, last_activity_at} is refused outright, on every row,
// however certainly the id is already there.

async function stepActivity(
  db: SupabaseClient, drive: DriveClient, allParts: Part[], c: RestoreCursor, deadline: number
): Promise<RestoreCursor> {
  if (!c.totalsDone) {
    const parts = partsForTable(allParts, "tickets");
    for (let p = c.totalsPart; p < parts.length; p++) {
      if (outOfBudget(deadline, Date.now())) { c.totalsPart = p; return c; }
      const patches = approvedTotalPatches(await readPart(drive, parts[p]));
      for (let at = 0; at < patches.length; at += WRITE_BATCH) {
        const { error } = await db.rpc("restore_patch_rows", {
          p_table: "tickets", p_rows: patches.slice(at, at + WRITE_BATCH)
        });
        if (error) throw new Error(`Restoring the signed tickets' totals failed: ${error.message}`);
      }
    }
    c.totalsPart = 0;
    c.totalsDone = true;
    return c;
  }

  const parts = partsForTable(allParts, "jobs");
  for (let p = c.activityPart; p < parts.length; p++) {
    if (outOfBudget(deadline, Date.now())) { c.activityPart = p; return c; }
    const patches = activityPatches(await readPart(drive, parts[p]));
    for (let at = 0; at < patches.length; at += WRITE_BATCH) {
      const { error } = await db.rpc("restore_patch_rows", {
        p_table: "jobs", p_rows: patches.slice(at, at + WRITE_BATCH)
      });
      if (error) throw new Error(`Restoring the jobs' activity times failed: ${error.message}`);
    }
  }
  c.activityPart = 0;
  c.phase = "done";
  return c;
}

// ═════════════════════════════════════════════════════════════════════════
// Restoring a few jobs
// ═════════════════════════════════════════════════════════════════════════
//
// The same machinery — the same door, the same cursor-in-the-row, the same
// guard on every write, the same kick between slices — pointed at a much
// smaller job. What is different is that it writes into tables that are NOT
// empty, and every rule follows from that: nothing live is deleted, nothing
// live is overwritten, and a row this restore chose not to write takes its
// own children out of the restore with it rather than leaving them to be
// refused by a foreign key.
//
// Which tables a job's records live in, in the order they have to go back:
// the job itself, then everything that names it.
const JOB_TABLES = ["jobs", ...JOB_CHILD_TABLES];

// The chosen jobs' rows, one part at a time. The backup is read exactly the
// way it was written and each part is filtered to the jobs asked for, so a
// per-job restore never holds more than one part in memory however big the
// backup is — and one part is this phase's unit of work, so the slice's
// budget is checked between them by the loop that calls this.
async function stepJobTables(
  db: SupabaseClient, drive: DriveClient, allParts: Part[],
  c: JobRestoreCursor, jobRefs: () => Promise<JobRefs>
): Promise<void> {
  if (c.tableIndex >= JOB_TABLES.length) { c.phase = "files"; return; }
  // The jobs table is walked first, and once it is done a run with no job to
  // put anything under has nothing left to do: no part of the other five
  // tables can match, no PDF is pointed at and no patch has a row. Reading
  // them anyway is a year of parts fetched off the drive and filtered away.
  if (c.tableIndex > 0 && noRestorableJobs(c)) { c.phase = "done"; return; }
  const table = JOB_TABLES[c.tableIndex];
  const parts = partsForTable(allParts, table);
  if (c.partIndex >= parts.length) { afterJobTable(c, JOB_TABLES.length); return; }

  const all = await readPart(drive, parts[c.partIndex]);
  // Three sets, and the difference between them is the point: what was
  // asked for, what has a row here now, and which tickets actually went
  // back. A job that collided on its number is in the first and not the
  // second, so its tickets are never even read for — while a job that was
  // already here IS in the second, because its missing records are the whole
  // reason somebody pressed the button a second time.
  const mine = rowsForChosenJobs(table, all, {
    chosen: c.jobIds, restored: [...c.jobsDone, ...c.jobsHere], tickets: c.ticketIds
  });
  const written = !mine.length ? 0
    : table === "jobs"
      ? await putJobs(db, c, mine, await jobRefs())
      : await putJobChildren(db, c, table, mine);

  afterJobPart(c, {
    table, rows: written, lastPart: c.partIndex >= parts.length - 1, tableCount: JOB_TABLES.length
  });
}

// A job carries four references that may not exist here any more: its
// client, its contractor, the two contacts on it, and the person who raised
// it. The organisations are looked for by id and then by name — a client
// re-entered by hand after a mistake has a new id and the same name — the
// contacts by id and then by name inside whichever organisation the job
// ended up with, and anything still unmatched is left empty and named in
// the report rather than blocking the job.
async function putJobs(
  db: SupabaseClient, c: JobRestoreCursor, rows: Record<string, unknown>[], refs: JobRefs
): Promise<number> {
  // Two independent lookups, together.
  const [ids, numbers] = await Promise.all([
    liveValues(db, "jobs", "id", rows.map(r => String(r.id ?? ""))),
    liveValues(db, "jobs", "job_number", rows.map(r => String(r.job_number ?? "")))
  ]);
  const decided = jobsToRestore(rows, { ids, numbers });
  for (const note of decided.skipped) addRestoreNote(c.skipped, note);
  for (const note of decided.collisions) addRestoreNote(c.collisions, note);
  // A job that is already here is a parent the children still follow. It is
  // kept apart from jobsDone on purpose: this run did not write it, so the
  // activity phase leaves its place on the board alone — but its tickets,
  // assessments and reports have somewhere to go, and every one of those
  // that is already there will be skipped by its own id in its own table.
  // Without this, a restore that died between the jobs insert and the
  // tickets could never be finished by pressing the button again: the retry
  // would skip the job and call itself complete over missing work.
  c.jobsHere = [...new Set([...c.jobsHere, ...decided.alreadyHere])];
  if (!decided.rows.length) return 0;

  const raisedBy = await liveValues(db, "profiles", "id",
    decided.rows.map(r => String(r.created_by ?? "")));
  const ready = blankUnknown(decided.rows, "created_by", raisedBy).map(row => {
    const job = { ...row };
    const number = String(job.job_number ?? "");
    const client = matchOrganisation(job.client_id, refs.clientNames, refs.liveClients);
    const contractor = matchOrganisation(job.contractor_id, refs.contractorNames, refs.liveContractors);
    job.client_id = client.id;
    job.contractor_id = contractor.id;
    noteOrganisation(c, number, "client", client);
    noteOrganisation(c, number, "contractor", contractor);
    // Each contact inside the organisation the job has just ended up
    // pointing at: two firms may each have a Dave, and a contact matched
    // across a client boundary would put one client's rep on another's job.
    const clientRep = matchContact(job.client_contact_id, refs.contacts, refs.liveContacts, client.id);
    const contractorRep = matchContact(job.contractor_contact_id, refs.contacts, refs.liveContacts, contractor.id);
    job.client_contact_id = clientRep.id;
    job.contractor_contact_id = contractorRep.id;
    if (clientRep.how === "lost") {
      addRestoreNote(c.skipped,
        `Job ${number} was restored without its client contact${clientRep.name ? ` (${clientRep.name})` : ""} — ` +
        `that contact is no longer in the app.`);
    }
    if (contractorRep.how === "lost") {
      addRestoreNote(c.skipped,
        `Job ${number} was restored without its contractor contact${contractorRep.name ? ` (${contractorRep.name})` : ""} — ` +
        `that contact is no longer in the app.`);
    }
    return job;
  });

  for (let at = 0; at < ready.length; at += WRITE_BATCH) {
    const { error } = await db.from("jobs").insert(ready.slice(at, at + WRITE_BATCH));
    if (error) throw new Error(`Restoring the jobs failed: ${error.message}`);
  }
  // Only now, and only the ones that went in. Everything under a job follows
  // this list, so a job named here that is not on the table would be a batch
  // of children nothing will ever satisfy.
  c.jobsDone = [...new Set([...c.jobsDone, ...ready.map(r => String(r.id ?? ""))])];
  return ready.length;
}

function noteOrganisation(
  c: JobRestoreCursor, jobNumber: string, what: string,
  found: { id: string | null; how: string; name: string }
): void {
  if (found.how === "name") {
    addRestoreNote(c.skipped,
      `Job ${jobNumber} was matched to the ${what} “${found.name}” by name — that organisation has a ` +
      `different id here than it had in the backup. Check the job is on the right one.`);
  }
  if (found.how === "lost") {
    addRestoreNote(c.skipped,
      `Job ${jobNumber} was restored without its ${what}${found.name ? ` (${found.name})` : ""} — that ` +
      `organisation is no longer in the app. Set it on the job record.`);
  }
}

// Tickets, charges, crew hours, assessments, reports and price overrides. A
// ticket's id IS its number, so an id already in use is the collision the
// office cares about, and its charges and crew go with it: half a ticket is
// worse than none.
async function putJobChildren(
  db: SupabaseClient, c: JobRestoreCursor, table: string, rows: Record<string, unknown>[]
): Promise<number> {
  const key = "id";
  const ids = rows.map(r => String(r[key] ?? ""));

  let ready: Record<string, unknown>[];
  if (table === "tickets") {
    // Three independent lookups over the same ids, together. A number
    // deliberately retired is not free either; and which job each live
    // ticket of that number is on matters, because a ticket already here
    // under the job it came back under is that same ticket — the second
    // press of the button — and saying "collision" about twenty of those
    // would read as twenty invoices in danger.
    const [live, burned, jobOf] = await Promise.all([
      liveValues(db, table, key, ids),
      liveValues(db, "burned_ticket_numbers", "id", ids),
      liveTicketJobs(db, ids)
    ]);
    const decided = ticketsToRestore(rows, { ids: live, burned, jobOf });
    for (const note of decided.skipped) addRestoreNote(c.skipped, note);
    for (const note of decided.collisions) addRestoreNote(c.collisions, note);
    const techs = await liveValues(db, "profiles", "id",
      decided.rows.map(r => String(r.technician_id ?? "")));
    // At zero, and put right in the activity phase. tickets_total_balances
    // is a deferred constraint trigger that re-adds a ticket's lines at the
    // commit of its own insert, and ticket_lines cannot load before tickets
    // do — a ticket carrying its real total would be refused on every priced
    // ticket in the backup.
    ready = ticketsForLoad(blankUnknown(decided.rows, "technician_id", techs));
  } else {
    const live = await liveValues(db, table, key, ids);
    const decided = childRowsToRestore(table, rows, live);
    for (const note of decided.skipped) addRestoreNote(c.skipped, note);
    ready = decided.rows;
    if (table === "ticket_crew") {
      // ticket_crew.profile_id is NOT NULL, so a crew row for somebody with
      // no profile cannot be written at all. It is hours somebody worked, so
      // it is named rather than guessed at.
      const crew = crewWithLiveProfiles(ready, await liveValues(db, "profiles", "id",
        ready.map(r => String(r.profile_id ?? ""))));
      for (const note of crew.skipped) addRestoreNote(c.skipped, note);
      ready = crew.rows;
    }
    if (table === "jhas") {
      // One lookup over both columns' people, used for each.
      const people = await liveValues(db, "profiles", "id",
        ready.flatMap(r => [String(r.signed_by ?? ""), String(r.closed_by ?? "")]));
      ready = blankUnknown(ready, "signed_by", people);
      ready = blankUnknown(ready, "closed_by", people);
    }
  }

  // Three of these tables carry client_key, the app's own idempotency key,
  // unique wherever it is not null. A restored row keeps its own, so a key
  // that is live here under a different id would refuse the whole batch with
  // a message naming an index — asked about first, and named the way a
  // ticket number in use is named.
  if (table === "tickets" || table === "jhas" || table === "reports") {
    const taken = await liveValues(db, table, "client_key",
      ready.map(r => String(r.client_key ?? "")));
    const decided = withoutTakenClientKeys(table, ready, taken);
    for (const note of decided.collisions) addRestoreNote(c.collisions, note);
    ready = decided.rows;
  }

  if (!ready.length) return 0;
  for (let at = 0; at < ready.length; at += WRITE_BATCH) {
    const { error } = await db.from(table).insert(ready.slice(at, at + WRITE_BATCH));
    if (error) throw new Error(`Restoring ${table.replace(/_/g, " ")} failed: ${error.message}`);
  }

  // Only the tickets that actually went back may bring charges and crew, and
  // only the PDFs of rows that actually went back are worth fetching.
  if (table === "tickets") {
    c.ticketIds = [...new Set([...c.ticketIds, ...ready.map(r => String(r.id ?? ""))])];
  }
  if (table === "jhas" || table === "reports") {
    c.pdfKeys = [...new Set([...c.pdfKeys, ...pdfKeysFor(table, ready)])];
  }
  return ready.length;
}

// Which of these values are already here. Asked in batches, because "in"
// with twenty-five thousand values is a URL no gateway will take — and a
// hundred at a time rather than two hundred, because a uuid is thirty-six
// characters before the commas and the escaping, and the ceiling that
// matters is the URL's length and not the row count.
async function liveValues(
  db: SupabaseClient, table: string, column: string, values: string[]
): Promise<string[]> {
  const out: string[] = [];
  const unique = [...new Set(values.filter(Boolean))];
  for (let at = 0; at < unique.length; at += 100) {
    const { data, error } = await db.from(table).select(column).in(column, unique.slice(at, at + 100));
    if (error) throw new Error(`Reading ${table} back failed: ${error.message}`);
    // The column is chosen at run time, so supabase-js cannot know the row
    // shape and types the answer as an error union; the cast is the only way
    // to read a column whose name is a variable.
    for (const r of (data ?? []) as unknown as Record<string, unknown>[]) out.push(String(r[column]));
  }
  return out;
}

// Which job each of these ticket numbers is on here, for the tickets that
// are here at all. It is the difference between the second press of Restore
// jobs — the same ticket, on the same job, already back — and a number that
// has since been used by somebody else's invoice.
async function liveTicketJobs(db: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let at = 0; at < unique.length; at += 100) {
    const { data, error } = await db.from("tickets").select("id, job_id").in("id", unique.slice(at, at + 100));
    if (error) throw new Error(`Reading the tickets back failed: ${error.message}`);
    for (const r of (data ?? []) as unknown as Record<string, unknown>[]) {
      out.set(String(r.id ?? ""), String(r.job_id ?? ""));
    }
  }
  return out;
}

// The organisations and contacts, from the backup and from this database,
// so a job's references can be resolved rather than assumed.
interface JobRefs {
  clientNames: Map<string, string>;
  contractorNames: Map<string, string>;
  contacts: Map<string, { name: string; org_id: string }>;
  liveClients: { ids: Set<string>; byName: Map<string, string> };
  liveContractors: { ids: Set<string>; byName: Map<string, string> };
  liveContacts: { ids: Set<string>; byOrgAndName: Map<string, string> };
}

async function readJobRefs(
  db: SupabaseClient, drive: DriveClient, allParts: Part[]
): Promise<JobRefs> {
  const namesFrom = (rows: Record<string, unknown>[]): Map<string, string> => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(String(r.id ?? ""), String(r.name ?? ""));
    return m;
  };
  const liveOrgs = async (table: string) => {
    const rows = await readEveryRow(db, table, "id, name");
    const ids = new Set<string>();
    const byName = new Map<string, string>();
    for (const r of rows) {
      ids.add(String(r.id ?? ""));
      byName.set(String(r.name ?? "").trim().toLowerCase(), String(r.id ?? ""));
    }
    return { ids, byName };
  };

  // Six reads — three tables out of the backup, three walked live — that
  // depend on nothing but the drive and the database, started together.
  // They used to run one after another, every slice, inside the same
  // hundred-second budget the load itself has to fit in.
  const [backupContactRows, liveContactRows, clientRows, contractorRows, liveClients, liveContractors] =
    await Promise.all([
      readTable(drive, allParts, "contacts"),
      readEveryRow(db, "contacts", "id, name, org_id"),
      readTable(drive, allParts, "clients"),
      readTable(drive, allParts, "contractors"),
      liveOrgs("clients"),
      liveOrgs("contractors")
    ]);
  const backupContacts = new Map<string, { name: string; org_id: string }>();
  for (const r of backupContactRows) {
    backupContacts.set(String(r.id ?? ""), {
      name: String(r.name ?? ""), org_id: String(r.org_id ?? "")
    });
  }
  const contactIds = new Set<string>();
  const byOrgAndName = new Map<string, string>();
  for (const r of liveContactRows) {
    contactIds.add(String(r.id ?? ""));
    byOrgAndName.set(contactKey(r.org_id, r.name), String(r.id ?? ""));
  }

  return {
    clientNames: namesFrom(clientRows),
    contractorNames: namesFrom(contractorRows),
    contacts: backupContacts,
    liveClients,
    liveContractors,
    liveContacts: { ids: contactIds, byOrgAndName }
  };
}

// PostgREST answers at most 1,000 rows per request, silently — and "every
// client we have" has to mean every one of them or a job comes back without
// an organisation that was there all along.
async function readEveryRow(
  db: SupabaseClient, table: string, columns: string
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(columns).order("id").range(from, from + 999);
    if (error) throw new Error(`Reading ${table} failed: ${error.message}`);
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

// Only the PDFs the restored rows point at, matched by the flat name the
// backup wrote them under. Nothing else in the files folder is touched.
async function stepJobFiles(
  db: SupabaseClient, drive: DriveClient, c: JobRestoreCursor, deadline: number
): Promise<void> {
  const wanted = [...new Set(c.pdfKeys)];
  if (!wanted.length) { c.phase = "activity"; return; }
  const folder = await subFolder(drive, c.folderId, FILES_FOLDER);
  if (!folder) {
    addRestoreNote(c.skipped, "That backup has no files folder, so the records came back without their PDFs.");
    c.phase = "activity";
    return;
  }

  if (!c.fileIndex) {
    // One listing per run rather than per slice: a year's files folder is
    // thousands of entries, and what this restore needs out of it is a few.
    const byName = new Map((await drive.listFiles(folder)).map(e => [e.name, e.id]));
    c.fileIndex = wanted.map(pathKey => {
      const cut = pathKey.indexOf("/");
      const name = fileEntryName(pathKey.slice(0, cut), pathKey.slice(cut + 1));
      return { key: pathKey, id: byName.get(name) ?? null };
    });
    return;
  }

  const list = c.fileIndex;
  // The same check the restore-all makes: a file whose bytes do not hash
  // to the backup's own record is named and left out.
  const index = await readFileIndex(drive, c.folderId);
  // And the same admission when there is no record to check against.
  if (!index.size && c.fileOffset === 0) {
    const unchecked = `${c.folderName || "That backup"} has no file index — it is from before files were hashed, or its records could not be squared with the folder the night it was made — so none of its PDFs could be checked against one on the way back.`;
    if (!c.skipped.includes(unchecked)) addRestoreNote(c.skipped, unchecked);
  }
  for (let i = c.fileOffset; i < list.length; i++) {
    if (outOfBudget(deadline, Date.now())) { c.fileOffset = i; return; }
    const item = list[i];
    if (!item.id) {
      addRestoreNote(c.skipped, `${item.key} was not in that backup, so the record came back without its PDF.`);
      continue;
    }
    const cut = item.key.indexOf("/");
    const bucket = item.key.slice(0, cut);
    const key = item.key.slice(cut + 1);
    const bytes = await drive.download(item.id);
    const rec = index.get(fileEntryName(bucket, key));
    if (rec && rec.sha256 && await hashBytes(bytes) !== rec.sha256) {
      c.damaged += 1;
      addRestoreNote(c.skipped, `${item.key} is damaged in that backup — its bytes do not hash to what was stored — so the record came back without its PDF.`);
      continue;
    }
    const { error } = await db.storage.from(bucket).upload(key, bytes, {
      upsert: true, contentType: contentTypeFor(key)
    });
    if (error) throw new Error(`Putting ${item.key} back failed: ${error.message}`);
    c.filesDone += 1;
    c.filesBytes += bytes.byteLength;
  }
  c.fileOffset = 0;
  c.phase = "activity";
}

// The two figures a trigger wrote over on the way in, put back for the rows
// THIS run wrote and no others — a ticket that was already here keeps its
// own total, and a job that was already here keeps its own place on the
// board. Both are UPDATEs through restore_patch_rows for the same reason
// restore-all's are: a two-column upsert is checked against the table's NOT
// NULL columns before Postgres ever looks for the conflict.
async function stepJobActivity(
  db: SupabaseClient, drive: DriveClient, allParts: Part[], c: JobRestoreCursor, deadline: number
): Promise<void> {
  if (!c.totalsDone) {
    const parts = partsForTable(allParts, "tickets");
    for (let p = c.totalsPart; p < parts.length; p++) {
      if (outOfBudget(deadline, Date.now())) { c.totalsPart = p; return; }
      const patches = onlyForIds(approvedTotalPatches(await readPart(drive, parts[p])), c.ticketIds);
      for (let at = 0; at < patches.length; at += WRITE_BATCH) {
        const { error } = await db.rpc("restore_patch_rows", {
          p_table: "tickets", p_rows: patches.slice(at, at + WRITE_BATCH)
        });
        if (error) throw new Error(`Restoring the signed tickets' totals failed: ${error.message}`);
      }
    }
    c.totalsPart = 0;
    c.totalsDone = true;
    return;
  }

  const parts = partsForTable(allParts, "jobs");
  for (let p = c.activityPart; p < parts.length; p++) {
    if (outOfBudget(deadline, Date.now())) { c.activityPart = p; return; }
    const patches = onlyForIds(activityPatches(await readPart(drive, parts[p])), c.jobsDone);
    for (let at = 0; at < patches.length; at += WRITE_BATCH) {
      const { error } = await db.rpc("restore_patch_rows", {
        p_table: "jobs", p_rows: patches.slice(at, at + WRITE_BATCH)
      });
      if (error) throw new Error(`Restoring the jobs' activity times failed: ${error.message}`);
    }
  }
  c.activityPart = 0;
  c.phase = "done";
}

// ── Reading a backup's parts ─────────────────────────────────────────────

async function subFolder(drive: DriveClient, folderId: string, name: string): Promise<string | null> {
  const found = (await drive.listFolders(folderId)).find(f => f.name === name);
  return found ? found.id : null;
}

async function readPart(drive: DriveClient, part: Part): Promise<Record<string, unknown>[]> {
  const packed = await drive.download(part.id);
  const rows = JSON.parse(new TextDecoder().decode(await gunzip(packed)));
  if (!Array.isArray(rows)) throw new Error(`${part.name} is not a table part.`);
  return rows as Record<string, unknown>[];
}

// A whole table at once, for the two places that need all of it rather than
// a part at a time: the accounts phase, which has to know every profile in
// the backup, and the settings row, which is one row.
async function readTable(
  drive: DriveClient, allParts: Part[], table: string
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const part of partsForTable(allParts, table)) out.push(...await readPart(drive, part));
  return out;
}
