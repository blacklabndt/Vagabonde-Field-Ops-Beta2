import { useState, useEffect, useCallback, useRef } from "react";
import { Db } from "../db.js";
import { Btn, Dialog, Field, ErrorBox, Loading, TagX } from "./common.jsx";
import {
  BACKUP_PROVIDERS, PROVIDER_LABEL, redirectUriFor, readBackupOutcome,
  isBeforeRestore, restoreNameMatches, failedRunAdvice, keepPhrase,
  runRows, runFiles, runBytes, sizeTrend, carriedOverNote, verifySentence, verifyNotesUnsaid
} from "../backupPanelLogic.js";
import { fileSize } from "../data.js";
import { describeSchedule, WEEKDAY_NAMES, nextRunAt, BACKUP_ZONE } from "../backupSchedule.js";

// Automatic backup — the Admin screen's Archive block, below the year-end
// dropdown, because they are the same question asked two ways: what happens
// to this work when the app is not the only copy of it any more.
//
// Everything real happens server-side. This screen connects a drive, sets a
// schedule, and reads back what the functions have been doing; it never
// holds a token, never holds a backup, and cannot see a client secret it
// has already saved — the state RPC answers "a secret is set", not the
// secret. So a blank secret box is the ordinary state and saving with one
// blank leaves the stored value alone.

