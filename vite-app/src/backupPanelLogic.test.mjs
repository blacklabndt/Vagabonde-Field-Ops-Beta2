// The backup panel's arithmetic, away from React. Three small questions get
// asked on that screen and each of them has a wrong answer that costs
// something real: the redirect URI has to be the same string the provider's
// registration holds or the connection dies at the door; a blank secret box
// has to mean "keep the one you have" rather than "erase it"; and the
// ?backup=… the drive sends the browser home with has to be read once and
// then taken off the address bar.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BACKUP_PROVIDERS, PROVIDER_LABEL,
  redirectUriFor, backupSettingsPatch, readBackupOutcome, cleanClientId,
  BEFORE_RESTORE_PREFIX, isBeforeRestore, restoreNameMatches, failedRunAdvice,
  keepToSave, keepPhrase, runRows, runFiles, runBytes, sizeTrend, verifySentence, verifyNotes } from "./backupPanelLogic.js";

// ── The redirect URI ─────────────────────────────────────────────────────

test("the redirect URI is the stored app address plus the provider", () => {
  const state = { approval_base_url: "https://ops.example.ca" };
  assert.equal(redirectUriFor(state, "google", "https://elsewhere"), "https://ops.example.ca/backup/oauth/google");
  assert.equal(redirectUriFor(state, "microsoft", "https://elsewhere"), "https://ops.example.ca/backup/oauth/microsoft");
  assert.equal(redirectUriFor(state, "dropbox", "https://elsewhere"), "https://ops.example.ca/backup/oauth/dropbox");
});

test("only the origin of the stored address counts — a path or a trailing slash is dropped", () => {
  assert.equal(
    redirectUriFor({ approval_base_url: "https://ops.example.ca/" }, "google", "https://x"),
    "https://ops.example.ca/backup/oauth/google"
  );
  assert.equal(
    redirectUriFor({ approval_base_url: "https://ops.example.ca/app?x=1" }, "google", "https://x"),
    "https://ops.example.ca/backup/oauth/google"
  );
});

test("with no address stored, this window's origin is the honest guess", () => {
  assert.equal(redirectUriFor({}, "google", "https://guess.example.ca"), "https://guess.example.ca/backup/oauth/google");
  assert.equal(redirectUriFor({ approval_base_url: "   " }, "google", "https://guess.example.ca"),
    "https://guess.example.ca/backup/oauth/google");
});

test("a stored address that isn't a URL falls back rather than throwing", () => {
  assert.equal(redirectUriFor({ approval_base_url: "ops.example.ca" }, "google", "https://guess.example.ca"),
    "https://guess.example.ca/backup/oauth/google");
});

test("the three providers, and each with a name a person would recognise", () => {
  assert.deepEqual(BACKUP_PROVIDERS, ["google", "microsoft", "dropbox"]);
  assert.deepEqual(BACKUP_PROVIDERS.map(p => PROVIDER_LABEL[p]), ["Google Drive", "OneDrive", "Dropbox"]);
});

// ── The saved settings ───────────────────────────────────────────────────

const FORM = {
  frequency: "weekly", weekday: 3, hour: 2, keep: 14,
  clientIdGoogle: "", clientSecretGoogle: "",
  clientIdMicrosoft: "", clientSecretMicrosoft: "",
  clientIdDropbox: "", clientSecretDropbox: ""
};

test("a blank secret box leaves the stored secret alone — the column is not in the patch at all", () => {
  const patch = backupSettingsPatch(FORM, Date.parse("2026-09-05T12:00:00Z"));
  assert.ok(!("backup_client_secret_google" in patch));
  assert.ok(!("backup_client_secret_microsoft" in patch));
  assert.ok(!("backup_client_secret_dropbox" in patch));
});

test("a typed secret is written, trimmed", () => {
  const patch = backupSettingsPatch({ ...FORM, clientSecretGoogle: "  s3cr3t  " }, 0);
  assert.equal(patch.backup_client_secret_google, "s3cr3t");
  assert.ok(!("backup_client_secret_dropbox" in patch));
});

