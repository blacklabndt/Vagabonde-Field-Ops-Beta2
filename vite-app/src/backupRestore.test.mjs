// Putting a backup back, as far as it can be checked without a drive: the
// phase arithmetic, chat history's two passes, the settings row's
// column-by-column rules, and the small decisions the restore makes on its
// own.
//
// backupRestore.ts is imported straight out of supabase/functions/ and node
// strips its types, so it is written in erasable TypeScript with no imports.
// If this file ever fails with "Unknown file extension" or a syntax error
// inside a .ts, something non-erasable has been added to it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  RESTORE_PHASES, WRITE_BATCH, CHAT_INSERT_PASS, CHAT_REPLY_PASS,
  newRestoreCursor, reviveRestoreCursor, restoreCounts,
  afterWipeStep, wipeKeepsCaller, afterPartLoaded, afterTableLoaded,
  WIPE_BATCH, MIN_WIPE_BATCH, afterWipeBatch, smallerWipeBatch, wipeTimedOut,
  SAFETY_REUSE_MS, safetyToReuse, reusedSafetyNote, rowWords,
  partsForTable, withoutAuthEmail, chatInsertRows, chatReplyPatches,
  settingsRestorePatch, ticketsForLoad, approvedTotalPatches, activityPatches,
  contentTypeFor, typedNameMatches, tooNewRefusal, accountFailureNote,
  withoutMissingProfiles, wantsSetPasswordMail, droppedAccountsNote, setPasswordMailNote,
  quotesThatLanded,
  rowsWithLiveParent,
  JOB_RESTORE_KIND, JOB_RESTORE_PHASES, MAX_RESTORE_NOTES,
  newJobRestoreCursor, reviveJobRestoreCursor, isJobRestoreCursor, jobRestoreCounts,
  addRestoreNote, rowsForChosenJobs, jobsToRestore, ticketsToRestore,
  childRowsToRestore, crewWithLiveProfiles, matchOrganisation, matchContact,
  blankUnknown, pdfKeysFor, onlyForIds, afterJobPart, afterJobTable,
  noRestorableJobs, withoutTakenClientKeys, rowIdentity
} from "../../supabase/functions/_shared/backupRestore.ts";

import {
  LOAD_ORDER, WIPE_ORDER, PROFILE_REFS, LIVE_PARENT_REFS,
  APP_SETTINGS_SECRETS, APP_SETTINGS_NEVER_RESTORED, JOB_CHILD_TABLES
} from "../../supabase/functions/_shared/backupTables.ts";

const ROOT = new URL("../../", import.meta.url);
const read = rel => readFileSync(new URL(rel, ROOT), "utf8");

// ── The order the spec argued about ──────────────────────────────────────

test("the phases run safety, wipe, accounts, tables, files, activity", () => {
  assert.deepEqual(RESTORE_PHASES,
    ["safety", "wipe", "accounts", "tables", "files", "activity", "done"]);
  // Accounts before tables, not after: profiles.id is a foreign key to
  // auth.users, so a profile row whose Auth user is gone cannot be inserted
  // at all.
  assert.ok(RESTORE_PHASES.indexOf("accounts") < RESTORE_PHASES.indexOf("tables"));
  // The safety copy is taken before anything is emptied. That is the whole
  // reason it is a phase rather than a step inside one.
  assert.equal(RESTORE_PHASES[0], "safety");
  assert.ok(RESTORE_PHASES.indexOf("safety") < RESTORE_PHASES.indexOf("wipe"));
  // The activity times are put back after the files, because the triggers
  // that overwrite them fire on everything the load touches.
  assert.ok(RESTORE_PHASES.indexOf("activity") > RESTORE_PHASES.indexOf("files"));
});

// ── The cursor ───────────────────────────────────────────────────────────

test("a fresh cursor starts at safety and remembers who is driving", () => {
  const c = newRestoreCursor({ folderId: "f1", folderName: "2026-09-05 02-00", keepProfileId: "kyle" });
  assert.equal(c.phase, "safety");
  assert.equal(c.folderId, "f1");
  assert.equal(c.folderName, "2026-09-05 02-00");
  assert.equal(c.keepProfileId, "kyle");
  assert.equal(c.safetyRunId, null);
  assert.equal(c.chatPass, CHAT_INSERT_PASS);
  assert.equal(c.historyCleared, false);
  assert.deepEqual(c.loaded, {});
});

test("a cursor read back out of jsonb is filled in rather than trusted", () => {
  const c = reviveRestoreCursor({
    phase: "tables", folderId: "f1", folderName: "2026-09-05 02-00",
    keepProfileId: "kyle", tableIndex: 4, partIndex: 2, batchDone: 1000,
    loaded: { jobs: 120 }, safetyRunId: "s1", historyCleared: true
  });
  assert.equal(c.phase, "tables");
  assert.equal(c.tableIndex, 4);
  assert.equal(c.batchDone, 1000);
  assert.equal(c.loaded.jobs, 120);
  assert.equal(c.safetyRunId, "s1");
  assert.equal(c.historyCleared, true);
  // Everything the writing slice did not have is present and harmless.
  assert.deepEqual(c.accountsMade, []);
  assert.deepEqual(c.accountsFailed, []);
  // A run raised before this field existed has none of it, and reading it as
  // undefined would throw on the first bounced email.
  assert.deepEqual(c.mailsFailed, []);
  assert.equal(c.fileOffset, 0);
  assert.equal(c.activityPart, 0);
  assert.equal(c.skipped, 0);
  assert.equal(c.collisions, 0);

  // A cursor that says nothing at all is a fresh one at safety.
  const fresh = reviveRestoreCursor(null);
  assert.equal(fresh.phase, "safety");
  assert.deepEqual(reviveRestoreCursor({}), fresh);
  // historyCleared is only ever true when it was written true — a truthy
  // string read out of jsonb must not be mistaken for the flag.
  assert.equal(reviveRestoreCursor({ historyCleared: "no" }).historyCleared, false);
});

test("the counts always carry skipped and collisions, at zero if nothing else", () => {
  const c = newRestoreCursor({ folderId: "f", folderName: "n", keepProfileId: "k" });
  const counts = restoreCounts(c);
  assert.deepEqual(counts.rows, {});
  assert.equal(counts.files, 0);
  assert.equal(counts.accounts, 0);
  assert.deepEqual(counts.accountsFailed, []);
  // A count that only exists once it is non-zero is a count nobody can read
  // as "none".
  assert.ok("skipped" in counts, "skipped is in every counts object");
  assert.ok("collisions" in counts, "collisions is in every counts object");
  assert.equal(counts.skipped, 0);
  assert.equal(counts.collisions, 0);

  c.loaded = { jobs: 12, tickets: 40 };
  c.filesDone = 9;
  c.filesBytes = 4096;
  c.accountsMade = ["a@b.ca", "c@d.ca"];
  c.accountsFailed = ["e@f.ca: bounced"];
  c.skipped = 3;
  c.collisions = 1;
  const after = restoreCounts(c);
  assert.deepEqual(after.rows, { jobs: 12, tickets: 40 });
  assert.equal(after.accounts, 2);
  assert.deepEqual(after.accountsFailed, ["e@f.ca: bounced"]);
  assert.equal(after.skipped, 3);
  assert.equal(after.collisions, 1);
});

test("the counts carry the safety copy's name, because a failed restore is read from them", () => {
  // The panel polls the run row and never sees the cursor, so the one thing
  // a failed restore-all has to be able to say — the app was emptied, and
  // here is the copy of what was in it — has to travel in counts.
  const c = newRestoreCursor({ folderId: "f", folderName: "n", keepProfileId: "k" });
  assert.ok("safety" in restoreCounts(c), "the key is there from the first slice");
  assert.equal(restoreCounts(c).safety, null, "and it is null until the copy has completed");

  // stepSafety sets it in the same breath as it moves the phase to wipe, so
  // a name on the run means the delete was next or already under way.
  c.safetyFolderName = "before-restore 2026-09-05 0210";
  c.phase = "wipe";
  assert.equal(restoreCounts(c).safety, "before-restore 2026-09-05 0210");

  const source = read("supabase/functions/backup-restore/index.ts");
  assert.match(source, /c\.safetyFolderName = safety\.folder_name/,
    "and it is still written where the safety copy is seen to finish");
});

// ── Safety ───────────────────────────────────────────────────────────────

