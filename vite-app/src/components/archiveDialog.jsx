import { useState, useEffect, useRef } from "react";
import { Db } from "../db.js";
import { money } from "../data.js";
import { Btn, Dialog, ErrorBox, Field } from "./common.jsx";
import { saveBlob } from "../zip.js";
import { OfflineCache } from "../offlineCache.js";
import { buildArchive, archiveZipName, verifyZip, archiveDrift, archiveIds, mapLimit } from "../archive.js";

// Archive — the Admin screen's dropdown. A year, or a date range; every job
// raised in it is read in full and handed back as one zip, filed client →
// month → job (details as text, the JHA and report PDFs, each ticket's
// invoice). Then the check: the owner picks the zip that landed on disk and
// every file in it is compared with what was built. Only a zip that checks
// out — and a build with nothing left unretrieved — unlocks the question
// they asked for: clear those jobs from the app to start fresh? That is
// the one bulk delete in the app, so it is behind a typed word as well as
// a button, and it says exactly what it is about to remove, including any
// ticket still out for a client's signature.

const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const mb = bytes => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
// This device's own clock, deliberately: what it dates is when the zip landed
// on this computer, and it is only ever read on the computer it landed on.
const at = ms => new Date(ms).toLocaleString("en-CA", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" });

// The build that has already happened, kept on the device.
//
// Building a busy year is an hour of reading, and until now all of it — the
// manifest, the figures, which jobs were in it — lived in this component's
// state and nowhere else, so closing the dialog (or a reload, or the tab
// dying) threw the hour away and left a zip on disk that could never be
// checked. Held here, the owner can download in the afternoon, check the file
// in the morning, and still clear.
//
// It changes none of the three gates. The zip still has to be picked and
// matched against this manifest, the jobs are still re-read live immediately
// before the delete — which is what catches the work filed since, and a day-old
// build has had a day to gain some — and CLEAR still has to be typed. A day is
// the ceiling because past that the re-check would refuse most of the time
// anyway, and an offer nobody can act on is worse than none.
const BUILT_KEY = "archive.built";
const BUILT_GOOD_FOR_MS = 24 * 60 * 60 * 1000;
// How many jobs are re-read at once by the check that runs after CLEAR is
// typed. The same figure the build renders invoices at, for the same reason:
// enough to stop a busy year being a long silence, few enough not to drown a
// truck's connection.
const RECHECK_CONCURRENCY = 4;

export function ArchiveDialog({ mode, currentUser, onClose, onCleared }) {
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 6 }, (_, i) => thisYear - i);
  const [year, setYear] = useState(thisYear - (new Date().getMonth() < 2 ? 1 : 0));
  const [from, setFrom] = useState(isoDay(new Date(thisYear, 0, 1)));
  const [to, setTo] = useState(isoDay(new Date()));
  const rangeFrom = mode === "year" ? `${year}-01-01` : from;
  const rangeTo = mode === "year" ? `${year}-12-31` : to;
  const rangeOk = /^\d{4}-\d{2}-\d{2}$/.test(rangeFrom) && /^\d{4}-\d{2}-\d{2}$/.test(rangeTo) && rangeFrom <= rangeTo;

  // What the range holds, counted before anything is built — the number is
  // the sanity check ("342 jobs?" means the wrong year).
  const [jobs, setJobs] = useState(null);
  const [counting, setCounting] = useState(false);
  const [error, setError] = useState("");
  const seq = useRef(0);
  useEffect(() => {
    if (!rangeOk) { setJobs(null); return undefined; }
    const mine = ++seq.current;
    setCounting(true);
    const t = setTimeout(() => {
      Db.listJobsCreatedBetween(rangeFrom, rangeTo)
        .then(rows => { if (mine === seq.current) { setJobs(rows); setError(""); } })
        .catch(e => { if (mine === seq.current) { setJobs(null); setError(e.message || "Couldn't count the jobs in that range."); } })
        .finally(() => { if (mine === seq.current) setCounting(false); });
    }, 300);
    return () => clearTimeout(t);
  }, [rangeFrom, rangeTo, rangeOk]);

  // pick → building → built (check the download) → clearing → cleared
  const [stage, setStage] = useState("pick");
  const [progress, setProgress] = useState(null);
  const [summary, setSummary] = useState(null);
  const [manifest, setManifest] = useState(null);
  const [zipName, setZipName] = useState("");
  const [checking, setChecking] = useState(false);
  const [verified, setVerified] = useState(null);
  const [confirmWord, setConfirmWord] = useState("");
  const [cleared, setCleared] = useState(null);
  const busy = stage === "building" || stage === "clearing" || checking;
  const complete = !!summary && summary.missing.length === 0;
  const canClear = complete && !!verified && verified.ok;

  // A build this device is still holding, and — once it has been picked up —
  // the jobs that build covered. The held ids are what the clear acts on from
  // then on, never the range picker's count: the picker may well be sitting on
  // a different year, and deleting the jobs somebody happens to have counted
  // rather than the ones in the zip would be the worst bug this screen could
  // have. Both `id` (the job number, which is how a refusal names a job) and
  // `dbId` (what is deleted) are kept, because the re-check needs to say which
  // job stopped it.
  const [held, setHeld] = useState(null);
  const [resumed, setResumed] = useState(null);
  const activeJobs = resumed || jobs;

  useEffect(() => {
    let alive = true;
    OfflineCache.read(BUILT_KEY)
      .then(hit => {
        const v = hit && hit.value;
        if (!alive || !v || !v.manifest || !v.summary) return;
        if (Date.now() - Number(v.builtAt || 0) >= BUILT_GOOD_FOR_MS) { OfflineCache.remove(BUILT_KEY); return; }
        setHeld(v);
      })
      // Nothing is lost if this read fails: the offer is a shortcut, and the
      // way without it — build again — is the way it has always worked.
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const forgetBuilt = () => { setHeld(null); OfflineCache.remove(BUILT_KEY); };

  // Picking the held build up again: everything the check and the clear need,
  // straight into the stage that asks for the zip.
  const resume = () => {
    if (!held) return;
    setResumed(held.jobIds || []);
    setSummary(held.summary);
    setManifest(held.manifest);
    setZipName(held.zipName || "");
    setVerified(null);
    setConfirmWord("");
    setError("");
    setStage("built");
  };

  const build = async () => {
    if (!jobs || !jobs.length) return;
    setStage("building");
    setError("");
    setVerified(null);
    setConfirmWord("");
    // The previous build's figures, name and manifest go too. Building again
    // is what the dialog tells the owner to do when the archive came back
    // incomplete or the zip didn't check out, so nothing from the build being
    // replaced may outlive it — least of all the manifest, which is what the
    // next downloaded zip is checked against.
    setSummary(null);
    setManifest(null);
    setZipName("");
    // Including the copy on disk: it names a zip that is about to be replaced.
    forgetBuilt();
    setResumed(null);
    setProgress({ index: 0, count: jobs.length, job: jobs[0].id, step: "starting", bytes: 0 });
    try {
      const { blob, summary: s, manifest: m } = await buildArchive({
        jobs, mode, from: rangeFrom, to: rangeTo, by: currentUser ? currentUser.name : "",
        onProgress: setProgress, db: Db
      });
      const name = archiveZipName(mode, rangeFrom, rangeTo);
      saveBlob(blob, name);
      setZipName(name);
      setSummary(s);
      setManifest(m);
      setStage("built");
      // Written after the download, so what is held is only ever a build whose
      // zip actually reached the disk. It is read straight back before this
      // screen believes it: everything the dialog says about closing and coming
      // back rests on the copy being there, and a storage that quietly refused
      // the write would make that a promise nobody could keep. A device that
      // cannot remember it still has the build on screen, which is where it was
      // before this existed.
      const keep = {
        zipName: name, manifest: m, summary: s, builtAt: Date.now(),
        jobIds: jobs.map(j => ({ id: j.id, dbId: j.dbId }))
      };
      OfflineCache.put(BUILT_KEY, keep)
        .then(() => OfflineCache.read(BUILT_KEY))
        .then(hit => { if (hit) setHeld(keep); })
        .catch(() => {});
    } catch (e) {
      setError(e.message || "The archive couldn't be built.");
      setStage("pick");
    }
  };

  // "Build it again" from the built stage. A build picked up from the device
  // holds only what the check and the clear need — the ids, not the jobs
  // themselves — so there is nothing here to build from and the button goes
  // back one step to the picker, which counts the range afresh.
  const buildAgain = () => {
    forgetBuilt();
    if (!resumed) { build(); return; }
    setResumed(null);
    setSummary(null);
    setManifest(null);
    setZipName("");
    setVerified(null);
    setConfirmWord("");
    setError("");
    setStage("pick");
  };

  // The proof: the file the owner picks is read back and every entry the
  // build wrote must be there, the same size, with the same checksum.
  const checkDownload = async file => {
    if (!file || !manifest) return;
    setChecking(true);
    setVerified(null);
    setError("");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setVerified({ ...verifyZip(bytes, manifest), file: file.name, size: bytes.length });
    } catch (e) {
      setError(e.message || "Couldn't read that file.");
    }
    setChecking(false);
  };

  // The build and this button can be minutes or hours apart, and nothing has
  // stopped the crew filing work against these jobs in between: a ticket
  // raised at 16:20 against a job archived at 16:00 is not in the zip, and
  // checking the download cannot see that — it only proves the file on disk
  // is the build. So the three lists are read again, live, immediately before
  // the delete, and a job that has changed stops it. Read live or not at all:
  // this device's remembered copy would answer with the counts the build
  // already agreed with, which is the one answer that proves nothing. A read
  // that fails refuses too — "couldn't check" is not "nothing has changed".
  //
  // A few jobs at a time rather than one after another: this is three reads
  // per job, and a busy year walked serially is thousands of round trips with
  // the dialog saying nothing after the owner typed CLEAR. Every job is still
  // read, and the answers are scanned in the jobs' own order, so whichever
  // job stops the clear is named the same way every time.
  const [checkedJobs, setCheckedJobs] = useState(0);
  const recheckJobs = () => OfflineCache.liveOnly(async () => {
    const counts = (summary && summary.jobCounts) || {};
    setCheckedJobs(0);
    let done = 0;
    const problems = await mapLimit(activeJobs, RECHECK_CONCURRENCY, async j => {
      try {
        const [tickets, jhas, reports] = await Promise.all([
          Db.listTicketsForJob(j.dbId), Db.listJhasForJob(j.dbId), Db.listReportsForJob(j.dbId)
        ]);
        const drift = archiveDrift(j, counts[String(j.dbId)], { tickets: tickets.length, jhas: jhas.length, reports: reports.length, ids: archiveIds(tickets, jhas, reports) });
        return drift ? `${drift} Nothing has been removed.` : "";
      } catch (e) {
        return `Job ${j.id} couldn't be checked against the app before clearing: ${e.message || "the read failed"}. Nothing has been removed — try again when the connection is better.`;
      } finally {
        setCheckedJobs(++done);
      }
    });
    return problems.find(Boolean) || "";
  });

  const clear = async () => {
    if (!activeJobs || !activeJobs.length || !canClear || confirmWord.trim().toUpperCase() !== "CLEAR") return;
    setStage("clearing");
    setError("");
    try {
      const drift = await recheckJobs();
      if (drift) { setError(drift); setStage("built"); return; }
      const result = await Db.archiveClearJobs(activeJobs.map(j => j.dbId));
      setCleared(result);
      setStage("cleared");
      // The jobs it named are gone, so the offer to check that zip is over.
      forgetBuilt();
      if (onCleared) onCleared(result);
    } catch (e) {
      setError(e.message || "The jobs couldn't be cleared.");
      setStage("built");
    }
  };

  // The two accidental ways out of the dialog — the grey backdrop and
  // Escape — ask first once there is something to lose. At "built" the
  // manifest, the summary and the zip's name are what the downloaded zip is
  // checked against; without a copy on the device they are here and nowhere
  // else, so closing means the file stays on disk, the check can never be
  // satisfied, and the way back is another build, which on a busy year is
  // another hour of reading. With the copy on the device — confirmed written,
  // see build() — closing costs nothing: the dialog offers it back for a day.
  // The buttons are somebody deciding and are left alone — "Keep the jobs"
  // says what it does.
  const requestClose = () => {
    if (stage === "built" && !held &&
      !confirm("The archive is built but not yet checked. Close anyway? You would have to build it again.")) return;
    onClose();
  };

  const title = mode === "year" ? "Archive a year" : "Archive a date range";
  const rangeLabel = mode === "year" ? String(year) : `${rangeFrom} to ${rangeTo}`;
  const count = activeJobs ? activeJobs.length : 0;

  const actions = stage === "pick" ? (
    <>
      <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
      <Btn variant="primary" onClick={build} disabled={!rangeOk || counting || !count}>
        {counting ? "Counting…" : count ? `Build the archive · ${plural(count, "job")}` : "Nothing to archive"}
      </Btn>
    </>
  ) : stage === "building" ? (
    <Btn variant="secondary" disabled>Building…</Btn>
  ) : stage === "built" ? (
    <>
      <Btn variant="secondary" onClick={onClose}>Keep the jobs</Btn>
      {/* Both ways out of a bad build — an incomplete archive, and a zip that
          didn't check out — end with the words "build it again", and until now
          there was nothing here to do it with: the owner had to close the
          dialog and start over from the year picker. */}
      <Btn variant="secondary" onClick={buildAgain} disabled={checking}>Build it again</Btn>
      <Btn variant="danger" onClick={clear} disabled={!canClear || confirmWord.trim().toUpperCase() !== "CLEAR"}
        title={!complete ? "The archive is not complete — see above" : !verified ? "Check the downloaded zip first" : !verified.ok ? "The downloaded zip did not check out" : undefined}>
        Clear {plural(count, "job")} from the app
      </Btn>
    </>
  ) : stage === "clearing" ? (
    <Btn variant="secondary" disabled>Clearing…</Btn>
  ) : (
    <Btn variant="primary" onClick={onClose}>Done</Btn>
  );

  return (
    <Dialog title={title} maxWidth={580} onClose={busy ? () => {} : requestClose} actions={actions}>
      <ErrorBox>{error}</ErrorBox>

      {/* The check before the delete is minutes of reading on a big year, and
          a dialog that only says "Clearing…" through it looks stuck at the
          exact moment nobody should be tempted to close it. */}
      {stage === "clearing" && (
        <div style={{ fontSize: 13 }}>
          {checkedJobs < count
            ? `Checking the app against the archive — job ${Math.min(checkedJobs + 1, count)} of ${count}…`
            : `Checked all ${plural(count, "job")}. Removing them…`}
        </div>
      )}

      {/* An archive built earlier and never checked. It is offered first,
          above the year picker, because building the same year a second time
          is the expensive mistake this is here to stop. */}
      {stage === "pick" && held && (
        <div style={{ fontSize: 13, border: "1px solid var(--color-accent)", padding: "8px 10px" }}>
          <strong>You built {held.zipName} at {at(held.builtAt)}</strong> — {plural((held.jobIds || []).length, "job")},
          {" "}and the download was never checked. The zip is still on this computer.
          <div style={{ marginTop: 8 }}>
            <Btn variant="secondary" onClick={resume}>Check that zip</Btn>
          </div>
          <div style={{ marginTop: 6, fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
            Or pick a range below and build again, which forgets this one.
          </div>
        </div>
      )}

      {stage === "pick" && (<>
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
          Every job raised in the period, filed client → month → job: the job's details as a text file, its hazard
          assessments and reports as the PDFs on file, and each ticket's field invoice, in one zip. Jobs are picked by
          the day they were raised. Nothing is changed in the app by building the archive.
        </div>
        {mode === "year" ? (
          <Field label="Year">
            <select className="input" value={year} onChange={e => setYear(Number(e.target.value))}>
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </Field>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="From"><input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field>
            <Field label="To"><input className="input" type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>
          </div>
        )}
        <div style={{ fontSize: 14 }}>
          {!rangeOk ? "Pick a range that starts before it ends."
            : counting ? "Counting the jobs…"
            : jobs ? (count ? `${plural(count, "job")} raised in ${rangeLabel}.` : `No jobs were raised in ${rangeLabel}.`)
            : ""}
        </div>
        <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
          Building reads every PDF and renders every ticket's invoice over the connection: minutes for a quiet month,
          but a busy year is thousands of files and can run to an hour or more. Start it on a desk, not on a phone,
          and leave this dialog open until the download appears — the next step checks it.
        </div>
      </>)}

      {stage === "building" && progress && (
        <div>
          <div style={{ fontSize: 14, marginBottom: 6 }}>
            {progress.step === "zipping"
              ? "Zipping…"
              : `Job ${Math.min(progress.index + 1, progress.count)} of ${progress.count} · ${progress.job} · ${progress.step}`}
          </div>
          <div style={{ height: 6, background: "color-mix(in srgb, var(--color-text) 10%, transparent)" }}>
            <div style={{ height: "100%", width: `${Math.round((Math.min(progress.index, progress.count) / Math.max(1, progress.count)) * 100)}%`, background: "var(--color-accent)", transition: "width .2s" }} />
          </div>
          <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginTop: 6 }}>{mb(progress.bytes)} so far</div>
        </div>
      )}

      {(stage === "built" || stage === "clearing") && summary && (<>
        <div style={{ fontSize: 14 }}>
          <strong>Built and downloaded as {zipName}</strong> — {plural(summary.jobs, "job")} for {plural(summary.clients, "client")}:
          {" "}{plural(summary.tickets, "ticket")} ({money(summary.beforeGstCents / 100)} before GST), {plural(summary.jhas, "assessment PDF")},
          {" "}{plural(summary.reports, "report PDF")}, {plural(summary.invoices, "invoice")} · {mb(summary.bytes)}.
        </div>
        {/* Resumed, so the figures above are from earlier and the app has had
            time to move on. Nothing is taken on trust for that: the jobs are
            read again live the moment CLEAR is pressed, and one that has
            gained a ticket since stops it. */}
        {resumed && held && (
          <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
            Built at {at(held.builtAt)}. Anything filed against these jobs since then is not in the zip — the jobs are
            checked against the app again before anything is removed, and one that has changed stops the clear.
          </div>
        )}
        {summary.notOnFile.length > 0 && (
          <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
            {plural(summary.notOnFile.length, "assessment or report has", "assessments or reports have")} no PDF on file — nothing to retrieve; their details are in the job text files and the README names them.
          </div>
        )}
        {!complete && (
          <div style={{ fontSize: 13, border: "1px solid var(--color-accent-700)", padding: "8px 10px" }}>
            <strong>This archive is not complete.</strong> {plural(summary.missing.length, "item")} could not be retrieved and {summary.missing.length === 1 ? "is" : "are"} listed in the zip's README.txt.
            Clearing is off. Build it again once the connection is better; if the same items fail, they need looking at before anything is removed.
          </div>
        )}

        <div style={{ fontSize: 13, marginTop: 4 }}>
          <strong>Check the download.</strong> Pick the zip that just landed on this computer. Every file in it is
          compared with what was built — {plural(manifest ? manifest.length : 0, "file")} — before clearing is offered.
        </div>
        <Field label="The downloaded zip">
          <input className="input" type="file" accept=".zip,application/zip" disabled={checking || stage === "clearing"}
            onChange={e => { const f = e.target.files && e.target.files[0]; e.target.value = ""; checkDownload(f); }} />
        </Field>
        {checking && <div style={{ fontSize: 13 }}>Checking…</div>}
        {verified && verified.ok && (
          <div style={{ fontSize: 13, border: "1px solid var(--color-accent)", padding: "8px 10px" }}>
            <strong>Verified.</strong> {verified.file} ({mb(verified.size)}) holds all {plural(verified.checked, "file")} that {verified.checked === 1 ? "was" : "were"} built, each intact.
          </div>
        )}
        {verified && !verified.ok && (
          <div style={{ fontSize: 13, border: "1px solid var(--color-accent-700)", padding: "8px 10px" }}>
            <strong>That file did not check out.</strong> {verified.reason || `${plural(verified.problems.length, "problem")}:`}
            {verified.problems.length > 0 && (
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12 }}>
                {verified.problems.slice(0, 8).map(p => <li key={p}>{p}</li>)}
                {verified.problems.length > 8 && <li>…and {verified.problems.length - 8} more</li>}
              </ul>
            )}
            <div style={{ marginTop: 6, fontSize: 12 }}>Make sure you picked the zip this dialog just downloaded; if it was, download it again by building again.</div>
          </div>
        )}

        {canClear && (<>
          <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)", marginTop: 4 }}>
            Clearing removes these {plural(summary.jobs, "job")} and everything filed against them — tickets{summary.awaiting ? ` (${summary.awaiting} still out for the client's signature)` : ""},
            {" "}assessments, reports and their PDFs — from the app. The zip on this computer is then the only copy. This can't be undone.
          </div>
          <Field label="Type CLEAR to confirm">
            <input className="input" value={confirmWord} onChange={e => setConfirmWord(e.target.value)} placeholder="CLEAR" autoComplete="off" disabled={stage === "clearing"} />
          </Field>
        </>)}
      </>)}

      {stage === "cleared" && cleared && (
        <div style={{ fontSize: 14 }}>
          <strong>Cleared.</strong> {plural(cleared.jobs, "job")}, {plural(cleared.tickets, "ticket")}, {plural(cleared.jhas, "assessment")} and {plural(cleared.reports, "report")} are gone from the app.
          {cleared.filesLeft ? ` ${plural(cleared.filesLeft, "PDF")} couldn't be removed from storage and can be cleaned up from the Supabase dashboard.` : " Their PDFs were removed from storage too."}
        </div>
      )}
    </Dialog>
  );
}