test("whitespace alone is still blank — it does not erase a stored secret", () => {
  const patch = backupSettingsPatch({ ...FORM, clientSecretDropbox: "   " }, 0);
  assert.ok(!("backup_client_secret_dropbox" in patch));
});

test("client IDs are trimmed, and an emptied box does clear the column", () => {
  const patch = backupSettingsPatch({ ...FORM, clientIdGoogle: " abc.apps ", clientIdDropbox: "" }, 0);
  assert.equal(patch.backup_client_id_google, "abc.apps");
  assert.equal(patch.backup_client_id_dropbox, null);
});

test("the schedule is clamped to what the database's own checks allow", () => {
  const patch = backupSettingsPatch({ ...FORM, frequency: "hourly", weekday: 99, hour: -4, keep: 9000 }, 0);
  assert.equal(patch.backup_frequency, "daily");
  assert.equal(patch.backup_weekday, 6);
  assert.equal(patch.backup_hour, 0);
  assert.equal(patch.backup_keep, 365);
});

test("nonsense in the number boxes lands on the defaults rather than on NaN", () => {
  const patch = backupSettingsPatch({ ...FORM, weekday: "", hour: "abc", keep: null }, 0);
  assert.equal(patch.backup_weekday, 0);
  assert.equal(patch.backup_hour, 0);
  assert.equal(patch.backup_keep, 14);
});

test("the sentence under the keep box says the number the save would write", () => {
  // The box and the save are read through the same clamp, so the three
  // cases that used to disagree cannot any more.
  assert.equal(keepToSave(""), 14);
  assert.equal(keepToSave("0"), 1);
  assert.equal(keepToSave("9000"), 365);
  assert.equal(keepToSave("30"), 30);
  for (const typed of ["", "0", "9000", "30"]) {
    assert.equal(backupSettingsPatch({ ...FORM, keep: typed }, 0).backup_keep, keepToSave(typed));
  }
});

test("one kept backup is “the most recent one”, not “the 1 most recents”", () => {
  assert.equal(keepPhrase(1), "the most recent one");
  assert.equal(keepPhrase(14), "the 14 most recent");
  assert.equal(keepPhrase(""), "the 14 most recent");
  assert.equal(keepPhrase("0"), "the most recent one");
});

test("the four frequencies the schedule knows all survive", () => {
  for (const f of ["daily", "weekdays", "weekly", "monthly"]) {
    assert.equal(backupSettingsPatch({ ...FORM, frequency: f }, 0).backup_frequency, f);
  }
});

test("the next run is only worked out once there is a drive to run to", () => {
  const now = Date.parse("2026-09-05T12:00:00Z");
  assert.ok(!("backup_next_run_at" in backupSettingsPatch({ ...FORM, connected: false }, now)));
  const patch = backupSettingsPatch({ ...FORM, connected: true }, now);
  assert.equal(typeof patch.backup_next_run_at, "string");
  assert.ok(Date.parse(patch.backup_next_run_at) > now);
});

test("the patch names the one row and stamps it", () => {
  const patch = backupSettingsPatch(FORM, Date.parse("2026-09-05T12:00:00Z"));
  assert.equal(patch.id, true);
  assert.equal(patch.updated_at, "2026-09-05T12:00:00.000Z");
});

test("the patch never carries a refresh token, an account or a provider — those are the callback's", () => {
  const patch = backupSettingsPatch({ ...FORM, backup_refresh_token: "x", provider: "google" }, 0);
  for (const key of ["backup_refresh_token", "backup_provider", "backup_account", "backup_root_folder_id"]) {
    assert.ok(!(key in patch), `${key} must not be writable from the browser's save`);
  }
});

// ── Coming back from the consent screen ──────────────────────────────────

test("a connected callback is read, and the query it came home with is taken off", () => {
  const out = readBackupOutcome("?backup=connected");
  assert.equal(out.outcome, "connected");
  assert.equal(out.why, "");
  assert.equal(out.rest, "");
});

test("a refusal carries the function's own words", () => {
  const out = readBackupOutcome("?backup=failed&why=That%20connection%20took%20more%20than%20ten%20minutes.");
  assert.equal(out.outcome, "failed");
  assert.equal(out.why, "That connection took more than ten minutes.");
});