test("a retry reuses the last attempt's safety copy rather than copying the damage", () => {
  const now = Date.parse("2026-09-05T22:10:00Z");
  const attempt = o => ({
    kind: "restore_all", status: o.status ?? "failed", folder_id: o.folder ?? "src",
    started_at: o.at, finished_at: o.at,
    cursor: { safetyFolderName: o.name ?? "", safetyRunId: o.runId ?? null }
  });

  // The ordinary case. The first attempt emptied ticket_crew and died in the
  // wipe; its safety copy is a copy of the app as it stood BEFORE that, and
  // taking a fresh one now would copy a database already 46,080 rows short.
  assert.deepEqual(
    safetyToReuse(
      [attempt({ at: "2026-09-05T21:10:00Z", name: "before-restore 2026-09-05 15-00", runId: "r1" })],
      { folderId: "src", now }),
    { folderName: "before-restore 2026-09-05 15-00", runId: "r1" });

  // EARLIEST of the failures: the first attempt copied the app whole, and
  // every attempt after it copied a database its wipe had already started
  // on. The rehearsal's second attempt was 46,080 crew rows short of its
  // first, and "newest" once handed that one to the Admin as the way back.
  assert.equal(
    safetyToReuse([
      attempt({ at: "2026-09-05T20:00:00Z", name: "before-restore 2026-09-05 14-00", runId: "r1" }),
      attempt({ at: "2026-09-05T21:10:00Z", name: "before-restore 2026-09-05 15-00", runId: "r2" })
    ], { folderId: "src", now }).folderName,
    "before-restore 2026-09-05 14-00");

  // An attempt whose copy never completed carries no folder name — the name
  // is written the moment the copy finishes, so its absence is the proof —
  // and there is nothing there to stand on.
  assert.equal(
    safetyToReuse([attempt({ at: "2026-09-05T21:10:00Z", name: "" })], { folderId: "src", now }),
    null);

  // A different backup's attempt copied the app before a different restore.
  assert.equal(
    safetyToReuse([attempt({ at: "2026-09-05T21:10:00Z", name: "before-restore x", folder: "other" })],
      { folderId: "src", now }),
    null);

  // Yesterday's is stale: the app has had a day's work put into it since,
  // and a copy that old is no longer what this restore is about to replace.
  assert.equal(
    safetyToReuse([attempt({ at: new Date(now - SAFETY_REUSE_MS - 1000).toISOString(), name: "old" })],
      { folderId: "src", now }),
    null);

  // And only a failure. A complete restore's copy describes an app that was
  // replaced on purpose; a running one is somebody else's business.
  for (const status of ["complete", "running", "queued"]) {
    assert.equal(
      safetyToReuse([attempt({ at: "2026-09-05T21:10:00Z", name: "n", status })], { folderId: "src", now }),
      null, `${status} is not a retry's to reuse`);
  }
});

test("the reused copy is named on the run, and the panel reads that list", () => {
  const note = reusedSafetyNote("before-restore 2026-09-05 16-00");
  assert.match(note, /before-restore 2026-09-05 16-00/);
  assert.match(note, /way back/);

  const c = newRestoreCursor({ folderId: "f", folderName: "n", keepProfileId: "k" });
  c.notes.push(note);
  assert.deepEqual(restoreCounts(c).notes, [note]);
  // A note nothing renders is a note nobody reads.
  assert.match(read("vite-app/src/components/backupPanel.jsx"), /noteList\(counts && counts\.notes\)/);

  const source = read("supabase/functions/backup-restore/index.ts");
  assert.match(source, /reusableSafety\(db, c\)/,
    "and the safety phase asks before it raises a second copy");
});

// ── Wipe ─────────────────────────────────────────────────────────────────

test("the wipe deletes in batches, and remembers the size and what it took", () => {
  const c = newRestoreCursor({ folderId: "f", folderName: "n", keepProfileId: "k" });
  assert.equal(c.wipeBatch, WIPE_BATCH);
  assert.deepEqual(c.wiped, {});

  assert.equal(afterWipeBatch(c, "ticket_lines", 2000), 2000);
  afterWipeBatch(c, "ticket_lines", 2000);
  afterWipeBatch(c, "ticket_lines", 111);
  assert.equal(c.wiped.ticket_lines, 4111);
  // On a run that finishes this is arithmetic nobody needs; on one that dies
  // in the wipe it is the only statement of what the app has lost.
  assert.equal(restoreCounts(c).wiped.ticket_lines, 4111);

  const back = reviveRestoreCursor(JSON.parse(JSON.stringify(c)));
  assert.equal(back.wiped.ticket_lines, 4111);
  assert.equal(back.wipeBatch, WIPE_BATCH);
  // A run raised before the size existed reads as the default. A zero here
  // would be a delete of no rows, asked for ever.
  assert.equal(reviveRestoreCursor({ phase: "wipe" }).wipeBatch, WIPE_BATCH);
});

test("a batch the cap cancels is halved, and only the floor is a failure", () => {
  assert.equal(smallerWipeBatch(2000), 1000);
  assert.equal(smallerWipeBatch(1000), 500);
  assert.equal(smallerWipeBatch(500), 250);
  assert.equal(smallerWipeBatch(250), MIN_WIPE_BATCH);
  // At the floor the answer is no. A hundred-odd rows that still will not go
  // in eight seconds are not failing on size, and shrinking further would
  // turn a real fault into a very slow one.
  assert.equal(smallerWipeBatch(MIN_WIPE_BATCH), null);
  assert.equal(smallerWipeBatch(0), WIPE_BATCH / 2, "no size on the cursor starts from the default");
});

test("only a statement timeout is answered by trying again with less", () => {
  assert.equal(wipeTimedOut({ code: "57014", message: "canceling statement due to statement timeout" }), true);
  // Not every gateway hands the code back; some only say it in words.
  assert.equal(wipeTimedOut({ message: "canceling statement due to statement timeout" }), true);
  // Everything else is itself. A permission refusal met by halving the batch
  // would be retried four times over and then reported as the wrong thing.
  assert.equal(wipeTimedOut({ code: "42501", message: "permission denied for table tickets" }), false);
  assert.equal(wipeTimedOut({ code: "23503", message: "violates foreign key constraint" }), false);
  assert.equal(wipeTimedOut(null), false);
});

test("the wipe's delete is bounded, and goes through the definer RPC", () => {
  const source = read("supabase/functions/backup-restore/index.ts");
  // The unbounded delete this replaced could not empty ticket_lines at all:
  // 111,777 rows, each firing the ticket-total trigger, cancelled by the
  // eight-second cap and rolled back whole, so a retry started from 111,777
  // again. Nothing here may go back to it.
  assert.match(source, /restore_wipe_batch/);
  assert.doesNotMatch(source, /from\(table\)\.delete\(\)/);
  assert.match(source, /stepWipe\(db: SupabaseClient, c: RestoreCursor, deadline: number\)/,
    "and the phase is budgeted like every other one");
  // The same delete in the load, which is one row per rate line put back.
  assert.match(source, /wipeBatch\(db, c, "rate_line_history", null\)/);

  const migration = read("supabase/migrations/20260905222931_the_wipe_deletes_a_batch_at_a_time.sql");
  assert.match(migration,
    /revoke execute on function public\.restore_wipe_batch\(text, integer, uuid\) from public, anon, authenticated/);
  assert.match(migration,
    /grant execute on function public\.restore_wipe_batch\(text, integer, uuid\) to service_role/);
  // Every table the wipe walks has to be on the function's whitelist, or the
  // restore stops on the first one that is not.
  for (const table of WIPE_ORDER) {
    assert.ok(migration.includes(`'${table}'`), `${table} is not on restore_wipe_batch's list`);
  }
});

test("the wipe walks its list once and then hands over to accounts", () => {
  let c = newRestoreCursor({ folderId: "f", folderName: "n", keepProfileId: "k" });
  c.phase = "wipe";
  for (let i = 0; i < WIPE_ORDER.length; i++) {
    assert.equal(c.phase, "wipe", `still wiping at ${WIPE_ORDER[i]}`);
    c = afterWipeStep(c, WIPE_ORDER.length);
  }
  assert.equal(c.wipeIndex, WIPE_ORDER.length);
  assert.equal(c.phase, "accounts");
});

test("only profiles keeps a row back, and it is the caller's", () => {
  assert.equal(wipeKeepsCaller("profiles"), true);
  for (const table of WIPE_ORDER.filter(t => t !== "profiles")) {
    assert.equal(wipeKeepsCaller(table), false, `${table} is emptied outright`);
  }
});

