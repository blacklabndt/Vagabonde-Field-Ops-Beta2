// The parts of a backup that are just data and arithmetic: which tables go
// in and in what order, what the manifest says, which old folders retention
// throws away, and a drive that answers without a network.
//
// These three modules are imported straight out of supabase/functions/ —
// node strips their types (Node 22.18+ / 24) — which is why they are
// written in erasable TypeScript with no imports of their own beyond the
// shared schedule. If this file ever fails with "Unknown file extension" or
// a syntax error inside a .ts, something non-erasable (an enum, a parameter
// property) has been added to one of them and must come back out.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import {
  LOAD_ORDER, BACKUP_TABLES, WIPE_ORDER, NEVER_WIPED, BUCKETS,
  APP_SETTINGS_SECRETS, APP_SETTINGS_NEVER_RESTORED,
  CURSOR_COLUMN, TABLE_KEYS, JOB_CHILD_TABLES,
  PAGE_ROWS, MAX_PART_ROWS, stripSecrets, partFileName, chunkRows
} from "../../supabase/functions/_shared/backupTables.ts";

import {
  MANIFEST_NAME, BACKUP_ROOT_NAME, TABLES_FOLDER, FILES_FOLDER,
  newManifest, recordTable, recordFiles, finishManifest, jobsIndex,
  folderStamp, beforeRestoreName, isBeforeRestore, foldersToDelete,
  schemaTooNew, fileEntryName, parseFileEntryName, recordFileIndex } from "../../supabase/functions/_shared/backupManifest.ts";

import {
  FakeDrive, GoogleDrive, OneDrive, Dropbox, authorizeUrl, SCOPES, PROVIDERS
} from "../../supabase/functions/_shared/drive.ts";

import {
  NONCE_MS, PROVIDERS as OAUTH_PROVIDERS, providerInPath, callbackUri,
  credentialsFrom, nonceRefusal, providerRefusal
} from "../../supabase/functions/_shared/backupOauth.ts";

import {
  BUDGET_MS, SLICE_ALIVE_MS, RETRIES, BACKOFF_MS,
  newRunCursor, reviveCursor, sliceDeadline, budgetLeft, outOfBudget,
  sliceLooksAlive, isRetryable, shouldRetry, worthAnotherGo, retryDelayMs, stillHoldsRun, gatewayRefusal,
  isTransientEdgeError, withinRetryWindow, RUN_RETRY_WINDOW_MS,
  hashBytes, parseFileIndex, FILES_INDEX_NAME,
  VERIFY_KIND, MAX_VERIFY_NOTES, newVerifyCursor, reviveVerifyCursor, addVerifyNote, verifyCounts, nextVerifyAt,
  afterTablePart, foldIntoIndex, forgetIndex, nextPhaseAfterManifest,
  startPrefixWalk, pausePage, afterFilesPage, countsOf, totalRows
} from "../../supabase/functions/_shared/backupRun.ts";

import { gzip, gunzip } from "../../supabase/functions/_shared/gzip.ts";

import { BACKUP_PROVIDERS } from "./backupPanelLogic.js";

const ROOT = new URL("../../", import.meta.url);
const read = rel => readFileSync(new URL(rel, ROOT), "utf8");

// ── The table lists ──────────────────────────────────────────────────────

test("every backed-up table is also a loaded table, and the other way round", () => {
  assert.deepEqual(BACKUP_TABLES, LOAD_ORDER);
  assert.equal(new Set(LOAD_ORDER).size, LOAD_ORDER.length, "no table twice");
});

test("the spec's table list is what is actually backed up", () => {
  // The spec names issued_ticket_numbers; the table is burned_ticket_numbers.
  const expected = [
    "clients", "contractors", "contacts", "profiles", "jobs", "tickets",
    "ticket_lines", "ticket_crew", "jhas", "reports", "rate_schedules",
    "rate_lines", "rate_overrides", "rate_line_history", "equipment",
    "timesheet_approvals", "chat_messages", "chat_reactions", "chat_reads",
    "push_subscriptions", "arcade_scores", "burned_ticket_numbers", "app_settings"
  ];
  assert.deepEqual([...BACKUP_TABLES].sort(), expected.sort());
});

test("parents come before their children in the load order", () => {
  const at = t => LOAD_ORDER.indexOf(t);
  // Every foreign key the schema actually declares, written out as
  // [parent, child] pairs and read off supabase/migrations/ by hand:
  // the baseline's FOREIGN KEY block plus the chat migrations' inline
  // `references`. contacts is a parent of jobs (client_contact_id and
  // contractor_contact_id) and has no foreign key of its own — org_id is
  // a discriminated reference, not a constraint.
  const pairs = [
    ["clients", "jobs"], ["contractors", "jobs"], ["contacts", "jobs"],
    ["profiles", "jobs"], ["jobs", "tickets"], ["profiles", "tickets"],
    ["tickets", "ticket_lines"], ["tickets", "ticket_crew"], ["profiles", "ticket_crew"],
    ["jobs", "jhas"], ["profiles", "jhas"], ["jobs", "reports"],
    ["clients", "rate_schedules"], ["rate_schedules", "rate_lines"],
    ["rate_lines", "rate_line_history"], ["rate_schedules", "rate_line_history"],
    ["profiles", "rate_line_history"],
    ["jobs", "rate_overrides"], ["profiles", "equipment"],
    ["profiles", "timesheet_approvals"], ["profiles", "chat_messages"],
    ["chat_messages", "chat_reactions"], ["profiles", "chat_reactions"],
    ["profiles", "chat_reads"],
    ["profiles", "push_subscriptions"], ["profiles", "arcade_scores"]
  ];
  for (const [parent, child] of pairs) {
    assert.ok(at(parent) >= 0 && at(child) >= 0, `${parent}/${child} must both be in the load order`);
    assert.ok(at(parent) < at(child), `${parent} must load before ${child}`);
  }
});

test("the wipe order is the handover script's own order", () => {
  // The restore empties the database before it loads it, and the one place
  // this project has ever worked out a safe delete order is the handover
  // wipe. Read it back rather than re-deriving it.
  const sql = read("supabase/handover/wipe-seed-data.sql");
  const inScript = [...sql.matchAll(/delete from public\.(\w+)/g)].map(m => m[1]);
  const shared = WIPE_ORDER.filter(t => inScript.includes(t));
  const sameInScript = inScript.filter(t => shared.includes(t));
  assert.deepEqual(shared, [...new Set(sameInScript)], "the wipe order must follow the handover script");
});

test("rate_lines is emptied before its history, because deleting one writes the other", () => {
  // rate_lines_history_trigger is AFTER INSERT OR DELETE OR UPDATE on
  // rate_lines and inserts a history row for each. Clearing
  // rate_line_history first therefore leaves a phantom row per line deleted
  // after it, and the load that follows collides with it. The restore's
  // ruling comes from the trigger's INSERT arm: rate_lines is loaded first,
  // then every rate_line_history row is deleted, and only then is the
  // backup's history file loaded — so the rows the inserts wrote are gone
  // before the real history goes in.
  const at = t => WIPE_ORDER.indexOf(t);
  assert.ok(at("rate_lines") >= 0 && at("rate_line_history") >= 0);
  assert.ok(at("rate_lines") < at("rate_line_history"),
    "rate_lines must be deleted before rate_line_history");
  const sql = read("supabase/handover/wipe-seed-data.sql");
  assert.ok(sql.indexOf("delete from public.rate_lines") < sql.indexOf("delete from public.rate_line_history"),
    "the handover script must delete them in that order too");
});

test("everything loaded is wiped first, except the settings row", () => {
  assert.deepEqual(NEVER_WIPED, ["app_settings"]);
  for (const t of LOAD_ORDER) {
    if (NEVER_WIPED.includes(t)) {
      assert.ok(!WIPE_ORDER.includes(t), `${t} must never be wiped`);
    } else {
      assert.ok(WIPE_ORDER.includes(t), `${t} is loaded but never wiped — the load would collide`);
    }
  }
});

test("profiles is wiped last, because everything else names it", () => {
  assert.equal(WIPE_ORDER[WIPE_ORDER.length - 1], "profiles");
});

test("the wipe clears the two log tables the backup does not carry", () => {
  // audit_log.actor_id and function_errors have foreign keys to profiles, so
  // they must go before profiles can. They are not backed up (they are
  // operational noise), so a restored database starts with both empty.
  assert.ok(WIPE_ORDER.includes("audit_log"));
  assert.ok(WIPE_ORDER.includes("function_errors"));
  assert.ok(!BACKUP_TABLES.includes("audit_log"));
  assert.ok(!BACKUP_TABLES.includes("function_errors"));
});

test("every table has a primary key and a paging answer", () => {
  for (const t of BACKUP_TABLES) {
    assert.ok(Array.isArray(TABLE_KEYS[t]) && TABLE_KEYS[t].length, `${t} needs a primary key`);
    assert.ok(t in CURSOR_COLUMN, `${t} needs a cursor column or an explicit null`);
    const cursor = CURSOR_COLUMN[t];
    if (cursor !== null) {
      assert.deepEqual(TABLE_KEYS[t], [cursor], `${t}'s cursor must be its whole primary key`);
    } else {
      assert.ok(TABLE_KEYS[t].length > 1, `${t} only pages by offset if its key is composite`);
    }
  }
});

test("only the composite-key tables page by offset", () => {
  const offset = BACKUP_TABLES.filter(t => CURSOR_COLUMN[t] === null);
  assert.deepEqual(offset.sort(), ["arcade_scores", "chat_reactions"].sort());
});

test("the buckets are the five the app actually stores in", () => {
  const sql = read("supabase/handover/wipe-seed-data.sql");
  for (const b of BUCKETS) assert.ok(sql.includes(`'${b}'`), `${b} should appear in the wipe script`);
  assert.deepEqual(BUCKETS, ["reports", "jhas", "shared", "timesheets", "chat-media"]);
});

// ── Secrets ──────────────────────────────────────────────────────────────