test("a cancelled consent screen is not an error", () => {
  assert.equal(readBackupOutcome("?backup=denied").outcome, "denied");
});

test("anything else on the address bar is left where it was", () => {
  const out = readBackupOutcome("?job=S-1234&backup=connected&why=x&tab=home");
  assert.equal(out.outcome, "connected");
  assert.equal(out.rest, "job=S-1234&tab=home");
});

test("no backup query at all means there is nothing to say", () => {
  assert.equal(readBackupOutcome("").outcome, "");
  assert.equal(readBackupOutcome("?job=S-1234").outcome, "");
});

test("an outcome word we don't know is treated as a failure, not as success", () => {
  const out = readBackupOutcome("?backup=sideways");
  assert.equal(out.outcome, "failed");
});

// ── The one thing about the panel itself that can be read off the source ──
// The component needs a browser to run, but the mistake this guards against
// is visible in the text: the reason a connection failed was put in the same
// state that the settings read clears the instant it succeeds — and that read
// is started by the very effect that wrote the reason. The Admin was left
// looking at "No drive connected." with nothing said about why.

test("the reason a connection failed survives the reload that follows it", () => {
  const src = readFileSync(new URL("./components/backupPanel.jsx", import.meta.url), "utf8");
  // The outcome has a state of its own…
  assert.match(src, /const \[outcomeError, setOutcomeError\] = useState\(""\)/);
  // …the callback's failure is written to it…
  assert.match(src, /else setOutcomeError\(why \|\|/);
  // …it is rendered…
  assert.ok(src.includes("<ErrorBox>{outcomeError}</ErrorBox>"), "the outcome must be on the screen");
  // …and nothing inside load() may clear it: load's success handler ends with
  // setError(""), which is exactly what swallowed the reason before.
  const load = /const load = useCallback\(\([^)]*\) => \{([\s\S]*?)\n  \}, \[\]\);/.exec(src);
  assert.ok(load, "load() should still be a useCallback with no dependencies");
  assert.ok(!load[1].includes("setOutcomeError"), "load() must never clear the callback's own message");
});