test("rate_lines is emptied before its history, and the restore says why", () => {
  // The trigger writes a history row per delete, so clearing the history
  // first leaves exactly as many phantoms as there were lines.
  assert.ok(WIPE_ORDER.indexOf("rate_lines") < WIPE_ORDER.indexOf("rate_line_history"));
  // And on the way back in, the same trigger's insert arm is why the
  // history is cleared again between the two loads.
  assert.ok(LOAD_ORDER.indexOf("rate_lines") < LOAD_ORDER.indexOf("rate_line_history"));
  const source = read("supabase/functions/backup-restore/index.ts");
  assert.match(source, /rate_line_history/,
    "the load clears the history rate_lines' own inserts wrote");
});

// ── Tables ───────────────────────────────────────────────────────────────

test("a part loaded adds to the count; the last one moves to the next table", () => {
  let c = newRestoreCursor({ folderId: "f", folderName: "n", keepProfileId: "k" });
  c.phase = "tables";
  c = afterPartLoaded(c, { table: "tickets", rows: 500, lastPart: false, tableCount: 3 });
  assert.equal(c.loaded.tickets, 500);
  assert.equal(c.partIndex, 1);
  assert.equal(c.tableIndex, 0);
  c = afterPartLoaded(c, { table: "tickets", rows: 120, lastPart: true, tableCount: 3 });
  assert.equal(c.loaded.tickets, 620);
  assert.equal(c.partIndex, 0);
  assert.equal(c.tableIndex, 1);
  assert.equal(c.phase, "tables");
});

test("the last table hands over to the files", () => {
  let c = newRestoreCursor({ folderId: "f", folderName: "n", keepProfileId: "k" });
  c.phase = "tables";
  c.tableIndex = LOAD_ORDER.length - 1;
  c = afterTableLoaded(c, LOAD_ORDER.length);
  assert.equal(c.phase, "files");
});

test("chat history rewinds for its second pass and only then moves on", () => {
  let c = newRestoreCursor({ folderId: "f", folderName: "n", keepProfileId: "k" });
  c.phase = "tables";
  c.tableIndex = 7;
  c.partIndex = 3;
  c = afterTableLoaded(c, 20, "chat_messages");
  // The same parts again, from the start, with the quotes this time.
  assert.equal(c.chatPass, CHAT_REPLY_PASS);
  assert.equal(c.partIndex, 0);
  assert.equal(c.tableIndex, 7, "still chat_messages");
  c = afterTableLoaded(c, 20, "chat_messages");
  assert.equal(c.tableIndex, 8);
  assert.equal(c.chatPass, CHAT_INSERT_PASS, "the next table starts on pass one");
});

test("a table's parts are its own, and rate_lines never takes the history's", () => {
  const entries = [
    { name: "rate_line_history.02.json.gz", id: "d" },
    { name: "rate_lines.02.json.gz", id: "b" },
    { name: "rate_lines.01.json.gz", id: "a" },
    { name: "rate_line_history.01.json.gz", id: "c" },
    { name: "manifest.json", id: "m" }
  ];
  assert.deepEqual(partsForTable(entries, "rate_lines").map(f => f.id), ["a", "b"]);
  assert.deepEqual(partsForTable(entries, "rate_line_history").map(f => f.id), ["c", "d"]);
  assert.deepEqual(partsForTable(entries, "jobs"), []);
  assert.deepEqual(partsForTable(null, "jobs"), []);
});

test("auth_email comes off before a profile row is written", () => {
  const rows = [
    { id: "1", name: "Kyle", auth_email: "kyle@example.ca" },
    { id: "2", name: "Sam" }
  ];
  const clean = withoutAuthEmail(rows);
  assert.deepEqual(clean, [{ id: "1", name: "Kyle" }, { id: "2", name: "Sam" }]);
  // The caller's own rows are not touched — the accounts phase still needs
  // the addresses.
  assert.equal(rows[0].auth_email, "kyle@example.ca");
});

// ── The people who could not be put back ─────────────────────────────────

test("a profile row whose account could not be made is left out of the load", () => {
  const rows = [{ id: "kyle" }, { id: "gone" }, { id: "sam" }];
  const { rows: out, skipped } = withoutMissingProfiles(rows, "profiles", ["gone"], PROFILE_REFS);
  assert.deepEqual(out.map(r => r.id), ["kyle", "sam"]);
  assert.equal(skipped, 1);
  // Nobody dropped is nothing to filter, and the caller's array comes back
  // as it was.
  const none = withoutMissingProfiles(rows, "profiles", [], PROFILE_REFS);
  assert.equal(none.skipped, 0);
  assert.equal(none.rows.length, 3);
});

test("a row that cannot stand without that person goes; a row that can is blanked", () => {
  // NOT NULL foreign key: the row has nowhere to go.
  const crew = withoutMissingProfiles(
    [{ id: "c1", profile_id: "gone", hours: 8 }, { id: "c2", profile_id: "sam", hours: 6 }],
    "ticket_crew", ["gone"], PROFILE_REFS
  );
  assert.deepEqual(crew.rows.map(r => r.id), ["c2"]);
  assert.equal(crew.skipped, 1);

  // Nullable: a job whose creator could not be re-created is still the job.
  const jobs = [{ id: "j1", job_number: "S-1", created_by: "gone" }, { id: "j2", job_number: "S-2", created_by: "sam" }];
  const kept = withoutMissingProfiles(jobs, "jobs", ["gone"], PROFILE_REFS);
  assert.equal(kept.skipped, 0);
  assert.deepEqual(kept.rows.map(r => r.id), ["j1", "j2"]);
  assert.equal(kept.rows[0].created_by, null);
  assert.equal(kept.rows[0].job_number, "S-1", "the rest of the row is untouched");
  assert.equal(jobs[0].created_by, "gone", "the caller's rows are untouched");

  // Both at once: the message goes, the pin on somebody else's message is
  // only forgotten.
  const chat = withoutMissingProfiles([
    { id: "m1", profile_id: "gone", body: "hi" },
    { id: "m2", profile_id: "sam", body: "hi", pinned_by: "gone" }
  ], "chat_messages", ["gone"], PROFILE_REFS);
  assert.equal(chat.skipped, 1);
  assert.deepEqual(chat.rows.map(r => r.id), ["m2"]);
  assert.equal(chat.rows[0].pinned_by, null);
});

test("a table that never names a profile is not filtered at all", () => {
  const lines = [{ id: "l1", ticket_id: "t1" }];
  const out = withoutMissingProfiles(lines, "ticket_lines", ["gone"], PROFILE_REFS);
  assert.equal(out.skipped, 0);
  assert.equal(out.rows, lines, "the same array, not a copy");
  // Every table PROFILE_REFS names is a table the restore actually loads.
  for (const table of Object.keys(PROFILE_REFS)) {
    assert.ok(LOAD_ORDER.includes(table), `${table} is loaded`);
  }
  // And the one that matters most is profiles' own id.
  assert.deepEqual(PROFILE_REFS.profiles.required, ["id"]);
});

test("a reaction to a message that was left out is left out with it", () => {
  // chat_reactions.message_id is NOT NULL and names chat_messages, and
  // chat_messages is a table this very restore can thin: a message written
  // by an account that could not be re-created is not going in. The
  // reaction would then name a row that is not there, and the foreign key
  // would refuse the batch it rode in — after the wipe, with the database
  // empty.
  const rows = [
    { id: "r1", message_id: "m1", profile_id: "sam", emoji: "👍" },
    { id: "r2", message_id: "m2", profile_id: "sam", emoji: "🎉" },
    { id: "r3", message_id: "m1", profile_id: "kyle", emoji: "👍" }
  ];
  const out = rowsWithLiveParent(rows, "message_id", ["m1"]);
  assert.deepEqual(out.rows.map(r => r.id), ["r1", "r3"]);
  assert.equal(out.dropped, 1);
  assert.equal(out.rows[0], rows[0], "the rows that stay are the caller's own");
  // Nothing dropped when every parent landed, and an empty list of parents
  // drops everything that names one.
  assert.equal(rowsWithLiveParent(rows, "message_id", ["m1", "m2"]).dropped, 0);
  assert.equal(rowsWithLiveParent(rows, "message_id", []).rows.length, 0);
  // A row that names nothing at all is nobody's orphan.
  assert.equal(rowsWithLiveParent([{ id: "r4" }], "message_id", []).dropped, 0);
  assert.deepEqual(rowsWithLiveParent(null, "message_id", []).rows, []);
});

