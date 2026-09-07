// The backup panel's arithmetic, kept out of the component so it can be
// tested without a browser.
//
// Three questions, each with an expensive wrong answer:
//
//   · the redirect URI — it has to be character-for-character what the
//     provider's own registration holds, and character-for-character what
//     the callback rebuilds on the server, or the drive refuses at the door;
//   · the settings patch — the panel can never see a stored client secret,
//     so a blank box is the ordinary state, and treating blank as "erase"
//     would break the connection on every save;
//   · the query the drive sends the browser home with — read once, said
//     once, and then off the address bar so a refresh does not repeat it.

import { nextRunAt } from "./backupSchedule.js";

export const BACKUP_PROVIDERS = ["google", "microsoft", "dropbox"];

export const PROVIDER_LABEL = {
  google: "Google Drive",
  microsoft: "OneDrive",
  dropbox: "Dropbox"
};

const FREQUENCIES = ["daily", "weekdays", "weekly", "monthly"];

// The copy taken automatically just before a restore. Retention never
// removes one — it is the only copy of what the restore replaced — and the
// list says so, so nobody has to work out why last Tuesday's is still there.
// The prefix is backupManifest.ts's BEFORE_RESTORE_PREFIX; the two are the
// same string on either side of a network, which is why it is written down
// in both places rather than guessed from a shape.
export const BEFORE_RESTORE_PREFIX = "before-restore ";

export function isBeforeRestore(name) {
  return String(name || "").startsWith(BEFORE_RESTORE_PREFIX);
}

// The typed confirmation on the restore dialog, which is the same answer the
// function gives itself before it starts. Trimmed at both ends because a
// name copied off the screen brings a space with it, and compared character
// for character otherwise: the whole point of typing the folder's own name
// is that it cannot be typed for the wrong night by accident.
export function restoreNameMatches(typed, folderName) {
  const a = String(typed ?? "").trim();
  const b = String(folderName ?? "").trim();
  return !!b && a === b;
}

// What to do about a run that failed, which is not the same sentence for
// all four kinds. A backup that fails leaves the app exactly as it was and
// the schedule carries it — "the next one will still run" is the whole
// answer. A restore that fails is a different situation entirely, and the
// panel used to give it the backup's sentence: a restore-all that died
// after the wipe left an emptied database on screen and told the Admin that
// the next scheduled backup would still run, which is true, useless, and
// would have backed up the emptiness.
//
// The gate is `counts.safety` — the name of the copy taken automatically
// just before the wipe, written on the run the moment that copy completes
// and null until then. A name means the app was emptied and names the way
// back; a null means the run stopped before anything was deleted.
export function failedRunAdvice(run) {
  const r = run || {};
  const kind = String(r.kind || "");
  const safety = String((r.counts && r.counts.safety) || "").trim();

  if (kind === "restore_jobs") {
    // A per-job restore deletes nothing: it adds the jobs it was given and
    // leaves everything else alone, so the app is whole either way.
    return "Nothing else in the app was touched — restoring jobs only adds. " +
      "Press Restore on those jobs again to have another go at what did not come back.";
  }

  if (kind === "restore_all") {
    if (!safety) {
      return "It stopped before the app was emptied, so nothing has been changed. " +
        "Everything is as it was; press Restore again when the reason above is dealt with.";
    }
    return "The app was emptied before this failed, so what is in it now is a part-restored copy. " +
      `Press Restore on the same backup to carry on from where it stopped, or restore “${safety}” — ` +
      "the copy taken automatically just before this started — to put back what was here before.";
  }

  return "The next scheduled backup will still run.";
}

// What a finished run wrote, out of `backup_runs.counts` — the shape
// backup-run's countsOf() writes: `{ rows: { <table>: n }, files, bytes }`.
// Read through these rather than reached into, because a run that died in its
// first slice has counts of `{}` and an older row may have none at all, and
// "NaN records" on a panel that is otherwise reporting a healthy backup is the
// kind of thing that gets a working backup switched off.
export const runRows = counts => {
  const rows = (counts && counts.rows) || {};
  let n = 0;
  for (const v of Object.values(rows)) n += Number(v) || 0;
  return n;
};
export const runFiles = counts => Number((counts && counts.files) || 0);
export const runBytes = counts => Number((counts && counts.bytes) || 0);
// How many of a run's files were copied over on the drive from the night
// before rather than read out of Supabase — the saving the nightly backup
// makes on its egress. Said only when it is not nothing.
export const runReused = counts => Number((counts && counts.reused) || 0);
export const carriedOverNote = counts => {
  const n = runReused(counts);
  return n ? `, ${n} carried over from the night before` : "";
};

// Only these two kinds put a copy of the app in the drive. A restore's own
// bytes are what it read back out, and drawing them on the same line as the
// backups would make an ordinary restore look like the night everything
// doubled.
export const SIZE_TREND_KINDS = ["backup", "before_restore"];

