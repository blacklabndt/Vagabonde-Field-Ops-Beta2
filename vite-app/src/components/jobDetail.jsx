import { useState, useEffect, useMemo, useRef } from "react";
import { money, todayLocal, localDate, dayMonth, initialsOf, ticketDateStamp, lastNumbers, JOB_FIELDS, EMPTY_JOB_RECORD, seesPrices as pricesFor, fileSize, reportFileRefusal, MAX_REPORT_LABEL, decimalString, contactsForOrg } from "../data.js";
import { acceptsNumberText } from "../numberInput.js";
import { serialsOnProfile, newSerials, mergedSerials, isMissingSetOwnDosimetry, dosimetryAskedFor, markDosimetryAsked } from "../dosimetryPrompt.js";
import { Db } from "../db.js";
import { describeScheduled } from "../scheduledSends.js";
import { OfflineCache } from "../offlineCache.js";
import { OfflineQueue } from "../offlineQueue.js";
import { deviceOffline } from "../savingWords.js";
import { Toasts } from "../toastBus.js";

// An idempotency key for a save (see Db.createTicket / uploadReport).
const newClientKey = () => (crypto.randomUUID ? crypto.randomUUID() : null);
import { tabList, Blueprint, Btn, TableScroll, TagX, Field, PdfGlyph, PdfLink, Dialog, ErrorBox, emailIn, contactLabel, splitContact, StatusTag, useMissingFields, SearchSelect, Loading, LoadingRow, ContactText } from "./common.jsx";