test("every NOT NULL key into a table the restore can thin is named", () => {
  // Read off pg_constraint against the live project: the only NOT NULL
  // foreign key into a table a restore can leave rows out of — the tables
  // PROFILE_REFS calls `required` — is chat_reactions.message_id.
  // chat_reads names profiles and never chat_messages, which is why it is
  // not here, and nothing at all names ticket_crew, arcade_scores,
  // push_subscriptions or timesheet_approvals.
  assert.deepEqual(LIVE_PARENT_REFS, {
    chat_reactions: { column: "message_id", parent: "chat_messages" }
  });
  for (const [table, ref] of Object.entries(LIVE_PARENT_REFS)) {
    assert.ok(LOAD_ORDER.includes(table), `${table} is loaded`);
    assert.ok(LOAD_ORDER.indexOf(ref.parent) < LOAD_ORDER.indexOf(table),
      `${ref.parent} loads before ${table}, or the check has nothing to read`);
    // A parent that cannot lose rows would not need checking at all.
    assert.ok((PROFILE_REFS[ref.parent]?.required ?? []).length > 0,
      `${ref.parent} is a table the restore can thin`);
  }
});

test("a part's skipped rows are counted once, however often a slice resumes", () => {
  // The trap: a slice that runs out of budget on its very first batch
  // persists batchDone at 0, and a resume that keys the counting off
  // batchDone === 0 adds the same part's skipped rows a second time.
  let c = newRestoreCursor({ folderId: "f", folderName: "n", keepProfileId: "k" });
  assert.equal(c.partSkipCounted, false, "a fresh part has not been counted");
  assert.equal(c.partDropped, 0);
  c.partSkipCounted = true;
  c.partDropped = 3;
  // The next part starts uncounted, whether the last one ended a table or not.
  c = afterPartLoaded(c, { table: "chat_reactions", rows: 10, lastPart: false, tableCount: 20 });
  assert.equal(c.partSkipCounted, false);
  assert.equal(c.partDropped, 0);
  c.partSkipCounted = true;
  c.partDropped = 2;
  c = afterTableLoaded(c, 20, "chat_reactions");
  assert.equal(c.partSkipCounted, false);
  assert.equal(c.partDropped, 0);
  // And it survives the round trip through jsonb, or a resumed slice would
  // read it as false and count the part again.
  const revived = reviveRestoreCursor({ partSkipCounted: true, partDropped: 4 });
  assert.equal(revived.partSkipCounted, true);
  assert.equal(revived.partDropped, 4);
  assert.equal(reviveRestoreCursor({}).partSkipCounted, false);
});

test("a deactivated account is re-created but is not invited back in", () => {
  assert.equal(wantsSetPasswordMail({ name: "Sam" }), true);
  assert.equal(wantsSetPasswordMail({ name: "Sam", deactivated_at: null }), true);
  assert.equal(wantsSetPasswordMail({ name: "Sam", deactivated_at: "" }), true);
  // Locked out on purpose: the profiles load puts deactivated_at back and
  // RLS locks them out again, so the mail would be an invitation to nothing.
  assert.equal(wantsSetPasswordMail({ name: "Sam", deactivated_at: "2026-01-02T00:00:00Z" }), false);
  assert.equal(wantsSetPasswordMail({}), true);
});

test("the people left out are named on the run itself", () => {
  assert.equal(droppedAccountsNote([], []), "", "nothing left out leaves the column null");
  assert.equal(droppedAccountsNote(null, null), "");
  const one = droppedAccountsNote(["p1"], ["sam@example.ca: address already registered"]);
  assert.match(one, /1 account could not be re-created/);
  assert.match(one, /sam@example\.ca/);
  assert.match(one, /profile id: p1/);
  const two = droppedAccountsNote(["p1", "p2"], ["a: x", "b: y"]);
  assert.match(two, /2 accounts could not be re-created/);
  assert.match(two, /profile ids: p1, p2/);
});

test("an account that only missed its email is not written down as an account that was lost", () => {
  // The two outcomes share `accountsFailed`, and the error log is where the
  // difference shows: an Admin reading a freshly restored database's error
  // log saw "Account not restored" once per bounced email — on a 44-account
  // roster, the whole company, every one of them actually there.
  assert.equal(setPasswordMailNote([]), "", "every email went out: nothing is written at all");
  assert.equal(setPasswordMailNote(null), "");
  const one = setPasswordMailNote(["sam@example.ca: the account was re-created but the email did not go out."]);
  assert.match(one, /^Set-password email not sent:/);
  assert.match(one, /1 account was restored/);
  assert.doesNotMatch(one, /not restored:/, "the words the dropped accounts get, and only them");
  assert.match(one, /sam@example\.ca/);
  const many = setPasswordMailNote(["a: x", "b: y", "c: z"]);
  assert.match(many, /3 accounts were restored/);
  // One line for all of them, and every one of them named in it.
  assert.match(many, /a: x · b: y · c: z/);
});

test("the mail failures are marked as they are pushed, not guessed at afterwards", () => {
  const source = read("supabase/functions/backup-restore/index.ts");
  // The order the two kinds were pushed in cannot say which is which, so the
  // one that is only a bounced email says so on the cursor as well as on the
  // panel's list.
  assert.match(source, /c\.accountsFailed\.push\(note\);\s*\n\s*c\.mailsFailed\.push\(note\);/);
  assert.match(source, /const mailOnly = new Set\(r\.mailsFailed\);/);
  assert.match(source, /if \(mailOnly\.has\(failure\)\) continue;/);
  assert.match(source, /`Account not restored: \$\{failure\}`/);
  assert.match(source, /const mails = setPasswordMailNote\(r\.mailsFailed\);/);
  // The panel's note is unchanged: it is still every failure, and it is
  // still gated on the accounts that were actually dropped.
  assert.match(source, /droppedAccountsNote\(\(c as RestoreCursor\)\.droppedProfileIds, \(c as RestoreCursor\)\.accountsFailed\)/);
});

test("a restore that raised its safety backup starts it rather than waiting for the cron", () => {
  const source = read("supabase/functions/backup-restore/index.ts");
  // The copy is inserted queued, and queued is not started. Nothing else in
  // this function ever pokes backup-run, so the restore used to sit in its
  // safety phase until the five-minute cron came round — and for ever on a
  // project whose cron job is missing or aimed at another project.
  assert.match(source, /kick\("backup-run", \{ action: "advance", runId: c\.safetyRunId \}, secret\)/);
  // Unchained on purpose: the chain flag is a slice following its own
  // heartbeat, and this is a queued run being started, where the cron may be
  // starting the very same row in the same second. Unchained, backup-run's
  // conditional claim settles that and only one slice takes the run.
  assert.doesNotMatch(source, /kick\("backup-run",[^)]*chain/);
});

// ── Chat history's two passes ────────────────────────────────────────────

test("pass one empties every quote and drops the ids already on the table", () => {
  const rows = [
    { id: "m1", body: "morning", reply_to: null },
    { id: "m2", body: "re: morning", reply_to: "m1" },
    { id: "m3", body: "already here", reply_to: null }
  ];
  const { rows: out, collisions } = chatInsertRows(rows, ["m3"]);
  assert.equal(out.length, 2);
  // The RPC has no ON CONFLICT clause: a row that is already there is a
  // failed batch, not a no-op.
  assert.equal(collisions, 1);
  assert.deepEqual(out.map(r => r.id), ["m1", "m2"]);
  // A reply can sit in an earlier part than the message it quotes, so no
  // quote goes in on this pass at all.
  assert.equal(out[1].reply_to, null);
  assert.equal(rows[1].reply_to, "m1", "the caller's rows are untouched");

  const none = chatInsertRows(rows, []);
  assert.equal(none.collisions, 0);
  assert.equal(none.rows.length, 3);
});

test("pass two writes only the quotes, and only where there is one", () => {
  const rows = [
    { id: "m1", body: "morning", reply_to: null },
    { id: "m2", body: "re: morning", reply_to: "m1" },
    { id: "m3", body: "no quote" }
  ];
  assert.deepEqual(chatReplyPatches(rows), [{ id: "m2", reply_to: "m1" }]);
  assert.deepEqual(chatReplyPatches([]), []);
  assert.deepEqual(chatReplyPatches(null), []);
});

test("a reply whose quoted message was left out keeps its own words", () => {
  const patches = [
    { id: "m2", reply_to: "m1" },
    { id: "m4", reply_to: "gone" }
  ];
  const { rows, dropped } = quotesThatLanded(patches, ["m1", "m2", "m4"]);
  assert.deepEqual(rows, [{ id: "m2", reply_to: "m1" }]);
  assert.equal(dropped, 1);
  // Everything on the table is everything patched.
  assert.equal(quotesThatLanded(patches, ["m1", "gone"]).dropped, 0);
  assert.deepEqual(quotesThatLanded([], ["m1"]).rows, []);
  assert.deepEqual(quotesThatLanded(null, null).rows, []);
});

// ── The settings row ─────────────────────────────────────────────────────