// The line under the list: how big the last several backups were, oldest on
// the left. It is there for one question — has this suddenly got smaller? —
// because a backup that quietly starts missing half the app looks exactly
// like a backup that worked, right down to the green "complete".
//
// Scaled from zero rather than from the smallest run, which is the whole
// point: on a min-to-max scale every set of runs fills the box and a night
// that halved looks like a night that dipped. From zero, half the bytes is
// half the height.
//
// Nothing is drawn from one run — a single point is not a trend — and a run
// that wrote nothing is left out rather than plotted as a zero, because that
// is a failure before the copying started, not a small backup.
export function sizeTrend(runs, width = 132, height = 26) {
  const usable = (runs || [])
    .filter(r => r && r.status === "complete" && SIZE_TREND_KINDS.includes(String(r.kind)))
    .map(r => ({
      bytes: runBytes(r.counts),
      name: String(r.folder_name || ""),
      at: r.finished_at || r.created_at || null
    }))
    .filter(r => r.bytes > 0)
    // listBackupRuns answers newest first; a line is read left to right.
    .reverse();
  if (usable.length < 2) return null;

  const max = usable.reduce((m, r) => Math.max(m, r.bytes), 0);
  // A point sitting exactly on the top or bottom edge is half a stroke
  // outside the box, so the plot keeps a pixel at each end.
  const top = 1;
  const band = Math.max(1, height - 2);
  const step = width / (usable.length - 1);
  const round = n => Math.round(n * 100) / 100;
  const points = usable.map((r, i) => ({
    ...r,
    x: round(i * step),
    y: round(top + band - (r.bytes / max) * band)
  }));

  const latest = usable[usable.length - 1].bytes;
  const previous = usable[usable.length - 2].bytes;
  return {
    points,
    max,
    latest,
    previous,
    line: points.map(p => `${p.x},${p.y}`).join(" "),
    // Worth a sentence, not just a shape: the last backup is under half the
    // one before it.
    halved: latest * 2 < previous
  };
}

// The address the app is served from is the address a drive sends the Admin
// back to. It is stored (Admin screen → App address) rather than guessed,
// because the drive's registration has to hold the same string — but this
// window's origin is what it almost always is, and saying so beats a blank
// box. Anything unparseable falls back the same way: this is the panel's
// display copy, and the server builds its own from the stored value.
export function redirectUriFor(state, provider, fallbackOrigin) {
  const configured = String((state && state.approval_base_url) || "").trim();
  let origin = fallbackOrigin;
  if (configured) {
    try { origin = new URL(configured).origin; } catch { /* fall back to this window */ }
  }
  return `${origin}/backup/oauth/${provider}`;
}

// An empty box means "the default", which is not the same as zero: an
// emptied "keep" is 14 backups, while a typed 0 is one. Anything that is
// not a number at all is the default too.
const clamp = (value, low, high, fallback) => {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(high, Math.max(low, n));
};

// What a save would actually write into "keep this many", which is not the
// same as the characters in the box: an emptied box is 14, a typed 0 is 1
// and 9000 is 365. The sentence under the box used to read the box back
// verbatim, so it promised numbers no save was going to write.
export const keepToSave = value => clamp(value, 1, 365, 14);

// The same number said in English. "the 14 most recents" pluralised the
// wrong word, and one kept backup is not "1 most recent" either.
export function keepPhrase(value) {
  const keep = keepToSave(value);
  return keep === 1 ? "the most recent one" : `the ${keep} most recent`;
}

// A Google client id copied off the console page comes with company: the
// first connection attempt saved 131 characters that began with the id and
// ended with "view or download the client", and Google answered the consent
// request with "OAuth client was not found". The id has one shape —
// digits, a hyphen, a token, .apps.googleusercontent.com — so it is taken
// out of whatever was pasted around it. Microsoft's is a GUID and Dropbox's
// an app key, neither of which the console pads, so they are only trimmed.
const GOOGLE_CLIENT_ID = /[0-9]+-[a-z0-9]+.apps.googleusercontent.com/i;
export function cleanClientId(provider, raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  if (provider === "google") {
    const m = GOOGLE_CLIENT_ID.exec(text);
    return m ? m[0] : text;
  }
  return text;
}

// The columns a save from this screen is allowed to write. The connection's
// own columns — provider, refresh token, account, folder — are the
// callback's alone and are deliberately absent: a browser that could write
// them could name a drive it does not own.
export function backupSettingsPatch(form, nowMs) {
  const f = form || {};
  const frequency = FREQUENCIES.includes(f.frequency) ? f.frequency : "daily";
  const weekday = clamp(f.weekday, 0, 6, 0);
  const hour = clamp(f.hour, 0, 23, 0);
  const keep = keepToSave(f.keep);

  const patch = {
    id: true,
    backup_frequency: frequency,
    backup_weekday: weekday,
    backup_hour: hour,
    backup_keep: keep,
    backup_client_id_google: cleanClientId("google", f.clientIdGoogle),
    backup_client_id_microsoft: cleanClientId("microsoft", f.clientIdMicrosoft),
    backup_client_id_dropbox: cleanClientId("dropbox", f.clientIdDropbox),
    updated_at: new Date(nowMs).toISOString()
  };

  for (const [field, column] of [
    ["clientSecretGoogle", "backup_client_secret_google"],
    ["clientSecretMicrosoft", "backup_client_secret_microsoft"],
    ["clientSecretDropbox", "backup_client_secret_dropbox"]
  ]) {
    const typed = String(f[field] || "").trim();
    if (typed) patch[column] = typed;
  }

  // The next due time is worked out here rather than left to the tick, so
  // the line under the schedule changes the moment it is saved. The
  // function's own copy of nextRunAt computes the same instant. With no
  // drive connected there is nowhere for a run to go, so it stays null.
  if (f.connected) patch.backup_next_run_at = nextRunAt({ frequency, weekday, hour }, nowMs);

  return patch;
}

// What the callback redirected home with. `rest` is the rest of the query
// string, so the panel can put the address bar back the way it found it
// minus this one message.
export function readBackupOutcome(search) {
  const q = new URLSearchParams(search || "");
  const raw = q.get("backup");
  const why = q.get("why") || "";
  q.delete("backup");
  q.delete("why");
  if (!raw) return { outcome: "", why: "", rest: q.toString() };
  // An outcome this version does not recognise is a refusal, never a
  // success: saying "connected" about something we cannot read would send
  // an Admin away believing backups are running.
  const outcome = ["connected", "denied", "failed"].includes(raw) ? raw : "failed";
  return { outcome, why, rest: q.toString() };
}
