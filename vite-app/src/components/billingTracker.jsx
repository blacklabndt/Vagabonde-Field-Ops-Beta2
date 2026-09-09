import React, { useState, useEffect, useRef } from "react";
import { todayLocal, money, seesPrices } from "../data.js";
import { Db } from "../db.js";
import { Blueprint, Btn, TableScroll, StatusTag, TagX, ErrorBox, Dialog, downloadCsv, emailIn, RowsPerPage, useRowsPerPage } from "./common.jsx";
import { Toasts } from "../toastBus.js";
import { runSendPool } from "../sendPool.js";
import { planChase } from "../chasePlan.js";
import { rollUpAging, isMissingTicketAging, AGING_BUCKETS } from "../ticketAging.js";
import { ticketExportRows, lineExportRows } from "../accountingExport.js";

const TRACKER_FILTERS = ["All", "Draft", "Awaiting approval", "Approved", "Invoiced", "Over 7 days"];
// Each status filter wears its own colour (matching StatusTag), so the pill row
// doubles as the legend for the table below it and triage is a glance: tap the
// amber pill for the ones to chase, the red for the ones that have sat too long.
// "All" has no tone and keeps the default steel.
const PILL_TONE = {
  Draft: "idle", "Awaiting approval": "warn", Approved: "ok",
  Invoiced: "steel", "Over 7 days": "bad"
};

// How the bulk chase paces itself. Three sends in flight covers the round trip
// to the Edge Function without the browser holding thousands of open requests;
// the 500 ms floor between starts keeps the whole pool under Resend's own
// per-second ceiling, which a straight fan-out walks into immediately. Twenty
// failing ticket numbers on screen is enough for the office to act on and
// short enough to read — the rest are counted, not listed.
const CHASE_WORKERS = 3;
const CHASE_INTERVAL_MS = 500;
const CHASE_LIST_LIMIT = 20;
// How many of the tickets about to be emailed the confirm dialog names one by
// one. Forty is about as much as anyone reads before scrolling past it, and
// the point of the list is to catch a wrong address in it — a thousand lines
// hides that as thoroughly as no list at all. The rest are counted.
const CHASE_DIALOG_LIMIT = 40;

const shortDate = iso => iso ? new Date(iso).toLocaleDateString("en-CA", { day: "2-digit", month: "short" }) : "";

// What the CSV was built from, said in the file itself. A spreadsheet of
// "the tickets" is unreadable a week later in accounting: there is no way to
// tell a narrowed export from a whole one, and both look complete.
function filterCaption(filter, q, from, to) {
  const parts = [`Status: ${filter}`];
  if (q) parts.push(`Search: ${q}`);
  parts.push(from || to ? `Worked ${from || "earliest"} to ${to || "latest"}` : "All work dates");
  return parts.join(" · ");
}

// The two spreadsheets, built by accountingExport.js and written by the CSV
// helper every other export here uses. The rows are its business and the
// quoting is downloadCsv's; this is only the filename and the trip to disk.
function exportTickets(tickets, caption, detail) {
  downloadCsv(`Tickets ${todayLocal()}.csv`, ticketExportRows(tickets, {
    caption, exportedOn: todayLocal(),
    invoices: detail.invoices, invoiceNumbers: detail.invoiceNumbers
  }));
}

function exportLines(tickets, caption, detail) {
  downloadCsv(`Ticket lines ${todayLocal()}.csv`, lineExportRows(tickets, {
    caption, exportedOn: todayLocal(), invoices: detail.invoices, lines: detail.lines
  }));
}