test("the live Resend and KLIPY keys survive a restore", () => {
  // What a backup actually holds: stripSecrets blanked them on the way out.
  const patch = settingsRestorePatch({
    id: true,
    resend_api_key: null,
    klipy_api_key: null,
    mail_from_reports: "reports@vagabonde.ca",
    approval_base_url: "https://app.example.ca",
    backup_refresh_token: null,
    backup_provider: "google"
  }, APP_SETTINGS_NEVER_RESTORED, APP_SETTINGS_SECRETS);

  assert.ok(!("resend_api_key" in patch), "a blanked key is never written back");
  assert.ok(!("klipy_api_key" in patch), "nor is the GIF key");
  assert.ok(!("id" in patch), "the enforced row's own key is not the restore's");
  // The drive connection this restore is running through stays exactly as
  // it is, whatever the backup remembers.
  assert.ok(!("backup_provider" in patch));
  assert.ok(!("backup_refresh_token" in patch));
  assert.equal(patch.mail_from_reports, "reports@vagabonde.ca");
  assert.equal(patch.approval_base_url, "https://app.example.ca");
});

test("a backup taken before the keys were stripped restores them like any column", () => {
  const patch = settingsRestorePatch(
    { resend_api_key: "re_old", klipy_api_key: "kl_old" },
    APP_SETTINGS_NEVER_RESTORED, APP_SETTINGS_SECRETS
  );
  assert.equal(patch.resend_api_key, "re_old");
  assert.equal(patch.klipy_api_key, "kl_old");
});

test("every column the backup blanks is one the restore skips or never writes", () => {
  // Whatever a backup holds, a null in one of these columns must not reach
  // app_settings. The two lists move together; this is the check that they
  // do.
  const blank = {};
  for (const column of APP_SETTINGS_SECRETS) blank[column] = null;
  const patch = settingsRestorePatch(blank, APP_SETTINGS_NEVER_RESTORED, APP_SETTINGS_SECRETS);
  assert.deepEqual(patch, {});
});

test("the settings row a fresh project has never had is created, not silently skipped", () => {
  // app_settings ships with no row, so on a project stood up from the
  // migrations an UPDATE ... where id matches nothing and every setting in
  // the backup is dropped without an error. The restore upserts the one
  // enforced row instead — this is the payload it sends, and the point is
  // that widening the write does not widen what is written: no backup_*
  // column and no blanked credential is in it, so an existing row's drive
  // connection and live keys are as safe as they were under the UPDATE.
  const patch = settingsRestorePatch({
    id: true,
    resend_api_key: null,
    backup_refresh_token: null,
    backup_keep: 1,
    mail_from_reports: "reports@vagabonde.ca"
  }, APP_SETTINGS_NEVER_RESTORED, APP_SETTINGS_SECRETS);
  const row = { id: true, ...patch };

  assert.equal(row.id, true, "the enforced row's own key comes from the restore, not the backup");
  assert.equal(row.mail_from_reports, "reports@vagabonde.ca");
  assert.deepEqual(Object.keys(row).filter(k => k.startsWith("backup_")), []);
  assert.ok(!("resend_api_key" in row));
});

// ── Tickets and their money ──────────────────────────────────────────────

test("a ticket goes back in at zero, because its lines are not there yet", () => {
  // tickets_total_balances is a DEFERRED CONSTRAINT trigger: at the commit
  // of a ticket's own insert it re-adds that ticket's lines and refuses the
  // write if they do not come to the total on the row. ticket_lines load
  // after tickets — the foreign key runs that way — so a ticket carrying its
  // real total is a ticket whose lines add up to nothing, and every priced
  // ticket in the backup would be refused.
  const rows = [
    { id: "t1", status: "Draft", total: 1250.5, job_id: "j1" },
    { id: "t2", status: "Approved", total: 900, approved_at: "2026-08-01T00:00:00Z" }
  ];
  const out = ticketsForLoad(rows);
  assert.deepEqual(out.map(r => r.total), [0, 0]);
  // Everything else about the row is untouched, and so is the caller's copy.
  assert.equal(out[0].job_id, "j1");
  assert.equal(out[1].approved_at, "2026-08-01T00:00:00Z");
  assert.equal(rows[0].total, 1250.5);
});

test("only a signed or invoiced ticket gets its own total written back", () => {
  const patches = approvedTotalPatches([
    { id: "t1", status: "Draft", total: 1250.5 },
    { id: "t2", status: "Awaiting approval", total: 300 },
    { id: "t3", status: "Approved", total: 900, approved_at: "2026-08-01T00:00:00Z" },
    { id: "t4", status: "Invoiced", total: 410.25, approved_at: "2026-07-02T00:00:00Z" },
    // Signed but somehow still called a draft: the signature is what counts.
    { id: "t5", status: "Draft", total: 77, approved_at: "2026-08-09T00:00:00Z" }
  ]);
  // A draft's total IS its lines by definition — the balance trigger has
  // been holding it to that all along — so the sync trigger's recomputation
  // is the same number and there is nothing to put back. A signed ticket's
  // is a figure a client agreed to, and re-pricing that is not the
  // restore's to do.
  assert.deepEqual(patches, [
    { id: "t3", total: 900 },
    { id: "t4", total: 410.25 },
    { id: "t5", total: 77 }
  ]);
  assert.deepEqual(approvedTotalPatches([]), []);
  assert.deepEqual(approvedTotalPatches(null), []);
  // A signed ticket with nothing in the total column is still worth zero,
  // not worth skipping.
  assert.deepEqual(
    approvedTotalPatches([{ id: "t6", status: "Approved", total: null }]),
    [{ id: "t6", total: 0 }]
  );
});

test("the restore remembers whether it has done the totals", () => {
  const c = newRestoreCursor({ folderId: "f", folderName: "n", keepProfileId: "k" });
  assert.equal(c.totalsDone, false);
  assert.equal(c.totalsPart, 0);
  assert.equal(reviveRestoreCursor({ totalsDone: true, totalsPart: 2 }).totalsDone, true);
  assert.equal(reviveRestoreCursor({ totalsDone: "yes" }).totalsDone, false);
});

// ── The activity times ───────────────────────────────────────────────────

test("only the jobs that had an activity time get one back", () => {
  assert.deepEqual(activityPatches([
    { id: "j1", job_number: "S-1", last_activity_at: "2026-08-01T00:00:00Z" },
    { id: "j2", job_number: "S-2", last_activity_at: null },
    { id: "j3", job_number: "S-3" }
  ]), [{ id: "j1", last_activity_at: "2026-08-01T00:00:00Z" }]);
  assert.deepEqual(activityPatches(null), []);
});

// ── The small decisions ──────────────────────────────────────────────────

test("a report put back is still a PDF", () => {
  assert.equal(contentTypeFor("j-1/RT-0001.pdf"), "application/pdf");
  assert.equal(contentTypeFor("chat/2026/photo.JPG"), "image/jpeg");
  assert.equal(contentTypeFor("chat/note.webm"), "audio/webm");
  assert.equal(contentTypeFor("odd/thing.qqq"), "application/octet-stream");
  assert.equal(contentTypeFor("no-extension"), "application/octet-stream");
  assert.equal(contentTypeFor("trailing."), "application/octet-stream");
  assert.equal(contentTypeFor(""), "application/octet-stream");
});

test("the typed name is the backup's own, character for character", () => {
  assert.equal(typedNameMatches("2026-09-05 02-00", "2026-09-05 02-00"), true);
  // A name copied off the screen brings a space with it.
  assert.equal(typedNameMatches("  2026-09-05 02-00 ", "2026-09-05 02-00"), true);
  // The wrong night is the whole thing this gate is for.
  assert.equal(typedNameMatches("2026-09-04 02-00", "2026-09-05 02-00"), false);
  assert.equal(typedNameMatches("2026-09-05 0200", "2026-09-05 02-00"), false);
  assert.equal(typedNameMatches("", ""), false, "empty is never a confirmation");
  assert.equal(typedNameMatches("", "2026-09-05 02-00"), false);
  assert.equal(typedNameMatches(null, null), false);
});

test("the refusals say what to do about them", () => {
  const why = tooNewRefusal("20260906000000", "20260905080604");
  assert.match(why, /20260906000000/);
  assert.match(why, /20260905080604/);
  assert.match(why, /Update the app first/);
  assert.equal(accountFailureNote("sam@example.ca", "bounced"), "sam@example.ca: bounced");
});

// ── What the batches are ─────────────────────────────────────────────────

test("rows go back in batches small enough for PostgREST to take", () => {
  assert.equal(WRITE_BATCH, 500);
  assert.ok(WRITE_BATCH > 0 && WRITE_BATCH <= 1000);
});