export function JobDetailScreen({ job, currentUser, onStartJha, onOpenTicket, onStartTicket, jobRecord, setJobRecord, onJobChanged, onJobDeleted, refreshKey = 0 }) {
  // Prices — rate cards, ticket lines, the amounts they add up to — are for
  // Admins and Technicians (the database refuses the lines to anyone else,
  // per the "round two" migration). Everyone else sees the ticket's number,
  // date and status, which is what a Helper needs.
  const seesPrices = pricesFor(currentUser);
  // Raising a ticket needs the ticket tab. This is button visibility, not a
  // tab change — the tabs themselves stay exactly as Users & access set them,
  // and the billing screen is still reachable for anyone who has that tab
  // even though CONTEXT_TABS keeps it out of the drawer. What it stops is a
  // Helper (job tab, no ticket tab) starting a ticket the rate card would
  // come back empty for: row-level security hands their account no rate
  // lines, so the day filed as a numbered $0 draft with the crew's hours on
  // it. Asked of tabList, the same question the drawer asks, so the two can
  // never drift apart — and of seesPrices too, because the editor behind the
  // button refuses a role that cannot read prices (a Coordinator holds the
  // tab and would otherwise be sent to a screen that turns them away).
  const canRaiseTickets = tabList(currentUser.tabs).includes("ticket") && seesPrices;
  // Filing a report needs the report tab, for the same reason and in the
  // same words: a Helper holds the job tab, and the job tab was all
  // reports_insert and the reports bucket ever asked for — so the button
  // was there for them and the API took the upload. Asked of tabList, so it
  // can't drift from what Users & access set. The button is only half of
  // it: round six's migration takes the job arm off both write policies,
  // because a button is a courtesy and the policy is the gate.
  const canUploadReports = tabList(currentUser.tabs).includes("upload");
  const [showUpload, setShowUpload] = useState(false);
  const [showTicket, setShowTicket] = useState(false);
  const [editingRecord, setEditingRecord] = useState(false);
  const [draft, setDraft] = useState(jobRecord);
  const [savingRecord, setSavingRecord] = useState(false);
  const [recordError, setRecordError] = useState("");
  // Whether THIS job's record has landed. Until it has, the panel is showing
  // an empty record and the screens downstream of it would be reading one —
  // so Edit and the draft-ticket rows wait for it rather than acting on a
  // record that isn't this job's.
  const [recordLoaded, setRecordLoaded] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState("");
  // The filed read's own failure, apart from a status change's: it is the
  // Delete job gate, and a "Mark complete" that blanked the shared box
  // re-armed the button over three cards still reading "None on file yet".
  const [filedError, setFiledError] = useState("");
  const [closingJha, setClosingJha] = useState(null);
  // The assessment or report being emailed — each holds its row so the
  // dialog can name the file it's about to send.
  const [sendingJha, setSendingJha] = useState(null);
  // Sends waiting for their time on this job, and ones that failed — read
  // live with the cards, never from the device cache.
  const [scheduled, setScheduled] = useState([]);
  const [cancellingId, setCancellingId] = useState("");
  const [scheduledError, setScheduledError] = useState("");
  const [sendingReport, setSendingReport] = useState(null);
  const [deletingJhaId, setDeletingJhaId] = useState(null);
  const [deletingReportId, setDeletingReportId] = useState(null);
  const [withdrawingId, setWithdrawingId] = useState(null);
  const [deleting, setDeleting] = useState(false);
  // A ticket opened to be read rather than edited. Holds the ticket id; the
  // dialog fetches its lines and crew itself.
  const [viewingTicket, setViewingTicket] = useState(null);
  // Rendering the PDF is best-effort in the background, so a failure used to
  // be invisible — the link simply wouldn't open. This puts the function's
  // own error on screen and lets it be retried.
  const [rendering, setRendering] = useState(null);
  // Which JHA row has its maintenance actions (send, re-render, delete)
  // unfolded — one at a time.
  const [moreJha, setMoreJha] = useState(null);
  // Keyed by row id (a JHA's or a report's), not a single string: one message
  // in screen state was drawn beside every row on the table, so a failure on
  // one assessment read as a failure on all of them.
  const [rowError, setRowError] = useState({});

  // A completed job is a closed book: nothing can be added to it until an admin
  // reopens it. Only admins see the switch — closing a job decides what a
  // client gets invoiced for, so it isn't a field decision.
  const complete = job && job.status === "Complete";
  const isAdmin = currentUser.role === "Admin";
  // Admins and technicians — the techs who file assessments and reports
  // clean up their own. Matches the jhas/reports delete policies; a helper
  // doesn't get the buttons because the database would refuse them anyway.
  const canDeleteFiled = isAdmin || currentUser.role === "Technician";
  // A JHA's delete is narrower than a report's (20260826032406): an Admin,
  // or the Technician who signed it. The button was offered to every
  // Technician and the database refused the others' presses.
  const canDeleteJha = j => isAdmin || (currentUser.role === "Technician" && j.signedById === currentUser.id);

  const toggleComplete = async () => {
    if (!complete && !confirm(`Mark ${job.id} complete? No more JHAs, reports or tickets can be added to it until it's reopened.`)) return;
    setStatusBusy(true);
    setStatusError("");
    try {
      await Db.setJobComplete(job.dbId, !complete);
      if (onJobChanged) await onJobChanged();
    } catch (e) {
      setStatusError(e.message || "Couldn't change the job's status.");
    }
    setStatusBusy(false);
  };

  const [jhas, setJhasNow] = useState([]);
  const [reports, setReportsNow] = useState([]);
  const [tickets, setTicketsNow] = useState([]);
  // Every fill of the three cards belongs to the job it was read for, not
  // refresh() alone: a delete's or a withdraw's own re-read landing after a
  // job change put one job's records in another job's card. The closure
  // carries the job this render was for; the ref carries the one on screen.
  const openJob = useRef(job && job.dbId);
  openJob.current = job && job.dbId;
  const forOpenJob = (set, at) => rows => { if (openJob.current === at) set(rows); };
  const setJhas = forOpenJob(setJhasNow, job && job.dbId);
  const setReports = forOpenJob(setReportsNow, job && job.dbId);
  const setTickets = forOpenJob(setTicketsNow, job && job.dbId);
  // Daily billing shows five tickets at a time. A long job runs to dozens of
  // days, and the card is one of four on a phone screen: a technician looking
  // for today's draft was scrolling past a month of signed bills to reach
  // the report card underneath. The count and the total below the table are
  // still over every ticket — paging is how the list is read, not what the
  // job adds up to. Newest first, so today's draft is on the first page.
  const [ticketPage, setTicketPage] = useState(0);
  const [loading, setLoading] = useState(true);

  // Split so a mutation on one card (uploading a report, closing a JHA)
  // only reloads that one list, not all three — a job with a long history
  // used to re-download its whole JHA/report/ticket record after every
  // single save.
  const refreshJhas = () => Db.listJhasForJob(job.dbId).then(setJhas).catch(e => console.error("Failed to load JHAs:", e.message));

  // Removing an assessment. confirm() rather than a dialog of its own: one
  // row, named by its file, and the database re-checks who may do it.
  const deleteJha = async j => {
    if (!confirm(`Delete ${j.file}? The assessment and its PDF are removed for good.`)) return;
    setDeletingJhaId(j.id);
    setRowError(p => ({ ...p, [j.id]: "" }));
    try { await Db.deleteJha(j.id); await refreshJhas(); }
    catch (e) { setRowError(p => ({ ...p, [j.id]: e.message || "Couldn't delete the assessment." })); }
    setDeletingJhaId(null);
  };
  const refreshReports = () => Db.listReportsForJob(job.dbId).then(setReports).catch(e => console.error("Failed to load reports:", e.message));

  // Same shape as deleteJha: one row, named by its file, re-checked by the
  // database.
  const deleteReport = async r => {
    if (!confirm(`Delete ${r.file}? The report and its PDF are removed for good.`)) return;
    setDeletingReportId(r.id);
    setRowError(p => ({ ...p, [r.id]: "" }));
    try { await Db.deleteReport(r.id); await refreshReports(); }
    catch (e) { setRowError(p => ({ ...p, [r.id]: e.message || "Couldn't delete the report." })); }
    setDeletingReportId(null);
  };
  const refreshTickets = () => Db.listTicketsForJob(job.dbId).then(setTickets).catch(e => console.error("Failed to load tickets:", e.message));

  // Pulling a sent ticket back before the client signs it. The wording says
  // exactly what changes: the link dies, the ticket reopens as a draft.
  //
  // "Cancel and edit" is the same act with the editor opened straight after,
  // because pulling a ticket back is nearly always the first half of fixing
  // it — and the two-step version (cancel here, find the row, tap Edit) was
  // what the owner asked to be one step. The editor is only opened once the
  // list has been re-read and the ticket is a draft again; the openers below
  // refuse anything else.
  // Answers whether the person agreed, so a caller that closed something to
  // ask (the viewer) can leave it open on a "no". The editor is opened only
  // when the list has been re-read as well: a withdraw that landed and a
  // refresh that failed used to navigate away from the error it had just
  // written, so it was never read.
  const cancelApproval = async (t, thenEdit = false) => {
    const tail = thenEdit ? " It opens for editing straight away." : " The ticket goes back to Draft to be fixed and resent.";
    if (!confirm(`Cancel the approval request for ${t.id}? The client's signing link stops working.${tail}`)) return false;
    setWithdrawingId(t.id);
    setRowError(p => ({ ...p, [t.id]: "" }));
    let refreshed = false;
    try {
      await Db.withdrawTicketApproval(t.id);
      // The read is done here rather than through refreshTickets, which
      // catches its own failure — through it `refreshed` was always true, the
      // message below was unreachable, and "Cancel and edit" opened the editor
      // on a list that had never been re-read.
      try { setTickets(await Db.listTicketsForJob(job.dbId)); refreshed = true; }
      catch (e) { setRowError(p => ({ ...p, [t.id]: `The approval was cancelled, but the list couldn't be re-read: ${e.message || "reload the job."}` })); }
    } catch (e) { setRowError(p => ({ ...p, [t.id]: e.message || "Couldn't cancel the approval." })); }
    setWithdrawingId(null);
    if (refreshed && thenEdit) onOpenTicket(t.id);
    return true;
  };
  // Read here rather than through the three refreshers, which swallow their
  // own failures: a failed first load left three cards reading "None on file
  // yet" and the delete dialog saying nothing had been filed against the
  // job, with its button enabled and no typed confirmation.
  // Which job's read is the current one, the way the record read below is
  // guarded: opening two jobs quickly left whichever finished last in the
  // three cards, under the other job's name.
  const filedSeq = useRef(0);
  const refresh = async () => {
    const mine = ++filedSeq.current;
    const fresh = set => rows => { if (mine === filedSeq.current) set(rows); };
    setLoading(true);
    setFiledError("");
    const out = await Promise.allSettled([
      Db.listJhasForJob(job.dbId).then(fresh(setJhas)),
      Db.listReportsForJob(job.dbId).then(fresh(setReports)),
      Db.listTicketsForJob(job.dbId).then(fresh(setTickets)),
      Db.listScheduledSendsForJob(job.dbId).then(fresh(setScheduled))
    ]);
    if (mine !== filedSeq.current) return;
    const bad = out.find(r => r.status === "rejected");
    if (bad) setFiledError(`Couldn't read what's filed against ${job.id}: ${(bad.reason && bad.reason.message) || "the read failed."} The cards below are incomplete — reload before deleting anything.`);
    setLoading(false);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the cards are read once per job; App remounts this screen when another job opens
  useEffect(() => { if (job && job.dbId) { setTicketPage(0); refresh(); } }, [job ? job.dbId : null]);

  // App bumps refreshKey after Ask's card sent, scheduled or cancelled
  // something on this job while the page was open; the mount read above
  // already has the value the screen opened with, so only a change counts.
  const seenRefresh = useRef(refreshKey);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on the signal alone; refresh is a per-render function over the same job
  useEffect(() => {
    if (refreshKey === seenRefresh.current) return;
    seenRefresh.current = refreshKey;
    if (job && job.dbId) refresh();
  }, [refreshKey]);

  // The record is derived from the job row and the contact directory, so it
  // reloads whenever you open a different job instead of showing the last one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the record is read once per job, and a different job remounts the whole screen
  useEffect(() => {
    if (!job || !job.dbId) return;
    let live = true;
    // Blanked before the read, not after it. The record is App's, shared with
    // the ticket and hazard-assessment screens, and it arrives here still
    // holding the last job opened. A failed read used to leave that one under
    // this job's name: the wrong client rep, contractor rep, AFE, LSD and
    // area on the panel — and Edit → Save would have written them onto this
    // job, filing the other client's rep against this one.
    setRecordLoaded(false);
    setRecordError("");
    setJobRecord(EMPTY_JOB_RECORD);
    Db.getJobRecord(job)
      // Guard against an out-of-order response: opening two jobs quickly used
      // to leave whichever request finished last in the panel, regardless of
      // which job was actually on screen.
      .then(r => { if (!live) return; setJobRecord(r); setRecordLoaded(true); })
      .catch(e => {
        if (!live) return;
        console.error("Failed to load job record:", e.message);
        setRecordError(e.message || "Couldn't load this job's record.");
      });
    return () => { live = false; };
  }, [job ? job.dbId : null]);

  // The contact directory, so the record's rep fields can be picked rather
  // than retyped. Db caches it, so this costs nothing on a second open.
  const [contacts, setContacts] = useState([]);
  // An empty directory is what the send dialog reports as "No client contacts
  // on file for this job", and what the record's rep pickers offer. A failed
  // read must not be mistaken for either.
  useEffect(() => { Db.listContacts().then(setContacts).catch(e => { setContacts([]); Toasts.show(`Couldn't read the contact directory: ${e.message || "the read failed."} Reps have to be typed until it loads.`, "error"); }); }, []);
  // The contractor can be retyped in the same edit, and a contractor that
  // isn't on file yet has no people on file either — so the rep list follows
  // the draft, not the saved job.
  const contractorRenamed = draft && (draft.contractor || "").trim().toLowerCase() !== (job.contractor || "").trim().toLowerCase();
  const contractorIdForDraft = contractorRenamed ? null : job.contractorId;
  // The two rep editors' people, from data.js's contactsForOrg, held on the
  // directory and the id: the edit form re-renders on every keystroke and
  // the directory is a thousand rows on the live project.
  const clientPeople = useMemo(() => contactsForOrg(contacts, "client", job.clientId), [contacts, job.clientId]);
  const contractorPeople = useMemo(() => contactsForOrg(contacts, "contractor", contractorIdForDraft), [contacts, contractorIdForDraft]);
  // The send dialogs offer the saved job's contractor, not the draft's.
  const contractorPeopleOnFile = useMemo(() => contactsForOrg(contacts, "contractor", job.contractorId), [contacts, job.contractorId]);

  // Confirmation that the save actually landed, rather than the panel just
  // flipping back to read-only and leaving you to guess.
  const [savedNote, setSavedNote] = useState(false);
  const savedTimer = useRef(null);
  useEffect(() => () => clearTimeout(savedTimer.current), []);

  const saveRecord = async () => {
    setSavingRecord(true);
    setRecordError("");
    try {
      await Db.updateJobRecord(job, draft);
      // Rebuild the joined display strings from the parts just edited — the
      // read-only view and the ticket dialog both read those, so reusing the
      // draft's stale ones would show the old rep until the next reload.
      const fmtRep = r => r ? [r.name, r.phone, r.email].filter(Boolean).join(" · ") : "";
      setJobRecord({
        ...draft,
        clientRep: fmtRep(draft.clientRepDetail),
        contractorRep: fmtRep(draft.contractorRepDetail)
      });
      setEditingRecord(false);
      setSavedNote(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSavedNote(false), 4000);
      // A rep edit can add someone to the directory, so the picker shouldn't
      // still be showing yesterday's list.
      Db.listContacts().then(setContacts).catch(() => {});
      // Pull the jobs list again so the dispatch board's Contractor column
      // reflects what was just typed here.
      if (onJobChanged) await onJobChanged();
    } catch (e) {
      setRecordError(e.message || "Couldn't save the job record.");
    }
    setSavingRecord(false);
  };

  // The most recent filed JHA, for the "Signed …" tag and template beside the
  // panel heading. Nothing else is read off it now — the hazards it covered
  // are on the assessment itself rather than summarised here.
  const latestJha = jhas[0];
  // Integer cents, like every other total in the app — a running float sum
  // of dollars is the one thing CLAUDE.md forbids outright.
  const ticketTotal = tickets.reduce((s, t) => s + Math.round(Number(t.amount || 0) * 100), 0) / 100;
  const awaitingApproval = tickets.some(t => t.status === "Awaiting approval");
  // Clamped rather than reset: a ticket cancelled off the last page leaves
  // the reader on the page that still exists.
  const ticketPageCount = Math.max(1, Math.ceil(tickets.length / TICKETS_PER_PAGE));
  const safeTicketPage = Math.min(ticketPage, ticketPageCount - 1);
  const shownTickets = tickets.slice(safeTicketPage * TICKETS_PER_PAGE, safeTicketPage * TICKETS_PER_PAGE + TICKETS_PER_PAGE);

  // Who may remove this job.
  //
  // An admin, always. Otherwise the person who raised it, until something has
  // left the building: once a ticket has gone to a client for approval, or
  // been approved or invoiced, the job it names has to stay put. A draft is
  // the technician's own unsent work and goes with the job.
  //
  // The same rules are enforced in delete_job — this decides whether to offer
  // the button, not whether the delete is allowed.
  const raisedByMe = !!job.createdById && job.createdById === currentUser.id;
  const billedSomething = tickets.some(t =>
    t.status === "Awaiting approval" || t.status === "Approved" || t.status === "Invoiced");
  const canDelete = isAdmin || (raisedByMe && !billedSomething);

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 34, margin: 0 }}>{job.project}</h2>
        <StatusTag status={job.status} />
        {isAdmin && (
          <Btn variant={complete ? "secondary" : "primary"} style={{ marginLeft: "auto" }}
            disabled={statusBusy} onClick={toggleComplete}>
            {statusBusy ? "Saving…" : complete ? "Reopen job" : "Mark complete"}
          </Btn>
        )}
      </div>
      <ErrorBox>{filedError}</ErrorBox>
      <ErrorBox>{statusError}</ErrorBox>
      {complete && (
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)", marginBottom: 18 }}>
          This job is complete — it's kept as a record and nothing further can be added.{isAdmin ? " Reopen it to make changes." : " An admin can reopen it."}
        </div>
      )}

      {scheduled.length > 0 && (
        <Blueprint style={{ padding: "14px 20px", marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <h4 style={{ margin: 0, fontSize: 17 }}>Scheduled sends</h4>
            <span style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
              go out at their time whether or not the app is open
            </span>
          </div>
          <ErrorBox>{scheduledError}</ErrorBox>
          {scheduled.map(row => {
            const d = describeScheduled(row);
            return (
              <div key={row.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "6px 0", fontSize: 13, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ color: d.failed ? "var(--color-accent-700)" : undefined }}>{d.line}</div>
                  {d.error && <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>{d.error}</div>}
                </div>
                {/* The same conditional update Ask's Cancel it makes: zero
                    rows back means it already went, and the list re-reads
                    either way so the strip shows what is true. */}
                <Btn variant="secondary" disabled={cancellingId === row.id} onClick={async () => {
                  setCancellingId(row.id);
                  setScheduledError("");
                  try { await Db.cancelScheduledSend(row.id); }
                  catch (e) { setScheduledError(e.message || "Couldn't cancel that send."); }
                  try { setScheduled(await Db.listScheduledSendsForJob(job.dbId)); } catch { /* the next open re-reads */ }
                  setCancellingId("");
                }}>{cancellingId === row.id ? "Working…" : d.failed ? "Dismiss" : "Cancel"}</Btn>
              </div>
            );
          })}
        </Blueprint>
      )}

      {/* One column: the job record leads (order: -1), then the work filed
         against it. The record used to sit in a 320px rail beside all of it,
         which pushed the whole page wider than the header. */}
      {/* minmax(0, 1fr), never bare 1fr: a 1fr track floors at its widest
          child's min-content, so one table stretched the whole screen past
          a phone. Zero lets the track shrink and the TableScrolls inside
          actually scroll. */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 20 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

          {/* Hazard assessment */}
          <Blueprint style={{ padding: "18px 20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <h4 style={{ margin: 0, fontSize: 19 }}>Hazard assessment</h4>
              {latestJha && <TagX variant="accent">Signed {latestJha.at}</TagX>}
              {latestJha && latestJha.template && (
                <span style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{latestJha.template}</span>
              )}
              {/* Held back by the job's record for the reason Create ticket
                  and Edit are: the builder seeds the site rep from this
                  job's contractor rep, so a record that hasn't landed seeds
                  the last job's, and one whose reps couldn't be read seeds
                  the client's usual contact — and that name goes on a signed
                  assessment. */}
              <Btn variant="primary" style={{ marginLeft: "auto" }}
                disabled={complete || !recordLoaded || !!jobRecord.repsUnknown}
                title={complete ? undefined
                  : !recordLoaded ? "Waiting for this job's details"
                  : jobRecord.repsUnknown ? "This job's reps couldn't be read — the panel is showing the client's usual contacts. Reopen the job when you're back in signal."
                  : undefined}
                onClick={onStartJha}>+ New JHA</Btn>
            </div>
            {/* The hazards from the last JHA used to be listed here as a grid
                of chips. They are on the assessment itself, which is one tap
                away and is the copy that counts — repeating a summary of them
                on the job invited reading the panel as the current state of
                the job rather than as a record of what was filed. The list of
                assessments is what this panel is for. */}
            <TableScroll><table className="table">
              <thead><tr><th>File</th><th>Signed</th><th>Signer</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {loading && <LoadingRow cols={5} />}
                {!loading && jhas.length === 0 && <tr><td colSpan={5} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>None on file yet.</td></tr>}
                {jhas.map((j, i) => (
                  <tr key={j.id || i}>
                    <td>
                      <PdfLink file={j.file} pdfKey={j.pdfKey} bucket="jhas" />
                      {j.backdated && (
                        <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                          covers {dayMonth(localDate(j.workDate))}
                        </div>
                      )}
                      {j.sentAt && (
                        <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                          Sent {j.sentAt}{j.sentTo ? " · " + j.sentTo.split(",").join(", ") : ""}
                        </div>
                      )}
                    </td>
                    <td>{j.at}</td>
                    <td>{j.by}</td>
                    <td>{j.status === "Open"
                      ? <TagX variant="outline">Open — no end readings</TagX>
                      : <TagX variant="neutral">Closed {j.closedAt}</TagX>}</td>
                    <td style={{ textAlign: "right" }}>
                      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap" }}>
                        {rowError[j.id] && <span style={{ fontSize: 11, color: "var(--color-accent-700)", maxWidth: 320, textAlign: "left" }}>{rowError[j.id]}</span>}
                        {/* The day's action stands alone; the maintenance
                            ones (re-render, send, delete) sit behind "More"
                            — four equal buttons in one cell didn't survive a
                            phone, and "Re-render PDF" is not what anyone
                            comes to this row for. */}
                        {j.status === "Open" && !complete && (
                          <Btn variant="secondary" onClick={() => setClosingJha(j)}>Close out</Btn>
                        )}
                        <Btn variant="ghost" aria-expanded={moreJha === j.id}
                          onClick={() => setMoreJha(m => m === j.id ? null : j.id)}>{moreJha === j.id ? "Less" : "More…"}</Btn>
                        {moreJha === j.id && (<>
                          <Btn variant="secondary" disabled={!j.pdfKey}
                            title={j.pdfKey ? undefined : "Render the PDF first"}
                            onClick={() => setSendingJha(j)}>Send to…</Btn>
                          <Btn variant="ghost" disabled={rendering === j.id} onClick={async () => {
                            setRendering(j.id);
                            setRowError(p => ({ ...p, [j.id]: "" }));
                            try { await Db.renderJhaPdf(j.id); await refreshJhas(); }
                            catch (e) { setRowError(p => ({ ...p, [j.id]: e.message || "The PDF didn't render." })); }
                            setRendering(null);
                          }}>{rendering === j.id ? "Rendering…" : "Re-render PDF"}</Btn>
                          {canDeleteJha(j) && (
                            <Btn variant="ghost" disabled={complete || deletingJhaId === j.id}
                              title={complete ? "Reopen the job first" : undefined}
                              onClick={() => deleteJha(j)}>{deletingJhaId === j.id ? "Deleting…" : "Delete"}</Btn>
                          )}
                        </>)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></TableScroll>
          </Blueprint>

          {/* Radiographic reports */}
          <Blueprint style={{ padding: "18px 20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <h4 style={{ margin: 0, fontSize: 19 }}>Radiographic reports</h4>
              <span style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{reports.length} on file</span>
              {/* Waits on the record for the same reason Create ticket does:
                  the dialog seeds the address it sends to from
                  jobRecord.contractorRep, so a record that hasn't landed —
                  or whose reps couldn't be read — mails the interpretation
                  to whoever the last job or the client's usual contact
                  happens to be. */}
              {canUploadReports && (
                <Btn variant="primary" style={{ marginLeft: "auto" }}
                  disabled={complete || !recordLoaded || !!jobRecord.repsUnknown}
                  title={complete ? undefined
                    : !recordLoaded ? "Waiting for this job's details"
                    : jobRecord.repsUnknown ? "This job's reps couldn't be read — the panel is showing the client's usual contacts. Reopen the job when you're back in signal."
                    : undefined}
                  onClick={() => setShowUpload(true)}>+ Upload report</Btn>
              )}
            </div>
            <TableScroll><table className="table">
              <thead><tr><th>File</th><th>Last numbers</th><th>Uploaded</th><th>Sent</th><th></th></tr></thead>
              <tbody>
                {loading && <LoadingRow cols={5} />}
                {!loading && reports.length === 0 && <tr><td colSpan={5} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>None on file yet.</td></tr>}
                {reports.map((r, i) => (
                  <tr key={r.id || i}>
                    <td><PdfLink file={r.file} pdfKey={r.pdfKey} bucket="reports" /></td>
                    <td>{r.welds}</td>
                    <td>{r.at}</td>
                    <td>{r.sent === "Yes" ? (
                      <>
                        <div>{r.sentAt || "Yes"}</div>
                        {r.sentTo && (
                          <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                            {r.sentTo.split(",").join(", ")}
                          </div>
                        )}
                      </>
                    ) : "Pending"}</td>
                    <td style={{ textAlign: "right" }}>
                      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
                        {rowError[r.id] && <span style={{ fontSize: 11, color: "var(--color-accent-700)", maxWidth: 320, textAlign: "left" }}>{rowError[r.id]}</span>}
                        <Btn variant="secondary" disabled={!r.pdfKey}
                          title={r.pdfKey ? undefined : "The PDF didn't reach storage"}
                          onClick={() => setSendingReport(r)}>Send to…</Btn>
                        {canDeleteFiled && (
                          <Btn variant="ghost" disabled={complete || deletingReportId === r.id}
                            title={complete ? "Reopen the job first" : undefined}
                            onClick={() => deleteReport(r)}>{deletingReportId === r.id ? "Deleting…" : "Delete"}</Btn>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></TableScroll>
          </Blueprint>

          {/* Daily billing */}
          <Blueprint style={{ padding: "18px 20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <h4 style={{ margin: 0, fontSize: 19 }}>Daily billing</h4>
              {awaitingApproval && <TagX variant="outline">Awaiting client approval</TagX>}
              {/* Held back by the job's record for the same reason Edit is:
                  the Create ticket dialog pre-fills both reps from it, so a
                  record that hasn't landed seeds the last job's reps, and one
                  whose reps couldn't be read seeds the client's usual
                  contacts — either way a ticket goes out naming someone
                  nobody chose for this job. */}
              {canRaiseTickets && (
                <Btn variant="primary" style={{ marginLeft: "auto" }}
                  disabled={complete || !recordLoaded || !!jobRecord.repsUnknown}
                  title={complete ? undefined
                    : !recordLoaded ? "Waiting for this job's details"
                    : jobRecord.repsUnknown ? "This job's reps couldn't be read — the panel is showing the client's usual contacts. Reopen the job when you're back in signal."
                    : undefined}
                  onClick={() => setShowTicket(true)}>+ Create ticket</Btn>
              )}
            </div>
            <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginBottom: 10 }}>
              {!canRaiseTickets
                ? "The day's tickets, as they were raised. Billing is the technician's to fill in."
                : complete
                  ? "This job is complete. Tap a ticket to read it or send it to the client again."
                  : "Tap your own draft to add the day's welds, hours and crew. Anyone else's ticket, and every sent one, opens to read."}
            </div>
            <TableScroll><table className="table">
              <thead><tr><th>Ticket</th><th>Date</th><th>Technician</th>{seesPrices && <th>Amount</th>}<th>Status</th><th></th></tr></thead>
              <tbody>
                {loading && <LoadingRow cols={seesPrices ? 6 : 5} />}
                {!loading && tickets.length === 0 && <tr><td colSpan={seesPrices ? 6 : 5} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>None raised yet.</td></tr>}
                {shownTickets.map(t => {
                  // A draft on an open job is still being built, so its row
                  // opens the billing screen. Everything else opens read-only.
                  //
                  // It used to open nothing at all: a sent or approved ticket
                  // was inert, and on a completed job so was every row. That
                  // is right about not offering an editor that would refuse to
                  // save, and wrong about the rest — a finished job is exactly
                  // where someone needs to look up what was billed, and chase
                  // a client who never signed. Reading is not editing.
                  // …and only for an account that may raise one: without the
                  // ticket tab the editor opens onto an empty rate card, so
                  // "open this draft" is an invitation to file a $0 day.
                  // …and only for the technician whose ticket it is, or an
                  // Admin. Somebody else's draft opens read-only like a sent
                  // one: a technician taking over a job needs to see how the
                  // last one billed it, not to change it — the database
                  // refuses the save anyway (can_write_ticket), and an editor
                  // that cannot save is a trap, not a courtesy.
                  const mine = t.techId === currentUser.id;
                  const editable = t.status === "Draft" && !complete && canRaiseTickets && (isAdmin || mine);
                  // Reading a ticket is reading its bill; without the prices
                  // the row is information enough and opens nothing.
                  //
                  // A draft is tappable the moment it is listed, record or no
                  // record: openTicketDraft will not mount the editor until
                  // this job's record is in hand — it loads one itself when
                  // the panel's read hasn't landed yet, and says so if that
                  // fails. Making the row inert until then instead was a tap
                  // that did nothing at all, for as long as the contacts read
                  // takes, with only a tooltip to explain it.
                  const open = editable ? () => onOpenTicket(t.id)
                    : seesPrices ? () => setViewingTicket(t.id) : null;
                  // Sent but not signed: still ours to pull back. The same
                  // people withdraw_ticket_approval names (20260908044141):
                  // that technician, an admin, or the office. A Coordinator
                  // gets the plain cancel only — "Cancel and edit" stays
                  // behind the editor's own gate below.
                  const canWithdraw = t.status === "Awaiting approval"
                    && (isAdmin || currentUser.role === "Coordinator" || t.techId === currentUser.id);
                  return (
                    <tr key={t.id} onClick={open || undefined}
                      tabIndex={open ? 0 : undefined}
                      role={open ? "button" : undefined}
                      title={editable ? "Open this draft to add the day's charges" : open ? (t.status === "Draft" && !mine ? `Read ${t.tech}'s draft — only an admin can edit another technician's ticket` : "Read this ticket") : undefined}
                      // Only the row's own key presses: an Enter on the cancel
                      // button bubbles up here too, and would open the ticket
                      // it just cancelled.
                      onKeyDown={e => { if (!open || e.target !== e.currentTarget) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
                      style={{ cursor: open ? "pointer" : "default" }}>
                      <td style={{ fontFamily: "var(--font-heading)", fontWeight: 600, color: "var(--color-accent)" }}>{t.id}</td>
                      <td>{t.date}</td><td>{t.tech}</td>{seesPrices && <td className="tabular">{money(t.amount)}</td>}
                      <td><StatusTag status={t.status} /></td>
                      <td style={{ textAlign: "right" }}>
                        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap" }}>
                          {/* The whole row opens the ticket, but nothing on a
                              phone says so — there is no hover, and a tooltip
                              never shows. A button that says View is how a
                              technician learns that a sent bill can be read
                              back from here. It opens exactly what the row
                              tap opens. */}
                          {open && !editable && (
                            <Btn variant="ghost" onClick={e => { e.stopPropagation(); open(); }}>View</Btn>
                          )}
                          {editable && (
                            <Btn variant="ghost" onClick={e => { e.stopPropagation(); open(); }}>Open</Btn>
                          )}
                        {canWithdraw && (
                          <>
                            {rowError[t.id] && <span style={{ fontSize: 11, color: "var(--color-accent-700)", maxWidth: 320, textAlign: "left" }}>{rowError[t.id]}</span>}
                            <Btn variant="ghost" disabled={complete || withdrawingId === t.id}
                              title={complete ? "Reopen the job first — a withdrawn ticket reopens as a draft, and drafts can't be edited on a complete job" : undefined}
                              onClick={e => { e.stopPropagation(); cancelApproval(t); }}>
                              {withdrawingId === t.id ? "Cancelling…" : "Cancel approval"}
                            </Btn>
                            {/* Only for an account the editor would open for
                                anyway (the same gate as the row's own Edit):
                                without the ticket tab and the prices, a
                                withdrawn ticket is a draft they cannot fill. */}
                            {canRaiseTickets && !complete && (
                              <Btn variant="ghost" disabled={withdrawingId === t.id}
                                title="Cancels the approval request and opens the ticket for editing"
                                onClick={e => { e.stopPropagation(); cancelApproval(t, true); }}>
                                Cancel and edit
                              </Btn>
                            )}
                          </>
                        )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table></TableScroll>
            {!loading && ticketPageCount > 1 && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0 0" }}>
                <Btn variant="secondary" onClick={() => setTicketPage(Math.max(0, safeTicketPage - 1))} disabled={safeTicketPage === 0}>← Previous</Btn>
                <span style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
                  Page {safeTicketPage + 1} of {ticketPageCount} · {tickets.length} tickets
                </span>
                <Btn variant="secondary" onClick={() => setTicketPage(Math.min(ticketPageCount - 1, safeTicketPage + 1))} disabled={safeTicketPage >= ticketPageCount - 1}>Next →</Btn>
              </div>
            )}
            <div className="strip" style={{ gridTemplateColumns: seesPrices ? "repeat(2, 1fr)" : "1fr", marginTop: 14 }}>
              <div><div className="strip-label">Tickets raised</div><div className="strip-value">{tickets.length}</div></div>
              {seesPrices && <div><div className="strip-label">Ticket total · before GST</div><div className="strip-value">{money(ticketTotal)}</div></div>}
            </div>
          </Blueprint>
        </div>

        {/* Job record */}
        <Blueprint style={{ padding: "18px 20px", order: -1 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
            <h4 style={{ margin: 0, fontSize: 19 }}>Job record</h4>
            {savedNote && !editingRecord && (
              <span style={{ marginLeft: 10, fontSize: 13, fontWeight: 600, color: "var(--color-accent-700)" }}>✓ Saved to this job</span>
            )}
            {!editingRecord
              ? <Btn variant="secondary" style={{ marginLeft: "auto" }}
                  // Not until this job's own record is in hand. Editing what
                  // is still on screen from the last job, then saving, files
                  // that job's reps against this one. Same rule for a record
                  // whose reps couldn't be read: the panel is showing the
                  // organisation's primary contacts as a stand-in, and Save
                  // would write those onto this job as its named reps.
                  disabled={complete || !recordLoaded || !!jobRecord.repsUnknown}
                  title={complete ? undefined
                    : !recordLoaded ? "Waiting for this job's details"
                    : jobRecord.repsUnknown ? "This job's reps couldn't be read — the panel is showing the client's usual contacts. Reopen the job when you're back in signal."
                    : undefined}
                  onClick={() => { setDraft(jobRecord); setSavedNote(false); setEditingRecord(true); }}>Edit</Btn>
              : <span style={{ marginLeft: "auto", fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Editing — changes aren't kept until you save</span>}
          </div>
          {/* The read that fills this panel, when it failed. It used to be a
              console line, so the panel simply sat empty with no way to tell
              a job with nothing filled in from a job whose details never
              arrived. */}
          {!editingRecord && <ErrorBox>{recordError}</ErrorBox>}
          {!editingRecord ? (
            // Three fixed columns, read down: identifier, client, contractor —
            // fixed rather than auto-fit, because auto-fit reflowed to four
            // columns on a wide screen and scrambled the pairings.
            // Kept as three columns at every width, same as desktop, rather
            // than collapsing to one on a phone.
            <div className="job-record-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
              <RecordCell label="Job #" value={jobRecord.job} />
              <RecordCell label="LSD" value={jobRecord.lsd} />
              <RecordCell label="AFE" value={jobRecord.afe} />

              <RecordCell label="Client" value={jobRecord.client} />
              <RecordCell label="Contractor" value={jobRecord.contractor} />
              {/* The operator's own name for where the work is — it prints on
                  the client's field invoice, and is not the LSD or the
                  internal project name. */}
              <RecordCell label="Area" value={jobRecord.area} />

              <RecordCell label="Client rep" value={jobRecord.clientRep ? <ContactText text={jobRecord.clientRep} /> : ""} />
              <RecordCell label="Contractor rep" value={jobRecord.contractorRep ? <ContactText text={jobRecord.contractorRep} /> : ""} />
              <RecordCell label="Started" value={jobRecord.started} />
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
                {JOB_FIELDS.filter(f => f.key !== "clientRep" && f.key !== "contractorRep").map(f => (
                  <Field key={f.key} label={f.label}>
                    <input className="input" value={draft[f.key] || ""}
                      disabled={f.key === "job" || f.key === "client" || f.key === "started"}
                      onChange={e => setDraft(p => ({ ...p, [f.key]: e.target.value }))} />
                  </Field>
                ))}
              </div>

              {/* The two reps, picked from the directory rather than retyped.
                  Same pattern as New job and Create ticket, and the parts are
                  three boxes because nobody should have to type a "·". */}
              <RepEditor
                heading="Client representative"
                options={clientPeople}
                value={draft.clientRepDetail}
                onChange={v => setDraft(p => ({ ...p, clientRepDetail: v }))}
                emptyNote={job.clientId ? "" : "No client on this job."}
              />
              <RepEditor
                heading="Contractor representative"
                options={contractorPeople}
                value={draft.contractorRepDetail}
                onChange={v => setDraft(p => ({ ...p, contractorRepDetail: v }))}
                emptyNote={contractorIdForDraft ? "" : "Name a contractor above first — their people are filed against them."}
              />
              <ErrorBox>{recordError}</ErrorBox>
              {/* Save sits under the fields it commits, on its own line, so
                  it reads as the end of the form rather than another control
                  in it. */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16, paddingTop: 14, borderTop: "1px solid color-mix(in srgb, var(--color-text) 12%, transparent)" }}>
                <Btn variant="primary" onClick={saveRecord} disabled={savingRecord}>{savingRecord ? "Saving…" : "Save job record"}</Btn>
                <Btn variant="secondary" onClick={() => setEditingRecord(false)} disabled={savingRecord}>Cancel</Btn>
                <span style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                  Saves the reps against this job — other jobs for the same client keep theirs.
                </span>
              </div>
            </>
          )}
        </Blueprint>
      </div>

      {/* Removing the job sits at the very bottom, past everything the job is
          actually for. It is the last thing on the page because it is the last
          thing you should reach for, and nothing below it can be mis-clicked
          on the way somewhere else. */}
      {canDelete && (
        <div style={{
          marginTop: 28, paddingTop: 16,
          borderTop: "1px solid color-mix(in srgb, var(--color-text) 12%, transparent)",
          display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap"
        }}>
          {/* A failed read leaves the three lists empty, and the dialog reads
              that as "nothing has been filed" with its button live and no
              typed confirmation. The banner above says so, but the dialog
              covers it — this is what actually stops the press. */}
          <Btn variant="secondary" disabled={statusBusy || !!filedError}
            title={filedError ? "Reload the job first — what's filed against it couldn't be read." : undefined}
            onClick={() => setDeleting(true)}>Delete job</Btn>
          <span style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            {isAdmin
              ? "Anything filed against this job can be moved to another one first."
              : "You raised this job and nothing has been billed from it yet."}
          </span>
        </div>
      )}

      {/* Said out loud rather than leaving the button quietly missing, so the
          person who raised a job knows why they can't remove it. */}
      {!canDelete && raisedByMe && billedSomething && (
        <div style={{
          marginTop: 28, paddingTop: 16,
          borderTop: "1px solid color-mix(in srgb, var(--color-text) 12%, transparent)",
          fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)"
        }}>
          A ticket from this job has already gone out for billing, so it can't be deleted. An admin can still remove it.
        </div>
      )}

      {showUpload && (
        <UploadReportDialog job={job} jobRecord={jobRecord} currentUser={currentUser} onClose={() => setShowUpload(false)}
          onSubmit={async () => { setShowUpload(false); await refreshReports(); }} />
      )}
      {showTicket && (
        <CreateTicketDialog job={job} jobRecord={jobRecord} contacts={contacts} currentUser={currentUser} onClose={() => setShowTicket(false)}
          onSubmit={async seed => {
            // Closed only once the ticket screen is actually open. The
            // dialog used to close first, so a job record that wouldn't
            // load took the chosen work date and both reps down with it and
            // left the person on Job detail with a toast and nothing typed.
            if (await onStartTicket(seed) !== false) setShowTicket(false);
          }} />
      )}
      {deleting && (
        <DeleteJobDialog job={job} jhas={jhas} reports={reports} tickets={tickets} isAdmin={isAdmin}
          onClose={() => setDeleting(false)}
          onDeleted={movedTo => { setDeleting(false); onJobDeleted(movedTo); }} />
      )}

      {closingJha && (
        <JhaCloseOutDialog jha={closingJha} currentUser={currentUser}
          onClose={() => setClosingJha(null)}
          onDone={async () => { setClosingJha(null); await refreshJhas(); }} />
      )}

      {sendingJha && (
        <SendPdfDialog title="Send assessment" file={sendingJha.file} job={job}
          clientContacts={clientPeople}
          contractorContacts={contractorPeopleOnFile}
          defaultMessage="Attached: the signed hazard assessment for the work noted below. Let us know if you have questions."
          send={(to, message) => Db.sendJhaEmail({ jhaId: sendingJha.id, to, cc: "", message })}
          onClose={() => setSendingJha(null)}
          onSent={async () => { setSendingJha(null); await refreshJhas(); }} />
      )}

      {sendingReport && (
        <SendPdfDialog title="Send report" file={sendingReport.file} job={job}
          clientContacts={clientPeople}
          contractorContacts={contractorPeopleOnFile}
          defaultMessage="Attached: interpreted RT report for the welds noted below. Let us know if you have questions."
          send={(to, message) => Db.sendReportEmail({ reportId: sendingReport.id, to, cc: "", message })}
          onClose={() => setSendingReport(null)}
          onSent={async () => { setSendingReport(null); await refreshReports(); }} />
      )}

      {viewingTicket && (
        <TicketViewDialog ticketId={viewingTicket} jobRecord={jobRecord}
          onClose={() => setViewingTicket(null)}
          onSent={async () => { setViewingTicket(null); await refreshTickets(); }}
          // The viewer is where a sent ticket is read, so it is where the
          // person notices the figure is wrong; the two cancel buttons live
          // here as well as on the row. Same gates as the row, resolved here
          // so the dialog knows nothing about roles.
          onWithdraw={async (t, thenEdit) => { if (await cancelApproval(t, thenEdit)) setViewingTicket(null); }}
          canEditAfter={canRaiseTickets && !complete}
          // The same gate as the row: a Complete job's withdrawn ticket would
          // be a draft nobody on that job can edit.
          canWithdraw={t => !complete && t.status === "Awaiting approval"
            && (isAdmin || currentUser.role === "Coordinator" || t.technician_id === currentUser.id)} />
      )}

    </div>
  );
}

// A ticket opened to be read, not edited.
//
// The billing screen is an editor: every button on it saves, and it refuses
// outright on a completed job or an approved ticket. That left the commonest
// question — "what did we actually bill them for?" — with nowhere to be
// asked, and no way to chase a client who never signed once the job was
// closed. This answers it without offering a single control that writes to
// the ticket.
//
// The one thing it does write is the approval email, which changes nothing on
// the ticket except that it has been sent again.
// How many of a job's tickets Daily billing shows at once.
const TICKETS_PER_PAGE = 5;

function TicketViewDialog({ ticketId, jobRecord, onClose, onSent, onWithdraw, canEditAfter, canWithdraw }) {
  const [ticket, setTicket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [sentNote, setSentNote] = useState("");
  // The rendered invoice, and the frame showing it.
  const [invoiceHtml, setInvoiceHtml] = useState("");
  const frameRef = useRef(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        // Crew is a nice-to-have beside the charges; a ticket raised before
        // crew was recorded simply has none, and that must not read as a
        // failure to load the ticket.
        // The invoice is rendered server-side by the same code the client's
        // copy uses, and it carries the crew and the totals itself — so this
        // reads the ticket only for its status, date and contact, which the
        // dialog's own header and send button need.
        const [t, html] = await Promise.all([
          Db.getTicket(ticketId),
          Db.renderTicketInvoice(ticketId).catch(() => "")
        ]);
        if (!live) return;
        setTicket(t);
        setInvoiceHtml(html);
      } catch (e) {
        if (live) setError(e.message || "Couldn't load that ticket.");
      }
      if (live) setLoading(false);
    })();
    return () => { live = false; };
  }, [ticketId]);

  // tickets.client_contact is jsonb holding a single label string under
  // `name` — "Rep · phone · email" — not a plain column. Reading it as a
  // string stringifies the object and quietly matches no email at all, which
  // would have hidden the send button rather than failing loudly.
  const contactLine = (ticket && ticket.client_contact && ticket.client_contact.name) || "";

  // Where the approval request goes. The ticket carries the contact it was
  // raised against, which is the one the client rep already saw; the job's
  // current rep is the fallback for a ticket raised before anyone was named.
  const recipient = emailIn(contactLine)
    || (jobRecord && jobRecord.clientRepDetail && jobRecord.clientRepDetail.email)
    || "";

  const signed = ticket && (ticket.status === "Approved" || ticket.status === "Invoiced");
  const canSend = !!ticket && !signed && !!recipient && Number(ticket.total) > 0;

  // The frame is given its content's full height so the *dialog* scrolls and
  // the iframe never does. A scrollbar inside a scrollbar is miserable to use
  // on a phone, which is where these get read.
  //
  // Measured from an effect rather than from onLoad alone: with srcDoc the
  // load event can beat the parse, and measuring then reports the empty
  // document — the frame sat at its placeholder 360px while the invoice
  // inside it was 1410.
  // The invoice is shown in a fixed viewport that scrolls, the way any
  // document viewer works.
  //
  // Sizing the frame to its content was tried and abandoned. srcDoc parses
  // asynchronously so onLoad measures an empty document; resizing the frame
  // reflows the responsive invoice inside it, so a poll settles on the height
  // the content had at the previous width (measured 1410, applied it, content
  // became 1528); and the dialog body is a flex column, so the measured height
  // was applied inline at 1419px and laid out at 360 until flex-shrink was
  // pinned. Three fixes deep for a scrollbar in a slightly nicer place is not
  // a good trade.


  // Prints the invoice on its own, not the app around it.
  const printInvoice = () => {
    const win = frameRef.current && frameRef.current.contentWindow;
    if (!win) return;
    win.focus();
    win.print();
  };

  const send = async () => {
    setSending(true);
    setError("");
    try {
      await Db.sendTicketApproval({ ticketId, to: recipient });
      setSentNote(`Approval request sent to ${recipient}.`);
      // The document now says "Awaiting approval"; re-render so the copy on
      // screen matches the one that just went out.
      setInvoiceHtml(await Db.renderTicketInvoice(ticketId).catch(() => invoiceHtml));
      if (onSent) await onSent();
    } catch (e) {
      setError(e.message || "Couldn't send that approval request.");
      setSending(false);
    }
  };

  // Why the button isn't there, rather than an unexplained absence.
  const cannotSendBecause =
    signed ? `This ticket is ${String(ticket.status).toLowerCase()} — the client has already signed it, so there is nothing to send.`
    : !recipient ? "No client email on file for this ticket. Add a client rep to the job record and it can be sent."
    : ticket && Number(ticket.total) <= 0 ? "This ticket has nothing on it yet, so there is nothing to approve."
    : "";

  return (
    <Dialog title={`Field invoice ${ticketId}`} maxWidth={900} onClose={onClose}
      actions={<>
        <Btn variant="secondary" onClick={onClose}>Close</Btn>
        {/* Pull a sent ticket back from here, where its figures are on
            screen. The dialog closes first and the job page does the
            asking, the refresh and (for "and edit") the opening — one
            code path whichever button it started from. */}
        {ticket && !sentNote && onWithdraw && canWithdraw && canWithdraw(ticket) && (
          <>
            <Btn variant="secondary" disabled={sending} onClick={() => onWithdraw({ id: ticketId }, false)}>Cancel approval</Btn>
            {canEditAfter && (
              <Btn variant="secondary" disabled={sending} onClick={() => onWithdraw({ id: ticketId }, true)}>Cancel and edit</Btn>
            )}
          </>
        )}
        {canSend && (
          <Btn variant="primary" disabled={sending || !!sentNote} onClick={send}>
            {sending ? "Sending…"
              : sentNote ? "Sent"
              : ticket.status === "Awaiting approval" ? "Send again" : "Send for approval"}
          </Btn>
        )}
      </>}>
      {loading && <Loading />}
      {error && <ErrorBox>{error}</ErrorBox>}
      {sentNote && (
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-accent-700)", marginBottom: 12 }}>
          ✓ {sentNote}
        </div>
      )}

      {ticket && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <StatusTag status={ticket.status} />
            <span style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
              Work performed {dayMonth(localDate(ticket.work_date))}
            </span>
            {invoiceHtml && (
              <Btn variant="ghost" style={{ marginLeft: "auto" }} onClick={printInvoice}>Print</Btn>
            )}
          </div>

          {/* The invoice itself, not a description of it.
              This panel used to re-list the charges in its own little table
              with its own totals — a second rendering of the same bill, which
              is one more thing that can disagree with what the client signed.
              It is now the document, rendered by the same code that renders
              the client's copy, in an iframe so the invoice's own stylesheet
              cannot leak into the app or the app's into it. */}
          {/* Sandboxed with everything but same-origin and modals withheld.
              The renderer escapes every field, but this frame is srcDoc in
              the app's own origin: without a sandbox, an escaping regression
              would hand whatever got injected the signed-in session. With
              one, scripts in the document simply never run — no allow-scripts
              means a regression renders as text instead of executing.
              allow-same-origin is safe on its own (dangerous only paired
              with allow-scripts) and keeps contentWindow reachable for the
              Print button; allow-modals is what lets print() open a dialog. */}
          {invoiceHtml
            ? <iframe
                title={`Field invoice ${ticketId}`}
                srcDoc={invoiceHtml}
                sandbox="allow-same-origin allow-modals"
                ref={frameRef}
                style={{
                  width: "100%",
                  height: "min(70vh, 900px)",
                  // An iframe is a flex item like any other, and the dialog body
                  // is a flex column: without this it gets shrunk to fit rather
                  // than keeping the height it was given.
                  flexShrink: 0,
                  border: "1px solid var(--color-divider)", background: "#fff", display: "block"
                }} />
            : !loading && !error && (
                <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                  Couldn't render this invoice.
                </div>
              )}

          {cannotSendBecause && !sentNote && (
            <div style={{ marginTop: 14, fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
              {cannotSendBecause}
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}

// One field of the job record: label over value, so a long contact string wraps
// under its own label instead of colliding with the next column.
function RecordCell({ label, value }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginBottom: 3 }}>{label}</div>
      {/* overflowWrap anywhere: a rep's email is one unbreakable token, and
          on a phone it is wider than a third-of-the-screen column — without
          a break opportunity it painted straight across the neighbouring
          cell instead of wrapping inside its own. */}
      <div className="tabular" style={{ fontSize: 14, textWrap: "pretty", overflowWrap: "anywhere" }}>
        {value || <span style={{ color: "color-mix(in srgb, var(--color-text) 35%, transparent)" }}>—</span>}
      </div>
    </div>
  );
}

// Closing out a JHA: the end readings, taken off each worker's DRD at the end
// of the day. Start is always 0, so what's typed here is the dose that person
// took on this assessment.
// Deleting a job, once it has things filed against it.
//
// A job raised by mistake should be removable, but "delete" on a job that
// carries eight JHAs and a fortnight of tickets is not one decision — it is
// two. This asks the second one out loud: does what is on it move somewhere,
// or go with it.
//
// The counts come from the screen behind, which has already loaded them. The
// database counts again and refuses if they don't add up, so this is the
// explanation rather than the enforcement.
function DeleteJobDialog({ job, jhas, reports, tickets, isAdmin, onClose, onDeleted }) {
  const [mode, setMode] = useState("transfer");
  const [target, setTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [typed, setTyped] = useState("");

  const attached = jhas.length + reports.length + tickets.length;
  // Billing the client has agreed to does not move and does not vanish. Said
  // here as well as in the database, so it isn't discovered after choosing.
  const locked = tickets.filter(t => t.status === "Approved" || t.status === "Invoiced");

  const confirmWord = job.id;
  const canDelete = !busy
    && locked.length === 0
    && (attached === 0 || (mode === "transfer" ? !!target : typed.trim() === confirmWord));

  const run = async () => {
    setBusy(true);
    setError("");
    try {
      await Db.deleteJob({
        jobId: job.dbId,
        transferToId: attached > 0 && mode === "transfer" ? target.dbId : null,
        discard: attached > 0 && mode === "discard"
      });
      onDeleted(mode === "transfer" ? target : null);
    } catch (e) {
      setBusy(false);
      setError(e.message || "Couldn't delete that job.");
    }
  };

  const Count = ({ n, one, many }) => (
    <li style={{ marginBottom: 2 }}>{n} {n === 1 ? one : many}</li>
  );

  return (
    <Dialog title={`Delete ${job.id}?`} maxWidth={560} onClose={onClose}
      actions={<>
        <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
        <Btn variant="primary" onClick={run} disabled={!canDelete}>
          {busy ? "Deleting…" : attached && mode === "transfer" ? "Transfer and delete" : "Delete job"}
        </Btn>
      </>}>
      <ErrorBox>{error}</ErrorBox>

      {locked.length > 0 ? (
        <div style={{ fontSize: 14 }}>
          <p style={{ marginTop: 0 }}>
            This job has <strong>{locked.length} approved or invoiced ticket{locked.length === 1 ? "" : "s"}</strong> on it.
          </p>
          <p style={{ color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
            That is the record of what the client agreed to pay, against this job. It can't be moved to a
            different job or deleted, so this job has to stay. If it was raised in error, mark it complete
            instead — it leaves the board without touching the billing.
          </p>
        </div>
      ) : attached === 0 ? (
        <div style={{ fontSize: 14 }}>
          Nothing has been filed against {job.id} — no hazard assessments, reports or tickets. Deleting it
          removes the job and nothing else.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 14, marginBottom: 4 }}>{job.id} still has:</div>
          <ul style={{ margin: "0 0 14px 18px", padding: 0, fontSize: 14 }}>
            {jhas.length > 0 && <Count n={jhas.length} one="hazard assessment" many="hazard assessments" />}
            {reports.length > 0 && <Count n={reports.length} one="radiographic report" many="radiographic reports" />}
            {tickets.length > 0 && <Count n={tickets.length} one="billing ticket" many="billing tickets" />}
          </ul>

          {/* Destroying a filed record is an admin's. Someone clearing up
              their own mistake moves it to the right job instead. */}
          {isAdmin ? (
            <div className="seg" role="group" aria-label="What happens to them" style={{ marginBottom: 12 }}>
              <button type="button" className={`seg-opt${mode === "transfer" ? " active" : ""}`}
                aria-pressed={mode === "transfer"} onClick={() => setMode("transfer")}>Move them to another job</button>
              <button type="button" className={`seg-opt${mode === "discard" ? " active" : ""}`}
                aria-pressed={mode === "discard"} onClick={() => setMode("discard")}>Delete them too</button>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginBottom: 12 }}>
              These move to another job — they aren't deleted. Ask an admin if they shouldn't be kept.
            </div>
          )}

          {mode === "transfer" ? (
            <Field label="Move them to">
              <SearchSelect
                style={{ maxWidth: "none" }}
                listId="transfer-job-list"
                ariaLabel="Search jobs to transfer to"
                placeholder={target ? `${target.id} — search to change…` : "Search by job #, project or site…"}
                search={async text => {
                  const res = await Db.searchJobs({ page: 0, pageSize: 25, search: text, searchField: "any" });
                  // Never offer the job being deleted as its own destination.
                  return { rows: res.rows.filter(j => j.dbId !== job.dbId), total: res.total };
                }}
                optionKey={j => j.dbId}
                onPick={setTarget}
                onError={setError}
                renderOption={j => (
                  <>
                    <div style={{ fontSize: 15 }}>{j.id} — {j.project || "No project name"}</div>
                    <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                      {j.client}{j.lsd ? ` · ${j.lsd}` : ""}
                    </div>
                  </>
                )}
              />
            </Field>
          ) : (
            <Field label={`Type ${confirmWord} to confirm`}>
              <input className="input" value={typed} onChange={e => setTyped(e.target.value)}
                placeholder={confirmWord} autoComplete="off" />
            </Field>
          )}

          <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
            {mode === "transfer"
              ? "Everything above moves to that job, then this one is deleted. Nothing is lost."
              : "Everything above is deleted with the job. Hazard assessments are a safety record — this can't be undone."}
          </div>
        </>
      )}
    </Dialog>
  );
}

function JhaCloseOutDialog({ jha, currentUser, onClose, onDone }) {
  const [rows, setRows] = useState(() =>
    (jha.dosimetry || []).map(d => ({ ...d, endReading: d.endReading == null ? "" : String(d.endReading) })));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // The same offer the builder makes, at the other end of the day: the
  // serials on this assessment for whoever is closing it out, when the
  // profile does not hold them. A JHA is often raised by one technician and
  // closed by the other, and the close-out is the first time the second one
  // sees their own kit written down. Asked once a session through the
  // builder's own mark, so the two screens never nag in turn; the profile is
  // read from the cached crew list, which is what the builder derives kits
  // from too.
  const [offer, setOffer] = useState(null);   // { row, onFile }
  const [keeping, setKeeping] = useState(false);
  const [keepMsg, setKeepMsg] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked once as the dialog opens; typing a reading changes no serial it reads
  useEffect(() => {
    if (dosimetryAskedFor(currentUser.id)) return undefined;
    const mine = rows.find(r => r.profileId === currentUser.id);
    if (!mine) return undefined;
    let alive = true;
    Db.listActiveProfiles().then(list => {
      if (!alive) return;
      const me = list.find(p => p.id === currentUser.id);
      if (!me) return;
      const onFile = serialsOnProfile(me);
      if (!newSerials(mine, onFile).length) return;
      markDosimetryAsked(currentUser.id);
      setOffer({ row: mine, onFile });
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const keepSerials = async () => {
    if (!offer) return;
    setKeeping(true);
    setKeepMsg("");
    try {
      await Db.setOwnDosimetry(mergedSerials(offer.row, offer.onFile));
      setOffer(null);
    } catch (e) {
      setKeepMsg(isMissingSetOwnDosimetry(e)
        ? "This app can't put serials on a profile here yet — ask an admin to add them to your profile."
        : (e.message || "Couldn't save them to your profile."));
    }
    setKeeping(false);
  };
  const offered = offer ? newSerials(offer.row, offer.onFile) : [];
  const offeredNames = offered.map(k => ({ tld: "TLD", drd: "DRD", alarm: "alarm" })[k]).join(", ");

  const set = (i, v) => setRows(p => p.map((r, idx) => idx === i ? { ...r, endReading: v } : r));

  const submit = async () => {
    // Named rather than counted: with a helper on the assessment there are two
    // fields, and "enter an end reading" gave no clue which one was still
    // blank — it read like the value just typed hadn't registered.
    const missing = rows.filter(r => String(r.endReading).trim() === "");
    if (missing.length) {
      setErr(`No end reading yet for ${missing.map(r => `${r.name || "worker"} (worker ${r.slot})`).join(" and ")}. Enter 0 if they took no dose.`);
      return;
    }
    const bad = rows.filter(r => {
      const n = Number(decimalString(r.endReading));
      return Number.isNaN(n) || n < 0;
    });
    if (bad.length) {
      setErr(`“${bad[0].endReading}” isn't a reading in mR — use digits and one decimal point.`);
      return;
    }
    setSaving(true);
    setErr("");
    try {
      await Db.closeOutJha({
        jhaId: jha.id,
        dosimetry: rows.map(r => ({ ...r, endReading: decimalString(r.endReading) })),
        closedBy: currentUser.id
      });
      await onDone();
    } catch (e) {
      setSaving(false);
      setErr(e.message || "Couldn't close out that assessment.");
    }
  };

  return (
    <Dialog title="Close out JHA" maxWidth={520} onClose={onClose}
      actions={<>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={submit} disabled={saving}>{saving ? "Saving…" : "Close out"}</Btn>
      </>}>
      <ErrorBox>{err}</ErrorBox>
      <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
        Filed {jha.at} by {jha.by}. Start readings were 0, so the end reading is the dose recorded against each worker.
      </div>
      {!rows.length && (
        <div style={{ fontSize: 13 }}>
          This assessment has no workers recorded on it — closing out will simply mark it done.
        </div>
      )}
      {offer && (
        <div style={{
          fontSize: 12, padding: "8px 10px", border: "1px solid var(--color-accent-700)",
          background: "color-mix(in srgb, var(--color-accent) 8%, transparent)", display: "flex", flexDirection: "column", gap: 8
        }}>
          <span>
            The {offeredNames} serial{offered.length > 1 ? "s" : ""} on this assessment {offered.length > 1 ? "aren't" : "isn't"} on your
            profile. Keep {offered.length > 1 ? "them" : "it"} there and the next JHA fills {offered.length > 1 ? "them" : "it"} in.
          </span>
          {keepMsg && <span style={{ color: "var(--color-accent-700)" }}>{keepMsg}</span>}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Btn variant="secondary" onClick={keepSerials} disabled={keeping}>{keeping ? "Keeping…" : "Keep these on my profile"}</Btn>
            <button type="button" onClick={() => setOffer(null)}
              style={{ background: "none", border: "none", textDecoration: "underline", cursor: "pointer", color: "inherit", font: "inherit", padding: 0 }}>
              Not now
            </button>
          </div>
        </div>
      )}
      {rows.map((r, i) => (
        <div key={r.profileId || i} style={{ border: "1px solid var(--color-divider)", padding: "12px 14px", display: "grid", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 16 }}>{r.name}</span>
            <TagX variant="outline">Nuclear energy worker ({r.slot})</TagX>
          </div>
          <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            Unit {r.unit || "—"} · TLD {r.tld || "—"} · DRD {r.drd || "—"} · Alarm {r.alarm || "—"}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <Field label="Start reading (mR)"><input className="input" value="0" disabled /></Field>
            <Field label="End reading (mR)">
              {/* A text input with a decimal keypad, not type="number": a
                  number input hands back "" for anything the browser considers
                  half-typed or locale-wrong (a comma decimal, a stray key), so
                  a reading that was clearly on screen arrived here empty. */}
              <input className="input" type="text" inputMode="decimal" autoFocus={i === 0}
                value={r.endReading}
                style={{ borderColor: String(r.endReading).trim() === "" ? undefined : "var(--color-accent)" }}
                onChange={e => { if (acceptsNumberText(e.target.value, 0.1)) set(i, e.target.value); }} />
            </Field>
          </div>
          <div style={{ fontSize: 12, color: "var(--color-accent)" }}>
            Dose recorded: {String(r.endReading).trim() === "" ? "—" : Number(decimalString(r.endReading)) + " mR"}
          </div>
        </div>
      ))}
    </Dialog>
  );
}

// Emails a filed PDF — an assessment or a report — to whoever needs it.
// Recipients are picked off the job's own client and contractor people —
// searchable, since a big outfit keeps a long directory — plus a typed
// address for anyone not on file. The send itself happens server-side (the
// caller passes it in), where the session is re-checked and sent_at/sent_to
// get stamped on the row only after the mail is accepted.
function SendPdfDialog({ title, file, job, clientContacts, contractorContacts, defaultMessage, send, onClose, onSent }) {
  const [picked, setPicked] = useState([]);
  const [custom, setCustom] = useState("");
  const [message, setMessage] = useState(defaultMessage);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const muted = "color-mix(in srgb, var(--color-text) 55%, transparent)";

  // Picking someone without an email is answered out loud rather than by a
  // chip that silently can't be sent to.
  const addPick = c => {
    const email = (c.email || "").trim();
    if (!email) {
      setError(`${c.name} has no email on file — add one on the Contacts screen, or type the address below.`);
      return;
    }
    setError("");
    setPicked(p => p.some(x => x.email.toLowerCase() === email.toLowerCase())
      ? p : [...p, { key: c.org_type + ":" + c.id, name: c.name, email }]);
  };

  // A local filter, not a server search — the directory for one job's client
  // and contractor is already in hand. Sliced to the dropdown's cap with the
  // true total, so a long directory says "keep typing to narrow it down"
  // instead of rendering every match.
  const searchIn = list => (text, max) => {
    const q = text.trim().toLowerCase();
    const rows = list.filter(c => !q || [c.name, c.title, c.email].some(v => (v || "").toLowerCase().includes(q)));
    return { rows: rows.slice(0, max), total: rows.length };
  };
  const renderContact = c => (
    <>
      <div style={{ fontSize: 15 }}>{c.name}{c.title ? " · " + c.title : ""}{c.is_primary ? " (primary)" : ""}</div>
      <div style={{ fontSize: 11, color: c.email ? muted : "var(--color-accent-700)" }}>{c.email || "No email on file"}</div>
    </>
  );

  const doSend = async () => {
    // The custom field takes "name@co.com" or a pasted "Joe <name@co.com>" —
    // whatever part looks like an address is what gets used.
    const extra = emailIn(custom);
    if (custom.trim() && !extra) { setError(`"${custom.trim()}" doesn't look like an email address.`); return; }
    const to = [...picked.map(p => p.email), ...(extra ? [extra] : [])];
    if (!to.length) { setError("Pick at least one contact, or type an address."); return; }
    setSending(true);
    setError("");
    try {
      await send(to.join(", "), message.trim());
      onSent();
    } catch (e) {
      setSending(false);
      setError(e.message || "Couldn't send it.");
    }
  };

  return (
    <Dialog title={title} maxWidth={540} onClose={onClose}
      actions={<>
        <Btn variant="secondary" onClick={onClose} disabled={sending}>Cancel</Btn>
        <Btn variant="primary" onClick={doSend} disabled={sending}>{sending ? "Sending…" : "Send"}</Btn>
      </>}>
      <ErrorBox>{error}</ErrorBox>
      <div style={{ fontSize: 13 }}>
        <PdfGlyph /> {file}
        <span style={{ color: muted }}> — {job.id} · {job.project}</span>
      </div>

      {picked.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {picked.map(p => (
            <TagX key={p.key} variant="accent">
              {p.name} · {p.email}
              <button type="button" aria-label={`Remove ${p.name}`}
                onClick={() => setPicked(list => list.filter(x => x.key !== p.key))}
                style={{ background: "none", border: 0, cursor: "pointer", color: "inherit", font: "inherit", padding: "0 0 0 6px" }}>
                ×
              </button>
            </TagX>
          ))}
        </div>
      )}

      <Field label={`Client contacts${job.client ? " — " + job.client : ""}`}>
        {clientContacts.length ? (
          <SearchSelect style={{ maxWidth: "none" }} listId="send-doc-client-list"
            ariaLabel="Search client contacts" placeholder="Search by name, title or email…"
            search={searchIn(clientContacts)} optionKey={c => c.id}
            onPick={addPick} renderOption={renderContact} />
        ) : (
          <div style={{ fontSize: 12, color: muted }}>No client contacts on file for this job.</div>
        )}
      </Field>
      <Field label={`Contractor contacts${job.contractor ? " — " + job.contractor : ""}`}>
        {contractorContacts.length ? (
          <SearchSelect style={{ maxWidth: "none" }} listId="send-doc-contractor-list"
            ariaLabel="Search contractor contacts" placeholder="Search by name, title or email…"
            search={searchIn(contractorContacts)} optionKey={c => c.id}
            onPick={addPick} renderOption={renderContact} />
        ) : (
          <div style={{ fontSize: 12, color: muted }}>No contractor contacts on file for this job.</div>
        )}
      </Field>
      <Field label="Someone else">
        <input className="input" type="email" value={custom} placeholder="name@company.com"
          onChange={e => { setError(""); setCustom(e.target.value); }} />
      </Field>
      <Field label="Message"><textarea className="input" value={message} onChange={e => setMessage(e.target.value)} /></Field>
    </Dialog>
  );
}

// pdf.js reads the text layer of a dropped report so the weld numbers can
// fill themselves in. Only the Upload dialog wants it, so it is fetched on
// the first dropped PDF and the service worker keeps it after that — the
// same bargain the timesheet page strikes with SheetJS, minus the CDN.
//
// It is OURS now, in public/pdfjs, and the move off the CDN is the fix
// rather than a preference: 3.11.174 was the last build that loads by
// <script> tag and it predates the patch for CVE-2024-4367, so the version
// could not move while the loader was a tag. Every build since is ESM
// only, and a dynamic import() takes no integrity attribute — so serving
// the bytes from this origin is what stands in for SRI here, exactly as
// public/fonts stood in for the webfont URL. cdnPins.test.mjs pins both
// files by hash, which is the check the attribute used to be.
//
// 6.3.289 is outside both of pdf.js's execution advisories (CVE-2024-4367,
// fixed 4.2.67; CVE-2026-16633, introduced 5.6.83 and fixed 6.2.108) and
// it holds no `new Function` in either file — the flaw's own sink is gone
// from the build rather than held out of reach by how we call it. Being
// same-origin, the worker is built directly instead of through a blob:
// wrapper, which is why worker-src no longer allows blob: at all.
const PDFJS_BASE = "/pdfjs/";
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    const loaded = import(/* @vite-ignore */ `${PDFJS_BASE}pdf.min.js`).then(mod => {
      const lib = mod.getDocument ? mod : mod.default;
      lib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}pdf.worker.min.js`;
      return lib;
    });
    // The timeout is for the fetch that neither resolves nor rejects — a
    // captive portal holding the socket open — which otherwise leaves the
    // drop zone waiting on a promise that never settles. A failure of
    // either kind clears the cached promise so the next drop retries
    // instead of meeting the same dead one.
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Couldn't load the PDF reader.")), 30000);
    });
    pdfjsPromise = Promise.race([loaded, timeout])
      .then(lib => { clearTimeout(timer); return lib; })
      .catch(() => {
        clearTimeout(timer);
        pdfjsPromise = null;
        throw new Error("Couldn't load the PDF reader.");
      });
  }
  return pdfjsPromise;
}

// The text layer of every page, joined. A report is a handful of pages; the
// cap is for the day somebody drops a welding procedures manual by mistake,
// so the dialog shrugs instead of chewing through three hundred pages.
async function pdfText(file, maxPages = 40) {
  const pdfjs = await loadPdfjs();
  // isEvalSupported is not an option in 6.x, because the code-generation
  // path it used to switch off was deleted — the test reads the vendored
  // bytes for `new Function(` and that is the load-bearing half. Passing it
  // costs nothing and is the seatbelt for the day somebody moves the
  // version back to a build that still has the sink.
  const task = pdfjs.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false });
  const doc = await task.promise;
  try {
    let out = "";
    const n = Math.min(doc.numPages, maxPages);
    for (let i = 1; i <= n; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      out += content.items.map(it => it.str).join(" ") + "\n";
    }
    return out;
    // The loading task, not the document: 6.x removed PDFDocumentProxy's
    // own destroy(), so the old call threw on the way out of a read that
    // had in fact succeeded — the dialog would have reported that it could
    // not read a report whose text it was holding. Destroying the task
    // tears down the document and the worker port together, and it is the
    // one spelling that works on every version from 3.x up.
  } finally { await task.destroy(); }
}

function UploadReportDialog({ job, jobRecord, currentUser, onClose, onSubmit }) {
  const [file, setFile] = useState(null);
  const [welds, setWelds] = useState("");
  const [to, setTo] = useState(() => emailIn(jobRecord.contractorRep));
  const [cc, setCc] = useState("");
  const [message, setMessage] = useState("Attached: interpreted RT report for the welds noted below. Let us know if you have questions.");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const miss = useMissingFields();

  // Reading the numbers off the dropped report. The scan fills the field but
  // never owns it: a value the tech typed, or edited after a fill, stays put
  // — the fill only lands on an empty field or over its own previous answer.
  // Every failure is silent (no text layer, CDN unreachable, scanned paper):
  // the field simply stays manual, which is what it was yesterday.
  const autoFill = useRef("");
  const scanSeq = useRef(0);
  const scanForNumbers = async f => {
    const seq = ++scanSeq.current;
    try {
      const found = lastNumbers(await pdfText(f));
      if (!found || seq !== scanSeq.current) return;   // a newer drop wins
      setWelds(w => {
        if (w && w !== autoFill.current) return w;     // hand-typed: theirs
        autoFill.current = found;
        return found;
      });
      miss.fixed("welds");
    } catch { /* stays manual */ }
  };

  // The stored row, once the upload has landed. A retry after the email
  // failed must not upload the same PDF again and file a second report —
  // it only has to send. Cleared when a different file is picked. The key
  // covers the other way a duplicate happened: an insert whose answer was
  // lost — the database hands the first row back for the same key.
  const storedReport = useRef(null);
  const uploadKey = useRef(newClientKey());
  const submit = async sent => {
    if (!file) { miss.flag("file"); setError("Attach the interpreted PDF first."); return; }
    if (!welds.trim()) { miss.flag("welds"); setError("Note which welds this report covers."); return; }
    if (sent && !emailIn(to)) { miss.flag("to"); setError("Add an email address to send to, or use Upload only."); return; }
    // The To box arrives pre-filled from the job's contractor rep, so pressing
    // send is one tap away from mailing an interpretation to an address nobody
    // read. Name it once, before anything leaves the building.
    if (sent && !confirm(`Send this report to ${to.trim()}${cc.trim() ? `, cc ${cc.trim()}` : ""}?`)) return;
    miss.clear();
    setSaving(true);
    setError("");
    try {
      // Nothing to learn from asking a radio that is already off: the wait
      // was a token refresh and then the upload, each timing out, before
      // landing in the same outbox the catch below uses — the eight frozen
      // seconds savingWords exists to remove. Straight there instead.
      if (!storedReport.current && deviceOffline()) throw Object.assign(new Error("No connection."), { networkFailure: true });
      if (!storedReport.current) {
        storedReport.current = await Db.uploadReport({
          jobDbId: job.dbId, jobNumber: job.id, file, welds: welds.trim(), result: "Accept",
          interpretedBy: currentUser.name, send: false, sendTo: to.trim(), clientKey: uploadKey.current
        });
      }
      const report = storedReport.current;
      // The row is stored first, then emailed — so a mail outage costs the
      // send, not the upload. The report shows as Pending and can be resent.
      if (sent) {
        setSaving("Sending…");
        await Db.sendReportEmail({
          reportId: report.id, to: to.trim(), cc: cc.trim(), message: message.trim()
        });
      }
      onSubmit();
    } catch (e) {
      // No signal: the report goes to the outbox with its file, the way a
      // ticket does, and uploads — and emails — when the truck is back in
      // range. The key minted above goes with it, so a replay after a lost
      // answer finds the row that already landed. This dialog used to be
      // the only way to file a report from a phone and had no offline path
      // at all: "Couldn't upload — try again", and the PDF died with the tab.
      // A refusal the server actually gave (.plain — humanizeError marks a
      // 42501, a dead session is marked the same) is a reason whatever the
      // radio says. Same order oqFlushOnce and the three field screens keep:
      // .plain before isNetworkError.
      if (!storedReport.current && !e.plain && OfflineQueue.isNetworkError(e)) {
        // The outbox itself can refuse — a PDF is the biggest thing this app
        // ever queues, and a tablet at its storage quota says no. Closing the
        // dialog then would throw the file away silently, so the failure is
        // shown here and the attachment stays on screen to try again.
        try {
          await OfflineQueue.enqueue("report", {
            jobDbId: job.dbId, jobNumber: job.id, file, welds: welds.trim(), interpretedBy: currentUser.name,
            recipient: sent ? to.trim() : "", clientKey: uploadKey.current
          });
        } catch {
          setSaving(false);
          setError("No connection, and this report couldn't be saved to the outbox on this device — the tablet may be out of storage.");
          return;
        }
        Toasts.show(sent
          ? "No connection — the report is in the outbox and will upload and send itself when you're back in range."
          : "No connection — the report is in the outbox and will upload when you're back in range.", "info");
        onSubmit();
        return;
      }
      setSaving(false);
      setError(storedReport.current
        ? `The report is uploaded, but the email didn't go out: ${e.message || "the email service didn't respond."} Try again to resend it, or close this — it's on file as Pending and can be sent from the list.`
        : (e.message || "Couldn't upload — try again."));
    }
  };

  return (
    // Cancel, like every other dialog here: the only ways out were Escape,
    // which a phone has not got, and a tap on the backdrop, which throws the
    // attachment away without saying so. And "Upload only" is the primary now
    // — on a phone the primary is the easy thumb target, and the other one
    // emails the interpretation to the contractor.
    <Dialog title="Upload report" maxWidth={540} onClose={onClose}
      actions={<>
        <Btn variant="secondary" onClick={onClose} disabled={!!saving}>Cancel</Btn>
        <Btn variant="secondary" onClick={() => submit(true)} disabled={!!saving}>{saving && saving !== true ? saving : "Upload & send"}</Btn>
        <Btn variant="primary" onClick={() => submit(false)} disabled={!!saving}>{saving === true ? "Uploading…" : "Upload only"}</Btn>
      </>}>
      <ErrorBox>{error}</ErrorBox>
      {/* The drop zone is not an .input, so it takes the same ring by hand
          rather than being the one required thing that doesn't light up. */}
      <div className="blueprint" style={{
        borderStyle: "dashed", padding: "22px", textAlign: "center", position: "relative",
        ...(miss.is("file") ? {
          borderColor: "var(--color-accent-700)",
          boxShadow: "0 0 0 2px color-mix(in srgb, var(--color-accent) 30%, transparent)",
          background: "color-mix(in srgb, var(--color-accent) 7%, transparent)"
        } : null)
      }}>
        <i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" />
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>Drop the interpreted PDF here, or click to browse — up to {MAX_REPORT_LABEL}</div>
        <input type="file" accept="application/pdf" aria-label="Interpreted PDF" aria-invalid={miss.is("file") || undefined}
          style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }}
          onChange={e => {
            const f = e.target.files[0] || null;
            e.target.value = "";
            // `accept=` is only what the picker offers; a drop, or "All files",
            // hands over whatever was chosen. The attachment on screen stays
            // as it was, so a mis-drop costs nothing already attached.
            const refused = reportFileRefusal(f);
            if (refused) { miss.flag("file"); setError(refused); return; }
            miss.fixed("file");
            setError("");
            setFile(f);
            storedReport.current = null;
            uploadKey.current = newClientKey();
            if (f) scanForNumbers(f);
          }} />
        {file && <div style={{ marginTop: 8, fontSize: 12 }}><PdfGlyph /> {file.name} · {fileSize(file.size)}</div>}
      </div>
      <Field label="Last numbers" missing={miss.is("welds")}>
        <input {...miss.props("welds")} value={welds} onChange={e => { miss.fixed("welds"); setWelds(e.target.value); }} placeholder="XF-47 to XF-54, MT-1 to MT-15" />
      </Field>

      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", marginTop: 4 }}>Send to contractor</div>
      <Field label="To" missing={miss.is("to")}>
        <input {...miss.props("to")} value={to} onChange={e => { miss.fixed("to"); setTo(e.target.value); }} />
      </Field>
      <Field label="Cc"><input className="input" value={cc} onChange={e => setCc(e.target.value)} /></Field>
      <Field label="Message"><textarea className="input" value={message} onChange={e => setMessage(e.target.value)} /></Field>
    </Dialog>
  );
}

function CreateTicketDialog({ job, jobRecord, contacts, currentUser, onClose, onSubmit }) {
  const miss = useMissingFields();
  const [workDate, setWorkDate] = useState(todayLocal);
  // Raising a ticket means work happened, and work needs a hazard assessment
  // filed for the day. This reminds rather than blocks — the JHA may have been
  // filed on paper, or by the other tech on the crew.
  const [jhaMissing, setJhaMissing] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the job's id is read here, and that id is what this already watches
  useEffect(() => {
    if (!job || !job.dbId) return;
    Db.jhaFiledToday(job.dbId).then(ok => setJhaMissing(!ok)).catch(() => setJhaMissing(false));
  }, [job ? job.dbId : null]);
  const [clientRep, setClientRep] = useState(() => splitContact(jobRecord.clientRep));
  const [contractorRep, setContractorRep] = useState(() => splitContact(jobRecord.contractorRep));
  // What the number will be if this ticket is raised now. The real one is
  // minted by the database at save time — see Db.createTicket — so this is a
  // preview, and it can move if someone else raises a ticket first.
  const [preview, setPreview] = useState("");
  const [provisional, setProvisional] = useState(false);
  const [error, setError] = useState("");
  // Opening the editor waits on the job's record, so the button has to say so
  // — and two taps must not raise two tickets' worth of seeds.
  const [busy, setBusy] = useState(false);
  useEffect(() => OfflineCache.subscribe(s => setProvisional(s.servingCached)), []);
  // The directory is the job page's own (it used to be read again here),
  // so both rep fields offer everyone on file for this job's client and
  // contractor rather than only the job's primary. Memoized on the directory
  // and the id: this dialog re-renders on every keystroke in a rep's name.
  const clientContacts = useMemo(() => contactsForOrg(contacts, "client", job.clientId), [contacts, job.clientId]);
  const contractorContacts = useMemo(() => contactsForOrg(contacts, "contractor", job.contractorId), [contacts, job.contractorId]);
  const clientRepOnFile = useMemo(() => (clientContacts.find(c => contactLabel(c) === contactLabel(clientRep)) || {}).id || "", [clientContacts, clientRep]);
  const contractorRepOnFile = useMemo(() => (contractorContacts.find(c => contactLabel(c) === contactLabel(contractorRep)) || {}).id || "", [contractorContacts, contractorRep]);

  const d = localDate(workDate);
  const initials = initialsOf(currentUser.name);
  const longDate = d.toLocaleDateString("en-CA", { weekday: "short", day: "2-digit", month: "long", year: "numeric" });
  const seq = preview ? preview.slice(preview.lastIndexOf("-") + 1) : "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: the date checked is built from the work date this already watches
  useEffect(() => {
    if (Number.isNaN(d.getTime())) return;
    let live = true;
    Db.nextTicketNumber(initials, workDate)
      .then(n => { if (live) setPreview(n); })
      .catch(() => { if (live) setPreview(""); });
    return () => { live = false; };
  }, [initials, workDate]);

  const submit = async () => {
    if (busy) return;
    if (Number.isNaN(d.getTime())) { miss.flag("workDate"); setError("Pick a valid work date."); return; }
    miss.clear();
    setError("");
    // Nothing is inserted here. This dialog used to create an empty draft
    // and hand its id to the billing screen, which left a ghost draft for
    // every dialog abandoned after Create, and could not work without
    // signal at all. Now it only chooses — the day and this ticket's own
    // reps — and the billing screen does the saving, with its outbox and
    // recovery copy behind it. The number is minted when it saves.
    // Awaited: opening the editor needs the job's record, which is a fetch,
    // and this dialog is what is holding the work date and the reps until it
    // lands. It closes itself on success; on a failure it stays open with
    // everything typed still in it, and the toast the loader raised says why.
    setBusy(true);
    try { await onSubmit({
      workDate,
      clientContact: contactLabel(clientRep) || "",
      contractorContact: contactLabel(contractorRep) || ""
    }); }
    catch (e) { setError(e.message || "Couldn't open the ticket screen — try again."); }
    setBusy(false);
  };

  return (
    <Dialog title="Create ticket" maxWidth={520} onClose={onClose}
      actions={<><Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn><Btn variant="primary" onClick={submit} disabled={busy}>{busy ? "Opening…" : "Create ticket"}</Btn></>}>
      <ErrorBox>{error}</ErrorBox>
      {jhaMissing && (
        <div style={{ border: "1px solid var(--color-accent)", padding: "10px 12px", fontSize: 13 }}>
          No JHA has been filed for this job today — start one before the crew works. The ticket can still be raised now.
        </div>
      )}
      <div className="blueprint" style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 16, position: "relative" }}>
        <i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" />
        <div>
          <div style={{ fontSize: 10, textTransform: "uppercase", color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Ticket number</div>
          <div className="tabular" style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 32 }}>{preview || "…"}</div>
        </div>
        <div style={{ marginLeft: "auto", textAlign: "right", fontSize: 12 }}>
          <div className="tabular">{initials} · {ticketDateStamp(d)} · {longDate}</div>
          <div style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            {seq ? `Ticket ${seq} of the day for ${initials}` : "Reserving a number…"}
          </div>
          {provisional && (
            <div style={{ color: "var(--color-accent-700)", marginTop: 2 }}>
              Provisional — offline, confirmed on sync
            </div>
          )}
        </div>
      </div>
      <Field label="Work date" missing={miss.is("workDate")}>
        <input {...miss.props("workDate")} type="date" value={workDate}
          onChange={e => { miss.fixed("workDate"); setWorkDate(e.target.value); }} />
      </Field>
      <Field label="Technician"><input className="input" value={currentUser.name} disabled /></Field>

      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", marginTop: 4 }}>
        Contacts for this ticket only — the job's contacts on file are untouched
      </div>
      <Field label="Client representative">
        {clientContacts.length > 0 && (
          <select className="input" style={{ marginBottom: 6 }} aria-label="Client contact on file"
            value={clientRepOnFile}
            onChange={e => {
              const c = clientContacts.find(x => String(x.id) === String(e.target.value));
              setClientRep(c ? { name: c.name, phone: c.phone || "", email: c.email || "" } : { name: "", phone: "", email: "" });
            }}>
            <option value="">Someone else — type below…</option>
            {clientContacts.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}{c.title ? " · " + c.title : ""}{c.is_primary ? " (primary)" : ""}
              </option>
            ))}
          </select>
        )}
        <ContactParts value={clientRep} onChange={setClientRep} />
      </Field>
      <Field label="Contractor representative">
        {contractorContacts.length > 0 && (
          <select className="input" style={{ marginBottom: 6 }} aria-label="Contractor contact on file"
            value={contractorRepOnFile}
            onChange={e => {
              const c = contractorContacts.find(x => String(x.id) === String(e.target.value));
              setContractorRep(c ? { name: c.name, phone: c.phone || "", email: c.email || "" } : { name: "", phone: "", email: "" });
            }}>
            <option value="">Someone else — type below…</option>
            {contractorContacts.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}{c.title ? " · " + c.title : ""}{c.is_primary ? " (primary)" : ""}
              </option>
            ))}
          </select>
        )}
        <ContactParts value={contractorRep} onChange={setContractorRep} />
      </Field>
    </Dialog>
  );
}

// Name, phone and email as three fields rather than one — the ticket still
// stores the joined string, but nobody should have to type a · to record a
// phone number.
function ContactParts({ value, onChange }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, minWidth: 0 }} className="grid-2col">
      <input className="input" style={{ gridColumn: "1 / -1", minWidth: 0 }} value={value.name} placeholder="Name"
        aria-label="Name" onChange={e => set("name", e.target.value)} />
      <input className="input" style={{ minWidth: 0 }} type="tel" value={value.phone} placeholder="Phone"
        aria-label="Phone" onChange={e => set("phone", e.target.value)} />
      <input className="input" style={{ minWidth: 0 }} type="email" value={value.email} placeholder="Email"
        aria-label="Email" onChange={e => set("email", e.target.value)} />
    </div>
  );
}

// One rep on the job record: pick them off the organisation's list, or type
// someone who isn't on it yet. Unlike the ticket dialog — which takes a
// one-off contact for that ticket alone — this names the person for the job,
// so it does write back to the directory.
function RepEditor({ heading, options, value, onChange, emptyNote }) {
  const rep = value || { id: "", name: "", email: "", phone: "" };
  const muted = "color-mix(in srgb, var(--color-text) 55%, transparent)";

  const pick = id => {
    const c = options.find(x => String(x.id) === String(id));
    onChange(c
      ? { id: c.id, name: c.name || "", phone: c.phone || "", email: c.email || "" }
      : { id: "", name: "", phone: "", email: "" });
  };

  const edit = v => {
    const picked = rep.id && options.find(c => String(c.id) === String(rep.id));
    // Correcting a picked person's phone or email updates them. Typing over
    // the *name* means somebody else entirely, so the link is dropped rather
    // than renaming the contact everyone else's jobs point at.
    const stillThem = !picked || (v.name || "").trim().toLowerCase() === (picked.name || "").trim().toLowerCase();
    onChange({ ...rep, ...v, id: stillThem ? rep.id : "" });
  };

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", marginBottom: 6 }}>
        {heading}
      </div>
      {options.length > 0 ? (
        <select className="input" style={{ marginBottom: 6 }} aria-label={heading + " on file"}
          value={rep.id || ""} onChange={e => pick(e.target.value)}>
          <option value="">Someone else — type below…</option>
          {options.map(c => (
            <option key={c.id} value={c.id}>
              {c.name}{c.title ? " · " + c.title : ""}{c.is_primary ? " (primary)" : ""}
            </option>
          ))}
        </select>
      ) : (
        <div style={{ fontSize: 12, color: muted, marginBottom: 6 }}>
          {emptyNote || "Nobody on file for them yet — typing a name here adds one."}
        </div>
      )}
      <ContactParts value={rep} onChange={edit} />
      <div style={{ fontSize: 12, color: muted, marginTop: 4 }}>
        {rep.id
          ? "Correcting the phone or email updates them in Contacts."
          : "A name that isn't on file is added to Contacts when you save."}
      </div>
    </div>
  );
}