// Every column app_settings has ever been given, read off the migrations.
// Only that table: a scan of every column in every migration would sweep up
// pdf_key, client_key and approval_token, which are records, not
// credentials, and would make this test impossible to pass.
function appSettingsColumns() {
  const dir = new URL("supabase/migrations/", ROOT);
  const columns = new Set();
  // The table was born as mail_settings and renamed in 20260902050835.
  const NAMES = "(?:app_settings|mail_settings)";
  for (const f of readdirSync(dir).sort()) {
    const sql = readFileSync(new URL(f, dir), "utf8");
    // create table public.mail_settings ( … );
    for (const m of sql.matchAll(new RegExp(`create table (?:if not exists )?public\\.${NAMES}\\s*\\(([\\s\\S]*?)\\n\\);`, "g"))) {
      for (const line of m[1].split("\n")) {
        const col = /^\s{2}(\w+)\s+\w/.exec(line);
        if (col && !/^(constraint|primary|unique|check|foreign)$/i.test(col[1])) columns.add(col[1]);
      }
    }
    // alter table public.app_settings … add column [if not exists] name …;
    for (const m of sql.matchAll(new RegExp(`alter table public\\.${NAMES}([\\s\\S]*?);`, "g"))) {
      for (const c of m[1].matchAll(/add column(?: if not exists)? (\w+)/g)) columns.add(c[1]);
    }
  }
  return [...columns];
}

test("the app_settings column scan finds the columns the migrations added", () => {
  // The scan itself has to be worth trusting, or the test below it is a
  // test of an empty list.
  const columns = appSettingsColumns();
  for (const known of ["resend_api_key", "from_reports", "klipy_api_key",
    "approval_base_url", "backup_provider", "backup_refresh_token",
    "backup_client_secret_dropbox", "backup_keep"]) {
    assert.ok(columns.includes(known), `the scan should have found ${known}`);
  }
  assert.ok(!columns.includes("constraint"), "a constraint line is not a column");
});

test("every credential column of app_settings is stripped from a backup", () => {
  // The list is checked against the migrations rather than against itself:
  // a column added later whose name says key, secret or token must be
  // added here too, and this is what says so.
  const credentials = appSettingsColumns().filter(c => /(secret|token|key)/i.test(c));
  assert.ok(credentials.length >= 6, "the scan found suspiciously few credential columns");
  for (const c of credentials) {
    assert.ok(APP_SETTINGS_SECRETS.includes(c), `${c} looks like a credential and must be stripped`);
  }
  assert.ok(APP_SETTINGS_SECRETS.includes("backup_oauth_state"), "the OAuth nonce is not a backup's business either");
});

test("stripSecrets empties the settings row's credentials and leaves the rest", () => {
  const row = {
    id: true, resend_api_key: "re_live", klipy_api_key: "kl_live",
    from_reports: "reports@vagabonde.ca", approval_base_url: "https://app.example.ca",
    backup_refresh_token: "1//refresh", backup_client_secret_google: "gsec",
    backup_provider: "google", backup_hour: 2
  };
  const [out] = stripSecrets("app_settings", [row]);
  assert.equal(out.resend_api_key, null);
  assert.equal(out.klipy_api_key, null);
  assert.equal(out.backup_refresh_token, null);
  assert.equal(out.backup_client_secret_google, null);
  assert.equal(out.from_reports, "reports@vagabonde.ca");
  assert.equal(out.backup_provider, "google");
  assert.equal(out.backup_hour, 2);
  assert.equal(row.resend_api_key, "re_live", "the caller's row must not be mutated");
});

test("stripSecrets leaves every other table exactly as it found it", () => {
  const rows = [
    { id: "a", straight_hours: 8, dose_mr: 1.25, resend_api_key: "not a credential here" },
    { id: "b", straight_hours: 0, dose_mr: null }
  ];
  // Compared against a copy taken before the call, so the assertion cannot
  // be satisfied by the function handing its own argument back mutated.
  const before = structuredClone(rows);
  assert.deepEqual(stripSecrets("ticket_crew", rows), before);
  assert.deepEqual(rows, before, "the caller's rows must not be touched");
});

test("a restore never writes back the drive connection it is running through", () => {
  for (const c of ["backup_provider", "backup_refresh_token", "backup_root_folder_id", "backup_next_run_at", "backup_hour"]) {
    assert.ok(APP_SETTINGS_NEVER_RESTORED.includes(c), `${c} must not be restored`);
  }
  assert.ok(!APP_SETTINGS_NEVER_RESTORED.includes("resend_api_key"));
  // Every backup_* column the migrations added, without exception: a new
  // one that slipped through would be restored out of a backup and point
  // the running restore at somebody else's drive.
  for (const c of appSettingsColumns().filter(c => c.startsWith("backup_"))) {
    assert.ok(APP_SETTINGS_NEVER_RESTORED.includes(c), `${c} is part of the connection and must not be restored`);
  }
});

// ── Paging and parts ─────────────────────────────────────────────────────

test("the page size is PostgREST's own silent cap", () => {
  assert.equal(PAGE_ROWS, 1000);
  assert.ok(MAX_PART_ROWS >= PAGE_ROWS && MAX_PART_ROWS % PAGE_ROWS === 0);
});

test("chunkRows splits at the cap and never drops or duplicates a row", () => {
  const rows = Array.from({ length: 2501 }, (_, i) => i);
  const parts = chunkRows(rows, 1000);
  assert.deepEqual(parts.map(p => p.length), [1000, 1000, 501]);
  assert.deepEqual(parts.flat(), rows);
  assert.deepEqual(chunkRows([], 1000), []);
  assert.deepEqual(chunkRows([1, 2], 1000), [[1, 2]]);
});

test("part files are flat names, numbered from one, that sort in order", () => {
  assert.equal(partFileName("tickets", 0), "tickets.01.json.gz");
  assert.equal(partFileName("tickets", 9), "tickets.10.json.gz");
  assert.ok(!partFileName("tickets", 0).includes("/"), "a drive name is one path segment");
  const names = [0, 1, 10, 2].map(i => partFileName("t", i));
  assert.deepEqual([...names].sort(), ["t.01.json.gz", "t.02.json.gz", "t.03.json.gz", "t.11.json.gz"]);
});

test("a stored object's name survives the round trip through the drive", () => {
  assert.equal(TABLES_FOLDER, "tables");
  assert.equal(FILES_FOLDER, "files");
  const cases = [
    ["reports", "8f1c/report-2026-08.pdf"],
    ["chat-media", "2026/08/voice note (1).webm"],
    ["shared", "Safety & procedures/RT+SOP.pdf"]
  ];
  for (const [bucket, key] of cases) {
    const name = fileEntryName(bucket, key);
    assert.ok(!name.includes("/"), `${name} must be one path segment`);
    assert.deepEqual(parseFileEntryName(name), { bucket, key });
  }
  assert.equal(parseFileEntryName("not-a-backup-file"), null);
});

test("restoring chosen jobs reaches for exactly the tables a job owns", () => {
  assert.deepEqual(JOB_CHILD_TABLES,
    ["tickets", "ticket_lines", "ticket_crew", "jhas", "reports", "rate_overrides"]);
});

// ── The manifest ─────────────────────────────────────────────────────────

test("a folder is stamped on Grande Prairie's clock", () => {
  assert.equal(folderStamp(Date.parse("2026-09-04T08:05:00Z")), "2026-09-04 02-05");
  assert.equal(folderStamp(Date.parse("2026-01-04T09:05:00Z")), "2026-01-04 02-05");
  assert.equal(BACKUP_ROOT_NAME, "VagaboNDE backups");
  assert.equal(MANIFEST_NAME, "manifest.json");
});

test("a manifest records what went in and says what it holds", () => {
  let m = newManifest("0.9.0-Beta", "20260904135107", "2026-09-04T08:00:00.000Z");
  m = recordTable(m, "tickets", 2501, ["tickets.01.json.gz", "tickets.02.json.gz"]);
  m = recordTable(m, "clients", 12, ["clients.01.json.gz"]);
  m = recordFiles(m, 340, 1234567);
  m = finishManifest(m, "2026-09-04T08:41:00.000Z");
  assert.equal(m.app_version, "0.9.0-Beta");
  assert.equal(m.schema_version, "20260904135107");
  assert.equal(m.tables.tickets.rows, 2501);
  assert.deepEqual(m.tables.tickets.parts, ["tickets.01.json.gz", "tickets.02.json.gz"]);
  assert.equal(m.files.count, 340);
  assert.equal(m.files.bytes, 1234567);
  assert.equal(m.finished_at, "2026-09-04T08:41:00.000Z");
  assert.match(m.note, /hours and dose/i, "the manifest must say what a backup contains");
  // It has to survive a round trip through the drive as bytes.
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m);
});

test("recordFiles adds up across the slices a run is made of", () => {
  let m = newManifest("0.9.0-Beta", null, "2026-09-04T08:00:00.000Z");
  m = recordFiles(m, 100, 1000);
  m = recordFiles(m, 40, 500, 30);
  // reused counts the files copied over on the drive from the night
  // before; they are among count, not beside it.
  assert.deepEqual(m.files, { count: 140, bytes: 1500, reused: 30 });
});

test("the jobs index is what the per-job restore picks from", () => {
  const index = jobsIndex({
    jobs: [
      { id: "j1", job_number: "25-0001", project: "Wapiti tie-in", status: "Active", created_at: "2026-08-01T12:00:00Z", client_id: "c1" },
      { id: "j2", job_number: "25-0002", project: "Kakwa", status: "Closed", created_at: "2026-08-02T12:00:00Z", client_id: null }
    ],
    clients: [{ id: "c1", name: "Northgate Energy" }],
    tickets: [{ job_id: "j1" }, { job_id: "j1" }],
    jhas: [{ job_id: "j2" }],
    reports: [{ job_id: "j1" }]
  });
  assert.deepEqual(index, [
    { id: "j1", job_number: "25-0001", client: "Northgate Energy", project: "Wapiti tie-in", created_at: "2026-08-01T12:00:00Z", status: "Active", tickets: 2, jhas: 0, reports: 1 },
    { id: "j2", job_number: "25-0002", client: "", project: "Kakwa", created_at: "2026-08-02T12:00:00Z", status: "Closed", tickets: 0, jhas: 1, reports: 0 }
  ]);
});

// ── Retention ────────────────────────────────────────────────────────────

test("a before-restore copy stops at the manifest and never prunes the drive", () => {
  // The safety copy is taken with a restore already in flight. Retention
  // counts folders and cannot see which one that restore is reading from,
  // so on a keep of 1 it would delete the backup being restored — after the
  // wipe, before the load.
  assert.equal(nextPhaseAfterManifest("before_restore"), "done");
  assert.equal(nextPhaseAfterManifest("backup"), "retention");
  assert.equal(nextPhaseAfterManifest(""), "retention");
  assert.equal(nextPhaseAfterManifest(undefined), "retention");
});