// ── The function itself, read back ───────────────────────────────────────

test("the restore keeps the gates it is supposed to keep", () => {
  const source = read("supabase/functions/backup-restore/index.ts");
  // The door, before a byte of the body is parsed.
  assert.match(source, /backupDoor/);
  // Chat history goes in through the RPC that turns the push trigger off.
  assert.match(source, /restore_chat_messages/);
  // The safety backup's own run id is on the row before the slice returns,
  // or every tick raises another one.
  assert.match(source, /safetyRunId/);
  // Every mid-run write is conditional on the run this slice still holds.
  assert.match(source, /stillHoldsRun/);
  // Files are replaced, not added beside.
  assert.match(source, /upsert:\s*true/);
  // A restore never mints a new id for an account: the whole backup names
  // the old one.
  assert.match(source, /sendSetPasswordLink/);
});

test("the three column patches go through the RPC, never an upsert", () => {
  const source = read("supabase/functions/backup-restore/index.ts");
  // A partial upsert of {id, reply_to}, {id, total} or {id, last_activity_at}
  // is refused by Postgres before it ever reaches ON CONFLICT: NOT NULL runs
  // on the proposed tuple, and chat_messages.profile_id, tickets.job_id and
  // jobs.job_number are all NOT NULL with no default. Every one of them is
  // an UPDATE, and restore_patch_rows is the only door.
  for (const table of ["chat_messages", "tickets", "jobs"]) {
    assert.match(source, new RegExp(`restore_patch_rows[\\s\\S]{0,200}p_table:\\s*"${table}"`),
      `${table} is patched through restore_patch_rows`);
  }
  // Five calls — the three above, and the per-job restore's own two, which
  // patch the same two columns for exactly the rows that run wrote — and no
  // upsert anywhere carrying a patch. Counted on the function's own name:
  // the wipe's RPC names a table too, and it names it to empty it.
  assert.equal((source.match(/rpc\("restore_patch_rows"/g) || []).length, 5);
  assert.doesNotMatch(source, /upsert\(patches/);
  assert.doesNotMatch(source, /upsert\(chatReplyPatches|upsert\(approvedTotalPatches|upsert\(activityPatches/);
});

test("a restore waiting on its safety backup still says it is alive", () => {
  const source = read("supabase/functions/backup-restore/index.ts");
  // The wait writes a heartbeat and nothing else. Without it the panel
  // reads a run that is behaving exactly as designed as a run that died.
  // It is the second half of the answer: the tick tends the heartbeat while
  // the safety backup is the run in flight, and this covers the poll the
  // restore's own slice makes on its way into the wait.
  assert.match(source, /async function beat\(/);
  assert.match(source, /await beat\(db, runId, guard\)/);
});

test("an orphaned child is filtered against the rows that actually landed", () => {
  const source = read("supabase/functions/backup-restore/index.ts");
  // The batch's parents are read back before it is written, exactly as
  // chat's second pass reads its quote targets back — and only when
  // somebody was dropped, because with nobody dropped every parent in the
  // backup is on the table.
  assert.match(source, /LIVE_PARENT_REFS/);
  assert.match(source, /rowsWithLiveParent/);
  assert.match(source, /c\.droppedProfileIds\.length/);
  // Counted once per part, on the cursor — not off batchDone, which is 0
  // again on a slice that ran out of budget before its first batch.
  assert.match(source, /if \(!c\.partSkipCounted\)/);
  assert.doesNotMatch(source, /if \(c\.batchDone === 0\) c\.skipped/);
});

// ── Restoring a few jobs — the everyday mistake ──────────────────────────
//
// A second kind of restore inside the same function. It deletes nothing, so
// it has no safety phase and no wipe; what it has instead is a set of
// decisions about rows that are already there, which is exactly the part
// worth settling without a drive.

test("a per-job restore has no safety phase and no wipe", () => {
  assert.deepEqual(JOB_RESTORE_PHASES, ["tables", "files", "activity", "done"]);
  // Nothing is deleted, so there is nothing to take a copy of first.
  assert.ok(!JOB_RESTORE_PHASES.includes("safety"));
  assert.ok(!JOB_RESTORE_PHASES.includes("wipe"));
  // And no accounts phase: it never creates an Auth user, it works with the
  // people this database already has.
  assert.ok(!JOB_RESTORE_PHASES.includes("accounts"));
});

test("the two cursors are told apart by the kind written on them", () => {
  const job = newJobRestoreCursor({ folderId: "f", folderName: "n", jobIds: ["a", "b"] });
  assert.equal(job.kind, JOB_RESTORE_KIND);
  assert.equal(job.phase, "tables");
  assert.deepEqual(job.jobIds, ["a", "b"]);
  assert.ok(isJobRestoreCursor(job));
  assert.ok(!isJobRestoreCursor(newRestoreCursor({ folderId: "f", folderName: "n", keepProfileId: "k" })));
  // A cursor read back out of jsonb keeps its kind and its lists.
  const back = reviveJobRestoreCursor(JSON.parse(JSON.stringify(job)));
  assert.deepEqual(back, job);
  // A run raised before a field existed still revives.
  const thin = reviveJobRestoreCursor({ folderId: "f", jobIds: ["a"] });
  assert.equal(thin.phase, "tables");
  assert.deepEqual(thin.skipped, []);
  assert.deepEqual(thin.collisions, []);
  assert.equal(thin.fileIndex, null);
});

test("this kind's counts carry the notes themselves, not a tally", () => {
  const c = newJobRestoreCursor({ folderId: "f", folderName: "n", jobIds: ["a"] });
  c.loaded = { jobs: 1, tickets: 3 };
  c.filesDone = 2;
  c.filesBytes = 100;
  addRestoreNote(c.skipped, "Job S-1 is already in the app.");
  addRestoreNote(c.collisions, "Ticket 24-100 is already in use.");
  const counts = jobRestoreCounts(c);
  assert.deepEqual(counts.rows, { jobs: 1, tickets: 3 });
  assert.equal(counts.files, 2);
  assert.equal(counts.bytes, 100);
  // Arrays, because a number cannot say which ticket number was in use.
  assert.deepEqual(counts.skipped, ["Job S-1 is already in the app."]);
  assert.deepEqual(counts.collisions, ["Ticket 24-100 is already in use."]);
});

test("the notes stop before the cursor stops fitting, and say so", () => {
  const notes = [];
  for (let i = 0; i < MAX_RESTORE_NOTES + 20; i++) addRestoreNote(notes, `note ${i}`);
  assert.equal(notes.length, MAX_RESTORE_NOTES + 1);
  assert.match(notes[notes.length - 1], /not listed/);
  // The cap is on the report nobody could read, never on what is restored.
  assert.ok(MAX_RESTORE_NOTES >= 100);
});

// ── Which rows of a part belong to this restore ──────────────────────────

test("a part is filtered to the chosen jobs, and children to what landed", () => {
  const sets = { chosen: ["j1", "j2"], restored: ["j1"], tickets: ["T-1"] };
  // The jobs table is filtered by what the Admin picked.
  assert.deepEqual(
    rowsForChosenJobs("jobs", [{ id: "j1" }, { id: "j2" }, { id: "j9" }], sets).map(r => r.id),
    ["j1", "j2"]
  );
  // Everything under a job is filtered by the jobs that ACTUALLY went back.
  // j2 collided on its number and was not restored, so its tickets, its
  // assessments and its reports have no parent and must not be attempted.
  for (const table of ["tickets", "jhas", "reports", "rate_overrides"]) {
    assert.deepEqual(
      rowsForChosenJobs(table, [{ id: "x", job_id: "j1" }, { id: "y", job_id: "j2" }], sets).map(r => r.id),
      ["x"], `${table} follows the jobs that landed`);
  }
  // And a ticket's own children follow the tickets that landed.
  for (const table of ["ticket_lines", "ticket_crew"]) {
    assert.deepEqual(
      rowsForChosenJobs(table, [{ id: "a", ticket_id: "T-1" }, { id: "b", ticket_id: "T-2" }], sets).map(r => r.id),
      ["a"], `${table} follows the tickets that landed`);
  }
});

test("every table a job's records live in is one this filter has an answer for", () => {
  for (const table of JOB_CHILD_TABLES) {
    const kept = rowsForChosenJobs(table, [{ job_id: "j9", ticket_id: "T-9" }],
      { chosen: ["j1"], restored: ["j1"], tickets: ["T-1"] });
    assert.equal(kept.length, 0, `${table} is filtered, not passed through`);
  }
});

// ── Nothing live is overwritten ──────────────────────────────────────────

test("a job already here is left alone, and a number in use is a collision", () => {
  const rows = [
    { id: "j1", job_number: "S-100" },   // already here, by id
    { id: "j2", job_number: "S-200" },   // that number belongs to another job
    { id: "j3", job_number: "S-300" }    // free
  ];
  const out = jobsToRestore(rows, { ids: ["j1"], numbers: ["S-100", "S-200"] });
  assert.deepEqual(out.rows.map(r => r.id), ["j3"]);
  // Left alone is not a collision: restoring the same job twice is a no-op.
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0], /S-100/);
  assert.match(out.skipped[0], /left alone/);
  // A number in use by a different job is the one the office cares about.
  assert.equal(out.collisions.length, 1);
  assert.match(out.collisions[0], /S-200/);
});

test("a job that is already here is still a job its missing records go under", () => {
  const rows = [
    { id: "j1", job_number: "S-100" },   // already here, by id
    { id: "j2", job_number: "S-200" },   // that number belongs to another job
    { id: "j3", job_number: "S-300" }    // free
  ];
  const out = jobsToRestore(rows, { ids: ["j1"], numbers: ["S-100", "S-200"] });
  // The job the restore left alone is named separately from the one it
  // refused. A restore that died between the job and its tickets leaves the
  // job live and its work missing, and the retry skips it by id — so the
  // job's own id goes on the list the children follow, and the run puts back
  // whatever is not there. A job it collided with has no row here at all and
  // is on no list.
  assert.deepEqual(out.alreadyHere, ["j1"]);
  // And the note says exactly that, because "left alone" on its own reads as
  // "nothing of yours was touched" to somebody looking for missing tickets.
  assert.match(out.skipped[0], /restored beside it/);
});

test("a run whose chosen jobs are none of them here stops after the jobs table", () => {
  const c = newJobRestoreCursor({ folderId: "f", folderName: "n", jobIds: ["j1"] });
  // Nothing landed and nothing was already here: there is no row for a
  // ticket, a charge, an assessment or a PDF to belong to, so the five
  // remaining tables, the drive listing and the two patch passes are all
  // work with a known answer.
  assert.ok(noRestorableJobs(c));
  c.jobsDone = ["j1"];
  assert.ok(!noRestorableJobs(c));
  c.jobsDone = [];
  c.jobsHere = ["j1"];
  // A job that was already here is exactly the case that must NOT stop: its
  // missing tickets are the reason the run was started twice.
  assert.ok(!noRestorableJobs(c));
});

test("the per-job cursor carries the jobs it found already here", () => {
  const c = newJobRestoreCursor({ folderId: "f", folderName: "n", jobIds: ["j1"] });
  assert.deepEqual(c.jobsHere, []);
  c.jobsHere = ["j1"];
  const back = reviveJobRestoreCursor(JSON.parse(JSON.stringify(c)));
  assert.deepEqual(back.jobsHere, ["j1"]);
  // A run raised before the field existed revives with an empty one rather
  // than an undefined that would throw on the first spread.
  assert.deepEqual(reviveJobRestoreCursor({ folderId: "f" }).jobsHere, []);
});

test("a ticket number already in use, or retired, is reported and skipped", () => {
  const rows = [{ id: "24-100" }, { id: "24-101" }, { id: "24-102" }];
  const out = ticketsToRestore(rows, { ids: ["24-100"], burned: ["24-101"] });
  assert.deepEqual(out.rows.map(r => r.id), ["24-102"]);
  assert.equal(out.collisions.length, 2);
  // Named by ticket number, because a ticket number is an invoice reference
  // and two of them is worse than one missing.
  assert.match(out.collisions.join(" "), /24-100/);
  assert.match(out.collisions.join(" "), /24-101/);
  assert.match(out.collisions.join(" "), /retired/);
});

test("the same ticket back on the same job is left alone, not called a collision", () => {
  const rows = [
    { id: "24-100", job_id: "j1" },   // here already, and it is this one
    { id: "24-101", job_id: "j1" },   // here already, but on somebody else's job
    { id: "24-102", job_id: "j1" }    // free
  ];
  const out = ticketsToRestore(rows, {
    ids: ["24-100", "24-101"], burned: [],
    jobOf: new Map([["24-100", "j1"], ["24-101", "j7"]])
  });
  assert.deepEqual(out.rows.map(r => r.id), ["24-102"]);
  // Pressing Restore jobs twice must not read as twenty invoices in danger.
  assert.equal(out.collisions.length, 1);
  assert.match(out.collisions[0], /24-101/);
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0], /24-100|1 ticket/);
  // And the note does not promise the charges came back: an already-here
  // ticket keeps its own lines, its own crew hours and its own total.
  assert.match(out.skipped[0], /left alone/);
});

test("a save key already in use is named, not left to a raw constraint", () => {
  // tickets, reports and jhas each carry a unique client_key where it is not
  // null. One row whose key is live under a different id would refuse the
  // whole batch with a Postgres message nobody in an office can read.
  const rows = [
    { id: "24-100", client_key: "k1" },
    { id: "24-101", client_key: null },
    { id: "24-102", client_key: "k9" }
  ];
  const out = withoutTakenClientKeys("tickets", rows, ["k1"]);
  assert.deepEqual(out.rows.map(r => r.id), ["24-101", "24-102"]);
  assert.equal(out.collisions.length, 1);
  assert.match(out.collisions[0], /24-100/);
  // Nothing taken means nothing to say and nothing copied.
  assert.deepEqual(withoutTakenClientKeys("tickets", rows, []).collisions, []);
  assert.equal(withoutTakenClientKeys("tickets", rows, []).rows.length, 3);
  // A report is its filename and an assessment is the day it was raised for:
  // neither has a number, and "a row was skipped" is not a report.
  assert.match(
    withoutTakenClientKeys("reports", [{ id: "r1", filename: "Weld 12.pdf", client_key: "k1" }], ["k1"]).collisions[0],
    /Weld 12\.pdf/);
  assert.match(
    withoutTakenClientKeys("jhas", [{ id: "h1", work_date: "2026-08-01", client_key: "k1" }], ["k1"]).collisions[0],
    /2026-08-01/);
  assert.match(rowIdentity("tickets", { id: "24-100" }), /24-100/);
  assert.match(rowIdentity("rate_overrides", { id: "o1" }), /rate override/);
});

test("a child row already here is left alone, and said once for the table", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const out = childRowsToRestore("ticket_lines", rows, ["a", "b"]);
  assert.deepEqual(out.rows.map(r => r.id), ["c"]);
  // One line per table, not one per row: a hundred of them is not a report.
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0], /2/);
  assert.match(out.skipped[0], /ticket line/);
  assert.deepEqual(childRowsToRestore("reports", rows, []).skipped, []);
});