const SECTION_TITLE = { fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 16, marginBottom: 4 };
const SECTION_HELP = { fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)", marginBottom: 12, lineHeight: 1.5 };
const QUIET = { fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" };

const REGISTRATION = {
  google: {
    where: "console.cloud.google.com/apis/credentials",
    steps: "Create a project, turn on the Google Drive API, then Credentials → Create credentials → OAuth client ID → Web application. Paste the redirect URI below into “Authorised redirect URIs”."
  },
  microsoft: {
    where: "entra.microsoft.com → App registrations",
    steps: "New registration, accounts in any organisational directory and personal Microsoft accounts. Add a Web platform with the redirect URI below, then Certificates & secrets → New client secret."
  },
  dropbox: {
    where: "dropbox.com/developers/apps",
    steps: "Create app → Scoped access → Full Dropbox. On Permissions tick files.content.write, files.content.read and files.metadata.read. Add the redirect URI below under OAuth 2."
  }
};

const capitalise = p => `${p[0].toUpperCase()}${p.slice(1)}`;

const mb = bytes => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
// Every other time in this feature is Grande Prairie's — the schedule the
// Admin sets, the folder each backup is stamped with, the hour the cron
// fires. A last-run line drawn on the browser's own clock would disagree
// with the folder name sitting beside it the moment anybody opened the panel
// from anywhere else.
//
// The year is in it because this is also how the restore-jobs picker dates
// the jobs in a backup, and telling a 2024 job from a 2026 one is the whole
// point of that list.
const when = iso => iso
  ? new Date(iso).toLocaleString("en-CA", {
      timeZone: BACKUP_ZONE, day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit"
    })
  : "—";

// A run's phase, said the way somebody who has not read the code would say
// it. The restore's own phases are in here too, because the same progress
// box shows a restore.
const PHASE_WORDS = {
  tables: "copying the records",
  files: "copying the PDFs and pictures",
  manifest: "writing the index",
  retention: "tidying up old backups",
  safety: "taking a backup first",
  wipe: "emptying the app",
  accounts: "putting the accounts back",
  activity: "putting the totals and dates right",
  done: "finishing"
};

const KIND_WORDS = {
  backup: "Backup",
  before_restore: "Safety backup",
  restore_all: "Restore",
  restore_jobs: "Restoring jobs",
  verify: "File check"
};

// The three figures every run keeps, now shared with the list of earlier runs
// and the line drawn under it — so what the last-run sentence counts and what
// the line plots cannot drift apart. They live in backupPanelLogic.js, where
// they are tested.
const rowsIn = runRows;
const filesIn = runFiles;
const bytesIn = runBytes;
// A restore's two other figures, and they arrive in two shapes on purpose.
// A restore-all writes into tables it has just emptied, so what it left out
// is a number; a per-job restore writes into tables that are full, so what
// it left out is a list of sentences — "two records were skipped" tells an
// office nothing, and "ticket 24-118 is already in use here" tells them what
// to do. Both are read through these, so neither shape can reach the render
// as a NaN or a spread of a number.
const noteList = v => (Array.isArray(v) ? v.filter(Boolean).map(String) : []);
const countOf = v => (Array.isArray(v) ? v.length : Number(v || 0));
const skippedIn = counts => countOf(counts && counts.skipped);
const collisionsIn = counts => countOf(counts && counts.collisions);
// Everything a finished restore has to say, in the order it is worth
// reading: what the run wants said outright, what could not go back, what
// was already there, and who could not be given an account again.
const notesIn = counts => [
  ...noteList(counts && counts.notes),
  ...noteList(counts && counts.collisions),
  ...noteList(counts && counts.skipped),
  ...noteList(counts && counts.accountsFailed)
];

// While something is in flight the panel looks every few seconds; when
// nothing is, it looks rarely — this screen is left open.
const POLL_BUSY_MS = 4000;
const POLL_IDLE_MS = 20000;
// A nudge is a whole function invocation, so it is not sent on every poll.
// The slice chain does the work; this is for when the chain drops.
const NUDGE_EVERY_MS = 15000;

// How far back "Earlier runs" reaches. It used to be five, which is a fine
// list and a poor line: on a daily schedule five points is under a week, and
// the question the line is drawn for — is this quietly getting smaller? — is
// asked of a fortnight. They are small rows behind a fold.
const EARLIER_RUNS = 12;

// The panel sits inside the Archive block's own box: a rule above it, not a
// second box — the two are one subject, keeping the work and keeping the
// app.
const SECTION_STYLE = { marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--color-divider)", minWidth: 0, overflowWrap: "anywhere" };

// How big the last several backups were, drawn rather than listed.
//
// A backup that has quietly stopped holding half the app finishes green,
// writes a folder, and reports a perfectly ordinary "complete" — the only
// thing that gives it away is the size, and a size is only a fact next to the
// sizes before it. Hence a line: the shape is read in a glance and the numbers
// are still in the rows above it.
//
// Twenty-six pixels of SVG written out here rather than a chart library: it is
// a polyline and a dot per run, and the app does not carry a charting
// dependency for it.
const TREND_W = 130;
const TREND_H = 26;

function SizeTrend({ runs }) {
  const trend = sizeTrend(runs, TREND_W, TREND_H);
  // Fewer than two backups in the list, or none that wrote anything: there is
  // nothing a line could say that the rows do not.
  if (!trend) return null;
  const label = `The last ${trend.points.length} backups by size, oldest first. Largest ${fileSize(trend.max)}, latest ${fileSize(trend.latest)}.`;
  return (
    <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <svg width={TREND_W + 4} height={TREND_H + 4} viewBox={`-2 -2 ${TREND_W + 4} ${TREND_H + 4}`}
        role="img" aria-label={label} style={{ flex: "none", overflow: "visible" }}>
        <title>{label}</title>
        <polyline points={trend.line} fill="none" stroke="var(--color-accent)" strokeWidth="1.5"
          strokeLinejoin="round" strokeLinecap="round" />
        {trend.points.map(p => (
          <circle key={`${p.name}-${p.x}`} cx={p.x} cy={p.y} r="1.8" fill="var(--color-accent)" />
        ))}
      </svg>
      <span style={QUIET}>
        Size of the last {trend.points.length} backups, oldest first &middot; largest {fileSize(trend.max)},
        {" "}latest {fileSize(trend.latest)}.
      </span>
      {trend.halved && (
        <div style={{ fontSize: 12, color: "var(--color-accent-700)", flexBasis: "100%" }}>
          The last backup is less than half the size of the one before it. That can be an ordinary quiet week, or it
          can be a copy that stopped partway &mdash; open the drive and check the folder holds the records and files
          the row above says it does.
        </div>
      )}
    </div>
  );
}

export function AutomaticBackupPanel() {
  const [state, setState] = useState(null);
  const [loadState, setLoadState] = useState("loading"); // loading | ready | failed
  const [error, setError] = useState("");
  // How the last connection ended, as the drive's own redirect reported it.
  // It is kept apart from `error` on purpose: `load()` clears `error` the
  // moment a read succeeds, and the read that follows the callback always
  // succeeds — so a reason put in `error` was wiped a heartbeat later and the
  // Admin was left reading "No drive connected." with nothing said about why.
  const [outcomeError, setOutcomeError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState("");
  const [showRegistration, setShowRegistration] = useState(false);
  const [form, setForm] = useState({
    frequency: "daily", weekday: 0, hour: 2, keep: 14,
    clientIdGoogle: "", clientSecretGoogle: "",
    clientIdMicrosoft: "", clientSecretMicrosoft: "",
    clientIdDropbox: "", clientSecretDropbox: ""
  });

  // A run in flight, and the poll that watches it. It is in a ref as well as
  // in state because the poll reschedules itself out of a closure: reading
  // `run` there would read whatever it was when the effect was set up, and
  // the interval would never change from idle to busy.
  const [run, setRun] = useState(null);
  const runRef = useRef(null);
  const nudgedAt = useRef(0);
  const [lastRuns, setLastRuns] = useState([]);
  const [starting, setStarting] = useState(false);

  // What is actually in the drive, and the backup a restore dialog is open
  // for. The list is not read on load: it is a round trip to the drive per
  // folder for the manifest, and this panel is opened far more often to
  // check a schedule than to put a backup back.
  const [backups, setBackups] = useState(null);
  const [listing, setListing] = useState(false);
  const [restoring, setRestoring] = useState(null);

  const showRun = value => { runRef.current = value; setRun(value); };

  // `seed` is what makes this safe to call on a timer: the schedule boxes
  // are filled from the server once, and after that only a Save resets them.
  // Refreshing them on every read would rewrite what the Admin is halfway
  // through typing.
  const load = useCallback((seed = false) => {
    setLoadState(s => (s === "ready" ? s : "loading"));
    Db.backupState()
      .then(row => {
        setState(row);
        if (seed) {
          setForm(f => ({
            ...f,
            frequency: row.frequency || "daily",
            weekday: Number(row.weekday) || 0,
            hour: Number(row.hour) || 0,
            keep: Number(row.keep) || 14,
            clientIdGoogle: row.client_id_google || "",
            clientIdMicrosoft: row.client_id_microsoft || "",
            clientIdDropbox: row.client_id_dropbox || ""
          }));
          // backup_state answers with the run in flight, so the progress box
          // is there on the first paint rather than one poll later.
          if (runRef.current === null) showRun(row.active_run || null);
        }
        setLoadState("ready");
        setError("");
      })
      .catch(e => {
        setError(e.message || "Couldn't read the backup settings.");
        setLoadState("failed");
      });
  }, []);

  useEffect(() => { load(true); }, [load]);

  useEffect(() => {
    let alive = true;
    let timer = null;
    const look = async () => {
      try {
        const open = await Db.currentBackupRun();
        if (!alive) return;
        const had = runRef.current;
        showRun(open);
        if (open) {
          if (Date.now() - nudgedAt.current > NUDGE_EVERY_MS) {
            nudgedAt.current = Date.now();
            Db.nudgeBackup();
          }
        } else if (had) {
          // Something finished while this screen was open: what it says now
          // is the last-run line and the list behind it.
          setLastRuns(await Db.listBackupRuns(EARLIER_RUNS));
          load();
        }
      } catch { /* a failed poll is not worth an error box */ }
      if (alive) timer = setTimeout(look, runRef.current ? POLL_BUSY_MS : POLL_IDLE_MS);
    };
    Db.listBackupRuns(EARLIER_RUNS).then(rows => { if (alive) setLastRuns(rows); }).catch(() => {});
    look();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [load]);

  const listBackups = async () => {
    setListing(true);
    setError("");
    try { setBackups(await Db.listBackups()); }
    catch (e) { setError(e.message || "Couldn't read the drive."); }
    finally { setListing(false); }
  };

  const backUpNow = async () => {
    setStarting(true);
    setError("");
    try {
      await Db.backupNow();
      showRun(await Db.currentBackupRun());
    } catch (e) {
      setError(e.message || "The backup couldn't be started.");
    } finally {
      setStarting(false);
    }
  };

  // Coming back from the drive's consent screen. The function redirects to
  // /?backup=connected (or =denied, or =failed&why=…); say so, then take the
  // query off the address bar so a refresh does not repeat the message.
  useEffect(() => {
    const { outcome, why, rest } = readBackupOutcome(window.location.search);
    if (!outcome) return;
    if (outcome === "connected") setNotice("The drive is connected. The first backup runs at the next scheduled time.");
    else if (outcome === "denied") setNotice("The drive was not connected: the consent screen was cancelled.");
    else setOutcomeError(why || "The drive couldn't be connected.");
    // The hash is the app's own route (route.js) and stays: dropping it here
    // sent the Google return to Home with the address bar behind the screen.
    window.history.replaceState({}, "", window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash);
    load();
  }, [load]);

  const set = (key, value) => { setForm(p => ({ ...p, [key]: value })); setError(""); };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await Db.saveBackupSettings({ ...form, connected: !!(state && state.connected) });
      // The secrets were written; forget the typed copies so the boxes go
      // back to their ordinary blank state.
      setForm(f => ({ ...f, clientSecretGoogle: "", clientSecretMicrosoft: "", clientSecretDropbox: "" }));
      // A Save is the one thing that refills these boxes from the server:
      // what comes back is the schedule as the database clamped it.
      load(true);
    } catch (e) {
      setError(e.message || "Couldn't save the backup settings.");
    } finally {
      setSaving(false);
    }
  };

  const connect = async provider => {
    setConnecting(provider);
    setError("");
    // A fresh attempt: how the last one ended is no longer the answer.
    setOutcomeError("");
    setNotice("");
    try {
      window.location.assign(await Db.backupOauthStartUrl(provider));
    } catch (e) {
      setError(e.message || "Couldn't start the connection.");
      setConnecting("");
    }
  };

  // One press clears the refresh token and backups stop until somebody sits
  // through the provider's consent screen again — on Google, picking the
  // right account out of however many this browser is signed into. The app
  // asks before far smaller undoings than this one.
  const disconnect = async () => {
    const who = (state && state.account) || "this drive";
    const provider = (state && PROVIDER_LABEL[state.provider]) || "the drive";
    if (!confirm(`Disconnect ${who}? Backups stop until a drive is connected again, and reconnecting means signing in to ${provider} once more.`)) return;
    setError("");
    setOutcomeError("");
    setNotice("");
    try { await Db.disconnectBackup(); load(); }
    catch (e) { setError(e.message || "Couldn't disconnect the drive."); }
  };

  if (loadState === "loading") {
    return <div style={SECTION_STYLE}><Loading label="Loading the backup settings…" /></div>;
  }

  const s = state || {};
  const connected = !!s.connected;

  return (
    <div style={SECTION_STYLE}>
      <div style={SECTION_TITLE}>Automatic backup</div>
      <div style={SECTION_HELP}>
        A copy of everything &mdash; every job, ticket, assessment, report and their PDFs &mdash; written to one
        drive account of your own on a schedule, and restorable from the same place. The app does the
        copying on its own server: nothing is downloaded to this computer and nothing is uploaded from it.
        The backup contains the crew&rsquo;s hours and dose readings and every client&rsquo;s pricing, so
        connect an account that belongs to the business.
      </div>

      {/* Two boxes, on purpose. The first is how the connection attempt ended
          — it arrived on the address bar and is only ever cleared by pressing
          Connect or Disconnect again. The second is this screen's own reading
          and saving, which clears itself. */}
      <ErrorBox>{outcomeError}</ErrorBox>
      <ErrorBox>{error}</ErrorBox>
      {notice && <div style={{ fontSize: 13, marginBottom: 12, color: "var(--color-accent)" }}>{notice}</div>}

      {/* The provider row. Only one drive is ever connected, so while one is
          there the other two are not offered: switching means Disconnect
          first, which is also what clears the old drive's token. */}
      {/* Connected: one line, whatever the column's width — the account
          shrinks and ellipsises before Disconnect is allowed to drop under
          it. Not connected: the three Connect buttons may wrap. */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: connected ? "nowrap" : "wrap", marginBottom: 10 }}>
        {connected ? (
          <>
            <TagX variant="outline">{PROVIDER_LABEL[s.provider] || s.provider}</TagX>
            <span style={{ fontSize: 14, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={s.account || undefined}>Connected as <strong>{s.account || "—"}</strong></span>
            {/* Not while something is running. Disconnecting clears the
                refresh token, and the slice in flight — or the very next one
                — then fails at connectDrive, which on a restore means failing
                somewhere between the wipe and the load. */}
            <Btn variant="danger" style={{ marginLeft: "auto", flex: "none" }} disabled={!!run} onClick={disconnect}
              title={run ? "Not while a run is going — wait for it to finish." : undefined}>Disconnect</Btn>
          </>
        ) : (
          <>
            <span style={{ fontSize: 14 }}>No drive connected.</span>
            {BACKUP_PROVIDERS.map(p => (
              <Btn key={p} variant="secondary" disabled={!!connecting} onClick={() => connect(p)}>
                {connecting === p ? "Opening…" : `Connect ${PROVIDER_LABEL[p]}`}
              </Btn>
            ))}
          </>
        )}
      </div>

      {s.connection_error && (
        <div style={{ fontSize: 13, border: "1px solid var(--color-accent-700)", padding: "8px 10px", marginBottom: 10 }}>
          <strong>The drive needs reconnecting.</strong> {s.connection_error} Press Disconnect and connect it again;
          backups are not running until you do.
        </div>
      )}

      {/* Schedule */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 12 }}>
        <Field label="How often">
          <select className="input" value={form.frequency} onChange={e => set("frequency", e.target.value)}>
            <option value="daily">Every day</option>
            <option value="weekdays">Weekdays only</option>
            <option value="weekly">Once a week</option>
            <option value="monthly">Once a month</option>
          </select>
        </Field>
        {form.frequency === "weekly" && (
          <Field label="Day">
            <select className="input" value={form.weekday} onChange={e => set("weekday", Number(e.target.value))}>
              {WEEKDAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          </Field>
        )}
        <Field label="At">
          <select className="input" value={form.hour} onChange={e => set("hour", Number(e.target.value))}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
            ))}
          </select>
        </Field>
        <Field label="Keep this many">
          <input className="input" type="number" min="1" max="365" value={form.keep}
            onChange={e => set("keep", e.target.value)} />
        </Field>
      </div>

      <div style={{ ...QUIET, marginBottom: 12 }}>
        {/* keepPhrase, not the box read back: an emptied box saves as 14, a
            typed 0 saves as 1, and this sentence used to name neither. */}
        {describeSchedule(form)}. Older backups beyond {keepPhrase(form.keep)} are
        removed after each successful run &mdash; except the copies taken automatically just before a restore,
        which are never tidied away.
        {connected && <> Next due <strong>{when(s.next_run_at || nextRunAt(form, Date.now()))}</strong>.</>}
        {/* The fortnightly file check: every file in the newest backup
            downloaded and hashed against its record, and re-stored from the
            app where it does not match. Its own run, after the backups. */}
        {connected && s.verify_next_at && <> Every file is checked every {s.verify_every_days || 14} days; next <strong>{when(s.verify_next_at)}</strong>.</>}
      </div>

      {/* Back up now, and what happened last time */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <Btn variant="secondary" disabled={!connected || starting || !!run} onClick={backUpNow}>
          {starting ? "Starting…" : run ? "A run is already going" : "Back up now"}
        </Btn>
        {!connected && <span style={QUIET}>Connect a drive first.</span>}
      </div>

      {run && (
        <div style={{ border: "1px solid var(--color-accent)", padding: "10px 12px", marginBottom: 12, fontSize: 13 }}>
          <strong>{KIND_WORDS[run.kind] || run.kind} in progress</strong>
          {run.folder_name ? <> &middot; {run.folder_name}</> : null}
          <div style={{ marginTop: 4 }}>
            {/* A file check loads no records and copies nothing, so the
                backup's three figures read as a run holding none of the app
                — on the one box built to catch exactly that. It counts in
                verifyCounts instead, said by the helper the finished row and
                the last-run sentence both use. */}
            {run.kind === "verify" ? (
              <>checking every file against its record &middot; {verifySentence(run.counts)} so far.</>
            ) : (
              <>{PHASE_WORDS[run.phase] || run.phase || "starting"} &middot; {plural(rowsIn(run.counts), "record")},
                {" "}{plural(filesIn(run.counts), "file")} ({mb(bytesIn(run.counts))}{carriedOverNote(run.counts)}) so far.</>
            )}
          </div>
          <div style={{ ...QUIET, marginTop: 4 }}>
            It keeps going on the server whether this screen is open or not &mdash; a big first backup can take an hour.
          </div>
        </div>
      )}

      {!run && s.last_run && (
        <div style={{ fontSize: 13, marginBottom: 12 }}>
          <strong>Last {(KIND_WORDS[s.last_run.kind] || "run").toLowerCase()}:</strong>{" "}
          {s.last_run.status === "complete" && s.last_run.kind === "verify" ? (
            <>finished {when(s.last_run.finished_at)}{s.last_run.folder_name
              ? <> &middot; {s.last_run.folder_name}</> : null} &middot; {verifySentence(s.last_run.counts)}.
              {/* A check that found no complete backup has no folder, and the
                  sentence has already quoted the first note as its why — the
                  list holds what it has not said. */}
              {verifyNotesUnsaid(s.last_run.counts).length > 0 && (
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {verifyNotesUnsaid(s.last_run.counts).map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              )}
            </>
          ) : s.last_run.status === "complete" ? (
            <>finished {when(s.last_run.finished_at)} &middot; {s.last_run.folder_name} &middot;{" "}
              {plural(rowsIn(s.last_run.counts), "record")}, {plural(filesIn(s.last_run.counts), "file")}{" "}
              ({mb(bytesIn(s.last_run.counts))}{carriedOverNote(s.last_run.counts)}).
              {/* The tallies belong to the restore that empties the app
                  first: there, a row left out is a row that is simply not
                  there any more. A per-job restore's figures are sentences
                  instead, and they are in the notes below — counting them
                  here would say "two records were skipped" over a report
                  that already names the ticket and the job. */}
              {s.last_run.kind !== "restore_jobs" && skippedIn(s.last_run.counts) > 0 && (
                <> {plural(skippedIn(s.last_run.counts), "record")} could not be put back and{" "}
                  {skippedIn(s.last_run.counts) === 1 ? "was" : "were"} left out.</>
              )}
              {s.last_run.kind !== "restore_jobs" && collisionsIn(s.last_run.counts) > 0 && (
                <> {plural(collisionsIn(s.last_run.counts), "record")} {collisionsIn(s.last_run.counts) === 1
                  ? "was" : "were"} already in the app and {collisionsIn(s.last_run.counts) === 1
                  ? "was" : "were"} left alone.</>
              )}
              {/* A run can finish and still have something an Admin has to be
                  told — the accounts that could not be re-created, and what
                  went with them. It is written on the run in `error`, and
                  showing it only on a failure was showing it never. */}
              {s.last_run.error && (
                <div style={{ marginTop: 4, color: "var(--color-accent-700)" }}>{s.last_run.error}</div>
              )}
            </>
          ) : (
            <span style={{ color: "var(--color-accent-700)" }}>
              failed {when(s.last_run.finished_at)} &mdash; {s.last_run.error || "no reason recorded"}.{" "}
              {/* What that leaves behind, which is not the same for a backup
                  and for a restore. A restore-all that died after the wipe
                  used to be told the next scheduled backup would still run:
                  true, useless, and the only two ways out of an emptied app
                  went unsaid. */}
              {failedRunAdvice(s.last_run)}
            </span>
          )}
          {/* The report itself, where the run kept one, and outside the
              complete/failed branch on purpose: a per-job restore that fails
              partway still names every job it could not put back, and those
              notes are exactly what the office has to act on. The one
              exception is a file check that completed: verifyCounts writes
              its notes into this same `notes`, and the branch above has
              already listed them — asking twice reads as two reports. */}
          {!(s.last_run.status === "complete" && s.last_run.kind === "verify")
            && notesIn(s.last_run.counts).length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ fontSize: 13 }}>
                It left {plural(notesIn(s.last_run.counts).length, "note")} &mdash; worth reading
              </summary>
              <ul style={{ fontSize: 12, margin: "8px 0 0", paddingLeft: 18 }}>
                {notesIn(s.last_run.counts).slice(0, 40).map((line, i) => <li key={i}>{line}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}

      {lastRuns.length > 1 && (
        <details style={{ marginBottom: 12 }}>
          <summary style={QUIET}>Earlier runs</summary>
          <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            {lastRuns.map(r => (
              <div key={r.id} style={{ fontSize: 12, display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <TagX variant="outline">{KIND_WORDS[r.kind] || r.kind}</TagX>
                <span>{r.folder_name || "—"}</span>
                {/* What the run actually moved. A folder name and a green
                    "complete" say a backup happened; they do not say whether
                    it holds the app. These three figures do, and they are the
                    same ones the last-run sentence above quotes. */}
                <span style={QUIET}>
                  {r.kind === "verify"
                    ? verifySentence(r.counts)
                    : <>{plural(rowsIn(r.counts), "record")} &middot; {plural(filesIn(r.counts), "file")} &middot; {fileSize(bytesIn(r.counts))}</>}
                </span>
                <span style={{ marginLeft: "auto" }}>{r.status} &middot; {when(r.finished_at || r.created_at)}</span>
              </div>
            ))}
          </div>
          <SizeTrend runs={lastRuns} />
        </details>
      )}

      {/* What is in the drive. Read on request rather than on load: it is a
          round trip per folder to open each manifest, and most visits to this
          screen are about the schedule, not about putting anything back. */}
      {connected && (
        <div style={{ borderTop: "1px solid var(--color-neutral-300)", paddingTop: 14, marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <div style={{ ...SECTION_TITLE, marginBottom: 0 }}>Backups in the drive</div>
            <Btn variant="secondary" style={{ marginLeft: "auto" }} disabled={listing} onClick={listBackups}>
              {listing ? "Reading…" : backups ? "Refresh" : "Show backups"}
            </Btn>
          </div>
          {backups && !backups.length && (
            <div style={QUIET}>Nothing in the drive yet. The first backup will appear here.</div>
          )}
          {backups && backups.length > 0 && (
            <div style={{ display: "grid", gap: 8 }}>
              {backups.map(b => (
                <div key={b.folderId} style={{ border: "1px solid var(--color-neutral-300)", padding: "10px 12px", fontSize: 13 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <strong>{b.name}</strong>
                    {isBeforeRestore(b.name) && <TagX variant="outline">kept</TagX>}
                    {b.incomplete && <TagX variant="outline">didn&rsquo;t finish</TagX>}
                    <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                      {/* The everyday one first, because it is the one that
                          gets pressed: a job somebody deleted on Tuesday,
                          not the whole app replaced. */}
                      <Btn variant="secondary" disabled={!!b.incomplete || !!run}
                        onClick={() => setRestoring({ ...b, mode: "jobs" })}>Restore jobs</Btn>
                      <Btn variant="secondary" disabled={!!b.incomplete || !!run}
                        onClick={() => setRestoring({ ...b, mode: "all" })}>Restore everything</Btn>
                    </span>
                  </div>
                  <div style={{ ...QUIET, marginTop: 4 }}>
                    {b.incomplete
                      ? "No index in this folder, so it is not offered for restoring."
                      : <>{plural(b.rows || 0, "record")} &middot; {plural(b.files || 0, "file")} ({mb(b.bytes || 0)}) &middot;{" "}
                          {plural(b.jobs || 0, "job")} &middot; app {b.app_version || "?"} &middot; {when(b.finished_at)}</>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {restoring && restoring.mode === "all" && (
        <RestoreDialog backup={restoring} onClose={() => setRestoring(null)}
          onStarted={() => { setRestoring(null); Db.currentBackupRun().then(showRun).catch(() => {}); }} />
      )}

      {restoring && restoring.mode === "jobs" && (
        <RestoreJobsDialog backup={restoring} onClose={() => setRestoring(null)}
          onStarted={() => { setRestoring(null); Db.currentBackupRun().then(showRun).catch(() => {}); }} />
      )}

      {/* App registration — collapsed, because it is done once and never
          again, and it is the fiddliest thing on this screen. It shares a
          row with Save: the one thing left to do down here on the left, the
          one thing that commits it on the right. The registration's own
          fields open underneath the row. */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <Btn variant="secondary" onClick={() => setShowRegistration(v => !v)}>
          {showRegistration ? "Hide app registration" : "App registration"}
        </Btn>
        <span style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
          {loadState === "failed" && <Btn variant="secondary" onClick={load}>Try loading again</Btn>}
          <Btn variant="primary" disabled={saving || loadState !== "ready"} onClick={save}>
            {saving ? "Saving…" : "Save backup settings"}
          </Btn>
        </span>
      </div>

      {showRegistration && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={SECTION_HELP}>
            Each drive needs its own free app registration under your account &mdash; that is what lets this app
            write to it. Do the one you mean to use and ignore the other two. Paste the redirect URI shown
            beneath each one into that provider&rsquo;s registration exactly as it appears.
          </div>
          {BACKUP_PROVIDERS.map(p => {
            const r = REGISTRATION[p];
            const idKey = `clientId${capitalise(p)}`;
            const secretKey = `clientSecret${capitalise(p)}`;
            const hasSecret = !!s[`has_secret_${p}`];
            return (
              <div key={p} style={{ border: "1px solid var(--color-neutral-300)", padding: "12px 14px" }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{PROVIDER_LABEL[p]}</div>
                <div style={{ ...QUIET, marginBottom: 10 }}>{r.where} &mdash; {r.steps}</div>
                <Field label="Redirect URI (paste this into the registration)">
                  <input className="input" readOnly value={redirectUriFor(s, p, window.location.origin)}
                    onFocus={e => e.target.select()} style={{ width: "100%" }} />
                </Field>
                {!String(s.approval_base_url || "").trim() && (
                  <div style={{ ...QUIET, marginTop: 4 }}>
                    App address is blank above, so that line is this window&rsquo;s own address. If the app is
                    reached on some other address, fill in App address first &mdash; the drive compares the two
                    character for character.
                  </div>
                )}
                <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                  <Field label="Client ID">
                    <input className="input" value={form[idKey]} autoComplete="off"
                      onChange={e => set(idKey, e.target.value)} style={{ width: "100%" }} />
                  </Field>
                  <Field label="Client secret">
                    <input className="input" type="password" value={form[secretKey]} autoComplete="off"
                      placeholder={hasSecret ? "saved — leave blank to keep it" : "from the registration"}
                      onChange={e => set(secretKey, e.target.value)} style={{ width: "100%" }} />
                  </Field>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Restore everything. The gate is the same shape as the archive dialog's
// typed CLEAR, for the same reason and one more: this replaces every record
// in the app with a copy of an older day, so the word to type is the
// backup's own name — which cannot be typed by accident and cannot be typed
// for the wrong night's backup.
//
// The preflight is asked before anything is offered, because whether a
// backup may be loaded into this database at all is the server's answer: it
// compares the schema the backup was taken at with the one this project is
// on, and a backup from a newer app holds columns this database has not got.
export function RestoreDialog({ backup, onClose, onStarted }) {
  const [check, setCheck] = useState(null);
  const [checking, setChecking] = useState(true);
  const [typed, setTyped] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    Db.restorePreflight(backup.folderId)
      .then(r => { if (alive) { setCheck(r); setChecking(false); } })
      .catch(e => { if (alive) { setError(e.message || "Couldn't read that backup."); setChecking(false); } });
    return () => { alive = false; };
  }, [backup.folderId]);

  const ready = !!check && !check.tooNew && restoreNameMatches(typed, backup.name);

  const start = async () => {
    setStarting(true);
    setError("");
    try {
      await Db.restoreAll({ folderId: backup.folderId, folderName: backup.name, confirm: typed });
      onStarted();
    } catch (e) {
      setError(e.message || "The restore couldn't be started.");
      setStarting(false);
    }
  };

  return (
    <Dialog title="Restore everything" maxWidth={580} onClose={starting ? () => {} : onClose}
      actions={<>
        <Btn variant="secondary" onClick={onClose} disabled={starting}>Cancel</Btn>
        {/* The one button in the app that empties the database. It wore the
            same blue as Save settings. */}
        <Btn variant="danger" disabled={!ready || starting} onClick={start}
          title={check && check.tooNew
            ? "That backup is newer than this app"
            : !ready ? "Type the backup's name to confirm" : undefined}>
          {starting ? "Starting…" : "Replace everything"}
        </Btn>
      </>}>
      <ErrorBox>{error}</ErrorBox>
      {checking && <Loading label="Reading that backup…" />}
      {check && (<>
        <div style={{ fontSize: 14 }}>
          <strong>{backup.name}</strong> holds {plural(check.rows || 0, "record")}, {plural(check.files || 0, "file")}{" "}
          ({mb(check.bytes || 0)}) and {plural(check.jobs || 0, "job")}.
        </div>

        {check.tooNew && (
          <div style={{ fontSize: 13, border: "1px solid var(--color-accent-700)", padding: "8px 10px" }}>
            <strong>This backup can&rsquo;t be restored here.</strong> It was taken from a newer version of the app
            (database {check.schema_version}) than this one ({check.live_schema_version}), so it holds things this
            app doesn&rsquo;t know about yet. Update the app first.
          </div>
        )}
        {!check.tooNew && check.older && (
          <div style={{ fontSize: 13, border: "1px solid var(--color-accent-700)", padding: "8px 10px" }}>
            <strong>This backup is older than the app.</strong> It was taken at database {check.schema_version}; this
            app is at {check.live_schema_version}. It will restore, but anything added to the app since then starts
            empty.
          </div>
        )}

        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 70%, transparent)" }}>
          What this does, in order: takes a complete backup of the app as it stands right now into a
          <strong> before-restore</strong> folder that is never tidied away; empties every table; re-creates any
          crew account that no longer exists and emails each of them a set-password link; loads every record
          from <strong>{backup.name}</strong>; and puts every PDF and picture back. If that first copy fails,
          nothing is emptied and nothing is restored.
        </div>
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 70%, transparent)" }}>
          Everything filed since that backup was taken will be gone &mdash; tickets, assessments, reports, chat,
          hours. Your own account keeps working throughout. The background error log and the audit trail are not
          in a backup and start empty. Passwords are never in a backup, which is why the crew get a link.
        </div>
        <div style={QUIET}>
          It runs on the server and keeps going whether this screen is open or not. A full restore takes about as
          long as the backup did.
        </div>

        {!check.tooNew && (
          <Field label={`Type the backup's name to confirm: ${backup.name}`}>
            <input className="input" value={typed} onChange={e => setTyped(e.target.value)}
              placeholder={backup.name} autoComplete="off" disabled={starting} style={{ width: "100%" }} />
          </Field>
        )}
      </>)}
    </Dialog>
  );
}

// Restore a few jobs — the everyday mistake, as opposed to the disaster.
//
// No typed word here, and that is the point rather than an oversight:
// nothing is deleted and nothing live is overwritten, so the worst outcome
// of pressing this by accident is that some old jobs come back and can be
// deleted again the ordinary way. What it needs instead is a way to find the
// right job among a year of them, which is the search box and the checkboxes.
//
// The list comes from the backup's own index — the manifest's jobs array,
// written when the backup was taken — so picking is a read of one small file
// rather than a walk of the whole backup.
export function RestoreJobsDialog({ backup, onClose, onStarted }) {
  const [manifest, setManifest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState(() => new Set());
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let alive = true;
    Db.backupManifest(backup.folderId)
      .then(m => { if (alive) { setManifest(m); setLoading(false); } })
      .catch(e => { if (alive) { setError(e.message || "Couldn't read that backup's index."); setLoading(false); } });
    return () => { alive = false; };
  }, [backup.folderId]);

  const jobs = (manifest && manifest.jobs) || [];
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? jobs.filter(j => `${j.job_number} ${j.client} ${j.project}`.toLowerCase().includes(needle))
    : jobs;

  const toggle = id => setChosen(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const start = async () => {
    setStarting(true);
    setError("");
    try {
      await Db.restoreJobs({ folderId: backup.folderId, folderName: backup.name, jobIds: [...chosen] });
      onStarted();
    } catch (e) {
      setError(e.message || "The restore couldn't be started.");
      setStarting(false);
    }
  };

  return (
    <Dialog title="Restore jobs" maxWidth={640} onClose={starting ? () => {} : onClose}
      actions={<>
        <Btn variant="secondary" onClick={onClose} disabled={starting}>Cancel</Btn>
        <Btn variant="primary" disabled={!chosen.size || starting} onClick={start}
          title={!chosen.size ? "Tick at least one job" : undefined}>
          {starting ? "Starting…" : `Restore ${plural(chosen.size, "job")}`}
        </Btn>
      </>}>
      <ErrorBox>{error}</ErrorBox>
      <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 70%, transparent)" }}>
        From <strong>{backup.name}</strong>. The chosen jobs come back with their tickets, charges, crew hours,
        assessments, reports and PDFs. Nothing already in the app is deleted or changed: a record that is still
        here is left alone, and a ticket number already in use is reported rather than duplicated. If a job&rsquo;s
        client or a crew member no longer exists, the restore says so instead of guessing.
      </div>
      {loading && <Loading label="Reading the backup’s index…" />}
      {!loading && !jobs.length && !error && <div style={QUIET}>That backup&rsquo;s index lists no jobs.</div>}
      {!loading && jobs.length > 0 && (<>
        <Field label="Find a job">
          <input className="input" value={query} onChange={e => setQuery(e.target.value)}
            placeholder="job number, client or project" autoComplete="off" style={{ width: "100%" }} />
        </Field>
        <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid var(--color-neutral-300)" }}>
          {shown.map(j => (
            <label key={j.id} style={{
              display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 10px",
              borderBottom: "1px solid var(--color-neutral-300)", cursor: "pointer"
            }}>
              <input type="checkbox" checked={chosen.has(j.id)} disabled={starting}
                onChange={() => toggle(j.id)} />
              <span style={{ fontSize: 13 }}>
                <strong>{j.job_number}</strong> &middot; {j.client || "no client on file"} &middot; {j.project || "—"}
                <span style={{ ...QUIET, display: "block" }}>
                  {j.status} &middot; raised {when(j.created_at)} &middot; {plural(j.tickets, "ticket")},{" "}
                  {plural(j.jhas, "assessment")}, {plural(j.reports, "report")}
                </span>
              </span>
            </label>
          ))}
          {!shown.length && <div style={{ ...QUIET, padding: "10px 12px" }}>Nothing matches that.</div>}
        </div>
        <div style={QUIET}>
          {plural(chosen.size, "job")} chosen of {plural(jobs.length, "job")} in this backup. It runs on the
          server and keeps going whether this screen is open or not; what it could not put back is listed on
          the panel when it finishes.
        </div>
      </>)}
    </Dialog>
  );
}