test("retention spares the folder a restore is reading from, however old", () => {
  const names = ["2026-09-01 02-00", "2026-09-02 02-00", "2026-09-03 02-00", "2026-09-04 02-00"];
  // A restore is usually FROM an older backup, which is precisely the folder
  // a keep of 1 deletes first.
  assert.deepEqual(foldersToDelete(names, 1, ["2026-09-01 02-00"]),
    ["2026-09-02 02-00", "2026-09-03 02-00"]);
  assert.deepEqual(foldersToDelete(names, 1, ["2026-09-01 02-00", "2026-09-02 02-00", "2026-09-03 02-00"]), []);
  // Nothing to spare, and a name that is not in the drive at all, both leave
  // the count exactly as it was.
  assert.deepEqual(foldersToDelete(names, 3), ["2026-09-01 02-00"]);
  assert.deepEqual(foldersToDelete(names, 3, []), ["2026-09-01 02-00"]);
  assert.deepEqual(foldersToDelete(names, 3, [null, "", "2026-08-30 02-00"]), ["2026-09-01 02-00"]);
});

test("retention keeps the newest N and throws the rest away", () => {
  const names = ["2026-09-01 02-00", "2026-09-02 02-00", "2026-09-03 02-00", "2026-09-04 02-00"];
  assert.deepEqual(foldersToDelete(names, 2), ["2026-09-01 02-00", "2026-09-02 02-00"]);
  assert.deepEqual(foldersToDelete(names, 4), []);
  assert.deepEqual(foldersToDelete(names, 10), []);
  assert.deepEqual(foldersToDelete([], 3), []);
});

test("retention reads the folders in date order however they arrive", () => {
  const shuffled = ["2026-09-04 02-00", "2026-09-01 02-00", "2026-09-03 02-00", "2026-09-02 02-00"];
  assert.deepEqual(foldersToDelete(shuffled, 1),
    ["2026-09-01 02-00", "2026-09-02 02-00", "2026-09-03 02-00"]);
});

test("retention never touches a before-restore folder", () => {
  const names = [
    "2026-09-01 02-00", "before-restore 2026-09-02 11-30",
    "2026-09-03 02-00", "2026-09-04 02-00", "notes"
  ];
  assert.equal(beforeRestoreName("2026-09-02 11-30"), "before-restore 2026-09-02 11-30");
  assert.equal(isBeforeRestore("before-restore 2026-09-02 11-30"), true);
  assert.equal(isBeforeRestore("2026-09-02 11-30"), false);
  // "notes" is not a backup folder either — a person's own folder in the
  // same drive must survive.
  assert.deepEqual(foldersToDelete(names, 2), ["2026-09-01 02-00"]);
});

test("a backup from a newer schema than the live one is refused", () => {
  assert.equal(schemaTooNew("20260910000000", "20260904135107"), true);
  assert.equal(schemaTooNew("20260904135107", "20260904135107"), false);
  assert.equal(schemaTooNew("20260901000000", "20260904135107"), false);
  // Unknown either side is not proof of anything, so it is not a refusal.
  assert.equal(schemaTooNew(null, "20260904135107"), false);
  assert.equal(schemaTooNew("20260910000000", null), false);
});

// ── The drive, against the fake ──────────────────────────────────────────

const bytes = s => new TextEncoder().encode(s);
const text = b => new TextDecoder().decode(b);

test("the fake drive answers the whole interface", async () => {
  const drive = new FakeDrive();
  const root = drive.rootId();
  const folder = await drive.createFolder(root, "VagaboNDE backups");
  const run = await drive.createFolder(folder, "2026-09-04 02-00");

  assert.deepEqual((await drive.listFolders(root)).map(f => f.name), ["VagaboNDE backups"]);
  assert.deepEqual((await drive.listFolders(folder)).map(f => f.name), ["2026-09-04 02-00"]);

  const id = await drive.upload(run, "manifest.json", bytes('{"ok":true}'), "application/json");
  assert.deepEqual((await drive.listFiles(run)).map(f => f.name), ["manifest.json"]);
  assert.equal(text(await drive.download(id)), '{"ok":true}');

  await drive.delete(id);
  assert.deepEqual(await drive.listFiles(run), []);
});

test("the fake drive overwrites a name rather than doubling it, as the real three do", async () => {
  const drive = new FakeDrive();
  const folder = await drive.createFolder(drive.rootId(), "run");
  await drive.upload(folder, "clients.01.json.gz", bytes("first"), "application/gzip");
  const second = await drive.upload(folder, "clients.01.json.gz", bytes("second"), "application/gzip");
  assert.equal((await drive.listFiles(folder)).length, 1);
  assert.equal(text(await drive.download(second)), "second");
});

test("deleting a folder takes what is inside it", async () => {
  const drive = new FakeDrive();
  const folder = await drive.createFolder(drive.rootId(), "old");
  const file = await drive.upload(folder, "a.json", bytes("a"), "application/json");
  await drive.delete(folder);
  assert.deepEqual(await drive.listFolders(drive.rootId()), []);
  await assert.rejects(() => drive.download(file), /not found/i);
});

test("the fake can be told to fail, so retries can be tested", async () => {
  const drive = new FakeDrive();
  const folder = await drive.createFolder(drive.rootId(), "run");
  drive.failNextUploads = 2;
  await assert.rejects(() => drive.upload(folder, "a", bytes("a"), "text/plain"), /drive is unavailable/i);
  await assert.rejects(() => drive.upload(folder, "a", bytes("a"), "text/plain"), /drive is unavailable/i);
  const id = await drive.upload(folder, "a", bytes("a"), "text/plain");
  assert.equal(text(await drive.download(id)), "a");
});

// ── The three real drives, against a stubbed fetch ───────────────────────
// Nothing here touches a network. withFetch swaps globalThis.fetch for a
// stub that records every request and answers it, and puts the real one
// back afterwards however the test ends — so the parts of each provider
// class that are pure protocol can be read back off the requests
// themselves: which name it asks about, where it resumes an upload, and
// what it does about a folder that is already there.

async function withFetch(stub, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return await stub(String(url), init, calls.length - 1);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });

const GOOGLE_LIST = "https://www.googleapis.com/drive/v3/files?";

test("Google resumes where the 308 says it got to, not where the sender hoped", async () => {
  // A resumable PUT can be accepted in part. Google says how much it kept
  // in the Range header of its 308, and carrying on past that would leave a
  // hole in the middle of the file: the upload "succeeds", the manifest
  // counts the rows, and the gzip is corrupt.
  const size = 6 * 1024 * 1024;          // one 8 MiB chunk covers the body…
  const kept = 1024 * 1024;              // …of which Google keeps 1 MiB.
  const ranges = [];
  const drive = new GoogleDrive("tok");

  const id = await withFetch(async (url, init) => {
    if (url.startsWith(GOOGLE_LIST)) return json({ files: [] });
    if (url.includes("uploadType=resumable")) {
      return json({}, 200, { Location: "https://upload.example/session-1" });
    }
    ranges.push(init.headers["Content-Range"]);
    if (ranges.length === 1) {
      return new Response(null, { status: 308, headers: { Range: `bytes=0-${kept - 1}` } });
    }
    return json({ id: "file-1" });
  }, () => drive.upload("folder-1", "tickets.01.json.gz", new Uint8Array(size), "application/gzip"));

  assert.equal(id, "file-1");
  assert.deepEqual(ranges, [
    `bytes 0-${size - 1}/${size}`,
    `bytes ${kept}-${size - 1}/${size}`
  ]);
});

test("a 308 with no Range at all is Google saying it took the whole chunk", async () => {
  const size = 10 * 1024 * 1024;         // two chunks: 8 MiB then 2 MiB.
  const chunk = 8 * 1024 * 1024;
  const ranges = [];
  const drive = new GoogleDrive("tok");

  const id = await withFetch(async (url, init) => {
    if (url.startsWith(GOOGLE_LIST)) return json({ files: [] });
    if (url.includes("uploadType=resumable")) {
      return json({}, 200, { Location: "https://upload.example/session-2" });
    }
    ranges.push(init.headers["Content-Range"]);
    if (ranges.length === 1) return new Response(null, { status: 308 });
    return json({ id: "file-2" });
  }, () => drive.upload("folder-1", "ticket_lines.01.json.gz", new Uint8Array(size), "application/gzip"));

  assert.equal(id, "file-2");
  assert.deepEqual(ranges, [
    `bytes 0-${chunk - 1}/${size}`,
    `bytes ${chunk}-${size - 1}/${size}`
  ]);
});

test("Google asks about the one name it is about to write, not the whole folder", async () => {
  const drive = new GoogleDrive("tok");
  const lookups = [];

  const id = await withFetch(async (url, init) => {
    if (url.startsWith(GOOGLE_LIST)) {
      lookups.push(new URL(url));
      return json({ files: [{ id: "old-1", name: "clients.01.json.gz" }] });
    }
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return json({ id: "new-1" });
  }, async calls => {
    const out = await drive.upload("folder-1", "clients.01.json.gz", bytes("rows"), "application/gzip");
    assert.equal(calls.length, 3, "one lookup, one delete, one upload — a folder read is not one of them");
    return out;
  });

  assert.equal(id, "new-1");
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].searchParams.get("q"),
    "name = 'clients.01.json.gz' and 'folder-1' in parents and trashed = false" +
    " and mimeType != 'application/vnd.google-apps.folder'");
});

test("an apostrophe in a name does not become a Drive query syntax error", async () => {
  const drive = new GoogleDrive("tok");
  let q = "";
  await withFetch(async url => {
    if (url.startsWith(GOOGLE_LIST)) {
      q = new URL(url).searchParams.get("q");
      return json({ files: [] });
    }
    return json({ id: "new-1" });
  }, () => drive.upload("folder-1", "O'Brien \\ Sons.pdf", bytes("x"), "application/pdf"));

  // Unescaped, Google answers a 400 rather than an empty list, and the
  // upload fails on a client whose name has an apostrophe in it.
  assert.ok(q.startsWith("name = 'O\\'Brien \\\\ Sons.pdf' and "), q);
});