test("one of something reads as one of something, in the office's own words", () => {
  // The noun was pluralised on the count and the verb was not, so a run
  // reported "1 report were already in the app and were left alone" — to an
  // Admin, in the panel, straight after a restore.
  assert.equal(
    childRowsToRestore("reports", [{ id: "a" }], ["a"]).skipped[0],
    "1 report was already in the app and was left alone.");
  assert.equal(
    childRowsToRestore("rate_overrides", [{ id: "a" }, { id: "b" }], ["a", "b"]).skipped[0],
    "2 rate overrides were already in the app and were left alone.");

  // And the database's word for a thing is not the office's. No rule turns
  // one into the other — "jhas" less its s is "jha" — so the words that
  // matter are written down.
  assert.equal(rowWords("jhas", 1), "assessment");
  assert.equal(rowWords("jhas", 3), "assessments");
  assert.equal(rowWords("ticket_crew", 1), "crew row");
  assert.equal(rowWords("ticket_crew", 2), "crew rows");
  assert.equal(rowWords("ticket_lines", 1), "ticket line");
  assert.equal(rowWords("ticket_lines", 6), "ticket lines");
  assert.equal(rowWords("tickets", 1), "ticket");
  assert.match(childRowsToRestore("jhas", [{ id: "a" }], ["a"]).skipped[0], /^1 assessment was /);
});

test("a crew row whose person has gone is skipped and counted out loud", () => {
  const rows = [
    { id: "c1", profile_id: "p1", straight_hours: 8 },
    { id: "c2", profile_id: "p9", straight_hours: 10 }
  ];
  const out = crewWithLiveProfiles(rows, ["p1"]);
  // ticket_crew.profile_id is NOT NULL, so there is nothing else it could be.
  assert.deepEqual(out.rows.map(r => r.id), ["c1"]);
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0], /hours/);
  assert.deepEqual(crewWithLiveProfiles(rows, ["p1", "p9"]).skipped, []);
});