// The same trick, for the same kind of mistake one screen further on: the
// settings read is now on a timer while a run is in flight, and it used to
// refill the schedule boxes every time it succeeded. That would rewrite what
// the Admin is halfway through typing, every few seconds, from the server.
// The boxes are filled once at load and again by a Save, and nowhere else.
test("a refresh of the backup state does not rewrite the schedule boxes", () => {
  const src = readFileSync(new URL("./components/backupPanel.jsx", import.meta.url), "utf8");
  const load = /const load = useCallback\(\(([^)]*)\) => \{([\s\S]*?)\n  \}, \[\]\);/.exec(src);
  assert.ok(load, "load() should still be a useCallback with no dependencies");
  assert.match(load[1], /seed/, "load() takes a flag saying whether to refill the form");
  // Every setForm in load() has to be inside the seed block, not merely one
  // of them: an unconditional one above it would rewrite the boxes again.
  const seedBlock = /if \(seed\) \{([\s\S]*?)\n {8}\}/.exec(load[2]);
  assert.ok(seedBlock, "load() must still guard its form fill with the seed flag");
  const inSeed = (seedBlock[1].match(/setForm\(/g) || []).length;
  // At least one, or the boxes are never filled at all — the count match
  // alone is satisfied by there being no setForm anywhere in load().
  assert.ok(inSeed > 0, "the seed block must still fill the form");
  assert.equal((load[2].match(/setForm\(/g) || []).length, inSeed,
    "every setForm in load() must sit inside the seed block");
  // Exactly two callers seed: the mount effect and the save.
  assert.equal((src.match(/load\(true\)/g) || []).length, 2);
});

// ── The backups list, and the gate on the restore dialog ─────────────────

test("a before-restore copy is recognised by the same prefix the server writes", () => {
  // The two halves of this string live on either side of a network. If they
  // ever drift, the list stops labelling the one folder retention never
  // removes and nobody can tell why last Tuesday's backup is still there.
  const shared = readFileSync(new URL("../../supabase/functions/_shared/backupManifest.ts", import.meta.url), "utf8");
  assert.match(shared, new RegExp('BEFORE_RESTORE_PREFIX = "' + BEFORE_RESTORE_PREFIX + '"'));

  assert.equal(isBeforeRestore("before-restore 2026-09-05 02-00"), true);
  assert.equal(isBeforeRestore("2026-09-05 02-00"), false);
  assert.equal(isBeforeRestore(""), false);
  assert.equal(isBeforeRestore(null), false);
});

test("the restore is confirmed by the backup's own name, character for character", () => {
  assert.equal(restoreNameMatches("2026-09-05 02-00", "2026-09-05 02-00"), true);
  // A name copied off the screen brings a space with it.
  assert.equal(restoreNameMatches("  2026-09-05 02-00 ", "2026-09-05 02-00"), true);
  // The wrong night is the whole thing this gate is for.
  assert.equal(restoreNameMatches("2026-09-04 02-00", "2026-09-05 02-00"), false);
  assert.equal(restoreNameMatches("", "2026-09-05 02-00"), false);
  assert.equal(restoreNameMatches("", ""), false, "empty is never a confirmation");
  assert.equal(restoreNameMatches(undefined, undefined), false);
});

// ── What a failed run leaves behind ──────────────────────────────────────

test("a failed backup says the schedule carries it; a failed restore says where the app is", () => {
  // A backup that fails changes nothing, so the schedule is the whole
  // answer.
  assert.match(failedRunAdvice({ kind: "backup", counts: {} }), /next scheduled backup will still run/);
  assert.match(failedRunAdvice({ kind: "before_restore", counts: {} }), /next scheduled backup will still run/);
  assert.match(failedRunAdvice(null), /next scheduled backup will still run/);
});

test("a restore-all that failed after the wipe names both ways out", () => {
  // counts.safety is the copy taken automatically just before the wipe. It
  // is written the moment that copy completes, which is the moment before
  // the first delete — so a name on the run means the app was emptied.
  const after = failedRunAdvice({
    kind: "restore_all",
    counts: { safety: "before-restore 2026-09-05 0210" }
  });
  assert.match(after, /emptied/, "the state the app is actually in has to be said");
  assert.match(after, /carry on from where it stopped/, "one way out: press Restore again");
  assert.match(after, /before-restore 2026-09-05 0210/, "the other: the copy of what was here before");
  assert.doesNotMatch(after, /next scheduled backup/,
    "backing up an emptied app is not advice");
});

test("a restore-all that failed before the wipe says nothing has been changed", () => {
  for (const counts of [{}, { safety: null }, { safety: "" }]) {
    const before = failedRunAdvice({ kind: "restore_all", counts });
    assert.match(before, /stopped before the app was emptied/);
    assert.match(before, /nothing has been changed/);
    // Saying the app was emptied when it was not is the worse error of the
    // two, and it is the one that would send an Admin to restore a copy
    // over a database that never lost anything.
    assert.doesNotMatch(before, /was emptied before this failed/);
    assert.doesNotMatch(before, /before-restore/);
  }
});

test("a per-job restore that failed touched nothing else", () => {
  const jobs = failedRunAdvice({ kind: "restore_jobs", counts: { safety: null } });
  assert.match(jobs, /Nothing else in the app was touched/);
  assert.match(jobs, /Press Restore on those jobs again/);
  assert.doesNotMatch(jobs, /emptied/);
});

test("a Google client id pasted with the console's helper text is reduced to the id", () => {
  const id = "102343884541-abc123def456.apps.googleusercontent.com";
  assert.equal(cleanClientId("google", `${id}

Client ID
view or download the client`), id);
  assert.equal(cleanClientId("google", `  ${id}  `), id);
  // Something that is not an id at all is kept as typed, so the consent
  // request fails loudly with what was entered rather than silently with nothing.
  assert.equal(cleanClientId("google", "not-an-id"), "not-an-id");
  assert.equal(cleanClientId("google", ""), null);
  assert.equal(cleanClientId("microsoft", " 3f2b0a1c-1111-2222-3333-444444444444 "), "3f2b0a1c-1111-2222-3333-444444444444");
  const patch = backupSettingsPatch({ ...FORM, clientIdGoogle: `${id} view or download the client` }, 0);
  assert.equal(patch.backup_client_id_google, id);
});

// ── What a run wrote, and the line under the list ────────────────────────

test("a run's figures come out of counts, and a run with none reads as zero", () => {
  const counts = { rows: { jobs: 12, tickets: 300, ticket_lines: 4000 }, files: 88, bytes: 1234567 };
  assert.equal(runRows(counts), 4312);
  assert.equal(runFiles(counts), 88);
  assert.equal(runBytes(counts), 1234567);
  for (const empty of [null, undefined, {}, { rows: {} }]) {
    assert.equal(runRows(empty), 0);
    assert.equal(runFiles(empty), 0);
    assert.equal(runBytes(empty), 0);
  }
  // A row written by an older version, or a slice that died mid-write.
  assert.equal(runRows({ rows: { jobs: "12", tickets: null } }), 12);
});

const run = (kind, bytes, extra = {}) => ({
  id: `${kind}-${bytes}`, kind, status: "complete", folder_name: `${bytes}`,
  finished_at: "2026-09-05T08:00:00Z", counts: { rows: { jobs: 1 }, files: 1, bytes }, ...extra
});

test("one run is not a trend", () => {
  assert.equal(sizeTrend([]), null);
  assert.equal(sizeTrend([run("backup", 100)]), null);
});

test("the line runs oldest to newest and is scaled from zero, so half is half", () => {
  // Newest first, the way listBackupRuns answers.
  const t = sizeTrend([run("backup", 50), run("backup", 100)], 100, 22);
  assert.equal(t.points.length, 2);
  assert.deepEqual(t.points.map(p => p.bytes), [100, 50]);
  assert.equal(t.max, 100);
  assert.equal(t.points[0].x, 0);
  assert.equal(t.points[1].x, 100);
  // The biggest sits a pixel below the top; half of it sits halfway down the
  // band, not on the floor — which is what a min-to-max scale would do.
  assert.equal(t.points[0].y, 1);
  assert.equal(t.points[1].y, 11);
  assert.equal(t.line, "0,1 100,11");
});

test("a backup that halved says so; one that held steady does not", () => {
  assert.equal(sizeTrend([run("backup", 40), run("backup", 100)]).halved, true);
  assert.equal(sizeTrend([run("backup", 90), run("backup", 100)]).halved, false);
  // Exactly half is not "less than half" — the sentence is for a real drop.
  assert.equal(sizeTrend([run("backup", 50), run("backup", 100)]).halved, false);
});

test("only runs that wrote a copy are plotted", () => {
  const rows = [
    run("restore_all", 900),                       // read back out, not written
    run("restore_jobs", 800),
    run("backup", 0),                              // failed before the copying
    run("backup", 300, { status: "failed" }),
    run("before_restore", 200),                    // a safety copy is a copy
    run("backup", 100)
  ];
  const t = sizeTrend(rows);
  assert.deepEqual(t.points.map(p => p.bytes), [100, 200]);
  assert.equal(t.latest, 200);
  assert.equal(t.previous, 100);
});

test("a file check reads as one sentence, and says when there was nothing to repair", () => {
  assert.equal(verifySentence({ verified: 25, repaired: 0, unrepairable: 0 }),
    "25 of 25 files matched their record, nothing to repair");
  assert.equal(verifySentence({ verified: 23, repaired: 2, unrepairable: 0 }),
    "23 of 25 files matched their record, 2 repaired from the app");
  assert.equal(verifySentence({ verified: 20, repaired: 3, unrepairable: 2 }),
    "20 of 25 files matched their record, 3 repaired from the app, 2 could not be repaired");
  // A run that died in its first slice has counts of {} — a sentence, not NaN.
  assert.equal(verifySentence({}), "0 of 0 files matched their record, nothing to repair");
  assert.deepEqual(verifyNotes({ notes: ["a", 2] }), ["a", "2"]);
  assert.deepEqual(verifyNotes(null), []);
});