export function BillingTrackerScreen({ onOpenTicket, currentUser }) {
  // The one price rule (data.js). The database already hands this screen
  // null totals for any other role; the tiles and the column follow suit
  // rather than printing "$0.00" against every ticket.
  const priced = seesPrices(currentUser);
  const [filter, setFilter] = useState("All");
  // The tick column and the Mark invoiced button it feeds are one thing,
  // and an Admin's alone: mark_tickets_invoiced raises 42501 for every
  // other role, and a Coordinator holds this tab. Header, cells, the empty
  // row's colSpan and the button all take this one test, or the table
  // loses a column.
  const picking = filter === "Approved" && currentUser.role === "Admin";
  // Search and a work-date window, sent to the server with the status — the
  // tracker holds every ticket ever raised, and finding one by client or
  // job used to mean paging.
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // The approved tickets ticked for a bulk "Mark invoiced". Only meaningful
  // on the Approved filter; cleared whenever the page or filter changes.
  const [picked, setPicked] = useState({});
  const [marking, setMarking] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useRowsPerPage();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  // The money across everything the filter matches — what "how much is this
  // client's month?" wants, which the page's own sum never answered.
  const [filteredTotal, setFilteredTotal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  // How old the outstanding money is and whose it is, rolled up by
  // ticketAging.js. Null until the database answers; `agingOff` is the one
  // answer that isn't a failure — a database without the ticket_aging
  // migration, which the tracker carries on without.
  const [aging, setAging] = useState(null);
  const [agingOff, setAgingOff] = useState(false);
  // The by-client view: the same outstanding money, one row per client
  // instead of one per ticket.
  const [byClient, setByClient] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportingLines, setExportingLines] = useState(false);
  const [chasing, setChasing] = useState(false);
  const [chaseResult, setChaseResult] = useState("");
  // What the chase is about to do, held while the office reads it. Null when
  // no dialog is open; the buckets are computed from the real list before the
  // dialog opens, so the numbers on it are the ones that will happen.
  const [chaseAsk, setChaseAsk] = useState(null);
  const [chasePreparing, setChasePreparing] = useState(false);
  // Where each unsigned ticket's approval link would go — id → address, or
  // "" for a ticket with nobody to send to. Null until the lookup answers,
  // and it can stay null (a failed lookup): a row that doesn't know still
  // offers the button and finds the address when it is pressed, because
  // "we couldn't check" must never render as "there is no rep on file".
  const [contacts, setContacts] = useState(null);
  // The ticket a single resend is working on, and what to say on its row
  // afterwards — the function's own words on a refusal, which is the whole
  // value of showing it there rather than in the page-wide error box.
  const [resendId, setResendId] = useState("");
  const [resendAsk, setResendAsk] = useState(null);
  // Pulling a sent ticket back from the tracker: the row being asked about
  // (with whether the editor follows) and the row mid-withdraw.
  const [withdrawAsk, setWithdrawAsk] = useState(null);
  const [withdrawingId, setWithdrawingId] = useState("");
  const [rowNotes, setRowNotes] = useState({});

  // The four tiles are computed over every ticket, independent of the page
  // showing below — loaded on mount and refreshed when the filter changes,
  // since a status flip elsewhere in the app would move a ticket between
  // buckets. (The empty-deps version never re-ran, so the tiles silently
  // drifted from the table below them.) Not on a page turn: both reads are
  // whole-book aggregates, and Next → Next → Next was running them again
  // for an answer that cannot change with the page. Every action here that
  // moves a ticket calls loadTiles itself.
  const loadStats = () =>
    Db.getTicketTrackerStats().then(setStats).catch(e => setError(e.message || "Couldn't load the tracker totals."));

  // The aging buckets and the by-client rollup, from the one RPC that groups
  // them in the database. A database without that migration — a fresh
  // environment, or this one before it is applied — answers "no such
  // routine", and the screen simply goes back to the tracker it has always
  // been rather than showing an error about a tile. Anything else is a real
  // failure and says so: silently blank money is worse than none.
  const loadAging = () =>
    Db.ticketAging()
      .then(rows => { setAging(rollUpAging(rows)); setAgingOff(false); })
      .catch(e => {
        if (isMissingTicketAging(e)) { setAging(null); setAgingOff(true); setByClient(false); return; }
        setError(e.message || "Couldn't work out how old the outstanding money is.");
      });

  const loadTiles = () => { loadStats(); loadAging(); };
  useEffect(() => { loadTiles(); }, [filter]);

  // A request token, so a slow earlier page cannot land after a newer one.
  // Tapping through filters or pages fires overlapping reads, and whichever
  // returns last used to win — repainting stale rows together with a total
  // that belongs to a different query, so the pager and the table disagreed.
  const loadSeq = useRef(0);
  const fetchPage = async (p, f, search = q, dFrom = from, dTo = to) => {
    const mine = ++loadSeq.current;
    setLoading(true);
    setError("");
    try {
      const { rows: r, total: t, filteredTotal: ft } = await Db.searchTickets({ page: p, pageSize, status: f, q: search, from: dFrom, to: dTo });
      if (mine !== loadSeq.current) return;
      // The page under us can empty out — a bulk "Mark invoiced" of the last
      // page's approved tickets moves every row on it out of the filter, and
      // this index has no rows left. The count rides on the first row, so an
      // empty page also reports a total of zero: the tracker would say "No
      // tickets are approved" about the ones just invoiced, with no pager
      // left to get back. Start again at page 1 instead. The same guard the
      // board and the equipment list carry.
      if (p > 0 && !r.length) { setPage(0); fetchPage(0, f, search, dFrom, dTo); return; }
      setRows(r);
      setTotal(t);
      setFilteredTotal(ft == null ? null : ft);
      setPicked({});
      // The per-row notes belong to the rows that were on screen — a resend
      // refusal left over from page 2 would otherwise reappear against
      // whatever ticket takes that id's place in the next filter.
      setRowNotes({});
    } catch (e) {
      if (mine !== loadSeq.current) return;
      setError(e.message || "Couldn't reach the database. Check your connection and reload.");
    }
    if (mine === loadSeq.current) setLoading(false);
  };
  // Filter, search, dates and page in one effect: as several, opening the
  // tracker (and every filter tap made while already on page 1) fetched the
  // same page twice. A changed filter or search lands on page 1; typing
  // waits for a pause so each keystroke isn't a request.
  const lastQuery = useRef(null);
  useEffect(() => {
    const key = [filter, q, from, to].join("\u0000");
    if (lastQuery.current !== null && lastQuery.current !== key && page !== 0) {
      lastQuery.current = key;
      setPage(0);
      return;
    }
    lastQuery.current = key;
    const t = setTimeout(() => fetchPage(page, filter, q, from, to), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [filter, q, from, to, page, pageSize]);

  // Where each unsigned ticket's approval link would go, read once for the
  // screen rather than once per row — and it is the same read the bulk chase
  // makes, resolved the same way, so a row's "Resend link" and "Chase all
  // unsigned" can never disagree about a ticket's address. Asked for only
  // when a row on screen could use it, and only for a role allowed to send.
  const contactsAsked = useRef(false);
  const loadUnsignedContacts = async () => {
    contactsAsked.current = true;
    const list = await Db.listUnsignedTicketContacts();
    setContacts(Object.fromEntries(list.map(t => [t.id, emailIn(t.contactLabel)])));
    return list;
  };
  useEffect(() => {
    if (!priced || contactsAsked.current) return;
    if (!rows.some(r => r.status === "Awaiting approval")) return;
    // A lookup that failed is not the page's error: the rows keep their
    // button and find the address when it is pressed. Saying "no client
    // email on file" because a read timed out would be a lie about somebody
    // else's record.
    loadUnsignedContacts().catch(() => {});
  }, [priced, rows]);

  // Integer-cents sum, never a running float total — the house money rule
  // (see gstOn in data.js). Summing dollars directly drifts a half-cent low
  // at certain boundaries; summing cents and dividing once is exact.
  const sum = arr => arr.reduce((s, t) => s + Math.round(t.amount * 100), 0) / 100;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  // The aging row and the By client view stand or fall together: both are
  // this one RPC. They are drawn while it is still loading — with the same
  // "—" the stats row shows — and dropped only when the database says it has
  // no such routine, which is a schema without that migration and not a
  // failure the office can do anything about.
  const showAging = !agingOff;

  // "Chased" is a fact about the ticket now (tickets.chased_at), not a memory
  // this page loses on reload. The flag does not send anything — "Chase all
  // unsigned" does that — it records that the client was nudged, and when.
  const flagChased = async id => {
    setError("");
    try {
      await Db.markTicketChased(id);
      const stamp = new Date().toISOString();
      setRows(p => p.map(r => r.id === id ? { ...r, chasedAt: stamp } : r));
    } catch (e) {
      setError(e.message || "Couldn't flag that ticket.");
    }
  };
  const flaggedCount = rows.filter(r => r.chasedAt).length;

  // One ticket's link, again. The everyday office call — a rep phones to say
  // the email is gone — used to mean leaving the tracker, finding the job,
  // opening the ticket and sending from there. This sends exactly what the
  // bulk chase sends, to the address the bulk chase would use, for the one
  // ticket being asked about.
  const noteOn = (id, text, bad) => setRowNotes(p => ({ ...p, [id]: text ? { text, bad: !!bad } : null }));

  // True only when the lookup answered and this ticket has nobody to send to.
  // A lookup that hasn't answered — or failed — is not an answer, and the row
  // keeps its button rather than telling the office there is no rep on file.
  const hasNoAddress = id => !!contacts && Object.prototype.hasOwnProperty.call(contacts, id) && !contacts[id];

  // The address a ticket's link goes to: off the screen's map when the
  // lookup answered, otherwise off the ticket itself — the same
  // client_contact field the map is built from, so the two cannot differ.
  const addressFor = async id => {
    if (contacts && Object.prototype.hasOwnProperty.call(contacts, id)) return contacts[id];
    const t = await Db.getTicket(id);
    return emailIn(t && t.client_contact ? t.client_contact.name : "");
  };

  // Ask before it goes, with the address on the dialog: a link mailed to the
  // wrong rep is not something the office can call back.
  const askResend = async t => {
    noteOn(t.id, "");
    try {
      // Nothing is marked busy here: this looks the address up (usually off
      // the map, with no read at all) and opens the question. The button is
      // disabled by the send itself, which is the part that must not run
      // twice.
      const to = await addressFor(t.id);
      if (to) setResendAsk({ id: t.id, to });
      else noteOn(t.id, "No client email on file — add a rep to the job, then resend.", true);
    } catch (e) {
      noteOn(t.id, e.message || "Couldn't work out where this ticket's link would go.", true);
    }
  };

  const resendLink = async ({ id, to }) => {
    setResendAsk(null);
    setResendId(id);
    try {
      await Db.sendTicketApproval({ ticketId: id, to });
      // Recorded on the ticket the way the bulk chase records it: best
      // effort, and after the send, because a flag that didn't save is a
      // cosmetic loss and must never turn a delivered email into a failure.
      // Muted because db.js announces both writes and the office pressed one
      // button — "Approval sent" is the answer, "Flagged as chased" is
      // bookkeeping.
      Toasts.mute();
      try { await Db.markTicketChased(id).catch(() => {}); } finally { Toasts.unmute(); }
      const stamp = new Date().toISOString();
      // The query tag goes with it: send-ticket-approval clears queried_at on
      // every resend, so leaving it on the row would have the office chasing
      // a question the server has already closed.
      setRows(p => p.map(r => r.id === id ? { ...r, chasedAt: stamp, queriedAt: null, queryText: "", queryBy: "" } : r));
      noteOn(id, `Link resent to ${to}.`);
    } catch (e) {
      // The function's own words. "That ticket is already approved" is the
      // answer the office needs; rewording it would hide which refusal it was.
      noteOn(id, e.message || "Couldn't resend that link.", true);
    }
    setResendId("");
  };

  // The client's link dies and the ticket goes back to Draft, through the
  // same definer RPC Job detail uses; the database applies the own-or-office
  // rule, so a technician's tap on somebody else's ticket comes back as the
  // RPC's own refusal rather than being hidden here. "Cancel and edit"
  // then opens the ticket, which for a draft means its job page — the
  // editor only ever opens over its own job's record (see App.openTicket) —
  // where Edit is one tap away. The page is re-read afterwards because a
  // Draft row does not belong in most of this screen's views.
  const withdrawApproval = async ({ row, edit }) => {
    setWithdrawAsk(null);
    setWithdrawingId(row.id);
    noteOn(row.id, "");
    try {
      await Db.withdrawTicketApproval(row.id);
      setWithdrawingId("");
      if (edit) { onOpenTicket({ ...row, status: "Draft" }); return; }
      noteOn(row.id, `Approval cancelled — ${row.id} is a draft again.`);
      await fetchPage(page, filter);
      loadTiles();
    } catch (e) {
      setWithdrawingId("");
      noteOn(row.id, e.message || "Couldn't cancel that approval.", true);
    }
  };

  // Approved → Invoiced (and back, for a slip). Admin-only in the database;
  // the tracker is where the office decides a ticket has been billed, and
  // nothing wrote that status before — "approved, not invoiced" grew for
  // ever and Open tickets never emptied.
  const setInvoiced = async (ids, invoiced) => {
    if (!ids.length) return;
    if (invoiced && !confirm(`Mark ${ids.length === 1 ? `ticket ${ids[0]}` : `${ids.length} tickets`} as invoiced? ${ids.length === 1 ? "It" : "They"} leave Open tickets and the ready-to-bill total.`)) return;
    setMarking(true);
    setError("");
    try {
      const n = invoiced ? await Db.markTicketsInvoiced(ids) : await Db.unmarkTicketsInvoiced(ids);
      if (n < ids.length) setError(`${ids.length - n} of ${ids.length} didn't change — ${invoiced ? "only approved tickets can be marked invoiced" : "only invoiced tickets can go back"}; the rest may have moved meanwhile.`);
      await fetchPage(page, filter);
      loadTiles();
    } catch (e) {
      setError(e.message || "Couldn't update those tickets.");
    }
    setMarking(false);
  };
  const pickedIds = Object.keys(picked).filter(id => picked[id]);
  const approvedOnPage = rows.filter(r => r.status === "Approved");

  const exportCurrentFilter = async () => {
    setExporting(true);
    setError("");
    try {
      // Every ticket matching the filter, not just the page on screen. Asking
      // for one enormous page looked like it did that and didn't: PostgREST
      // caps a response at 1000 rows without complaining, so the CSV came out
      // short and looked whole.
      //
      // The *whole* filter, too — search and the work-date window as well as
      // the status. Only the status was sent, so an admin who had narrowed
      // the screen to one client's March and pressed Export got every ticket
      // ever raised, under a footer count that said otherwise.
      const all = await Db.listTicketsForExport({ status: filter, q, from, to });
      // The invoice number rides on the rows themselves. A database that has
      // no such column yet answers so, and the export goes out with that
      // column blank and a line in the file saying why, rather than failing
      // over a number the office was not asking for.
      const detail = await Db.listTicketExportDetail(all);
      exportTickets(all, filterCaption(filter, q, from, to), detail);
    } catch (e) {
      setError(e.message || "Couldn't build the export.");
    }
    setExporting(false);
  };

  // The same filter, one row per charge instead of one per ticket: what a
  // ticket's figure is actually made of, which is the question a reconciliation
  // asks second. It reads every matching ticket's lines, so it is much the
  // slower of the two buttons and says so while it runs.
  const exportCurrentLines = async () => {
    setExportingLines(true);
    setError("");
    try {
      const all = await Db.listTicketsForExport({ status: filter, q, from, to });
      const detail = await Db.listTicketExportDetail(all, { withLines: true });
      exportLines(all, filterCaption(filter, q, from, to), detail);
    } catch (e) {
      setError(e.message || "Couldn't build the line export.");
    }
    setExportingLines(false);
  };

  // Resends the approval-link email for every ticket still awaiting
  // signature, in one pass, rather than opening each one individually. A
  // ticket with no client email on file is skipped and counted separately
  // — it can't be chased until a rep is added, but the rest shouldn't wait.
  //
  // Thousands of tickets can be awaiting signature at once, so this is a paced
  // pool rather than a loop (sendPool.js): sending them one after another with
  // nothing on screen was a job of unknown length that couldn't be called off,
  // and a transport asked to take four thousand emails as fast as the browser
  // can ask starts refusing them — refusals the old loop counted as failures
  // and then couldn't name.
  //
  // A ref, not state, for the stop: the pool asks on every start, and a
  // re-render is not what makes the answer true.
  const stopChase = useRef(false);
  const [stopping, setStopping] = useState(false);
  // Reads the unsigned tickets and works out the buckets — nothing is sent
  // here. One tap emails every client with an unsigned ticket and the only
  // undo is a phone call, so the office sees who is about to be written to,
  // and who is being left alone and why, before it decides. The native
  // confirm this replaced named a count and no addresses at all.
  const askChase = async () => {
    setChasePreparing(true);
    setChaseResult("");
    setError("");
    try {
      const list = await loadUnsignedContacts();
      setChaseAsk(planChase(list, { emailIn }));
    } catch (e) {
      setError(e.message || "Couldn't read the unsigned tickets.");
    }
    setChasePreparing(false);
  };

  const runChase = async plan => {
    const { due, queried, recent, noEmail } = plan;
    setChaseAsk(null);
    setChasing(true);
    setStopping(false);
    stopChase.current = false;
    setChaseResult("");
    setError("");
    try {
      setChaseResult(`Sending… 0 of ${due.length}`);
      // Muted around the pool: sendTicketApproval fires an "Approval sent"
      // toast per call, so chasing N tickets would stack N toasts over the
      // one summary line this button is meant to show. Same pattern as
      // OfflineQueue.flush and saveArcadeScore.
      Toasts.mute();
      let out;
      try {
        out = await runSendPool(due, async t => {
          await Db.sendTicketApproval({ ticketId: t.id, to: t.to });
          // Recorded on the ticket, so the flag survives a reload and the
          // next person to open the tracker sees who was already nudged.
          // Best-effort, and after the send: a flag that didn't save is a
          // cosmetic loss, and must never turn a delivered email into a
          // failure the pool then tries to deliver again.
          await Db.markTicketChased(t.id).catch(() => {});
        }, {
          concurrency: CHASE_WORKERS,
          minInterval: CHASE_INTERVAL_MS,
          shouldStop: () => stopChase.current,
          onProgress: (done, total) => setChaseResult(`Sending… ${done} of ${total}`)
        });
      } finally { Toasts.unmute(); }
      const parts = [`Sent to ${out.sent.length} of ${due.length}`];
      // Only when something really was left behind: the pool sets stopped
      // when a worker meets Stop after the last item has already gone out,
      // and "stopped — 0 not attempted" reads as a run cut short.
      if (out.stopped && out.remaining) parts.push(`stopped — ${out.remaining} not attempted`);
      if (queried.length) parts.push(`${queried.length} left alone — the client has a question open`);
      if (recent.length) parts.push(`${recent.length} left alone — sent or chased in the last 3 days`);
      if (noEmail.length) parts.push(`${noEmail.length} skipped — no client email on file`);
      // Named, not just counted. "37 failed to send" is a number the office
      // can do nothing with; the ticket numbers are the ones somebody now has
      // to chase by phone.
      if (out.failed.length) {
        const ids = out.failed.map(f => f.item.id);
        const shown = ids.slice(0, CHASE_LIST_LIMIT).join(", ");
        const rest = ids.length - CHASE_LIST_LIMIT;
        parts.push(`${ids.length} failed to send: ${shown}${rest > 0 ? ` and ${rest} more` : ""}`);
      }
      setChaseResult(parts.join(" · "));
      // The chase moved tickets Draft/Awaiting → Awaiting approval, so both
      // the table page and the tiles (and this button's own disabled
      // predicate, which reads stats.unsigned.count) are now stale.
      fetchPage(page, filter);
      loadTiles();
    } catch (e) {
      setError(e.message || "Couldn't chase unsigned tickets.");
    }
    setChasing(false);
    setStopping(false);
    stopChase.current = false;
  };

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
        <div>
          <div className="kicker">Admin · All jobs</div>
          <h2 style={{ fontSize: 34, margin: "2px 0 0" }}>Billing tracker</h2>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {/* The CSV's whole reason for existing is the Amount column, and
              the database hands a role that can't see prices null totals —
              so this built accounting a spreadsheet reading $0.00 against
              every ticket, which is worse than no spreadsheet at all. Same
              gate as the column and the tiles. */}
          {priced && (
            <Btn variant="secondary" onClick={exportCurrentFilter} disabled={exporting || exportingLines || !total}
              title="One row per ticket, with the subtotal, the GST and the grand total.">
              {exporting ? "Building…" : "Export to accounting"}
            </Btn>
          )}
          {/* The detail behind the same filter. Same gate and the same reason:
              a line export from a role the database hands null money to would
              be a spreadsheet of rates nobody can see. It is the slower
              button — every matching ticket's charges, not just its total — so
              only one export runs at a time. */}
          {priced && (
            <Btn variant="secondary" onClick={exportCurrentLines} disabled={exporting || exportingLines || !total}
              title="One row per charge on every ticket the filter matches. No GST — that is on the ticket export.">
              {exportingLines ? "Building…" : "Export lines"}
            </Btn>
          )}
          {/* Behind the same price gate as every other money control here.
              The email this sends is a ticket summary with the amount on it,
              and the database hands a role that can't see prices null totals
              — so a Coordinator pressing this would have mailed every client
              a $0.00 approval request, one tap, no undo. */}
          {priced && (
            <Btn variant="primary" onClick={askChase} disabled={chasing || chasePreparing || !(stats && stats.unsigned.count)}
              title="Resends the approval-link email to every ticket still awaiting signature.">
              {chasing ? "Sending…" : chasePreparing ? "Checking…" : "Chase all unsigned"}
            </Btn>
          )}
          {/* A run of four thousand emails has to be callable off — the office
              notices the wrong thing is going out on the second one, not the
              last. It starts no more sends; the two or three already in flight
              land, because half-sent is not a state the tracker can record. */}
          {priced && chasing && (
            <Btn variant="secondary" disabled={stopping}
              onClick={() => { stopChase.current = true; setStopping(true); }}
              title="Stops after the sends already in flight — the rest are left for another day.">
              {stopping ? "Stopping…" : "Stop"}
            </Btn>
          )}
        </div>
      </div>

      <ErrorBox>{error}</ErrorBox>
      {chaseResult && !error && (
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)", marginBottom: 14 }}>{chaseResult}</div>
      )}

      {/* Every tile the same way round: the money is the big figure and the
          count is the note. They used to disagree — dollars on Unsigned, a
          count on the others — so "$18,240 · 6 · 11 · 43" read left to right
          as four amounts. Money is the one the tracker exists to answer: how
          much is stuck at each stage, which is the question behind chasing a
          signature and behind billing. A role that cannot see prices gets the
          count in the big figure instead, because null totals are all the
          database gives it.

          The first row is where the money is stuck; the second is how long it
          has been stuck, which is the other half of the Monday-morning
          question and used to be one tile saying "over 7 days". Until
          ticket_aging answers, the aging row is drawn with the same "—"
          placeholders the stats row uses — the layout does not jump when it
          lands. A database that has never had that migration drops the row
          altogether and gets the tracker's old "Over 7 days" tile back. */}
      <div style={{ display: "grid", gridTemplateColumns: showAging ? "repeat(3, 1fr)" : "repeat(4, 1fr)", gap: 16, marginBottom: showAging ? 16 : 20 }} className="grid-2col">
        <Blueprint className="stat-tile">
          <div className="stat-label">Unsigned</div>
          <div className="stat-figure" style={{ color: "var(--color-accent-700)" }}>{stats ? (priced ? money(stats.unsigned.total) : stats.unsigned.count) : "—"}</div>
          <div className="stat-note">{priced ? `${stats ? stats.unsigned.count : "…"} tickets awaiting signature` : "tickets awaiting signature"}</div>
        </Blueprint>
        {!showAging && (
          <Blueprint className="stat-tile">
            <div className="stat-label">Over 7 days</div>
            <div className="stat-figure">{stats ? (priced ? money(stats.over7.total) : stats.over7.count) : "—"}</div>
            <div className="stat-note">{priced ? `${stats ? stats.over7.count : "…"} tickets unsigned for over a week` : "unsigned for over a week"}</div>
          </Blueprint>
        )}
        <Blueprint className="stat-tile">
          <div className="stat-label">Approved, not invoiced</div>
          <div className="stat-figure">{stats ? (priced ? money(stats.approved.total) : stats.approved.count) : "—"}</div>
          <div className="stat-note">{priced ? `${stats ? stats.approved.count : "…"} tickets ready to bill` : "signed, not yet invoiced"}</div>
        </Blueprint>
        <Blueprint className="stat-tile">
          <div className="stat-label">Invoiced</div>
          <div className="stat-figure">{stats ? (priced ? money(stats.invoiced.total) : stats.invoiced.count) : "—"}</div>
          <div className="stat-note">{priced ? `${stats ? stats.invoiced.count : "…"} tickets out the door` : "invoiced"}</div>
        </Blueprint>
      </div>

      {showAging && (<>
        {/* Said in words, because "outstanding" is a word every office uses
            slightly differently and this one has a definition: sent to the
            client and not yet through. There is no Paid status in the app —
            Invoiced is as far as a ticket goes — so an invoice the client
            has settled is still counted here until somebody archives it. */}
        <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginBottom: 8 }}>
          Outstanding by age of the work date — awaiting approval, approved or invoiced, and not yet archived.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 20 }} className="grid-2col">
          {AGING_BUCKETS.map(b => {
            const cell = aging ? aging.buckets[b.key] : null;
            return (
              <Blueprint key={b.key} className="stat-tile">
                <div className="stat-label">{b.label}</div>
                {/* The 90+ tile goes red: it is the one an office acts on, a
                    row of four identical tiles hides it, and red is the whole
                    point of the aging table — money that has sat too long. */}
                <div className="stat-figure" style={b.key === "90" ? { color: "var(--color-bad)" } : undefined}>
                  {cell ? (priced ? money(cell.total || 0) : cell.count) : "—"}
                </div>
                <div className="stat-note">{priced ? `${cell ? cell.count : "…"} tickets ${b.note}` : `tickets ${b.note}`}</div>
              </Blueprint>
            );
          })}
        </div>
      </>)}

      {/* The status pills, the search and the dates all narrow the ticket
          table. The by-client rollup is not narrowed by any of them — it is
          every outstanding ticket, grouped — so while it is showing, the
          controls that would appear to be filtering it are not on screen at
          all. Leaving them there would have the office reading a whole-book
          figure under a filter that says "Approved, March". */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        {!byClient && TRACKER_FILTERS.map(f => (
          <button key={f} className={`pill${PILL_TONE[f] ? ` pill-${PILL_TONE[f]}` : ""}${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>{f}</button>
        ))}
        {showAging && (<>
          {!byClient && <span aria-hidden="true" style={{ width: 1, height: 20, background: "var(--color-neutral-300)", margin: "0 4px" }} />}
          <button className={`pill${byClient ? " active" : ""}`} aria-pressed={byClient}
            onClick={() => setByClient(v => !v)}
            title="One row per client: what each of them owes and how long it has been outstanding.">
            By client
          </button>
        </>)}
        {!byClient && <RowsPerPage style={{ marginLeft: "auto" }} value={pageSize} onChange={n => { setPageSize(n); setPage(0); }} />}
      </div>
      {!byClient && (
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <input className="input" type="search" value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search ticket, job, project, client or technician…" aria-label="Search tickets"
          style={{ flex: "1 1 260px", minHeight: 36 }} />
        <label style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", display: "flex", alignItems: "center", gap: 6 }}>
          Worked from
          <input className="input" type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} aria-label="Work date from" style={{ minHeight: 36, width: 150 }} />
        </label>
        <label style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", display: "flex", alignItems: "center", gap: 6 }}>
          to
          <input className="input" type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} aria-label="Work date to" style={{ minHeight: 36, width: 150 }} />
        </label>
        {(q || from || to) && (
          <Btn variant="ghost" style={{ minHeight: 36 }} onClick={() => { setQ(""); setFrom(""); setTo(""); }}>Clear</Btn>
        )}
        {picking && (
          <Btn variant="primary" style={{ minHeight: 36, marginLeft: "auto" }} disabled={marking || !pickedIds.length}
            onClick={() => setInvoiced(pickedIds, true)}
            title="Moves the ticked tickets from Approved to Invoiced.">
            {marking ? "Marking…" : pickedIds.length ? `Mark ${pickedIds.length} invoiced` : "Mark invoiced"}
          </Btn>
        )}
      </div>
      )}

      {byClient ? (
        <ClientRollup aging={aging} priced={priced}
          onPick={name => { setQ(name); setByClient(false); setFilter("All"); }} />
      ) : (
      <Blueprint style={{ padding: "6px 18px 14px" }}>
        {loading && <div style={{ padding: "12px 4px", fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Loading tickets…</div>}
        <TableScroll><table className="table table-wide">
          <thead>
            <tr>
              {picking && (
                <th style={{ width: 34 }}>
                  <input type="checkbox" aria-label="Select every approved ticket on this page"
                    checked={approvedOnPage.length > 0 && approvedOnPage.every(r => picked[r.id])}
                    onChange={e => setPicked(e.target.checked ? Object.fromEntries(approvedOnPage.map(r => [r.id, true])) : {})} />
                </th>
              )}
              <th>Ticket</th><th>Date</th><th>Age</th><th>Job</th><th>Project + client</th><th>Technician</th>{priced && <th>Amount</th>}<th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {!loading && !rows.length && (
              <tr><td colSpan={picking ? 10 : 9} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                {(q || from || to) ? "No tickets match that search." : filter === "All" ? "No tickets raised yet." : `No tickets are ${filter.toLowerCase()}.`}
              </td></tr>
            )}
            {!loading && rows.map(t => {
              const overdue = t.age > 7 && t.status === "Awaiting approval";
              const flagged = !!t.chasedAt;
              return (
                <tr key={t.id}>
                  {picking && (
                    <td>
                      {t.status === "Approved" && (
                        <input type="checkbox" aria-label={`Select ticket ${t.id}`} checked={!!picked[t.id]}
                          onChange={e => setPicked(p => ({ ...p, [t.id]: e.target.checked }))} />
                      )}
                    </td>
                  )}
                  {/* The ticket number is the way in, and it was reachable by
                      mouse alone. Same shape as the ticket rows on Job
                      detail: a button in a cell, Enter or Space to open. */}
                  <td className="clickable" style={{ fontFamily: "var(--font-heading)", fontWeight: 600 }}
                    title={t.status === "Draft" ? "Open this draft to finish it" : "Open the job this ticket is on"}
                    tabIndex={0}
                    role="button"
                    aria-label={t.status === "Draft" ? `Open draft ticket ${t.id}` : `Open the job for ticket ${t.id}`}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenTicket(t); } }}
                    onClick={() => onOpenTicket(t)}>{t.id}</td>
                  <td>{t.date}</td>
                  {/* Overdue reads red — the tag already carries a left stripe
                      and a word, so it answers anyone who can't tell the hue
                      apart or is reading it in daylight through a windscreen. */}
                  <td className="tabular" style={{ color: overdue ? "var(--color-bad)" : "inherit", whiteSpace: "nowrap" }}>
                    {t.age === 0 ? "today" : t.age + " d"}
                    {overdue && <TagX variant="bad" style={{ marginLeft: 6 }}>overdue</TagX>}
                  </td>
                  <td>{t.job}</td>
                  <td>{t.project}<div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{t.client}</div></td>
                  <td>{t.tech}</td>
                  {priced && <td className="tabular">{money(t.amount)}</td>}
                  <td>
                    <StatusTag status={t.status} />
                    {/* The rep pressed "Query this ticket" instead of
                        signing: what they said, in the office's face until
                        the ticket is fixed and resent (a resend clears it). */}
                    {t.queriedAt && t.status !== "Approved" && t.status !== "Invoiced" && (
                      <div style={{ marginTop: 4 }}>
                        <TagX variant="accent" title={`Queried ${new Date(t.queriedAt).toLocaleString("en-CA")}`}>Queried{t.queryBy ? ` by ${t.queryBy}` : ""}</TagX>
                        {t.queryText && <div style={{ fontSize: 11, marginTop: 3, maxWidth: 320, whiteSpace: "pre-wrap" }}>{t.queryText}</div>}
                      </div>
                    )}
                    {t.status === "Invoiced" && t.invoicedAt && (
                      <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                        {/* The number the bill went out under — what a client's
                            accounts department quotes back on the phone. */}
                        {t.invoiceNumber != null && <span className="tabular">Invoice #{t.invoiceNumber} · </span>}
                        {shortDate(t.invoicedAt)}
                      </div>
                    )}
                  </td>
                  <td>
                    {t.status === "Awaiting approval" && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        {flagged
                          ? <TagX variant="outline" title={`Chased ${new Date(t.chasedAt).toLocaleString("en-CA")}`}>Chased {shortDate(t.chasedAt)}</TagX>
                          : <Btn variant="secondary" onClick={() => flagChased(t.id)}
                              title="Records that the client has been nudged about this ticket — it doesn't send anything.">
                              Flag as chased
                            </Btn>}
                        {/* The rep phoned and the email is gone: send this one
                            ticket's link again without leaving the tracker.
                            Behind the same price gate as the bulk chase and
                            for the same reason — the email carries the
                            ticket's total, and the database hands a role that
                            can't see prices a null one, so a Coordinator
                            pressing this would mail the client a $0.00
                            approval request. A ticket the lookup says has
                            nobody to send to says so instead of offering a
                            button that opens onto nowhere. */}
                        {priced && (hasNoAddress(t.id)
                          ? <span style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                              No client email on file
                            </span>
                          : <Btn variant="secondary" disabled={resendId === t.id} onClick={() => askResend(t)}
                              title="Emails the client rep a fresh approval link. It replaces the link they already have.">
                              {resendId === t.id ? "Sending…" : "Resend link"}
                            </Btn>)}
                        {/* The figure is wrong and the client has not signed
                            yet: take the link back, and optionally go and
                            fix it. Not behind the price gate — cancelling
                            sends nothing; the database decides whose
                            ticket it is. */}
                        <Btn variant="secondary" disabled={withdrawingId === t.id}
                          title="Kills the client's signing link and puts the ticket back to Draft."
                          onClick={() => setWithdrawAsk({ row: t, edit: false })}>
                          {withdrawingId === t.id ? "Cancelling…" : "Cancel approval"}
                        </Btn>
                        {/* An Admin's alone. App.openTicket sends a Draft
                            straight to the editor, and loadDraft refuses a
                            ticket that is not the signed-in account's unless
                            it is an Admin's — this row carries no
                            technician_id to test against, and a Coordinator
                            pressing it killed the signing link and then met
                            "another technician's ticket". Everyone else
                            keeps the plain Cancel approval beside it. */}
                        {currentUser.role === "Admin" && (
                          <Btn variant="secondary" disabled={withdrawingId === t.id}
                            title="Cancels the approval request and opens the ticket to be edited."
                            onClick={() => setWithdrawAsk({ row: t, edit: true })}>
                            Cancel and edit
                          </Btn>
                        )}
                      </div>
                    )}
                    {rowNotes[t.id] && (
                      <div style={{ fontSize: 11, marginTop: 4, maxWidth: 320,
                        color: rowNotes[t.id].bad ? "var(--color-accent-700)" : "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
                        {rowNotes[t.id].text}
                      </div>
                    )}
                    {t.status === "Draft" && <Btn variant="secondary" onClick={() => onOpenTicket(t)}>Finish</Btn>}
                    {/* Admin-only, like the bulk button above. */}
                    {t.status === "Approved" && currentUser.role === "Admin" && (
                      <Btn variant="secondary" disabled={marking} onClick={() => setInvoiced([t.id], true)}
                        title="Moves this ticket from Approved to Invoiced.">Mark invoiced</Btn>
                    )}
                    {t.status === "Invoiced" && currentUser.role === "Admin" && (
                      <Btn variant="ghost" disabled={marking} onClick={() => setInvoiced([t.id], false)}
                        title="Back to Approved — for a ticket marked invoiced by mistake.">Back to approved</Btn>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></TableScroll>
        {!loading && pageCount > 1 && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 4px 4px" }}>
            <Btn variant="secondary" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>← Previous</Btn>
            <span style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>Page {page + 1} of {pageCount}</span>
            <Btn variant="secondary" onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1}>Next →</Btn>
          </div>
        )}
        <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginTop: 10 }}>
          {total} ticket{total === 1 ? "" : "s"}{(q || from || to) ? " matching" : ""}{priced ? (filteredTotal != null && total > rows.length
            ? ` · ${money(filteredTotal)} across all ${total} · ${money(sum(rows))} on this page`
            : ` · ${money(filteredTotal != null ? filteredTotal : sum(rows))} in total`) : ""}
          {flaggedCount > 0 && ` · ${flaggedCount} chased`}
        </div>
      </Blueprint>
      )}

      {/* Both dialogs last, after the page they are asking about. Each names
          the address the email is going to, because a link sent to the wrong
          rep is not something the office can call back. */}
      {resendAsk && (
        <Dialog title={`Resend ticket ${resendAsk.id}?`} maxWidth={460} onClose={() => setResendAsk(null)}
          actions={<>
            <Btn variant="secondary" onClick={() => setResendAsk(null)}>Cancel</Btn>
            <Btn variant="primary" onClick={() => resendLink(resendAsk)}>Resend link</Btn>
          </>}>
          <div style={{ fontSize: 14 }}>
            Resend the approval link for {resendAsk.id} to <strong>{resendAsk.to}</strong>? This replaces the
            link they already have.
          </div>
        </Dialog>
      )}
      {withdrawAsk && (
        <Dialog title={`Cancel the approval request for ${withdrawAsk.row.id}?`} maxWidth={460} onClose={() => setWithdrawAsk(null)}
          actions={<>
            <Btn variant="secondary" onClick={() => setWithdrawAsk(null)}>Keep it</Btn>
            <Btn variant="primary" onClick={() => withdrawApproval(withdrawAsk)}>
              {withdrawAsk.edit ? "Cancel and edit" : "Cancel approval"}
            </Btn>
          </>}>
          <div style={{ fontSize: 14 }}>
            The client's signing link stops working and the ticket goes back to Draft.
            {withdrawAsk.edit ? " Its job opens next, with the ticket ready to edit and resend." : " It can be fixed and resent from its job."}
          </div>
        </Dialog>
      )}
      {chaseAsk && (
        <ChaseDialog plan={chaseAsk} onClose={() => setChaseAsk(null)} onSend={() => runChase(chaseAsk)} />
      )}
    </div>
  );
}

// Who owes what, and how long it has been — the Monday-morning question, in
// one screen instead of a paged table read client by client.
//
// The grouping is the database's (ticket_aging), because "every outstanding
// ticket" is thousands of rows and PostgREST caps a response at 1,000 without
// saying so. This draws the rollup ticketAging.js shapes: one row per client,
// biggest first, with the four buckets beside the total.
//
// Clicking a client goes back to the ticket table with the search set to
// their name. That is deliberately the search box and not a new filter: the
// search already matches the client name server-side, so the tickets come
// back paged and priced the way every other view of them does, and the office
// can widen or narrow from there. It matches on the name, so a job whose
// project or technician happens to carry the same word comes with it — the
// search box says what it did, which is the point of using it.
function ClientRollup({ aging, priced, onPick }) {
  if (!aging) {
    return (
      <Blueprint style={{ padding: "14px 18px" }}>
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
          Working out what each client owes…
        </div>
      </Blueprint>
    );
  }
  const { clients, count, total } = aging;
  // A role without prices gets the count in every money cell, exactly as it
  // gets the count in the tiles: null totals are all the database gives it,
  // and a column of "$0.00" against real work would be a lie.
  const cell = c => priced ? money(c.total || 0) : c.count;
  return (
    <Blueprint style={{ padding: "6px 18px 14px" }}>
      <TableScroll><table className="table table-wide">
        <thead>
          <tr>
            <th>Client</th>
            <th>Tickets</th>
            {priced && <th>Outstanding</th>}
            {AGING_BUCKETS.map(b => <th key={b.key}>{b.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {!clients.length && (
            <tr><td colSpan={priced ? 7 : 6} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
              Nothing is outstanding — every ticket is still a draft or has been archived.
            </td></tr>
          )}
          {clients.map(c => (
            <tr key={c.clientId || "none"}>
              {/* The tickets behind the row, the same way the ticket number
                  opens a ticket: a button in a cell, Enter or Space to
                  follow. A group of jobs with no client on them has no name
                  to search for, so that row is plain text. */}
              {c.clientId
                ? <td className="clickable" tabIndex={0} role="button"
                    aria-label={`Show the tickets for ${c.name}`}
                    title="Show this client's tickets"
                    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(c.name); } }}
                    onClick={() => onPick(c.name)}>{c.name}</td>
                : <td style={{ color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>{c.name}</td>}
              <td className="tabular">{c.count}</td>
              {priced && <td className="tabular" style={{ fontWeight: 600 }}>{money(c.total || 0)}</td>}
              {AGING_BUCKETS.map(b => (
                <td key={b.key} className="tabular"
                  style={b.key === "90" && c.buckets[b.key].count ? { color: "var(--color-accent-700)" } : undefined}>
                  {c.buckets[b.key].count ? cell(c.buckets[b.key]) : "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table></TableScroll>
      <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginTop: 10 }}>
        {clients.length} client{clients.length === 1 ? "" : "s"} · {count} outstanding ticket{count === 1 ? "" : "s"}
        {priced ? ` · ${money(total || 0)} in total` : ""}
      </div>
    </Blueprint>
  );
}

// What "Chase all unsigned" is about to do, said before it does it: which
// tickets get an email and at which address, and which are being left alone
// and why. The buckets are the chase's own (chasePlan.js), worked out from the
// same list the pool will send from — this is the plan, not an estimate of it.
//
// It replaced a native confirm() that named a count and nothing else. That box
// is unthemeable, and on iOS Safari it can be suppressed outright after a
// couple in a row — an unaskable question in front of the largest outward act
// in the app.
function ChaseDialog({ plan, onClose, onSend }) {
  const { due, queried, recent, noEmail } = plan;
  const shown = due.slice(0, CHASE_DIALOG_LIMIT);
  const rest = due.length - shown.length;
  const Skip = ({ n, why }) => n ? <li style={{ marginBottom: 2 }}>{n} {n === 1 ? "ticket" : "tickets"} {why}</li> : null;
  const skipped = queried.length + recent.length + noEmail.length;
  return (
    <Dialog title="Chase unsigned tickets" maxWidth={560} onClose={onClose}
      actions={<>
        <Btn variant="secondary" onClick={onClose}>{due.length ? "Cancel" : "Close"}</Btn>
        {due.length > 0 && (
          <Btn variant="primary" onClick={onSend}>Send {due.length} email{due.length === 1 ? "" : "s"}</Btn>
        )}
      </>}>
      <div style={{ fontSize: 14 }}>
        {due.length
          ? "Each of these client reps gets a fresh approval link. It replaces the link they already have, so the old one stops working."
          : "Nothing is due to be chased right now — every unsigned ticket is in one of the lists below."}
      </div>

      {due.length > 0 && (<>
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
          {due.length} due to be chased{rest > 0 ? `, ${shown.length} of them listed` : ""}:
        </div>
        <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--color-neutral-300)", padding: "6px 10px", fontSize: 13 }}>
          {shown.map(d => (
            <div key={d.id} style={{ display: "flex", gap: 10, justifyContent: "space-between", padding: "2px 0" }}>
              <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600 }}>{d.id}</span>
              <span style={{ color: "color-mix(in srgb, var(--color-text) 70%, transparent)", overflowWrap: "anywhere" }}>{d.to}</span>
            </div>
          ))}
          {rest > 0 && (
            <div style={{ padding: "4px 0 0", color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
              and {rest} more
            </div>
          )}
        </div>
      </>)}

      {skipped > 0 && (
        <div style={{ fontSize: 13 }}>
          <div style={{ color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
            Left alone, and not emailed:
          </div>
          <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
            <Skip n={queried.length} why="with a question open — a resend would rub the question out" />
            <Skip n={recent.length} why="sent or chased in the last 3 days" />
            <Skip n={noEmail.length} why="with no client email on file" />
          </ul>
        </div>
      )}
    </Dialog>
  );
}