test("a name on a row that stands without it is blanked, not dropped", () => {
  const rows = [{ id: "t1", technician_id: "p1" }, { id: "t2", technician_id: "p9" }, { id: "t3" }];
  const out = blankUnknown(rows, "technician_id", ["p1"]);
  assert.equal(out.length, 3);
  assert.equal(out[0].technician_id, "p1");
  assert.equal(out[1].technician_id, null);
  assert.equal(out[2].technician_id, undefined);
  // The caller's rows are never touched.
  assert.equal(rows[1].technician_id, "p9");
});

// ── The organisations a job points at ────────────────────────────────────

test("a client is kept by id, matched by name, or reported lost", () => {
  const names = new Map([["c1", "Painted Pony"], ["c2", "Tourmaline"], ["c3", "Ovintiv"]]);
  const live = { ids: new Set(["c1"]), byName: new Map([["tourmaline", "c2-new"]]) };
  // Still here under the id the backup knows.
  assert.deepEqual(matchOrganisation("c1", names, live), { id: "c1", how: "id", name: "Painted Pony" });
  // Re-entered by hand after a mistake: new id, same name.
  assert.deepEqual(matchOrganisation("c2", names, live), { id: "c2-new", how: "name", name: "Tourmaline" });
  // Gone altogether — the job still goes back, without it.
  assert.deepEqual(matchOrganisation("c3", names, live), { id: null, how: "lost", name: "Ovintiv" });
  // A job that never named one is not missing anything.
  assert.deepEqual(matchOrganisation(null, names, live), { id: null, how: "none", name: "" });
  // Case and stray spaces are how a name gets re-typed, not a different firm.
  assert.equal(matchOrganisation("c4", new Map([["c4", "  TOURMALINE "]]), live).id, "c2-new");
});

test("a contact is matched inside the organisation the job ended up with", () => {
  const backup = new Map([
    ["k1", { name: "Dave Ross", org_id: "c1" }],
    ["k2", { name: "Jen Ho", org_id: "c2" }],
    ["k3", { name: "Nobody", org_id: "c3" }]
  ]);
  const live = { ids: new Set(["k1"]), byOrgAndName: new Map([["c2-new|jen ho", "k2-new"]]) };
  assert.equal(matchContact("k1", backup, live, "c1").id, "k1");
  // The client was re-entered by hand, so its contacts were too.
  assert.equal(matchContact("k2", backup, live, "c2-new").id, "k2-new");
  assert.equal(matchContact("k2", backup, live, "c2-new").how, "name");
  // No organisation to look inside means no match to make.
  assert.equal(matchContact("k3", backup, live, null).id, null);
  assert.equal(matchContact("k3", backup, live, null).how, "lost");
  assert.equal(matchContact(null, backup, live, "c1").how, "none");
});

// ── The PDFs, and the two figures a trigger writes over ──────────────────

test("only the PDFs the restored rows actually point at are fetched", () => {
  const keys = pdfKeysFor("jhas", [{ pdf_key: "a.pdf" }, { pdf_key: null }, { pdf_key: "" }, { pdf_key: "b.pdf" }]);
  assert.deepEqual(keys, ["jhas/a.pdf", "jhas/b.pdf"]);
  assert.deepEqual(pdfKeysFor("reports", []), []);
});

test("the totals and dates are put back only on the rows this run wrote", () => {
  const patches = [{ id: "t1", total: 100 }, { id: "t2", total: 200 }];
  // A ticket that was already here keeps its own figures: this restore did
  // not write it and must not re-price it.
  assert.deepEqual(onlyForIds(patches, ["t1"]), [{ id: "t1", total: 100 }]);
  assert.deepEqual(onlyForIds(patches, []), []);
});

// ── The cursor's arithmetic ──────────────────────────────────────────────

test("a per-job restore walks part by part and table by table", () => {
  let c = newJobRestoreCursor({ folderId: "f", folderName: "n", jobIds: ["j1"] });
  c = afterJobPart(c, { table: "jobs", rows: 1, lastPart: false, tableCount: 3 });
  assert.equal(c.partIndex, 1);
  assert.equal(c.loaded.jobs, 1);
  c = afterJobPart(c, { table: "jobs", rows: 2, lastPart: true, tableCount: 3 });
  assert.equal(c.loaded.jobs, 3);
  assert.equal(c.tableIndex, 1);
  assert.equal(c.partIndex, 0);
  assert.equal(c.phase, "tables");
  c = afterJobTable(c, 3);
  c = afterJobTable(c, 3);
  // The last table done is the files phase, and there is no wipe behind it.
  assert.equal(c.tableIndex, 3);
  assert.equal(c.phase, "files");
});

// ── The second kind, read back out of the function ───────────────────────

test("restoring a few jobs deletes nothing and overwrites nothing", () => {
  const source = read("supabase/functions/backup-restore/index.ts");
  assert.match(source, /restore_jobs/);
  // Not one delete in the whole of the per-job path — and none anywhere in
  // the file any more, because restore-all's two (the wipe phase's, and the
  // price history the load itself wrote) both go through restore_wipe_batch
  // now. An unbounded PostgREST delete reappearing here is the bug that
  // could not empty ticket_lines.
  assert.equal((source.match(/\.delete\(\)/g) || []).length, 0);
  assert.match(source, /function startRestoreJobs\(/);
  assert.match(source, /function putJobs\(/);
  assert.match(source, /function putJobChildren\(/);
  // Inserts, never upserts: an upsert would replace a live row, which is the
  // one thing this must not do.
  assert.doesNotMatch(source, /putJobChildren[\s\S]{0,1600}\.upsert\(/);
  // The chosen jobs' rows only, and the tickets that landed only.
  assert.match(source, /rowsForChosenJobs/);
  assert.match(source, /ticketsToRestore/);
  assert.match(source, /crewWithLiveProfiles/);
  // The same guard discipline as every other slice.
  assert.match(source, /stillHoldsRun/);
});

test("a restored ticket goes in at zero and is re-priced from its lines", () => {
  const source = read("supabase/functions/backup-restore/index.ts");
  // Same reason as restore-all: tickets_total_balances is a deferred
  // constraint trigger, and ticket_lines cannot load before tickets do. A
  // ticket carrying its real total would be refused on every priced ticket.
  assert.match(source, /ticketsForLoad/);
  // And the signed ones get the backup's own figure back afterwards, in the
  // activity phase, through the RPC — never an upsert.
  assert.match(source, /stepJobActivity/);
  assert.match(source, /onlyForIds\(approvedTotalPatches/);
  assert.match(source, /onlyForIds\(activityPatches/);
});

test("a job already in the app is a parent the children still follow", () => {
  const source = read("supabase/functions/backup-restore/index.ts");
  // The two lists together: the jobs this run wrote and the jobs it found
  // already here. A restore that died between a job and its tickets is
  // retried by pressing the same button, and the retry has to reach the
  // tickets rather than skip the job and report itself green.
  assert.match(source, /restored: \[\.\.\.c\.jobsDone, \.\.\.c\.jobsHere\]/);
  // But only the ones it actually wrote get their board position and their
  // signed totals put back — a live job keeps its own.
  assert.match(source, /onlyForIds\(activityPatches\([\s\S]{0,80}c\.jobsDone\)/);
  assert.doesNotMatch(source, /onlyForIds\(activityPatches\([\s\S]{0,120}jobsHere/);
  // And the run stops where there is nothing under any of them.
  assert.match(source, /noRestorableJobs\(c\)/);
});

test("a save key already in use is checked for before the batch, not after", () => {
  const source = read("supabase/functions/backup-restore/index.ts");
  // The three tables that carry one. A raw unique-violation would fail the
  // whole run with a message naming an index.
  assert.match(source, /withoutTakenClientKeys/);
  assert.match(source, /"client_key"/);
  // Batched small: an "in" list is a URL, and a gateway has an opinion about
  // how long a URL may be.
  assert.match(source, /at \+= 100/);
  assert.doesNotMatch(source, /at \+= 200/);
});

test("a damaged file is counted on both cursors and reaches the panel's counts", () => {
  const full = reviveRestoreCursor({ phase: "files", damaged: 2 });
  assert.equal(full.damaged, 2);
  assert.equal(reviveRestoreCursor({}).damaged, 0, "a cursor from before the check has none");
  assert.equal(restoreCounts(full).damaged, 2);
  const job = reviveJobRestoreCursor({ folderId: "f", folderName: "2026-09-08 00-00", jobIds: ["j1"], damaged: 1 });
  assert.equal(job.damaged, 1);
  assert.equal(jobRestoreCounts(job).damaged, 1);
});