test("Google looks for the folder rather than making a second one of the same name", async () => {
  const drive = new GoogleDrive("tok");
  const found = await withFetch(async (url, init) => {
    assert.notEqual(init.method, "POST", "nothing may be created when the folder is already there");
    return json({ files: [{ id: "folder-9", name: "tables" }] });
  }, async calls => {
    const id = await drive.createFolder("run-1", "tables");
    assert.equal(calls.length, 1);
    return id;
  });
  assert.equal(found, "folder-9");
});

test("Google creates the folder when the lookup finds none", async () => {
  const drive = new GoogleDrive("tok");
  const made = await withFetch(async (url, init) => {
    if (!init.method || init.method === "GET") return json({ files: [] });
    assert.equal(JSON.parse(init.body).mimeType, "application/vnd.google-apps.folder");
    return json({ id: "folder-new" });
  }, () => drive.createFolder("run-1", "tables"));
  assert.equal(made, "folder-new");
});

test("OneDrive resumes where nextExpectedRanges says it got to, not where the sender hoped", async () => {
  // Graph accepts a chunk in part exactly the way Google does, and says so
  // in the 202's nextExpectedRanges rather than in a Range header. Sending
  // the next chunk from `end` regardless leaves a hole in the middle of the
  // part file that nothing downstream notices.
  const size = 6 * 1024 * 1024;          // one 5 MiB chunk, then 1 MiB…
  const chunk = 5 * 1024 * 1024;
  const kept = 2 * 1024 * 1024;          // …of which Graph keeps 2 MiB.
  const ranges = [];
  const drive = new OneDrive("tok");

  const id = await withFetch(async (url, init) => {
    if (url.includes("createUploadSession")) return json({ uploadUrl: "https://upload.example/graph-1" });
    ranges.push(init.headers["Content-Range"]);
    if (ranges.length === 1) return json({ nextExpectedRanges: [`${kept}-${size - 1}`] }, 202);
    return json({ id: "item-1" });
  }, () => drive.upload("folder-1", "tickets.01.json.gz", new Uint8Array(size), "application/gzip"));

  assert.equal(id, "item-1");
  assert.deepEqual(ranges, [
    `bytes 0-${chunk - 1}/${size}`,
    `bytes ${kept}-${size - 1}/${size}`
  ]);
});

test("a 202 with no ranges on it is OneDrive saying it took the whole chunk", async () => {
  const size = 6 * 1024 * 1024;
  const chunk = 5 * 1024 * 1024;
  const ranges = [];
  const drive = new OneDrive("tok");

  const id = await withFetch(async (url, init) => {
    if (url.includes("createUploadSession")) return json({ uploadUrl: "https://upload.example/graph-2" });
    ranges.push(init.headers["Content-Range"]);
    if (ranges.length === 1) return new Response(null, { status: 202 });
    return json({ id: "item-2" });
  }, () => drive.upload("folder-1", "ticket_lines.01.json.gz", new Uint8Array(size), "application/gzip"));

  assert.equal(id, "item-2");
  assert.deepEqual(ranges, [
    `bytes 0-${chunk - 1}/${size}`,
    `bytes ${chunk}-${size - 1}/${size}`
  ]);
});

test("OneDrive gives up on a session that keeps none of two identical chunks", async () => {
  // An open-ended range back at the start is Graph asking for the same
  // bytes again. Once is the protocol; twice is a wedged session, and a
  // loop that never ends is worse than a failure the retry can see.
  const size = 6 * 1024 * 1024;
  const ranges = [];
  const drive = new OneDrive("tok");

  await assert.rejects(
    withFetch(async (url, init) => {
      if (url.includes("createUploadSession")) return json({ uploadUrl: "https://upload.example/graph-3" });
      ranges.push(init.headers["Content-Range"]);
      return json({ nextExpectedRanges: ["0-"] }, 202);
    }, () => drive.upload("folder-1", "jobs.01.json.gz", new Uint8Array(size), "application/gzip")),
    e => {
      assert.match(e.message, /upload session is stuck/);
      assert.equal(e.retryable, true, "the run's own retry has to be allowed to try the whole upload again");
      return true;
    }
  );
  assert.equal(ranges.length, 2, "the same chunk twice, and then it stops");
});

test("OneDrive creates a folder fail-on-conflict, and looks it up rather than replacing it", async () => {
  const drive = new OneDrive("tok");
  const lookups = [];
  const bodies = [];

  const id = await withFetch(async (url, init) => {
    if (url.includes(":/tables")) {
      lookups.push(url);
      // Free the first time; taken by the time the 409 sends us back.
      return lookups.length === 1
        ? new Response(null, { status: 404 })
        : json({ id: "folder-9", folder: {} });
    }
    bodies.push(JSON.parse(init.body));
    return json({ error: { code: "nameAlreadyExists" } }, 409);
  }, () => drive.createFolder("run-1", "tables"));

  assert.equal(id, "folder-9");
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]["@microsoft.graph.conflictBehavior"], "fail",
    "replace would throw away the backup already in that folder");
  assert.equal(lookups.length, 2, "the 409 is answered by looking again, not by giving up");
});

test("Dropbox returns the folder it finds rather than asking to create it", async () => {
  const drive = new Dropbox("tok");
  const endpoints = [];
  const path = await withFetch(async (url, init) => {
    endpoints.push(url.replace("https://api.dropboxapi.com/2/", ""));
    assert.equal(JSON.parse(init.body).path, "/VagaboNDE backups");
    return json({ ".tag": "folder", path_display: "/VagaboNDE backups" });
  }, () => drive.createFolder("", "VagaboNDE backups"));

  assert.equal(path, "/VagaboNDE backups");
  assert.deepEqual(endpoints, ["files/get_metadata"]);
});

test("Dropbox creates the folder when the path is free", async () => {
  const drive = new Dropbox("tok");
  const endpoints = [];
  const path = await withFetch(async url => {
    endpoints.push(url.replace("https://api.dropboxapi.com/2/", ""));
    // "path/not_found" is Dropbox saying the name is going spare.
    if (url.endsWith("files/get_metadata")) return json({ error_summary: "path/not_found/." }, 409);
    return json({ metadata: { path_display: "/VagaboNDE backups/2026-09-04 02-00" } });
  }, () => drive.createFolder("/VagaboNDE backups", "2026-09-04 02-00"));

  assert.equal(path, "/VagaboNDE backups/2026-09-04 02-00");
  assert.deepEqual(endpoints, ["files/get_metadata", "files/create_folder_v2"]);
});

// ── The consent URLs ─────────────────────────────────────────────────────

test("the three providers are asked for exactly the scopes the spec names", () => {
  assert.deepEqual(PROVIDERS, ["google", "microsoft", "dropbox"]);
  assert.equal(SCOPES.google, "https://www.googleapis.com/auth/drive.file");
  assert.equal(SCOPES.microsoft, "Files.ReadWrite offline_access");
  assert.equal(SCOPES.dropbox, "files.content.write files.content.read files.metadata.read");
});

