import { useState, useEffect, useMemo, useRef } from "react";
import { localDate, dayMonth, payPeriodLabel, recentPayPeriods, hours, recentQuarters, recentYears, quarterOf } from "../data.js";
import { Db } from "../db.js";
// The dose ledger calls one RPC that has no Db wrapper of its own; the sign-in
// screen reaches for the client the same way.
import { sbClient } from "../config.js";
import { Blueprint, Btn, TableScroll, TagX, ErrorBox, RowsPerPage, useRowsPerPage , Loading, PdfLink, StatusTag, downloadCsv, Dialog } from "./common.jsx";
import { makeZip, safeFilename, saveBlob } from "../zip.js";
import { loadXlsx, loadJsPdf } from "../cdnLibs.js";
import { runInOrder, approvalProgressLine, approvalRunSummary } from "../approvalRun.js";

// Timesheets — hours per person per pay period, built from ticket crew rows.
//
// Nothing is entered here: every line originates on a billing ticket, so the
// hours a person is paid for and the hours the client was billed for come
// from the same record and can't drift apart. Admin reviews and approves;
// there is no submit step.

export function TimesheetsScreen({ currentUser }) {
  // Built once. It was rebuilt on every render, which meant the object in
  // `period` stopped being identity-equal to anything in the list.
  const periods = useMemo(() => recentPayPeriods(12), []);
  const [period, setPeriod] = useState(periods[0]);
  const [entries, setEntries] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [view, setView] = useState("period");      // period | approved | awaiting | dose

  // ── The dose ledger ────────────────────────────────────────────────────
  // Dose is recorded per person per ticket day (the crew block). Summed by
  // calendar quarter and calendar year — the figures a nuclear energy
  // worker's record needs — for everyone (Admin) or for yourself. The same
  // privacy holds whichever way the figures arrive: row-level security
  // returns a technician's own rows and nobody else's, and the filter below
  // says so a second time.
  //
  // The per-person figures are summed by the database, through dose_totals.
  // Adding them up here meant a year of crew rows — tens of thousands of
  // them, paged a thousand at a time, tens of megabytes — crossing the wire
  // to produce the forty-odd numbers this screen shows. The entries
  // themselves are still what the CSV is made of, so that export asks for
  // them when the button is pressed instead of keeping them all in hand.
  const [doseKind, setDoseKind] = useState("quarter");
  const doseOptions = useMemo(() => doseKind === "quarter" ? recentQuarters(8) : recentYears(5), [doseKind]);
  const [dosePeriod, setDosePeriod] = useState(null);
  const effDose = dosePeriod && dosePeriod.kind === doseKind ? dosePeriod : doseOptions[0];
  // One of these two carries the ledger: the RPC's per-person rows, or — on a
  // database that does not have the function yet — the crew entries this
  // screen has always grouped for itself.
  const [doseSummary, setDoseSummary] = useState(null);
  const [doseRows, setDoseRows] = useState([]);
  const [doseLoading, setDoseLoading] = useState(false);
  const [doseExporting, setDoseExporting] = useState(false);
  const doseSeq = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dose read wants the start and end dates alone, and both are listed here
  useEffect(() => {
    if (view !== "dose") return;
    const mine = ++doseSeq.current;
    setDoseLoading(true);
    loadDose(effDose)
      .then(({ summary, entries }) => {
        if (mine !== doseSeq.current) return;
        setDoseSummary(summary);
        setDoseRows(entries);
      })
      .catch(e => { if (mine === doseSeq.current) setError(e.message || "Couldn't load the dose entries."); })
      .finally(() => { if (mine === doseSeq.current) setDoseLoading(false); });
  }, [view, effDose.start, effDose.end]);
  const doseLedger = useMemo(() => {
    // Whoever carries the most first — the order the record is read in.
    const byDose = (a, b) => b.total - a.total || a.name.localeCompare(b.name);
    // Tenths of a mR, as integers: the DRDs read to one decimal, and a ledger
    // added up in floats drifts in the last place.
    const tenths = mR => Math.round(Number(mR || 0) * 10);
    if (doseSummary) {
      return doseSummary
        .filter(r => currentUser.role === "Admin" || r.profile_id === currentUser.id)
        .map(r => ({
          profileId: r.profile_id,
          name: r.name || "",
          days: r.days == null ? null : Number(r.days),
          total: tenths(r.total_mr),
          quarters: [r.q1, r.q2, r.q3, r.q4].map(tenths)
        }))
        .sort(byDose);
    }
    const byId = new Map();
    for (const e of doseRows) {
      if (currentUser.role !== "Admin" && e.profileId !== currentUser.id) continue;
      let p = byId.get(e.profileId);
      if (!p) { p = { profileId: e.profileId, name: e.name, days: 0, total: 0, quarters: [0, 0, 0, 0] }; byId.set(e.profileId, p); }
      p.days += 1;
      p.total += tenths(e.dose);
      p.quarters[quarterOf(e.date) - 1] += tenths(e.dose);
    }
    return [...byId.values()].sort(byDose);
  }, [doseSummary, doseRows, currentUser.role, currentUser.id]);
  const mr = tenths => (tenths / 10).toFixed(1);
  // The entry-by-entry sheet is the only thing that wants every crew row, so
  // it is the only thing that asks for them — on the click, not on the way
  // into the screen. On the fallback path they are already here and there is
  // no sense fetching them twice.
  const exportDose = async () => {
    setDoseExporting(true);
    setError("");
    try {
      const entries = doseRows.length
        ? doseRows
        : (await Db.listTimesheetEntries({ start: effDose.start, end: effDose.end })).filter(r => r.dose > 0);
      const byId = new Map();
      for (const e of entries) {
        if (currentUser.role !== "Admin" && e.profileId !== currentUser.id) continue;
        const held = byId.get(e.profileId);
        if (held) held.push(e); else byId.set(e.profileId, [e]);
      }
      downloadCsv(`Dose ${effDose.label}.csv`, [
        ["Person", "Date", "Job", "Ticket", "Dose (mR)"],
        ...doseLedger.flatMap(p => (byId.get(p.profileId) || []).map(e => [p.name, e.date, e.job, e.ticketId, (Math.round(e.dose * 10) / 10).toFixed(1)])),
        [],
        ["Person", "Days with dose", `Total mR · ${effDose.label}`, ...(doseKind === "year" ? ["Q1", "Q2", "Q3", "Q4"] : [])],
        ...doseLedger.map(p => [p.name, p.days == null ? (byId.get(p.profileId) || []).length : p.days, mr(p.total), ...(doseKind === "year" ? p.quarters.map(mr) : [])])
      ]);
    } catch (e) {
      setError(e.message || "Couldn't build the dose report.");
    }
    setDoseExporting(false);
  };
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [entryPage, setEntryPage] = useState(0);
  // Everyone on the books, for the admin picker. The crew list beside it only
  // holds people with hours this period, which is the common case and the
  // wrong one when the question is "why has Dave not booked anything".
  const [roster, setRoster] = useState([]);
  // Shared with the board, the tracker and the equipment register.
  const [pageSize, setPageSize] = useRowsPerPage();

  // ── Signing off several people at once ─────────────────────────────────
  // Six people every fortnight, each one two screens away, was the whole of
  // payroll day. The awaiting tab already knows who is outstanding; these
  // hold who has been ticked there and how a run of them is going.
  //
  // A ref, not state, for the stop: it is asked between people and a
  // re-render is not what makes the answer true.
  const [picked, setPicked] = useState(() => new Set());
  const [askApprove, setAskApprove] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchStopping, setBatchStopping] = useState(false);
  const [batchProgress, setBatchProgress] = useState("");
  const [batchResult, setBatchResult] = useState("");
  const stopBatch = useRef(false);
  // A tick means "this person, this fortnight". Carrying it across a period
  // change would sign off hours the admin never looked at.
  useEffect(() => {
    setPicked(new Set());
    setBatchResult("");
  }, [period.start]);

  // Which load is the current one. A pay period can hold thousands of crew
  // rows and takes seconds to fetch, so switching period twice in a row means
  // two requests in flight — and without this the slower, older one lands last
  // and puts the wrong fortnight's hours under the new period's heading. On a
  // screen people are paid from, that is not a cosmetic race.
  const isAdminRef = useRef(currentUser.role === "Admin");
  const loadSeq = useRef(0);
  const load = async p => {
    const mine = ++loadSeq.current;
    setLoading(true);
    setError("");
    try {
      const [rows, appr] = await Promise.all([
        Db.listTimesheetEntries(p),
        Db.listApprovals({ start: p.start })
      ]);
      if (mine !== loadSeq.current) return;
      setEntries(rows);
      setApprovals(appr);
      // A technician or helper has one timesheet: their own. Row-level
      // security already returns only their crew rows, so this is about which
      // one the screen opens on, not about what they could reach.
      setSelected(s => {
        if (!isAdminRef.current) return currentUser.id;
        return rows.some(r => r.profileId === s) ? s : (rows[0] ? rows[0].profileId : null);
      });
    } catch (e) {
      if (mine !== loadSeq.current) return;
      setError(e.message || "Couldn't load timesheets.");
    }
    if (mine === loadSeq.current) setLoading(false);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the period's start, which names one period; load reads nothing else that moves
  useEffect(() => { load(period); }, [period.start]);

  // Admins only: reviewing somebody else's hours is not a technician's job,
  // and the tab itself is open to more than admins.
  const isAdmin = currentUser.role === "Admin";
  useEffect(() => {
    if (!isAdmin) return;
    Db.listProfiles().then(setRoster).catch(() => setRoster([]));
  }, [isAdmin]);

  // One row per person, with their entries attached. Grouped through a Map
  // rather than a linear search per entry, and recomputed only when the
  // entries change rather than on every keystroke elsewhere on the page.
  const people = useMemo(() => {
    const byId = new Map();
    for (const e of entries) {
      let p = byId.get(e.profileId);
      if (!p) {
        p = { profileId: e.profileId, name: e.name, isSub: e.isSub, entries: [], straight: 0, ot: 0, solo: 0, soloOt: 0, dose: 0, mileage: 0 };
        byId.set(e.profileId, p);
      }
      p.entries.push(e);
      p.straight += e.straight;
      p.ot += e.ot;
      p.solo += e.solo;
      p.soloOt += e.soloOt;
      p.dose += e.dose;
      p.mileage += e.mileage;
    }
    return [...byId.values()].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  }, [entries]);

  // A person with no hours this period still has a timesheet — an empty one,
  // which is an answer rather than a blank screen. Only assembled for admins,
  // since nobody else can pick from outside the crew list.
  const selectable = useMemo(() => {
    if (!isAdmin) return people;
    const have = new Set(people.map(p => p.profileId));
    const empties = roster
      .filter(r => !have.has(r.id))
      .map(r => ({
        profileId: r.id, name: r.displayName || r.name, isSub: !!r.is_subcontractor,
        entries: [], straight: 0, ot: 0, solo: 0, soloOt: 0, dose: 0, mileage: 0
      }));
    return [...people, ...empties].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  }, [people, roster, isAdmin]);

  // A non-admin with no hours this period still gets their own empty sheet
  // rather than nothing at all.
  const ownEmpty = {
    profileId: currentUser.id, name: currentUser.name, isSub: false,
    entries: [], straight: 0, ot: 0, solo: 0, soloOt: 0, dose: 0, mileage: 0
  };
  const person = selectable.find(p => p.profileId === selected)
    || (isAdmin ? (selectable[0] || null) : (people.find(p => p.profileId === currentUser.id) || ownEmpty));
  // What "Export period summary" may include: everyone for an admin; for
  // anyone else only their own row. The query also returns crewmates on
  // shared tickets, whose hours this screen deliberately doesn't show — the
  // workbook mustn't be the way around that.
  const summaryPeople = isAdmin ? people : people.filter(p => p.profileId === currentUser.id);
  // Keep the picker in step with that fallback: when an admin opens a period
  // with no hours (selected falls to null) or switches to a person with none
  // this fortnight, point selected at the first roster entry so the picker
  // shows a name and the card shows that person's empty sheet — an empty
  // sheet is an answer, not a blank content area.
  useEffect(() => {
    if (!isAdmin || !selectable.length) return;
    if (!selectable.some(p => p.profileId === selected)) setSelected(selectable[0].profileId);
  }, [isAdmin, selectable, selected]);
  // Solo and mileage columns only appear when they carry something: a tech who
  // never works alone shouldn't read two empty columns all period.
  const showSolo = !!person && (person.solo > 0 || person.soloOt > 0);
  const showMileage = !!person && person.isSub;

  // The entry table is paged, but the totals above and below it are not — they
  // are the period's figures, which is the whole point of the screen and what
  // gets approved. Paging is only about how many rows are on screen at once.
  //
  // Sliced in the browser rather than fetched per page, unlike the board and
  // the tracker: the totals, the approval and the Excel export all need every
  // row for the period anyway, so the data is already here. Asking the server
  // again per page would be a round trip to re-fetch what we hold.
  const entryCount = person ? person.entries.length : 0;
  const entryPageCount = Math.max(1, Math.ceil(entryCount / pageSize));
  // Clamped rather than reset, so a page that shrinks under you lands on the
  // last real page instead of an empty one.
  const safePage = Math.min(entryPage, entryPageCount - 1);
  const visibleEntries = person
    ? person.entries.slice(safePage * pageSize, (safePage + 1) * pageSize)
    : [];
  // Back to page 1 when the person or the period changes — page 4 of one
  // person's entries means nothing on the next.
  useEffect(() => { setEntryPage(0); }, [selected, period.start, pageSize]);
  const approvalFor = id => approvals.find(a => a.profile_id === id);
  const approved = person ? approvalFor(person.profileId) : null;

  // Who is still waiting this period: hours on the books, no sign-off. A
  // roster member with no entries is not waiting — there is nothing to
  // approve — so the count is work outstanding, not people outstanding.
  const awaiting = selectable.filter(p => p.entries.length && !approvalFor(p.profileId));
  // Read back out of the live list rather than kept as its own array, so a
  // person who was signed off since the tick — by the per-person button, or
  // by the run that just finished — leaves the selection with the list.
  const chosen = awaiting.filter(p => picked.has(p.profileId));
  const togglePick = id => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Every export button goes through this, so none of them can forget to
  // clear the busy flag on the way out — a download that fails and leaves the
  // button reading "Building…" looks like the app hung.
  const runExport = async (fn) => {
    setExporting(true);
    setError("");
    try { await fn(); }
    catch (e) { setError(e.message || "Couldn't build the spreadsheet."); }
    setExporting(false);
  };

  const toggleApproval = async () => {
    if (!person) return;
    // Reopening takes the sign-off back and deletes the PDF it froze — the
    // record of what was approved. Approving again builds a new one from
    // whatever the tickets say then, so it is not the same document.
    if (approved && !confirm(`Reopen ${person.name}'s timesheet for ${payPeriodLabel(period)}? The approval and its PDF are removed — this can't be undone, and approving again makes a fresh document.`)) return;
    // The load generation this action belongs to. If the admin switches
    // period mid-approval (the picker isn't disabled during the write), a
    // new load() bumps loadSeq, and the refresh below is skipped so it can't
    // overwrite the new period's approvals with this old period's — a wrong
    // Approved/Not-approved badge on a payroll screen.
    const mine = loadSeq.current;
    setBusy(true);
    setError("");
    try {
      if (approved) {
        await Db.unapproveTimesheet({ profileId: person.profileId, start: period.start });
      } else {
        await approvePersonPeriod({
          person, period, approvedBy: currentUser.id, approverName: currentUser.name
        });
      }
      const fresh = await Db.listApprovals({ start: period.start });
      if (mine === loadSeq.current) setApprovals(fresh);
    } catch (e) {
      setError(e.message || "Couldn't update the approval.");
    }
    setBusy(false);
  };

  // The ticked people, one after another, each through the same routine the
  // per-person button runs. Sequential and not a pool: each one renders a PDF
  // in this browser, so the wait is the render and four at once would only
  // cost the laptop memory.
  const approveChosen = async () => {
    setAskApprove(false);
    // The list is fixed here, before anything is written — the run must not
    // grow or shrink under its own progress line.
    const list = chosen;
    if (!list.length) return;
    // Which load this run belongs to, for the same reason the single approval
    // keeps one: an admin who changes period mid-run has a newer load in
    // flight, and this run's refresh must not put the old fortnight back.
    const mine = loadSeq.current;
    stopBatch.current = false;
    setBatchStopping(false);
    setBatchRunning(true);
    setBatchResult("");
    setBatchProgress(approvalProgressLine(1, list.length, list[0].name));
    setError("");

    const out = await runInOrder(
      list,
      p => approvePersonPeriod({ person: p, period, approvedBy: currentUser.id, approverName: currentUser.name }),
      {
        shouldStop: () => stopBatch.current,
        onStart: (n, total, p) => setBatchProgress(approvalProgressLine(n, total, p.name))
      }
    );

    setBatchProgress("");
    setBatchResult(approvalRunSummary({
      done: out.done, failed: out.failed, notStarted: out.notStarted,
      stopped: out.stopped, total: list.length
    }));
    // Whoever did not get signed off stays ticked, so pressing the button
    // again is the retry — the alternative is hunting for them in the list.
    setPicked(new Set([...out.failed.map(f => f.item.profileId), ...out.notStarted.map(p => p.profileId)]));
    setBatchRunning(false);
    setBatchStopping(false);
    stopBatch.current = false;
    // The people just signed off have to leave the tab, and the approvals
    // this wrote are what says so — so the approvals are re-read, as the
    // single-person button does, and not the period's crew rows: an
    // approval writes timesheet_approvals alone, and load(period) was
    // pulling the fortnight's thousands of entries again for nothing.
    try {
      const fresh = await Db.listApprovals({ start: period.start });
      if (mine === loadSeq.current) setApprovals(fresh);
    } catch (e) {
      setError(e.message || "Couldn't re-read the approvals.");
    }
  };

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
        <div>
          {/* A technician's own timesheet is not an admin screen — it shows
              their hours and nobody else's, the way Open tickets shows their
              own drafts. The literal "Admin · Hours" headed it as if it
              belonged to someone else's job. */}
          <div className="kicker">{isAdmin ? "Admin · Hours" : "Your hours"}</div>
          <h2 style={{ fontSize: 34, margin: "2px 0 0" }}>Timesheets</h2>
        </div>
        {view === "period" && <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {/* Applies to the entry table on the right, not the crew list — the
              crew list is one row per person and is short by nature. */}
          <RowsPerPage value={pageSize} onChange={setPageSize} />
          {/* Admins can reach anybody, not only whoever booked hours. The crew
              list beside the table stays as the quick path for the usual
              case; this is for the question the crew list cannot answer. */}
          {isAdmin && selectable.length > 0 && (
            <select className="input" aria-label="Show timesheet for" style={{ width: "auto", minHeight: 38 }}
              value={selected || ""} onChange={e => setSelected(e.target.value)}>
              {selectable.map(p => (
                <option key={p.profileId} value={p.profileId}>
                  {p.name}{p.entries.length ? "" : " — no hours"}
                </option>
              ))}
            </select>
          )}
          <select className="input" value={period.start} style={{ width: "auto", minHeight: 38 }}
            onChange={e => setPeriod(periods.find(p => p.start === e.target.value) || periods[0])}>
            {periods.map(p => <option key={p.start} value={p.start}>{payPeriodLabel(p)}</option>)}
          </select>
          {isAdmin && (
            <Btn variant="secondary" style={{ minHeight: 38 }}
              onClick={() => runExport(() => exportOneTimesheet({ person, period }))}
              disabled={!person || exporting}>
              {exporting ? "Building…" : "This timesheet"}
            </Btn>
          )}
          {isAdmin && (
            <Btn variant="secondary" style={{ minHeight: 38 }}
              onClick={() => runExport(() => exportEveryTimesheet({ people: selectable, period }))}
              disabled={!selectable.length || exporting}>
              {exporting ? "Building…" : "All timesheets (.zip)"}
            </Btn>
          )}
          <Btn variant="secondary" style={{ minHeight: 38 }}
            onClick={() => runExport(() => exportTimesheetWorkbook({ people: summaryPeople, period }))}
            disabled={!summaryPeople.length || exporting}>{exporting ? "Building…" : "Export period summary"}</Btn>
        </div>}
      </div>

      {/* The live period on one tab; what has been signed off on the other.
          The approved tab is everyone's own record — an admin reviewing
          somebody else stays on the period view, where the roster is. */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        <button className={"pill" + (view === "period" ? " active" : "")} onClick={() => setView("period")}>Timesheet</button>
        <button className={"pill" + (view === "approved" ? " active" : "")} onClick={() => setView("approved")}>Approved timesheets</button>
        <button className={"pill" + (view === "dose" ? " active" : "")} onClick={() => setView("dose")}>Dose ledger</button>
        {/* The count is this period's outstanding work, so an admin opening
            the screen knows whether payroll is ready without hunting. */}
        {isAdmin && (
          <button className={"pill" + (view === "awaiting" ? " active" : "")} onClick={() => setView("awaiting")}>
            Awaiting approval{!loading && awaiting.length ? ` (${awaiting.length})` : ""}
          </button>
        )}
      </div>

      {view === "dose" ? (
        <div>
          <ErrorBox>{error}</ErrorBox>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
            <div className="seg" role="group" aria-label="Period type">
              {[["quarter", "Quarter"], ["year", "Year"]].map(([k, label]) => (
                <button key={k} type="button" className={`seg-opt${doseKind === k ? " active" : ""}`}
                  aria-pressed={doseKind === k} onClick={() => setDoseKind(k)}>{label}</button>
              ))}
            </div>
            <select className="input" aria-label="Dose period" style={{ width: "auto", minHeight: 38 }} value={effDose.start}
              onChange={e => setDosePeriod(doseOptions.find(o => o.start === e.target.value) || doseOptions[0])}>
              {doseOptions.map(o => <option key={o.start} value={o.start}>{o.label}</option>)}
            </select>
            {/* Everyone, not Admins alone: a dose record is the one document
                a technician is personally asked for, and the ledger they are
                looking at is already their own. exportDose keeps a non-admin
                to their own rows, so the file is the screen and nothing more. */}
            <Btn variant="secondary" style={{ minHeight: 38, marginLeft: "auto" }} onClick={exportDose} disabled={!doseLedger.length || doseLoading || doseExporting}>
              {doseExporting ? "Building…" : isAdmin ? "Export dose report (.csv)" : "Export my dose record (.csv)"}
            </Btn>
          </div>
          <Blueprint style={{ padding: "6px 18px 14px" }}>
            {doseLoading && <div style={{ padding: "12px 4px", fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Loading dose entries…</div>}
            <TableScroll><table className="table table-wide">
              <thead>
                <tr>
                  <th>Person</th>
                  <th style={{ width: 120 }}>Days with dose</th>
                  {doseKind === "year" && <><th style={{ width: 80 }}>Q1</th><th style={{ width: 80 }}>Q2</th><th style={{ width: 80 }}>Q3</th><th style={{ width: 80 }}>Q4</th></>}
                  <th style={{ width: 110 }}>Total mR</th>
                </tr>
              </thead>
              <tbody>
                {!doseLoading && !doseLedger.length && (
                  <tr><td colSpan={doseKind === "year" ? 7 : 3} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                    No dose recorded for {effDose.label}.
                  </td></tr>
                )}
                {!doseLoading && doseLedger.map(p => (
                  <tr key={p.profileId}>
                    <td style={{ fontFamily: "var(--font-heading)", fontWeight: 600 }}>{p.name}</td>
                    <td className="tabular">{p.days == null ? "—" : p.days}</td>
                    {doseKind === "year" && p.quarters.map((q, i) => <td key={i} className="tabular">{mr(q)}</td>)}
                    <td className="tabular" style={{ fontWeight: 600 }}>{mr(p.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table></TableScroll>
            <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginTop: 8 }}>
              Dose is what each person recorded on the ticket's crew block for the day, in mR, summed by calendar quarter and calendar year.
              {isAdmin ? " The export lists every entry, then a total per person." : " You see your own record."}
            </div>
          </Blueprint>
        </div>
      ) : view === "approved" ? (
        <ApprovedList currentUser={currentUser} />
      ) : view === "awaiting" ? (
        <div>
          <ErrorBox>{error}</ErrorBox>
          <div style={{ marginBottom: 14, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {/* Held still while a run is going: the run is signing off this
                fortnight, and switching underneath it would leave the
                progress line naming people from a period nobody is on. */}
            <select className="input" value={period.start} style={{ width: "auto", minHeight: 38 }} disabled={batchRunning}
              onChange={e => setPeriod(periods.find(p => p.start === e.target.value) || periods[0])}>
              {periods.map(p => <option key={p.start} value={p.start}>{payPeriodLabel(p)}</option>)}
            </select>
            {isAdmin && awaiting.length > 0 && (<>
              <Btn variant="secondary" style={{ minHeight: 38 }} disabled={batchRunning}
                onClick={() => setPicked(new Set(awaiting.map(p => p.profileId)))}>Tick all</Btn>
              <Btn variant="secondary" style={{ minHeight: 38 }} disabled={batchRunning || !picked.size}
                onClick={() => setPicked(new Set())}>Clear</Btn>
              {/* Same gate as the per-person button beside a timesheet:
                  approval is an admin's act, in the policy as well as here. */}
              <Btn variant="primary" style={{ minHeight: 38, marginLeft: "auto" }}
                disabled={!chosen.length || batchRunning || busy}
                onClick={() => setAskApprove(true)}
                title="Builds each person's timesheet PDF and signs their period off, one after another.">
                {batchRunning ? "Approving…" : `Approve ${chosen.length} period${chosen.length === 1 ? "" : "s"}`}
              </Btn>
              {/* A run of a dozen sign-offs has to be callable off — the
                  admin spots the wrong name on the second one, not the last.
                  It starts no more; the person in hand is finished, because
                  a PDF half-way to the bucket is not a state to stop in. */}
              {batchRunning && (
                <Btn variant="secondary" style={{ minHeight: 38 }} disabled={batchStopping}
                  onClick={() => { stopBatch.current = true; setBatchStopping(true); }}
                  title="Finishes the timesheet being signed off and leaves the rest.">
                  {batchStopping ? "Stopping…" : "Stop"}
                </Btn>
              )}
            </>)}
          </div>
          {(batchProgress || batchResult) && (
            <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)", marginBottom: 14 }}>
              {batchProgress || batchResult}
            </div>
          )}
          {loading ? (
            <Loading />
          ) : !awaiting.length ? (
            <Blueprint style={{ padding: "22px 20px" }}>
              <div style={{ fontSize: 14, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
                Everyone with hours in {payPeriodLabel(period)} has been signed off.
              </div>
            </Blueprint>
          ) : (
            <Blueprint style={{ padding: "6px 18px 14px" }}>
              <TableScroll><table className="table">
                <thead>
                  <tr>
                    {isAdmin && (
                      <th style={{ width: 34 }}>
                        <input type="checkbox" aria-label="Select everyone awaiting approval" disabled={batchRunning}
                          checked={awaiting.length > 0 && chosen.length === awaiting.length}
                          onChange={e => setPicked(e.target.checked ? new Set(awaiting.map(p => p.profileId)) : new Set())} />
                      </th>
                    )}
                    <th>Name</th>
                    <th style={{ width: 80 }}>Entries</th>
                    <th style={{ width: 80 }}>Reg hrs</th>
                    <th style={{ width: 80 }}>OT hrs</th>
                    <th style={{ width: 90 }}>Dose (mR)</th>
                    <th style={{ width: 110 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {awaiting.map(p => (
                    <tr key={p.profileId}>
                      {isAdmin && (
                        <td>
                          <input type="checkbox" aria-label={`Select ${p.name}`} disabled={batchRunning}
                            checked={picked.has(p.profileId)} onChange={() => togglePick(p.profileId)} />
                        </td>
                      )}
                      <td>{p.name}{p.isSub ? <span style={{ fontSize: 11, opacity: .6 }}> · Subcontractor</span> : ""}</td>
                      <td className="tabular">{p.entries.length}</td>
                      <td className="tabular">{hours(p.straight)}</td>
                      <td className="tabular">{hours(p.ot)}</td>
                      <td className="tabular">{hours(p.dose)}</td>
                      {/* Review, not Approve: signing off hours nobody looked
                          at is exactly what this screen exists to prevent. */}
                      <td><Btn variant="secondary" disabled={batchRunning}
                        onClick={() => { setSelected(p.profileId); setView("period"); }}>Review</Btn></td>
                    </tr>
                  ))}
                </tbody>
              </table></TableScroll>
            </Blueprint>
          )}
        </div>
      ) : (<>

      <ErrorBox>{error}</ErrorBox>

      {loading ? (
        <Loading />
      // Only an admin can be told there is nobody on the books — a
      // non-admin has one timesheet, and an empty one is the answer
      // (ownEmpty, below), which this test stood in front of.
      ) : isAdmin && !selectable.length ? (
        <Blueprint style={{ padding: "22px 20px" }}>
          <div style={{ fontSize: 14, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
            No hours recorded in {payPeriodLabel(period)}, and nobody on the books to show. Hours arrive here when a billing ticket is raised with a crew on it.
          </div>
        </Blueprint>
      ) : (
        <div>

          {person && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <Blueprint style={{ padding: "18px 20px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
                  <h4 style={{ margin: 0, fontSize: 19 }}>{person.name}</h4>
                  {person.isSub && <TagX variant="outline">Subcontractor</TagX>}
                  {approved
                    ? <TagX variant="accent">Approved {new Date(approved.approved_at).toLocaleDateString("en-CA", { day: "2-digit", month: "short" })}</TagX>
                    : <TagX variant="dashed">Not approved</TagX>}
                  {approved && approved.pdf_key && (
                    <PdfLink bucket="timesheets" pdfKey={approved.pdf_key} file="View" style={{ fontSize: 13 }} />
                  )}
                  {/* Approval is a control, not a formality: signing off your
                      own hours is not one. */}
                  {/* Held while a batch is running: the two paths write the
                      same table and reload the same approvals, and a
                      sign-off pressed here mid-run would race that reload. */}
                  {isAdmin && <Btn variant={approved ? "secondary" : "primary"} style={{ marginLeft: "auto" }}
                    onClick={toggleApproval} disabled={busy || batchRunning}>
                    {approved ? "Reopen" : "Approve period"}
                  </Btn>}
                </div>

                {/* auto-fit, not repeat(N, 1fr): a 1fr track will not shrink
                    below its content, so six stats forced the layout to
                    ~540px and a phone viewport stretched to match — the
                    whole screen scrolled sideways. Wrapping to two rows on
                    narrow screens is the correct trade. */}
                <div className="strip" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(104px, 1fr))" }}>
                  <Stat label="Reg hrs" value={hours(person.straight)} unit="h" />
                  <Stat label="OT hrs" value={hours(person.ot)} unit="h" />
                  {showSolo && <Stat label="Solo reg" value={hours(person.solo)} unit="h" />}
                  {showSolo && <Stat label="Solo OT" value={hours(person.soloOt)} unit="h" />}
                  <Stat label="Dose this period" value={hours(person.dose)} unit="mR" />
                  {showMileage && <Stat label="Mileage" value={person.mileage.toFixed(0)} unit="km" />}
                </div>
                <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 65%, transparent)", marginTop: 10 }}>
                  Total paid hours {hours(person.straight + person.ot)}{showSolo ? " — solo hours are a rate distinction within those, not additional time." : "."}
                </div>
              </Blueprint>

              <Blueprint style={{ padding: "6px 18px 14px" }}>
                <TableScroll><table className="table table-wide">
                  <thead>
                    <tr>
                      <th style={{ width: 90 }}>Date</th>
                      <th style={{ width: 120 }}>Ticket</th>
                      {/* A pay period approved on drafts is approved on
                          hours that can still change; the status was loaded
                          and printed on the export, but not shown here. */}
                      <th style={{ width: 120 }}>Status</th>
                      <th>Job · project</th>
                      <th style={{ width: 70 }}>Reg</th>
                      <th style={{ width: 60 }}>OT</th>
                      {showSolo && <th style={{ width: 75 }}>Solo reg</th>}
                      {showSolo && <th style={{ width: 70 }}>Solo OT</th>}
                      <th style={{ width: 75 }}>Dose</th>
                      {showMileage && <th style={{ width: 80 }}>Mileage</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleEntries.map(e => (
                      <tr key={e.id}>
                        <td className="tabular">{dayMonth(localDate(e.date))}</td>
                        <td className="tabular" style={{ fontFamily: "var(--font-heading)", fontWeight: 600 }}>{e.ticketId}</td>
                        <td>{e.ticketStatus ? <StatusTag status={e.ticketStatus} /> : "—"}</td>
                        <td>
                          <div>{e.project}</div>
                          <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>{e.job} · {e.client}</div>
                        </td>
                        <td className="tabular">{hours(e.straight)}</td>
                        <td className="tabular">{hours(e.ot)}</td>
                        {showSolo && <td className="tabular">{e.solo ? hours(e.solo) : "—"}</td>}
                        {showSolo && <td className="tabular">{e.soloOt ? hours(e.soloOt) : "—"}</td>}
                        <td className="tabular">{e.dose ? hours(e.dose) + " mR" : "—"}</td>
                        {showMileage && <td className="tabular">{e.mileage ? e.mileage.toFixed(0) : "—"}</td>}
                      </tr>
                    ))}
                    <tr>
                      {/* Says "all N entries" once there is more than one page,
                          so a total larger than the rows above it reads as the
                          period's figure rather than a mistake.
                          Four, not three: Date, Ticket, Status and Job · project
                          all sit before Reg. The Status column was added after
                          this row was written and the span was not moved with
                          it, so every figure printed one heading to the left —
                          period hours under OT, and a dose reading under
                          Mileage, on a payroll screen. */}
                      <td colSpan={4} style={{ fontWeight: 600 }}>
                        Period total{entryPageCount > 1 ? ` · all ${entryCount} entries` : ""}
                      </td>
                      <td className="tabular" style={{ fontWeight: 600 }}>{hours(person.straight)}</td>
                      <td className="tabular" style={{ fontWeight: 600 }}>{hours(person.ot)}</td>
                      {showSolo && <td className="tabular" style={{ fontWeight: 600 }}>{hours(person.solo)}</td>}
                      {showSolo && <td className="tabular" style={{ fontWeight: 600 }}>{hours(person.soloOt)}</td>}
                      <td className="tabular" style={{ fontWeight: 600 }}>{hours(person.dose)}</td>
                      {showMileage && <td className="tabular" style={{ fontWeight: 600 }}>{person.mileage.toFixed(0)}</td>}
                    </tr>
                  </tbody>
                </table></TableScroll>
                {/* Same control as the dispatch board, the billing tracker and
                    the equipment register — hidden at one page, as they are. */}
                {entryPageCount > 1 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 4px 4px" }}>
                    <Btn variant="secondary" onClick={() => setEntryPage(p => Math.max(0, p - 1))} disabled={safePage === 0}>← Previous</Btn>
                    <span style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>Page {safePage + 1} of {entryPageCount}</span>
                    <Btn variant="secondary" onClick={() => setEntryPage(p => Math.min(entryPageCount - 1, p + 1))} disabled={safePage >= entryPageCount - 1}>Next →</Btn>
                  </div>
                )}
              </Blueprint>

              <p style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 65%, transparent)", margin: 0 }}>
                Hours come from the crew on each billing ticket — to correct one, edit the ticket rather than this page.
                Dose is recorded per person per ticket in mR.
              </p>
            </div>
          )}
        </div>
      )}
      </>)}

      {/* Approving is a signature on somebody's pay, and a batch of them is a
          batch of signatures — so it names every person and the fortnight
          before it starts, and reopening one afterwards is a separate act on
          each timesheet. */}
      {askApprove && chosen.length > 0 && (
        <Dialog title={`Approve ${chosen.length} timesheet${chosen.length === 1 ? "" : "s"}`} maxWidth={480}
          onClose={() => setAskApprove(false)}
          actions={<>
            <Btn variant="secondary" onClick={() => setAskApprove(false)}>Cancel</Btn>
            <Btn variant="primary" onClick={approveChosen}>Approve {chosen.length} period{chosen.length === 1 ? "" : "s"}</Btn>
          </>}>
          <div style={{ fontSize: 14 }}>
            Sign off {payPeriodLabel(period)} for {chosen.length === 1 ? "this person" : "these people"}? Each one gets a timesheet PDF built from the hours on this screen.
          </div>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14, maxHeight: 220, overflowY: "auto" }}>
            {chosen.map(p => (
              <li key={p.profileId}>
                {p.name} — {hours(p.straight + p.ot)} h over {p.entries.length} {p.entries.length === 1 ? "entry" : "entries"}
              </li>
            ))}
          </ul>
          <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
            They are done one after another and can be stopped part way. Reopening an approval afterwards is one timesheet at a time.
          </div>
        </Dialog>
      )}
    </div>
  );
}

// Where the dose ledger's figures come from. dose_totals adds them up in the
// database — one row per person, the four calendar quarters and a total —
// rather than sending a year of crew rows over to be added up here.
//
// It is live on this project (20260904135107), so the fallback below is
// belt and braces for a database that has not had that migration — a fresh
// environment brought up from an older schema — which still has to show the
// ledger. It costs nothing where the function exists, so it stays.
// PostgREST answers PGRST202 for a routine it cannot find, and older
// gateways say the same in words; that answer — and only that one, see
// isMissingDoseTotals — falls back to the read this screen has always used.
// Anything else — a permission refusal, a timeout — is a real failure and
// reaches the screen as itself.
async function loadDose({ start, end }) {
  const { data, error } = await sbClient.rpc("dose_totals", { p_start: start, p_end: end });
  if (!error) return { summary: data || [], entries: [] };
  if (!isMissingDoseTotals(error)) throw error;
  const entries = await Db.listTimesheetEntries({ start, end });
  return { summary: null, entries: entries.filter(r => r.dose > 0) };
}

// The code is the reliable half; the message is checked too because older
// gateways only say it in words — but only a message that names this
// function, so nothing else gets quietly treated as "not deployed yet".
function isMissingDoseTotals(error) {
  if (error.code === "PGRST202") return true;
  const msg = String(error.message || "");
  return msg.includes("dose_totals") && /could not find|does not exist|not found/i.test(msg);
}

// The other tab: every period of yours that has been signed off, newest
// first, each one a stored PDF. This is deliberately your own record even
// for admins — reviewing somebody else's hours happens on the period view,
// where the roster and the Approve button are.
function ApprovedList({ currentUser }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    Db.listMyApprovedTimesheets(currentUser.id)
      .then(r => { if (live) setRows(r); })
      .catch(e => { if (live) { setError(e.message || "Couldn't load approved timesheets."); setRows([]); } });
    return () => { live = false; };
  }, [currentUser.id]);

  if (rows === null) return <Loading />;
  return (
    <div>
      <ErrorBox>{error}</ErrorBox>
      {!rows.length && !error ? (
        <Blueprint style={{ padding: "22px 20px" }}>
          <div style={{ fontSize: 14, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
            Nothing signed off yet. When an admin approves one of your pay periods, the timesheet lands here as a PDF.
          </div>
        </Blueprint>
      ) : (
        <Blueprint style={{ padding: "6px 18px 14px" }}>
          <TableScroll><table className="table">
            <thead>
              <tr>
                <th>Pay period</th>
                <th style={{ width: 160 }}>Approved by</th>
                <th style={{ width: 110 }}>On</th>
                <th style={{ width: 200 }}>Document</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.start}>
                  <td>{payPeriodLabel({ start: r.start, end: r.end })}</td>
                  <td>{r.by}</td>
                  <td className="tabular">{new Date(r.at).toLocaleDateString("en-CA", { day: "2-digit", month: "short", year: "numeric" })}</td>
                  {/* Approvals recorded before PDFs existed have no document;
                      PdfLink renders those as muted text, which is the truth. */}
                  <td><PdfLink bucket="timesheets" pdfKey={r.pdfKey} file={`Timesheet ${r.start}`} /></td>
                </tr>
              ))}
            </tbody>
          </table></TableScroll>
        </Blueprint>
      )}
    </div>
  );
}

function Stat({ label, value, unit }) {
  return (
    <div>
      <div style={{ fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{label}</div>
      <div className="tabular" style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 26, lineHeight: 1.15 }}>
        {value}<span style={{ fontSize: 13, fontWeight: 400, marginLeft: 4, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{unit}</span>
      </div>
    </div>
  );
}

// SheetJS and jsPDF come from cdnLibs.js, on demand, shared with Ask's files.

// What approving one person's period actually is, in one place: the PDF built
// from the figures the admin is looking at, then the row that points at it.
// Both buttons run this — the per-person "Approve period" and the batch on the
// awaiting tab — rather than each building its own document, because a batch
// approval that froze a different sheet from the single one would be a second
// definition of what an approval means.
async function approvePersonPeriod({ person, period, approvedBy, approverName }) {
  // The document is built before the row is written: approving means freezing
  // these figures, so if the PDF cannot be produced the period stays open.
  const JsPDF = await loadJsPdf();
  const pdfBytes = buildTimesheetPdf(JsPDF, person, period, approverName);
  await Db.approveTimesheet({
    profileId: person.profileId, start: period.start, end: period.end,
    approvedBy, pdfBytes
  });
}

// The document that approval freezes: the same figures as the Excel export
// and the screen — totals strip, then every entry — plus the line neither
// of those carries, which is who signed it off and when. Ticket data can be
// corrected after the fact; this is the record of what was approved.
function buildTimesheetPdf(JsPDF, person, period, approverName) {
  const doc = new JsPDF({ unit: "pt", format: "letter" });
  const label = payPeriodLabel(period);
  const showSolo = person.solo > 0 || person.soloOt > 0;
  const ink = [29, 31, 32];
  const num = n => String(hours(n));

  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.setTextColor(...ink);
  doc.text("VagaboNDE — Timesheet", 48, 54);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(`${person.name} · ${person.isSub ? "Subcontractor" : "Employee"}`, 48, 72);
  doc.text(label, 48, 86);

  doc.autoTable({
    startY: 104,
    margin: { left: 48, right: 48 },
    styles: { fontSize: 9, cellPadding: 5, textColor: ink },
    headStyles: { fillColor: [40, 44, 46], textColor: 255 },
    head: [[
      "Reg hrs", "OT hrs",
      ...(showSolo ? ["Solo reg", "Solo OT"] : []),
      "Total paid", "Dose (mR)",
      ...(person.isSub ? ["Mileage (km)"] : [])
    ]],
    body: [[
      num(person.straight), num(person.ot),
      ...(showSolo ? [num(person.solo), num(person.soloOt)] : []),
      num(person.straight + person.ot), num(person.dose),
      ...(person.isSub ? [String(Math.round(person.mileage))] : [])
    ]]
  });

  const detailCols = 5 + 2 + (showSolo ? 2 : 0) + 1 + (person.isSub ? 1 : 0);
  doc.autoTable({
    startY: doc.lastAutoTable.finalY + 16,
    margin: { left: 48, right: 48 },
    styles: { fontSize: 7.5, cellPadding: 3.5, textColor: ink },
    headStyles: { fillColor: [40, 44, 46], textColor: 255 },
    head: [[
      "Date", "Ticket", "Job", "Project", "Client", "Reg", "OT",
      ...(showSolo ? ["Solo", "Solo OT"] : []),
      "Dose",
      ...(person.isSub ? ["km"] : []),
      "Status"
    ]],
    body: person.entries.length
      ? person.entries.map(e => [
          e.date, e.ticketId, e.job, e.project, e.client, num(e.straight), num(e.ot),
          ...(showSolo ? [num(e.solo), num(e.soloOt)] : []),
          num(e.dose),
          ...(person.isSub ? [String(Math.round(e.mileage))] : []),
          e.ticketStatus
        ])
      : [[{ content: "No hours recorded in this period.", colSpan: detailCols + 1, styles: { fontStyle: "italic" } }]]
  });

  // The approval line, and a fresh page for it if the table ran the sheet
  // out — a signature block that overprints the last row is not a document
  // anyone should file.
  let y = doc.lastAutoTable.finalY + 26;
  if (y > doc.internal.pageSize.getHeight() - 48) {
    doc.addPage();
    y = 56;
  }
  doc.setFontSize(10);
  doc.text(
    `Approved by ${approverName} — ${new Date().toLocaleDateString("en-CA", { day: "2-digit", month: "short", year: "numeric" })}`,
    48, y
  );
  return doc.output("arraybuffer");
}

// Two sheets, because a bookkeeper wants both: Summary is one row per person
// to key into payroll, Detail is every entry so a subcontractor can lift the
// lines straight into their own invoice.
//
// Built rather than written, so the same shape serves all three buttons: the
// whole period in one workbook, one person on their own, and one workbook per
// person inside a bundle. A person's figures must not depend on which button
// produced them.
function buildWorkbook(XLSX, people, period) {
  const label = payPeriodLabel(period);

  const summary = people.map(p => ({
    Name: p.name,
    Type: p.isSub ? "Subcontractor" : "Employee",
    "Straight hours": Number(hours(p.straight)),
    "Overtime hours": Number(hours(p.ot)),
    "Solo reg hours": Number(hours(p.solo)),
    "Solo OT hours": Number(hours(p.soloOt)),
    "Total hours": Number(hours(p.straight + p.ot)),
    "Dose (mR)": Number(hours(p.dose)),
    "Mileage (km)": p.isSub ? Math.round(p.mileage) : "",
    "Pay period": label
  }));

  const detail = [];
  for (const p of people) {
    for (const e of p.entries) {
      detail.push({
        Name: p.name,
        Type: p.isSub ? "Subcontractor" : "Employee",
        Role: e.role || "Technician",
        Date: e.date,
        Ticket: e.ticketId,
        Job: e.job,
        Project: e.project,
        Client: e.client,
        "Straight hours": Number(hours(e.straight)),
        "Overtime hours": Number(hours(e.ot)),
        "Solo reg hours": Number(hours(e.solo)),
        "Solo OT hours": Number(hours(e.soloOt)),
        "Dose (mR)": Number(hours(e.dose)),
        "Mileage (km)": p.isSub ? Math.round(e.mileage) : "",
        "Ticket status": e.ticketStatus
      });
    }
  }

  // A person with no hours gets a workbook with a header row and nothing
  // under it. json_to_sheet on an empty array produces a sheet with no header
  // at all, which reads as a broken file rather than as an empty period.
  const wb = XLSX.utils.book_new();
  const s1 = XLSX.utils.json_to_sheet(summary.length ? summary : [{
    Name: people.length ? people[0].name : "",
    Type: "", "Straight hours": 0, "Overtime hours": 0, "Solo reg hours": 0,
    "Solo OT hours": 0, "Total hours": 0, "Dose (mR)": 0, "Mileage (km)": "", "Pay period": label
  }]);
  const s2 = XLSX.utils.json_to_sheet(detail.length ? detail : [{
    Name: people.length ? people[0].name : "", Type: "", Role: "", Date: "", Ticket: "",
    Job: "", Project: "", Client: "", "Straight hours": "", "Overtime hours": "",
    "Solo reg hours": "", "Solo OT hours": "", "Dose (mR)": "", "Mileage (km)": "",
    "Ticket status": "No hours recorded in this period"
  }]);
  s1["!cols"] = [{ wch: 22 }, { wch: 15 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 13 }, { wch: 12 }, { wch: 11 }, { wch: 13 }, { wch: 20 }];
  s2["!cols"] = [{ wch: 22 }, { wch: 15 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 26 }, { wch: 24 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 13 }, { wch: 11 }, { wch: 13 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, s1, "Summary");
  XLSX.utils.book_append_sheet(wb, s2, "Detail");
  return wb;
}

const periodSuffix = period => `${period.start} to ${period.end}`;

// Everyone, in one workbook — "Export period summary". Its Summary sheet is
// one row per person, which is the whole crew side by side and the only one
// of the three exports that gives you that: the bundle holds a file each,
// every one with a single-row Summary.
async function exportTimesheetWorkbook({ people, period }) {
  const XLSX = await loadXlsx();
  XLSX.writeFile(buildWorkbook(XLSX, people, period), `Timesheets ${periodSuffix(period)}.xlsx`);
}

// One person, on their own — what gets emailed to a subcontractor who asked
// for their hours, without the rest of the crew's attached.
async function exportOneTimesheet({ person, period }) {
  const XLSX = await loadXlsx();
  XLSX.writeFile(
    buildWorkbook(XLSX, [person], period),
    `Timesheet ${safeFilename(person.name)} ${periodSuffix(period)}.xlsx`
  );
}

// One workbook each, bundled. Not one workbook with a sheet per person:
// these get forwarded individually, and a bookkeeper should be able to send
// somebody their hours without sending everyone else's too.
async function exportEveryTimesheet({ people, period }) {
  const XLSX = await loadXlsx();
  const suffix = periodSuffix(period);

  // Names come from a free-text column and two people can share one. A
  // duplicate would silently overwrite inside the archive, so a collision
  // gets a number rather than one person's hours disappearing.
  const used = new Map();
  const files = people.map(p => {
    const base = safeFilename(p.name, "unnamed");
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    const name = `Timesheet ${base}${n > 1 ? ` (${n})` : ""} ${suffix}.xlsx`;
    return {
      name,
      data: new Uint8Array(XLSX.write(buildWorkbook(XLSX, [p], period), { type: "array", bookType: "xlsx" }))
    };
  });

  saveBlob(makeZip(files), `Timesheets ${suffix}.zip`);
}