test("each authorize URL carries the state, the redirect and offline access", () => {
  const redirect = "https://app.example.ca/backup/oauth/google";
  const google = new URL(authorizeUrl("google", "gid", redirect, "nonce123"));
  assert.equal(google.origin + google.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(google.searchParams.get("client_id"), "gid");
  assert.equal(google.searchParams.get("redirect_uri"), redirect);
  assert.equal(google.searchParams.get("response_type"), "code");
  assert.equal(google.searchParams.get("access_type"), "offline");
  assert.equal(google.searchParams.get("prompt"), "consent");
  assert.equal(google.searchParams.get("state"), "nonce123");
  assert.equal(google.searchParams.get("scope"), SCOPES.google);

  const ms = new URL(authorizeUrl("microsoft", "mid", "https://app.example.ca/backup/oauth/microsoft", "n2"));
  assert.equal(ms.origin + ms.pathname, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  assert.equal(ms.searchParams.get("response_mode"), "query");
  assert.equal(ms.searchParams.get("scope"), SCOPES.microsoft);
  assert.equal(ms.searchParams.get("state"), "n2");

  const db = new URL(authorizeUrl("dropbox", "did", "https://app.example.ca/backup/oauth/dropbox", "n3"));
  assert.equal(db.origin + db.pathname, "https://www.dropbox.com/oauth2/authorize");
  assert.equal(db.searchParams.get("token_access_type"), "offline");
  assert.equal(db.searchParams.get("scope"), SCOPES.dropbox);
  assert.equal(db.searchParams.get("state"), "n3");
});

test("an unknown provider is refused rather than guessed at", () => {
  assert.throws(() => authorizeUrl("box", "id", "https://x/y", "n"), /provider/i);
});

// ── The connection's own doors ───────────────────────────────────────────
// backup-oauth answers a browser that carries no token, so what stands in
// for one is a nonce this app minted minutes earlier. These are the checks
// that door is made of, with the network and the database taken out.

test("the provider is the last segment of the callback's path, and only if we know it", () => {
  assert.equal(providerInPath("/backup-oauth/google"), "google");
  assert.equal(providerInPath("/functions/v1/backup-oauth/microsoft"), "microsoft");
  assert.equal(providerInPath("/backup-oauth/dropbox/"), "dropbox");
  // The function's own name is not a provider, so a bare POST is not a
  // callback.
  assert.equal(providerInPath("/backup-oauth"), "");
  assert.equal(providerInPath("/functions/v1/backup-oauth"), "");
  assert.equal(providerInPath("/backup-oauth/box"), "");
  assert.equal(providerInPath("/backup-oauth/GOOGLE"), "");
  assert.equal(providerInPath(""), "");
});

test("the callback URI is built from the stored app address, origin only", () => {
  assert.deepEqual(callbackUri("https://ops.example.ca", "google"),
    { uri: "https://ops.example.ca/backup/oauth/google", base: "https://ops.example.ca" });
  assert.deepEqual(callbackUri("https://ops.example.ca/", "dropbox"),
    { uri: "https://ops.example.ca/backup/oauth/dropbox", base: "https://ops.example.ca" });
  assert.deepEqual(callbackUri("https://ops.example.ca/somewhere?x=1", "microsoft"),
    { uri: "https://ops.example.ca/backup/oauth/microsoft", base: "https://ops.example.ca" });
});

test("the panel and the function build the same string from the same stored address", () => {
  // The provider's registration holds one of these two and compares it with
  // the other. They are computed in different languages on different
  // machines; if they ever drift, every connection fails at the exchange.
  const stored = "https://ops.example.ca/";
  for (const p of PROVIDERS) {
    assert.equal(callbackUri(stored, p).uri, `https://ops.example.ca/backup/oauth/${p}`);
  }
});

test("with no app address stored the server refuses rather than guessing", () => {
  assert.throws(() => callbackUri("", "google"), /App address/i);
  assert.throws(() => callbackUri("   ", "google"), /App address/i);
  assert.throws(() => callbackUri("ops.example.ca", "google"), /App address/i);
});

test("credentials come out of the row by provider, and an incomplete pair is refused", () => {
  const row = {
    backup_client_id_google: " gid ", backup_client_secret_google: " gsecret ",
    backup_client_id_microsoft: "mid", backup_client_secret_microsoft: null,
    backup_client_id_dropbox: null, backup_client_secret_dropbox: "dsecret"
  };
  assert.deepEqual(credentialsFrom(row, "google"), { id: "gid", secret: "gsecret" });
  assert.throws(() => credentialsFrom(row, "microsoft"), /client secret|registration/i);
  assert.throws(() => credentialsFrom(row, "dropbox"), /client ID|registration/i);
  assert.throws(() => credentialsFrom({}, "google"), /registration/i);
});

test("the three provider lists are one list written three times", () => {
  // drive.ts knows how to talk to them, backupOauth.ts decides whether a
  // callback path names one, and the panel draws a Connect button per name.
  // None of the three may import the others (two are erasable TypeScript
  // read by Deno, one is browser JavaScript), so the copies are held level
  // here instead: a provider added to drive.ts alone is a drive the callback
  // answers 404 for, and one added to the panel alone is a button that
  // cannot start.
  assert.deepEqual(OAUTH_PROVIDERS, PROVIDERS);
  assert.deepEqual(BACKUP_PROVIDERS, PROVIDERS);
});

test("the callback spends the nonce it was handed and no other", () => {
  // Nulling the nonce on the settings row's id alone meant that any GET of
  // the callback address — a crawler, a stranger, a stale link — cleared the
  // nonce the Admin's Connect had just minted, and Connect could never
  // finish. The function is read back here because the fix is a filter on an
  // update, which no pure function can hold.
  const src = read("supabase/functions/backup-oauth/index.ts");
  const updates = [...src.matchAll(/\.update\(\{([^{}]*backup_oauth_state: null[^{}]*)\}\)([^;]*);/g)];
  assert.equal(updates.length, 2, "the nonce is nulled in exactly two places: disconnect, and spending it");
  for (const [, body, filters] of updates) {
    // Disconnect is an Admin's own POST and lets go of the whole connection,
    // so it clears the row's nonce unconditionally and rightly.
    if (/backup_refresh_token: null/.test(body)) continue;
    assert.match(filters, /\.eq\("backup_oauth_state",/,
      "the callback may spend only the nonce actually presented to it");
  }
  // And both callback paths — the consent screen's Cancel and the real
  // return — go through that one door.
  assert.equal((src.match(/await spendNonce\(/g) ?? []).length, 2);
});

test("a drive's own refusal is retold rather than repeated into the address bar", () => {
  // ok() in drive.ts throws "<what> failed (<status>): <up to 400 characters
  // of the provider's response body>". That body rides the redirect's why=
  // into an address bar and a browser history if it is passed through, so
  // the shape is recognised and answered in this app's own words.
  const raw = 'google token exchange failed (400): {"error":"invalid_grant","error_description":"Bad Request"}';
  const said = providerRefusal(raw);
  assert.ok(!said.includes("invalid_grant"), "the provider's body must not survive");
  assert.match(said, /google token exchange/);
  assert.match(said, /400/);

  // 401/403 on the token exchange is the registration, and says so.
  assert.match(providerRefusal("google token exchange failed (401): {}"), /client ID and client secret/i);
  assert.match(providerRefusal("dropbox token exchange failed (403): nope"), /client ID and client secret/i);
  // 401/403 after the sign-in is the API, not the credentials — and Google's
  // "not enabled" body is named for what it is, without the body itself.
  const off = providerRefusal('Google Drive account failed (403): {"error":{"code":403,"message":"Google Drive API has not been used in project 1023 before or it is disabled. Enable it by visiting https://console…"}}');
  assert.match(off, /Drive API is not enabled/);
  assert.ok(!off.includes("console…") && !off.includes("1023"), "the body must not survive");
  assert.match(providerRefusal("OneDrive account failed (401): {}"), /signed you in but refused the next call/i);
  assert.ok(!providerRefusal("OneDrive account failed (401): {}").includes("client ID"));
  // Busy is worth trying again; a 400 is not.
  assert.match(providerRefusal("Google Drive folder failed (503): <html>busy</html>"), /again in a minute/i);
  assert.match(providerRefusal("microsoft token exchange failed (429): slow down"), /again in a minute/i);
  assert.ok(!providerRefusal("Google Drive folder failed (503): <html>busy</html>").includes("<html>"));

  // Everything the app wrote itself is already a sentence and is left alone.
  for (const own of [
    "That connection link wasn't the one this app started. Press Connect again.",
    "The drive sent us back without an authorisation code.",
    "google sent an access token but no refresh token, so the connection would stop working within the hour."
  ]) {
    assert.equal(providerRefusal(own), own);
  }
  assert.equal(providerRefusal(""), "");
});

test("the nonce has to be the one we minted", () => {
  const now = Date.parse("2026-09-05T12:00:00Z");
  const minted = now - 60_000;
  assert.equal(nonceRefusal("abc", "abc", minted, now), "");
  assert.match(nonceRefusal("abc", "xyz", minted, now), /wasn't the one this app started/);
  // Nothing minted at all: a callback arriving out of nowhere, or a second
  // one after the first spent it.
  assert.match(nonceRefusal("", "abc", minted, now), /wasn't the one this app started/);
  assert.match(nonceRefusal(null, "abc", minted, now), /wasn't the one this app started/);
  // An empty presented value must never match an empty stored one.
  assert.match(nonceRefusal("", "", minted, now), /wasn't the one this app started/);
});

test("the nonce goes stale at ten minutes", () => {
  const now = Date.parse("2026-09-05T12:00:00Z");
  assert.equal(NONCE_MS, 10 * 60 * 1000);
  assert.equal(nonceRefusal("abc", "abc", now - NONCE_MS + 1000, now), "");
  assert.match(nonceRefusal("abc", "abc", now - NONCE_MS - 1000, now), /more than ten minutes/);
  // No mint time on the row is not "infinitely fresh".
  assert.match(nonceRefusal("abc", "abc", 0, now), /more than ten minutes/);
  assert.match(nonceRefusal("abc", "abc", NaN, now), /more than ten minutes/);
});

test("the shared modules read nothing from the world around them", () => {
  // They are imported by the node suite AND by Deno Edge Functions. An
  // import of supabase-js or a read of Deno.env in any of the three breaks
  // this file outright; the assertion is here so the reason is named.
  for (const f of ["backupTables.ts", "backupManifest.ts", "drive.ts", "backupOauth.ts",
    "backupRun.ts", "backupSchedule.ts", "gzip.ts"]) {
    const src = read(`supabase/functions/_shared/${f}`);
    const imports = [...src.matchAll(/^import .*?from ["'](.+?)["']/gm)].map(m => m[1]);
    const allowed = f === "backupManifest.ts" ? ["./backupSchedule.ts"] : [];
    assert.deepEqual(imports, allowed, `${f} must import only ${allowed.join(", ") || "nothing"}`);
    assert.ok(!/Deno\.env|process\.env/.test(src), `${f} must not read the environment`);
    // Erasable TypeScript only: an enum or a namespace does not strip.
    assert.ok(!/^\s*(?:export\s+)?(?:const\s+)?enum\s/m.test(src), `${f} must not declare an enum`);
    // Nor does a constructor parameter property: `constructor(private token:
    // string)` strips to a constructor that never assigns, and drive.ts's
    // three clients all take their token that way.
    assert.ok(!/constructor\s*\([^)]*\b(?:public|private|protected|readonly)\s/.test(src),
      `${f} must not use a constructor parameter property`);
    // No literal control character may reach a source file (git would call
    // it binary); dropboxArg's high range is written as escapes.
    assert.ok(!/[\x00-\x08\x0e-\x1f\x7f]/.test(src), `${f} must hold no control characters`);
  }
});

// ── Gzip ─────────────────────────────────────────────────────────────────

test("a table part survives being gzipped and read back", async () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: `t-${i}`, total: i * 137, note: "Wapiti tie-in · RT" }));
  const json = JSON.stringify(rows);
  const packed = await gzip(new TextEncoder().encode(json));
  assert.ok(packed.byteLength < json.length, "gzip should be smaller than the JSON it came from");
  // A gzip member starts 1f 8b — the restore reads these back with a
  // DecompressionStream that will not say so if it is handed something else.
  assert.equal(packed[0], 0x1f);
  assert.equal(packed[1], 0x8b);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(await gunzip(packed))), rows);
});

test("an empty table still round-trips", async () => {
  const packed = await gzip(new TextEncoder().encode("[]"));
  assert.equal(new TextDecoder().decode(await gunzip(packed)), "[]");
});

// ── The slice's budget, and the retry ────────────────────────────────────

test("a slice's budget is spent against its own deadline", () => {
  const start = Date.parse("2026-09-05T02:00:00Z");
  const deadline = sliceDeadline(start);
  assert.equal(deadline - start, BUDGET_MS);
  assert.equal(budgetLeft(deadline, start), BUDGET_MS);
  assert.equal(outOfBudget(deadline, start + BUDGET_MS - 1), false);
  assert.equal(outOfBudget(deadline, start + BUDGET_MS), true);
  // Past the deadline stays past it — a negative remainder is no remainder.
  assert.equal(budgetLeft(deadline, start + BUDGET_MS + 5000), 0);
});

test("a heartbeat older than a slice can live is a run to reclaim", () => {
  const now = Date.parse("2026-09-05T02:10:00Z");
  // Shorter than the five minutes between cron ticks, so a slice whose
  // self-kick was lost is picked up on the next tick and not ten minutes on.
  assert.ok(SLICE_ALIVE_MS < 5 * 60_000, "a stale run must be reclaimable within one cron gap");
  assert.ok(SLICE_ALIVE_MS > BUDGET_MS, "a slice must not be declared dead while it is still inside its budget");
  assert.equal(sliceLooksAlive(new Date(now - 1000).toISOString(), now), true);
  assert.equal(sliceLooksAlive(new Date(now - SLICE_ALIVE_MS - 1000).toISOString(), now), false);
  // A run nobody has started yet has no heartbeat, and that is not "alive".
  assert.equal(sliceLooksAlive(null, now), false);
  assert.equal(sliceLooksAlive("", now), false);
  assert.equal(sliceLooksAlive("not a date", now), false);
});

test("the wipe empties tickets before the list their numbers are burned into", () => {
  // tickets_burn_issued_number is BEFORE DELETE on tickets and inserts a
  // burned_ticket_numbers row for every ticket carrying approval_sent_at,
  // so clearing the burn list first leaves exactly as many rows behind as
  // there were sent tickets deleted after it.
  assert.ok(WIPE_ORDER.indexOf("tickets") < WIPE_ORDER.indexOf("burned_ticket_numbers"));
  const src = read("supabase/functions/_shared/backupTables.ts");
  assert.match(src, /tickets_burn_issued_number/, "and the reason has to stay written down beside the order");
});

test("the walk of the account list stops on an empty page, not a short one", () => {
  // perPage is a request, not a promise: a gateway that caps below 1,000
  // answers the first page short, and a walk that stops there drops every
  // account after the cap — silently, in the two places it matters most.
  for (const file of ["supabase/functions/backup-run/index.ts", "supabase/functions/backup-restore/index.ts"]) {
    const src = read(file);
    assert.match(src, /listUsers\(\{ page, perPage: 1000 \}\)/, file);
    assert.match(src, /if \(!users\.length\) break;/, file);
    assert.doesNotMatch(src, /if \(users\.length < 1000\) break;/, file);
  }
});

test("the chain that drives a backup asks for the run it just moved", () => {
  const source = read("supabase/functions/backup-run/index.ts");
  // The self-kick used to say {action:"tick"} straight after writing a
  // fresh heartbeat, so the invocation it woke read its own heartbeat as
  // "another slice is alive" and returned busy without advancing anything:
  // every backup crawled at one slice per five-minute cron tick. The chain
  // now names the run and says it is the chain, and only that exemption
  // skips the aliveness gate.
  assert.match(source, /kick\("backup-run",\s*\{\s*action:\s*"advance",\s*runId,\s*chain:\s*true\s*\}/);
  assert.doesNotMatch(source, /kick\("backup-run",\s*\{\s*action:\s*"tick"\s*\}\s*,\s*secret\s*\)\s*;\s*\n\s*return \{ ok: true, runId, phase/);
  // The door: an advance is the machinery's, never an Admin's.
  assert.match(source, /if \(action === "advance"\)[\s\S]{0,200}caller\.internal/);
  // And the exemption is addressed at that run, not at whatever is running.
  assert.match(source, /!\(chained && String\(run\.id\) === runId\) && sliceLooksAlive/);
  // What that exemption rests on is idempotent units, and the comment above
  // it has to say so: the conditional claim cannot be the answer, because
  // two slices of a run that is already `running` both match `status =
  // running` and both take it.
  const why = source.slice(
    source.indexOf("// The exemption is addressed at this run"),
    source.indexOf("async function advanceById")
  );
  assert.ok(why, "the comment that explains the exemption is still there");
  assert.doesNotMatch(why, /claims the run conditionally on the status it was read at/);
  assert.match(why, /idempotent/);
});

test("a restore waiting on its safety backup is tended by whichever slice moved the copy", () => {
  const source = read("supabase/functions/backup-run/index.ts");
  // While the safety copy is the run in flight the tick never reaches its
  // forward-to-a-restore branch — it returns after advancing its own kind —
  // so the restore waiting on that copy would look dead for as long as the
  // copy took. The tick therefore tends it: the restore is found by the
  // safety run's own id on its cursor.
  assert.match(source, /async function tendWaitingRestore\(/);
  assert.match(source, /safetyRunId/);
  assert.match(source, /String\(safety\.kind\) !== "before_restore"/);
  // And when the copy is finished the restore is kicked rather than left
  // for the next cron tick five minutes away.
  assert.match(source, /kick\("backup-restore",\s*\{\s*action:\s*"advance",\s*runId:[^}]*chain:\s*true\s*\}/);
  // The tick is not the only thing that moves a safety copy: the copy's own
  // chain, and the restore's kick that starts it, both come through
  // advanceById. A copy finished there with nobody tending it left the
  // restore waiting for the cron — for ever on a project that has none.
  const byId = source.slice(
    source.indexOf("async function advanceById"),
    source.indexOf("async function queueRun")
  );
  assert.match(byId, /await tend\(db, run, secret\);/,
    "the chain pays the same courtesy the tick does");
  assert.equal((source.match(/await tend\(/g) ?? []).length, 4,
    "the tick's three branches and the chain");
});

test("a slice that matched no row has lost the run and must stop writing", () => {
  // PostgREST answers a conditional update with the rows it matched, and the
  // shape of that answer is what says whether this slice still holds the run:
  // a `.select("id")` on an update that matched nothing comes back as an
  // empty array, and the slice reading it was superseded while it hung.
  assert.equal(stillHoldsRun([{ id: "r1" }]), true);
});

test("a gateway page is named plainly, and anything else keeps its own words", () => {
  // The whole message supabase-js hands back when Cloudflare answers for
  // Supabase's API: the digest mailed this HTML to the office once.
  const page = "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>cloudflare</center>\r\n</body>\r\n</html>\r\n";
  assert.equal(gatewayRefusal(page), "Supabase's API answered 502 Bad Gateway — a passing outage at the edge, not the backup");
  assert.match(gatewayRefusal("<html><head><title>504 Gateway Time-out</title></head></html>"), /504 Gateway Time-out/);
  // A real refusal, a JSON error, or words that merely mention a number
  // are not a gateway page and must reach the log as themselves.
  assert.equal(gatewayRefusal("permission denied for table backup_runs"), null);
  assert.equal(gatewayRefusal("Drive answered 502 for the upload"), null);
  assert.equal(gatewayRefusal("<html><title>404 Not Found</title></html>"), null);
  assert.equal(gatewayRefusal(""), null);
  assert.equal(stillHoldsRun({ id: "r1" }), true, "maybeSingle answers with the row itself");
  assert.equal(stillHoldsRun([]), false, "no row matched: another slice owns this run now");
  assert.equal(stillHoldsRun(null), false);
  assert.equal(stillHoldsRun(undefined), false, "a client that returned no data is not a match");
});

test("every write a slice makes to its own run is conditional on still holding it", () => {
  // Reclaiming a run whose heartbeat went quiet has no compare-and-swap on
  // purpose — a CAS on a timestamptz that failed to match would wedge the
  // schedule for ever — so the slice that was superseded is the one that has
  // to notice. It notices by writing conditionally: a slice hung inside one
  // unit past SLICE_ALIVE_MS, reclaimed and then waking after the run had
  // finished, would otherwise write its stale cursor over a complete run, and
  // its throw on the way out would mark that run failed. A filter on an
  // update is not something a pure function can hold, so the function itself
  // is read back.
  const src = read("supabase/functions/backup-run/index.ts");
  const updates = src.split('.from("backup_runs")').slice(1)
    .filter(rest => rest.trimStart().startsWith(".update("))
    .map(rest => rest.slice(0, rest.indexOf(";")));
  assert.equal(updates.length, 8, "claim, the folder, the cursor after every unit, the completion, " +
    "the failure, the heartbeat the tick keeps for a restore waiting on its safety copy, " +
    "and the file check's own cursor write and completion");
  for (const statement of updates) {
    assert.match(statement, /\.eq\("status",/,
      `a write to backup_runs with no status guard: ${statement.replace(/\s+/g, " ").slice(0, 140)}`);
  }
  // The guard is only half of it: the three writes that carry on afterwards
  // have to read the match back and stop when there is none.
  // — the cursor write, the completion and the failure; the folder write,
  // which status alone cannot tell a reclaim from; and the clock move on
  // app_settings, which is the claim on a scheduled run.
  assert.equal((src.match(/stillHoldsRun\(/g) ?? []).length, 8,
    "the cursor write, the completion, the failure, the folder write, the two clock moves, " +
    "and the file check's cursor write and completion each check what they matched");
  // Two slices both believe "running" after a reclaim, so the folder write
  // needs the one condition that tells them apart: no folder yet.
  assert.match(src, /\.update\(\{\s*folder_id: folderId,\s*folder_name: name\s*\}\)[\s\S]{0,160}\.is\("folder_id",\s*null\)/,
    "the folder write is conditional on folder_id still being null");
  assert.match(src, /if \(!folderId\)\s*return \{\s*ok: true,\s*runId,\s*superseded: true\s*\};/,
    "a slice that lost the folder stops");
  // The loser must not delete the folder the winner recorded: ensureFolder
  // is find-or-create by name, so two slices in one minute hold one id.
  assert.match(src, /String\(owner\.folder_id \?\? ""\) === folderId\) return null;/,
    "the stray-folder delete is skipped when the winner holds the same folder");
  // The clock moves only for the tick that read the due time it replaces.
  assert.match(src, /\.eq\("backup_next_run_at", s\.backup_next_run_at\)\.select\("id"\)/,
    "the clock move is conditional on the due time the tick read");
  assert.match(src, /if \(!stillHoldsRun\(held\)\) return \{ ok: true, runId, superseded: true \};/,
    "a superseded slice returns rather than carrying on round the loop");
});

test("the kick is held open by the runtime rather than left to be reaped", () => {
  // kick() fires a request and the handler returns; an isolate with nothing
  // left to answer can be torn down before that request has gone anywhere.
  // Deno's edge runtime keeps the isolate alive for a promise handed to
  // EdgeRuntime.waitUntil, and the fallback where there is no such global is
  // the fire-and-forget it always was. backupCommon.ts imports supabase-js
  // and reads the environment, so it cannot be imported here — it is read.
  const src = read("supabase/functions/_shared/backupCommon.ts");
  assert.match(src, /const sent = fetch\(/, "the kick's promise has to be held to be handed over");
  assert.match(src, /edge\.waitUntil\(sent\)/);
  assert.match(src, /typeof edge\.waitUntil === "function"/,
    "a runtime without waitUntil falls back rather than throwing");
  assert.match(src, /cron is the backstop/i, "why a lost kick is survivable has to stay written down");
});

test("only the flag on a drive's refusal earns a retry", () => {
  const busy = Object.assign(new Error("Uploading failed (429): slow down"), { status: 429, retryable: true });
  const refused = Object.assign(new Error("Uploading failed (403): no"), { status: 403, retryable: false });
  assert.equal(isRetryable(busy), true);
  // Prose is not evidence: a 403 whose body happens to say "try again" is
  // still an answer.
  assert.equal(isRetryable(refused), false);
  assert.equal(isRetryable(new Error("Failed to fetch")), false);
  assert.equal(shouldRetry(busy, 0), true);
  assert.equal(shouldRetry(busy, RETRIES - 1), true);
  // The last attempt is the last: three goes over, then the run fails.
  assert.equal(shouldRetry(busy, RETRIES), false);
  assert.equal(shouldRetry(refused, 0), false);
  assert.deepEqual([0, 1, 2, 9].map(retryDelayMs), [BACKOFF_MS[0], BACKOFF_MS[1], BACKOFF_MS[2], BACKOFF_MS[2]]);
  // Every retry of a unit has to fit inside a slice with room to spare.
  assert.ok(BACKOFF_MS.reduce((a, b) => a + b, 0) < BUDGET_MS / 2);
});

test("the token endpoint gets one more kind of second chance than a drive does", () => {
  // connectDrive's refresh is the first call of every slice, so a token
  // endpoint having a bad second used to fail a restore between the wipe
  // and the load. It retries on the drive's own flag, and on a reply that
  // never arrived at all — fetch throws a TypeError with no status on it.
  const busy = Object.assign(new Error("token refresh failed (503): busy"), { status: 503, retryable: true });
  const dropped = new TypeError("error sending request for url");
  const badGrant = Object.assign(new Error("token refresh failed (400): invalid_grant"),
    { status: 400, retryable: false });

  assert.equal(worthAnotherGo(busy), true);
  assert.equal(worthAnotherGo(dropped), true);
  // An invalid_grant is an answer: the Admin has to reconnect, and three
  // goes at it only delay saying so.
  assert.equal(worthAnotherGo(badGrant), false);
  // And a refusal the module raised itself — "sent no refresh token" — is
  // not a network failure just because it has no status on it.
  assert.equal(worthAnotherGo(new Error("dropbox refused to refresh the connection.")), false);
  assert.equal(worthAnotherGo(null), false);
});

test("a passing edge error is transient; a real refusal is not", () => {
  // The one that lost a night's backup: a conditional write to backup_runs
  // whose socket was reset mid-flight. fetch throws a TypeError with no status.
  const reset = new TypeError("error sending request from 10.32.165.66:43062 for " +
    "https://x.supabase.co/rest/v1/backup_runs?id=eq.abc&status=eq.running&select=id " +
    "(104.18.38.10:443): client error (SendRequest): connection error: connection reset");
  assert.equal(isTransientEdgeError(reset), true);
  // The gateway blips that followed it, in both shapes the edge answers them:
  // the HTML page supabase-js hands back whole, and the bare phrase.
  assert.equal(isTransientEdgeError(new Error("<html><head><title>502 Bad Gateway</title></head></html>")), true);
  assert.equal(isTransientEdgeError(new Error("Gateway Timeout")), true);
  // A flagged 429 from the drive is worth another go too — worthAnotherGo says so.
  assert.equal(isTransientEdgeError(Object.assign(new Error("429: slow down"), { status: 429, retryable: true })), true);
  // A real answer must still fail the run: a permission refusal, a drive 5xx
  // named as the drive's (not a Supabase gateway page), and empty/null.
  assert.equal(isTransientEdgeError(new Error("permission denied for table backup_runs")), false);
  assert.equal(isTransientEdgeError(new Error("Drive answered 502 for the upload")), false);
  assert.equal(isTransientEdgeError(null), false);
});

test("a run is left for reclaim only while it is young enough to still finish", () => {
  const now = 10_000_000_000;
  // A blip a minute into the run: keep it, the next tick resumes it.
  assert.equal(withinRetryWindow(now - 60_000, now), true);
  // Still failing hours later past the ceiling: fail it for good rather than
  // wedge the schedule — and the ceiling is under a day, so tomorrow's backup
  // is never blocked by a run that could not finish today.
  assert.equal(withinRetryWindow(now - (RUN_RETRY_WINDOW_MS + 1), now), false);
  assert.ok(RUN_RETRY_WINDOW_MS < 24 * 60 * 60 * 1000, "the ceiling clears before the next daily run is due");
  // No timestamp yet — a transient failure at the very first slice, before the
  // claim wrote started_at — reads as just-started, so it is kept, not failed.
  assert.equal(withinRetryWindow(NaN, now), true);
});

test("a transient edge blip mid-slice leaves the run for the next tick, not failed", () => {
  // The reclaim path (a stale heartbeat is picked up and the cursor resumed)
  // only rescues a run still marked running. So the slice's catch must not turn
  // a passing network blip into a terminal failure — that is exactly what threw
  // a night's backup away. A real error still fails, on the else path.
  const src = read("supabase/functions/backup-run/index.ts");
  assert.match(src, /if \(isTransientEdgeError\(e\) && withinRetryWindow\(/,
    "the catch asks whether the error is a passing edge blip and the run is still young");
  assert.match(src, /transient: true/, "a transient blip returns rather than failing the run");
  assert.match(src, /return await fail\(db, runId, \(e as Error\)\.message, guard\);/,
    "a real error still fails the run");
});

test("connectDrive's refresh is under the same three goes as everything else", () => {
  // backupCommon.ts is Deno-only, so this is read rather than imported.
  const src = read("supabase/functions/_shared/backupCommon.ts");
  assert.match(src, /refreshWithRetry\(provider, clientId, clientSecret, refresh\)/,
    "the refresh has to go through the retry, not straight at the network");
  assert.match(src, /worthAnotherGo\(e\)/, "and it asks the same question the run's own retry asks");
  assert.match(src, /attempt <= RETRIES/, "the same three goes");
  assert.match(src, /retryDelayMs\(attempt\)/, "with the same widening gaps");
});

// ── The cursor: tables ───────────────────────────────────────────────────

test("a table that is not finished continues from the key the walk reached", () => {
  let c = newRunCursor("2026-09-05T02:00:00.000Z");
  c = afterTablePart(c, {
    table: "tickets", tableCount: 3, rows: 25000, partName: "tickets.01.json.gz",
    exhausted: false, lastKey: "abc-999", offset: 25000
  });
  assert.equal(c.phase, "tables");
  assert.equal(c.tableIndex, 0, "the same table continues");
  assert.equal(c.partIndex, 1);
  assert.equal(c.lastKey, "abc-999");
  assert.equal(c.offset, 25000);
  assert.equal(c.rows.tickets, 25000);
  assert.deepEqual(c.parts.tickets, ["tickets.01.json.gz"]);

  // The second part adds to the count rather than replacing it, and the
  // parts list keeps both names — the restore reads them in that order.
  c = afterTablePart(c, {
    table: "tickets", tableCount: 3, rows: 400, partName: "tickets.02.json.gz",
    exhausted: true, lastKey: null, offset: 0
  });
  assert.equal(c.rows.tickets, 25400);
  assert.deepEqual(c.parts.tickets, ["tickets.01.json.gz", "tickets.02.json.gz"]);
  assert.equal(c.tableIndex, 1, "an exhausted table moves to the next one");
  assert.equal(c.partIndex, 0);
  assert.equal(c.lastKey, null);
  assert.equal(c.offset, 0);
  assert.equal(c.phase, "tables");
});

test("the last table hands the run to the files phase", () => {
  let c = newRunCursor("2026-09-05T02:00:00.000Z");
  c.tableIndex = 2;
  c = afterTablePart(c, {
    table: "app_settings", tableCount: 3, rows: 1, partName: "app_settings.01.json.gz",
    exhausted: true, lastKey: null, offset: 0
  });
  assert.equal(c.tableIndex, 3);
  assert.equal(c.phase, "files");
});

test("an empty table is still a part, so the manifest can say zero", () => {
  let c = newRunCursor("2026-09-05T02:00:00.000Z");
  c = afterTablePart(c, {
    table: "burned_ticket_numbers", tableCount: 5, rows: 0, partName: "burned_ticket_numbers.01.json.gz",
    exhausted: true, lastKey: null, offset: 0
  });
  assert.equal(c.rows.burned_ticket_numbers, 0);
  assert.deepEqual(c.parts.burned_ticket_numbers, ["burned_ticket_numbers.01.json.gz"]);
});

test("the jobs index is folded out of the rows the tables phase reads", () => {
  let c = newRunCursor("2026-09-05T02:00:00.000Z");
  c = foldIntoIndex(c, "clients", [{ id: "c1", name: "Pembina", address: "unused" }]);
  c = foldIntoIndex(c, "jobs", [{
    id: "j1", job_number: "25-1001", project: "Wapiti tie-in", status: "Open",
    created_at: "2026-08-01T00:00:00Z", client_id: "c1", notes: "unused"
  }]);
  c = foldIntoIndex(c, "tickets", [{ id: "t1", job_id: "j1", total: 123456 }, { id: "t2", job_id: "j1" }]);
  c = foldIntoIndex(c, "jhas", [{ id: "h1", job_id: "j1" }]);
  c = foldIntoIndex(c, "reports", [{ id: "r1", job_id: "j1" }]);
  // A table that is not one of the five leaves the index alone.
  c = foldIntoIndex(c, "chat_messages", [{ id: "m1", body: "hello" }]);

  assert.equal(c.index.clients.length, 1);
  assert.deepEqual(c.index.clients[0], { id: "c1", name: "Pembina" });
  // Only the columns the index shows: the rest would put the whole database
  // in the cursor.
  assert.deepEqual(Object.keys(c.index.jobs[0]).sort(),
    ["client_id", "created_at", "id", "job_number", "project", "status"]);
  assert.deepEqual(c.index.tickets, [{ job_id: "j1" }, { job_id: "j1" }]);

  const built = jobsIndex(c.index);
  assert.equal(built.length, 1);
  assert.equal(built[0].client, "Pembina");
  assert.equal(built[0].tickets, 2);
  assert.equal(built[0].jhas, 1);
  assert.equal(built[0].reports, 1);

  c = forgetIndex(c);
  assert.deepEqual(c.index, { jobs: [], clients: [], tickets: [], jhas: [], reports: [] });
});

// ── The cursor: files ────────────────────────────────────────────────────

test("a bucket is walked depth first and the stack says where it got to", () => {
  let c = newRunCursor("2026-09-05T02:00:00.000Z");
  c.phase = "files";

  const top = startPrefixWalk(c);
  assert.deepEqual(top, { prefix: "", offset: 0 });

  // A short page at the root, with two sub-folders on it: the root is
  // finished and its folders go on the stack.
  c = afterFilesPage(c, {
    bucketCount: 2, pageLength: 3, pageRows: 1000,
    folderNames: ["j-1", "j-2"], files: 1, bytes: 2048
  });
  assert.deepEqual(c.prefixes, [{ prefix: "j-1/", offset: 0 }, { prefix: "j-2/", offset: 0 }]);
  assert.equal(c.files, 1);
  assert.equal(c.bytes, 2048);
  assert.equal(c.bucketIndex, 0, "the bucket is not done while its folders are on the stack");

  // j-2 is the top of the stack and comes first; a full page leaves it there
  // with its offset advanced, so the next listing carries on rather than
  // repeating.
  c = afterFilesPage(c, { bucketCount: 2, pageLength: 1000, pageRows: 1000, folderNames: [], files: 1000, bytes: 1000 });
  assert.deepEqual(c.prefixes[c.prefixes.length - 1], { prefix: "j-2/", offset: 1000 });
  c = afterFilesPage(c, { bucketCount: 2, pageLength: 4, pageRows: 1000, folderNames: [], files: 4, bytes: 40 });
  assert.deepEqual(c.prefixes, [{ prefix: "j-1/", offset: 0 }]);

  // The last prefix empties the stack, which is what ends the bucket.
  c = afterFilesPage(c, { bucketCount: 2, pageLength: 1, pageRows: 1000, folderNames: [], files: 1, bytes: 10 });
  assert.deepEqual(c.prefixes, []);
  assert.equal(c.bucketIndex, 1);
  assert.equal(c.phase, "files", "there is another bucket to do");

  // The next bucket starts its own walk at its own root.
  const next = startPrefixWalk(c);
  assert.deepEqual(next, { prefix: "", offset: 0 });
  c = afterFilesPage(c, { bucketCount: 2, pageLength: 0, pageRows: 1000, folderNames: [], files: 0, bytes: 0 });
  assert.equal(c.bucketIndex, 2);
  assert.equal(c.phase, "manifest", "the last bucket hands the run to the manifest");
});

test("a page cut short by the budget resumes where it stopped", () => {
  let c = newRunCursor("2026-09-05T02:00:00.000Z");
  c.phase = "files";
  startPrefixWalk(c);

  c = pausePage(c, 7, 7, 700);
  assert.equal(c.pageDone, 7);
  assert.equal(c.files, 7);
  assert.equal(c.bytes, 700);
  // Nothing else moved: the same page is listed again at the same offset,
  // and the first seven objects are skipped rather than uploaded twice.
  assert.deepEqual(c.prefixes, [{ prefix: "", offset: 0 }]);
  assert.equal(c.bucketIndex, 0);

  // Finishing that page clears the marker, and only the objects done in
  // this second half are added.
  c = afterFilesPage(c, { bucketCount: 1, pageLength: 12, pageRows: 1000, folderNames: [], files: 5, bytes: 500 });
  assert.equal(c.pageDone, 0);
  assert.equal(c.files, 12);
  assert.equal(c.bytes, 1200);
});

// ── Reading a cursor back out of the database ────────────────────────────

test("a cursor read back out of jsonb is filled in rather than trusted", () => {
  const c = reviveCursor({
    phase: "files", bucketIndex: 1, files: 40, bytes: 900,
    prefixes: [{ prefix: "j-1/", offset: 1000 }],
    rows: { jobs: 12 }, parts: { jobs: ["jobs.01.json.gz"] },
    startedAt: "2026-09-05T02:00:00.000Z"
  }, "2026-09-05T09:00:00.000Z");
  assert.equal(c.phase, "files");
  assert.equal(c.startedAt, "2026-09-05T02:00:00.000Z", "the run's own start, not this slice's");
  assert.deepEqual(c.prefixes, [{ prefix: "j-1/", offset: 1000 }]);
  assert.equal(c.rows.jobs, 12);
  // Everything the writing slice did not have is present and harmless.
  assert.deepEqual(c.index, { jobs: [], clients: [], tickets: [], jhas: [], reports: [] });
  assert.equal(c.tableIndex, 0);
  assert.equal(c.lastKey, null);
  assert.equal(c.pageDone, 0);

  // An empty cursor — a run that has only just been queued — is a fresh one.
  const fresh = reviveCursor(null, "2026-09-05T09:00:00.000Z");
  assert.deepEqual(fresh, newRunCursor("2026-09-05T09:00:00.000Z"));
  assert.deepEqual(reviveCursor({}, "2026-09-05T09:00:00.000Z"), fresh);
});

test("the counts the panel shows are the cursor's own", () => {
  let c = newRunCursor("2026-09-05T02:00:00.000Z");
  c = afterTablePart(c, { table: "jobs", tableCount: 2, rows: 120, partName: "jobs.01.json.gz", exhausted: true, lastKey: null, offset: 0 });
  c = afterTablePart(c, { table: "tickets", tableCount: 2, rows: 340, partName: "tickets.01.json.gz", exhausted: true, lastKey: null, offset: 0 });
  c.files = 9;
  c.bytes = 12345;
  const counts = countsOf(c);
  assert.deepEqual(counts.rows, { jobs: 120, tickets: 340 });
  assert.equal(counts.files, 9);
  assert.equal(totalRows(counts), 460);
  // A run with nothing recorded yet counts zero rather than throwing.
  assert.equal(totalRows(null), 0);
  assert.equal(totalRows({}), 0);
});

test("a file is hashed the way the index and a restore will compare it", async () => {
  // The SHA-256 of "abc", as every reference implementation prints it.
  assert.equal(await hashBytes(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(await hashBytes(new Uint8Array(0)),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("the file index reads back only records that carry a hash", () => {
  const good = "b".repeat(64);
  const rows = [
    { name: "reports%2Fa.pdf", bucket: "reports", key: "a.pdf", size: 10, sha256: good, reused: true },
    { name: "reports%2Fb.pdf", bucket: "reports", key: "b.pdf", size: 11, sha256: null },
    { name: "reports%2Fc.pdf", bucket: "reports", key: "c.pdf", size: 12, sha256: "not a hash" },
    { name: "", bucket: "reports", key: "d.pdf", size: 13, sha256: good }
  ];
  const index = parseFileIndex(JSON.stringify(rows));
  assert.deepEqual([...index.keys()], ["reports%2Fa.pdf"]);
  assert.equal(index.get("reports%2Fa.pdf").reused, true);
  // Not JSON, or not an array: an empty index, never a throw — a folder
  // whose index cannot be read is read through, not failed.
  assert.equal(parseFileIndex("<html>").size, 0);
  assert.equal(parseFileIndex("{}").size, 0);
  assert.equal(FILES_INDEX_NAME, "files.json.gz");
});

test("the manifest records how many files are hashed, where, and the spot check", () => {
  let m = newManifest("0.92-beta 2", "20260908141656", "2026-09-08T06:00:00Z");
  m = recordFiles(m, 25, 6054632, 7);
  m = recordFileIndex(m, 25, "files.json.gz", "ok: reports%2FS-10113%2Fx.pdf");
  assert.deepEqual(m.files, { count: 25, bytes: 6054632, reused: 7, hashed: 25, index: "files.json.gz", spot: "ok: reports%2FS-10113%2Fx.pdf" });
  // recordFiles after it keeps the index fields: it adds, never resets.
  m = recordFiles(m, 1, 100, 0);
  assert.equal(m.files.hashed, 25);
  assert.equal(m.files.count, 26);
});

test("a file check's cursor starts empty, revives from jsonb, and its counts read as the panel needs", () => {
  assert.equal(VERIFY_KIND, "verify");
  const fresh = newVerifyCursor("2026-09-09T07:00:00Z");
  assert.equal(fresh.folderId, null);
  assert.equal(fresh.offset, 0);
  assert.equal(fresh.done, false);
  // Read back with gaps and the wrong types: filled in, never trusted.
  const c = reviveVerifyCursor({ folderId: "f1", folderName: "2026-09-08 00-00", backupRunId: "r1", offset: "12", verified: 10, repaired: 2, notes: ["a"], indexDirty: true }, "2026-09-09T07:00:00Z");
  assert.equal(c.offset, 12);
  assert.equal(c.unrepairable, 0);
  assert.equal(c.indexDirty, true);
  assert.deepEqual(c.notes, ["a"]);
  const counts = verifyCounts(c);
  assert.equal(counts.files, 12, "files is every file the check looked at, the way every other kind counts");
  assert.equal(counts.verified, 10);
  assert.equal(counts.repaired, 2);
  assert.equal(counts.unrepairable, 0);
  assert.equal(counts.folder, "2026-09-08 00-00");
  assert.deepEqual(counts.rows, {}, "no records: the row's record count reads zero, not NaN");
});

test("a file check's notes are capped, and the cap says so once", () => {
  const c = newVerifyCursor("2026-09-09T07:00:00Z");
  for (let i = 0; i < MAX_VERIFY_NOTES + 5; i++) addVerifyNote(c, "reports/x" + i + ".pdf was re-stored");
  assert.equal(c.notes.length, MAX_VERIFY_NOTES + 1);
  assert.match(c.notes[MAX_VERIFY_NOTES], /and more/);
});

test("the next file check is a whole number of days on, fourteen when the setting is nonsense", () => {
  const now = Date.parse("2026-09-09T07:00:00Z");
  assert.equal(nextVerifyAt(now, 14), "2026-09-23T07:00:00.000Z");
  assert.equal(nextVerifyAt(now, 7), "2026-09-16T07:00:00.000Z");
  assert.equal(nextVerifyAt(now, 0), "2026-09-23T07:00:00.000Z");
  assert.equal(nextVerifyAt(now, NaN), "2026-09-23T07:00:00.000Z");
});
