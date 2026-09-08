import React, { useState, useEffect, useMemo, useRef } from "react";
import { money, todayLocal, localDate, dayMonth, initialsOf, crewRoleFor, hours, lineTotal, gstOn, gstLabel, gstRateOf, seesPrices, saneQuantityCeiling, SANE_CREW_HOURS, contactsForOrg } from "../data.js";
import { Db } from "../db.js";
import { Blueprint, Btn, TagX, Field, ErrorBox, emailIn, NoJobSelected, QueuedPanel, NumField, Loading, useScreenFoot, SearchSelect } from "./common.jsx";
import { OfflineQueue } from "../offlineQueue.js";
import { OfflineCache } from "../offlineCache.js";
import { savingLabel, deviceOffline } from "../savingWords.js";
import { overwroteKey, overwroteWords } from "../overwriteNote.js";

// Stored ticket lines back into the two on-screen lists, matched by label
// against the client's catalog — what's offered, in what order, at what
// price all come from the rate card now, so a line whose label is no longer
// on the card can't be driven by a dropdown that no longer has it.
//
// It is still a charge on the ticket, though. Anything unmatched comes back
// as `orphans` — verbatim, rate and all — because the card being edited
// underneath a saved draft (a line retired, or the client flipped onto the
// house card) used to mean the next Save silently deleted that money:
// buildLines rebuilt from the dropdowns alone and updateTicket replaces a
// ticket's lines wholesale. The screen shows them, counts them, and writes
// them back; taking one off is a decision someone makes on purpose.
//
// `keepQuantities` is the difference between reopening a draft (which must
// come back exactly as it was left) and copying yesterday's ticket forward
// (which must not).
function linesToForm(lines, keepQuantities, catalog) {
  const weldKeyByLabel = Object.fromEntries(catalog.welds.map(w => [w.label, w.key]));
  const serviceKeyByLabel = Object.fromEntries(catalog.others.map(s => [s.label, s.key]));
  // Tickets billed before the 20260818025620 rename stored the old names.
  // They still reopen and copy forward as the lines they are.
  if (serviceKeyByLabel["Straight time"]) serviceKeyByLabel["Technician — straight"] = serviceKeyByLabel["Straight time"];
  if (serviceKeyByLabel["Overtime"]) serviceKeyByLabel["Technician — overtime"] = serviceKeyByLabel["Overtime"];
  const welds = [], others = [], orphans = [];
  (lines || []).forEach(l => {
    const qty = keepQuantities ? Number(l.quantity) : 0;
    const key = l.kind === "weld" ? weldKeyByLabel[l.label] : serviceKeyByLabel[l.label];
    if (key) (l.kind === "weld" ? welds : others).push({ key, qty });
    // Copying a ticket forward is the one caller that must not carry these:
    // a new ticket takes its shape from the card as it stands today.
    else if (keepQuantities) orphans.push({
      kind: l.kind, label: l.label, unit: l.unit,
      quantity: Number(l.quantity) || 0, unit_rate: Number(l.unit_rate) || 0
    });
  });
  return { welds, others, orphans };
}

// Catalog keys are kind:label, and the catalog dresses that label up for the
// dropdown — " · RT film" for the three RT modes, " — per weld" for a method
// — which is the label the ticket line then stores. Both halves are built in
// getPublishedRatesForClient; read the other way round, this is how a line
// carrying nothing but a key the card has since dropped is matched back to
// the row it was saved as.
const KEY_LABEL_SUFFIX = {
  rt_film: " · RT film", rt_cr: " · RT CR", rt_dr: " · RT DR",
  method: " — per weld", custom_method: " — per weld"
};
const storedLabelForKey = key => {
  const at = String(key).indexOf(":");
  return at < 0 ? String(key) : key.slice(at + 1) + (KEY_LABEL_SUFFIX[key.slice(0, at)] || "");
};

// The recovery copy holds a line the way the card knew it — a key and a
// quantity — and the card goes on being edited underneath it. A line that
// leaves the card between the copy being written and the draft being
// reopened leaves the copy naming a key nothing answers to: the render drops
// it, buildLines never writes it, and the next Save deletes a charge that is
// sitting on the stored ticket. The loader had already put that same row in
// `orphans`, verbatim; restoring the copy over the top threw the orphan away
// as well, so the money went with it in silence.
//
// So the two sources each answer the half they know. The stored rows are the
// authority for what exists and what it is priced at; the copy is the
// authority for what was taken off — an off-card charge someone removed on
// purpose must stay removed, which is why an orphan the copy already carries
// is left exactly as the copy left it and never rebuilt from the row. The
// quantity is the copy's: the line was still live when that figure was
// typed, and the day's figures are the whole reason there is a copy at all.
function reconcileRecoveredLines({ weldLines, otherLines, orphanLines }, draftRows, catalog) {
  if (!catalog || !draftRows || !draftRows.length) return { weldLines, otherLines, orphanLines };
  const liveWeld = new Set(catalog.welds.map(w => w.key));
  const liveService = new Set(catalog.others.map(s => s.key));
  // Labels already spoken for, so one stored row can never become two
  // charges on the same ticket.
  const spokenFor = new Set(orphanLines.map(o => o.label));
  const rescued = [];
  const keep = (lines, live) => lines.filter(l => {
    if (live.has(l.key)) return true;
    const row = draftRows.find(r => r.label === storedLabelForKey(l.key));
    // Nothing stored under that key — a new ticket's copy, or a line that
    // left the ticket as well as the card. There is no price to put on it,
    // so it stays where it is and the render goes on ignoring it.
    if (!row) return true;
    if (!spokenFor.has(row.label)) {
      spokenFor.add(row.label);
      rescued.push({
        kind: row.kind, label: row.label, unit: row.unit,
        quantity: Number(l.qty) || 0, unit_rate: Number(row.unit_rate) || 0
      });
    }
    return false;
  });
  const welds = keep(weldLines, liveWeld);
  const others = keep(otherLines, liveService);
  return {
    weldLines: welds, otherLines: others,
    orphanLines: rescued.length ? [...orphanLines, ...rescued] : orphanLines
  };
}

// Everything a crew row carries that is a measurement of today.
const CREW_FIGURES = ["straight", "ot", "solo", "soloOt", "dose", "mileage"];
// A typed standby explanation counts too: a ticket that is nothing but a
// delays note so far was being dropped from the recovery copy as untouched.
// Off-card charges count as entries too: a reopened draft whose only lines
// are ones the card no longer offers is a real ticket with real money on it,
// and reading it as untouched deleted the recovery copy that was keeping
// track of one being removed.
const hasEntries = (weldLines, otherLines, crew, delays = "", orphanLines = []) =>
  weldLines.some(l => l.qty > 0) ||
  otherLines.some(l => l.qty > 0) ||
  crew.some(c => CREW_FIGURES.some(k => c[k] > 0)) ||
  orphanLines.some(l => l.quantity > 0) ||
  (typeof delays === "string" && delays.trim().length > 0);

// `seed` is what Job detail's Create ticket dialog chose for a NEW ticket —
// the work date and this ticket's own reps. Absent for a reopened draft and
// for a ticket started from Home.
export function TicketMobileScreen({ job, jobRecord, currentUser, onSaved, ticket, seed = null, onOpenJob = null }) {
  // A ticket is a bill, and the rate card behind it is refused to anyone who
  // isn't an Admin or a Technician — but refused row by row, so the catalog
  // comes back as a real object with nothing in it. That is not a screen to
  // open: the dropdowns would be empty and the day would file as a numbered
  // $0 draft with the crew's hours on it. So the answer is settled here,
  // before the first rates read, and the fetch never happens — which also
  // keeps the emptied catalog from being written into this device's offline
  // cache, where it would then price the next technician's ticket at zero.
  const mayPrice = seesPrices(currentUser);
  const [rates, setRates] = useState(null);
  const [loadError, setLoadError] = useState(mayPrice ? ""
    : "Ticket prices are an Admin's or a Technician's — ask one of them to raise this ticket.");
  // Both belong to the in-progress-ticket recovery further down, but they are
  // read by the crew-seeding effect above it, so they are declared here.
  //
  // wipReady stops the writer running before the reader has had its turn,
  // which would persist an empty form over the very thing being recovered.
  const wipReady = useRef(false);
  // wipRestored stops the crew-seeding effect from resetting a recovered crew
  // when the recovered work date re-runs it.
  const wipRestored = useRef(false);
  // skipWipWrite swallows exactly one run of the writer, for the reload that
  // "Start empty" does on a reopened draft — see discardRecovered.
  const skipWipWrite = useRef(false);
  const [ticketId, setTicketId] = useState(ticket || "");
  // A reopened draft has to finish loading before its zeros can be trusted as
  // zeros rather than as "not read yet".
  const [loadingTicket, setLoadingTicket] = useState(!!ticket);

  // Every ticket starts empty, per Kyle. The usual lines used to be laid out
  // ready to step up, but a pre-laid line is a claim waiting to be skimmed
  // past — every charge on a ticket is now one somebody picked from the
  // dropdown on purpose. (Reopened drafts and "start from last ticket" still
  // bring their own lines; this is only what a blank ticket opens with.)
  const [weldLines, setWeldLines] = useState([]);
  // The dropdown picks start empty because the menus themselves arrive with
  // the catalog; the render falls back to the first available item. Per-weld
  // picks are one per mode dropdown (film / CR / DR / methods), keyed the
  // same way the groups are.
  const [weldPicks, setWeldPicks] = useState({});
  const [otherLines, setOtherLines] = useState([]);
  // Charges already on a saved draft that this client's card no longer
  // offers. Read-only — there is no dropdown behind them to change a
  // quantity against — but still money on the ticket, so they are totalled
  // and written back untouched. See linesToForm.
  const [orphanLines, setOrphanLines] = useState([]);
  const [servicePick, setServicePick] = useState("");
  const [saving, setSaving] = useState(false);
  // How long the save on screen has been waiting, which is what decides the
  // button's wording (savingLabel). Measured from a start stamp rather than
  // counted in ticks, because a phone that dims its screen throttles the
  // interval and a tick count would report a wait shorter than it was. Up
  // here with every other hook, above the early returns below.
  const [savingMs, setSavingMs] = useState(0);
  // Which of the two footer buttons is in flight, so the "still trying"
  // words land on the one that was pressed rather than always on the primary.
  const [savingSend, setSavingSend] = useState(false);
  useEffect(() => {
    if (!saving) { setSavingMs(0); return undefined; }
    const startedAt = Date.now();
    const id = setInterval(() => setSavingMs(Date.now() - startedAt), 250);
    return () => clearInterval(id);
  }, [saving]);
  const [saveError, setSaveError] = useState("");
  const [queued, setQueued] = useState(false);
  // The footer is on screen whenever the form is (not the no-job or queued
  // panels); the toast reads this to keep clear of it.
  useScreenFoot(!!job && !queued && !loadError && !!rates && !loadingTicket);
  // Set once the ticket row exists, so a retry emails rather than re-inserts.
  // A reopened draft is already in the database, so it starts true and every
  // save is an update.
  const [created, setCreated] = useState(!!ticket);
  // Whether the last attempt got the ticket saved but failed to email it — the
  // only case where the primary button should offer a retry rather than a send.
  const [emailFailed, setEmailFailed] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // The contact this ticket was actually raised against. A reopened draft may
  // name a different rep than the job's current primary — that is the whole
  // point of the per-ticket contacts — so the approval email follows the ticket,
  // not the job.
  const [ticketClientContact, setTicketClientContact] = useState((seed && seed.clientContact) || "");
  const [ticketContractorContact, setTicketContractorContact] = useState((seed && seed.contractorContact) || "");
  // The idempotency key for this unsaved ticket (Db.createTicket): minted
  // once, kept with the recovery copy, so a save whose answer was lost on
  // the radio — or replayed from the outbox — finds the row it already
  // made instead of minting a second number.
  const [clientKey, setClientKey] = useState(() => (crypto.randomUUID ? crypto.randomUUID() : null));
  // A JHA left open at the end of the day is the thing most easily forgotten,
  // and the moment someone closes out their billing is when they're thinking
  // about the day ending. Reminder only — it never blocks the ticket.
  const [openJha, setOpenJha] = useState(null);
  useEffect(() => {
    if (!job || !job.dbId) return;
    Db.openJhaForJob(job.dbId).then(setOpenJha).catch(() => setOpenJha(null));
  }, [job ? job.dbId : null]);

  // Crew: who was on this ticket, and how the billed hours land on each
  // person's timesheet. Seeded with whoever is raising the ticket.
  const [people, setPeople] = useState([]);
  const [crew, setCrew] = useState([]);
  // The filer as a crew row — what every ticket starts with. Read through a
  // ref by the draft loader, which may run before or after the directory
  // arrives; whichever comes second fills in the profile's own name and
  // subcontractor flag.
  const peopleRef = useRef([]);
  useEffect(() => { peopleRef.current = people; }, [people]);
  const seedCrew = list => {
    const me = (list || []).find(p => p.id === currentUser.id);
    return [{
      profileId: currentUser.id,
      name: me ? me.displayName : currentUser.name,
      isSub: me ? me.is_subcontractor : false,
      role: "Lead", straight: 0, ot: 0, solo: 0, soloOt: 0, dose: 0, mileage: 0
    }];
  };

  // The date this ticket is filed against — captured once when the screen
  // opens, in local time, so a ticket built either side of midnight UTC still
  // carries the day the work was actually done. A reopened draft keeps the day
  // it was raised for, not today.
  const [workDate, setWorkDate] = useState(() => (seed && seed.workDate) || todayLocal());
  // Standby, waiting on the line, road bans. Prints on the client's field
  // invoice, so it belongs to the day rather than to the job.
  const [delays, setDelays] = useState("");
  // Changing where the approval goes: the box, and this client's people on
  // file to pick from (read the first time the box opens). Out of the
  // directory this device already holds — Db.listContacts is cached in
  // memory and on the device — rather than a fresh paged read of the
  // organisation, which needed signal in the one screen used without it.
  const [editingTo, setEditingTo] = useState(false);
  const [clientContacts, setClientContacts] = useState([]);
  useEffect(() => {
    if (!editingTo || !job || !job.clientId) return;
    let live = true;
    Db.listContacts()
      .then(rows => { if (live) setClientContacts(contactsForOrg(rows, "client", job.clientId)); })
      .catch(() => { /* the box still takes a typed address */ });
    return () => { live = false; };
  }, [editingTo, job ? job.clientId : null]);
  // A number worked out on this device rather than handed over by the
  // database. It usually matches what gets stored, but it can be overtaken,
  // so it must not read like a settled fact — this is the number a technician
  // might write on the day's paperwork.
  const [provisionalNumber, setProvisionalNumber] = useState(false);
  useEffect(() => OfflineCache.subscribe(s => setProvisionalNumber(!ticket && s.servingCached)), [ticket]);

  // Rates and the crew directory belong to the client and the org, not the
  // day the work was done — so they load when the client changes and never
  // on a work-date edit. WIP recovery and reopening a draft both set
  // workDate after mount; when this was one effect keyed on workDate too,
  // each of those needlessly re-pulled the whole rate card and profile list.
  useEffect(() => {
    if (!job) return;
    if (!mayPrice) return;
    (async () => {
      try {
        const r = await Db.getPublishedRatesForClient(job.clientId);
        if (!r) { setLoadError("No published rate schedule for this client yet — set one up in Rate admin first."); return; }
        setRates(r);
      } catch (e) {
        // Rates come from the offline cache when there's no signal, so getting
        // here with a network error means this client's card has never been
        // loaded on this device. Say that, rather than "Couldn't load rates".
        setLoadError(OfflineQueue.isNetworkError(e)
          ? "No connection, and this client's rates haven't been opened on this device yet. Open this job once in range and the ticket screen works offline from then on."
          : (e.message || "Couldn't load rates."));
      }
    })();

    Db.listActiveProfiles()
      .then(list => {
        setPeople(list);
        // A reopened draft brings its own crew rows (or is seeded by the
        // draft loader when it has none); seeding "just me" here would
        // overwrite them. The guard also covers a recovered WIP entry. What
        // this path still owes them is the profile's own name and
        // subcontractor flag, if the filer's row was seeded before the
        // directory arrived.
        if (ticket || wipRestored.current) {
          const me = list.find(p => p.id === currentUser.id);
          if (me) setCrew(p => p.map(c => c.profileId === me.id ? { ...c, name: me.displayName, isSub: me.is_subcontractor } : c));
          return;
        }
        setCrew(seedCrew(list));
      })
      .catch(e => {
        console.error("Couldn't load crew list:", e.message);
        // Without the directory a new ticket has no crew row and no picker,
        // so it would save with nobody's hours on it — the day's pay. A
        // reopened draft brought its own crew and only loses the "add
        // someone" box.
        if (!ticket && !wipRestored.current) setLoadError(`Couldn't load the crew list: ${e.message || "the read failed."} Nobody's hours could be entered on this ticket — check your connection and open it again.`);
      });
  }, [job ? job.clientId : null]);

  // The ticket-number preview is the one thing here that varies by day. A
  // preview only: the number that actually gets stored is minted by the
  // database at save time, which keeps a ticket built offline this morning
  // from colliding with one raised in the meantime. Its own effect so a
  // work-date edit reprices the number without re-pulling rates or crew.
  useEffect(() => {
    if (!job || ticket || !mayPrice) return;
    Db.nextTicketNumber(initialsOf(currentUser.name), workDate)
      .then(setTicketId)
      .catch(e => setLoadError(e.message || "Couldn't reserve a ticket number."));
  }, [job ? job.clientId : null, workDate, ticket]);

  // Reopening a draft: pull its lines and crew back into the form. Lines
  // are matched by label, which is what the ticket stores — a line whose label
  // no longer exists in the rate card comes back read-only rather than being
  // dropped, since dropping it deleted the charge on the next save.
  // Waits for the catalog, since the labels are matched against it — and runs
  // once: the rates object is refetched when the work date changes, and
  // re-running this then would wipe edits back to the stored draft.
  const draftLoaded = useRef(false);
  // The stored ticket's lines exactly as the loader read them. Kept because
  // the recovery reader below has to be able to name and price a line the
  // card dropped after the copy was written — see reconcileRecoveredLines.
  const draftRows = useRef(null);
  // The read itself, kept out of the effect because "Start empty" on a
  // reopened draft runs it a second time: throwing away an unsaved copy has
  // to mean going back to what is STORED, not to a blank ticket. Every field
  // is assigned rather than filled in only when the row has something to say,
  // so the second run can put back a delays note or a rep that was cleared.
  const loadDraft = async () => {
    try {
      const [row, savedCrew] = await Promise.all([Db.getTicket(ticket), Db.listCrewForTicket(ticket)]);
      // Somebody else's ticket, and this is not an Admin: the editor stops
      // here rather than filling a form the database will refuse to save.
      // Job detail already opens such a ticket read-only; this is the guard
      // behind that button, for the tracker and anything else that reaches
      // the editor by id.
      if (row.technician_id && row.technician_id !== currentUser.id && currentUser.role !== "Admin") {
        setLoadError("This is another technician's ticket. Only an admin can edit someone else's ticket — open it from Job detail to read it.");
        return;
      }
      draftRows.current = row.ticket_lines || [];
      const { welds, others, orphans } = linesToForm(row.ticket_lines, true, rates);
      setWeldLines(welds);
      setOtherLines(others);
      setOrphanLines(orphans);
      setWorkDate(row.work_date || todayLocal());
      setDelays(row.delays || "");
      setTicketClientContact((row.client_contact && row.client_contact.name) || "");
      setTicketContractorContact((row.contractor_contact && row.contractor_contact.name) || "");
      // A draft raised from Job detail arrives with no crew rows at all,
      // and a ticket with nobody on it bills hours no one is paid for —
      // so an empty crew is seeded with the filer, exactly as a fresh
      // ticket is.
      setCrew(savedCrew.length ? savedCrew : seedCrew(peopleRef.current));
    } catch (e) {
      // Nothing was put on screen, so the run this read was meant to swallow
      // never happens — and a suppression left armed is spent on the next
      // real edit instead, which is the one write that matters. Handing it
      // back here keeps a failed reload from costing a genuine recovery copy.
      skipWipWrite.current = false;
      setLoadError(e.message || "Couldn't open that ticket.");
    }
  };
  useEffect(() => {
    if (!ticket || !rates || draftLoaded.current) return;
    draftLoaded.current = true;
    loadDraft().then(() => setLoadingTicket(false));
  }, [ticket, rates]);

  // ── Start from the last ticket ─────────────────────────────────────────
  // Offered, never applied on its own: a ticket must never arrive carrying
  // shape nobody asked for.
  const [lastTicket, setLastTicket] = useState(null);
  const [copiedFrom, setCopiedFrom] = useState("");
  useEffect(() => {
    if (!job || !job.dbId) return;
    let live = true;
    Db.lastTicketForJob(job.dbId, ticket)
      .then(t => { if (live) setLastTicket(t); })
      // Nothing to offer is the normal case on a job's first ticket, and
      // offline it can't be answered. Either way the button just isn't there.
      .catch(() => { if (live) setLastTicket(null); });
    return () => { live = false; };
  }, [job ? job.dbId : null, ticket]);

  const startFromLast = () => {
    if (!lastTicket || !rates) return;
    const { welds, others } = linesToForm(lastTicket.lines, false, rates);
    if (welds.length) setWeldLines(welds);
    if (others.length) setOtherLines(others);
    if (lastTicket.crew.length) {
      // The people and their roles carry over; their hours do not. Copying
      // the figures would mean a tired crew could file yesterday's numbers by
      // tapping straight through — the whole point is to skip the picking,
      // not the counting.
      setCrew(lastTicket.crew.map(c => ({
        ...c, ...Object.fromEntries(CREW_FIGURES.map(k => [k, 0]))
      })));
    }
    setCopiedFrom(lastTicket.id);
  };

  // ── Don't lose a half-entered ticket ───────────────────────────────────
  // Save draft is a deliberate act, so a tab evicted by the phone halfway
  // through entering a day's welds used to take the lot with it. This keeps
  // a copy on the device as it is typed.
  //
  // Keyed by the draft being edited, or by the job when it is a new ticket, so
  // two jobs on the go don't overwrite each other.
  const wipKey = `ticket.wip.${ticket || (job && job.dbId)}`;
  const [recovered, setRecovered] = useState(null);

  // The replay's note that this ticket's queued copy wrote over somebody
  // else's save. The toast that said so is long gone by the time the ticket
  // is reopened; this stays until it is dismissed, and only on the device
  // whose replay it was. A new ticket has no id and no history to overwrite.
  const [overwrote, setOverwrote] = useState(null);
  useEffect(() => {
    if (!ticket) { setOverwrote(null); return undefined; }
    let live = true;
    OfflineCache.read(overwroteKey(ticket))
      .then(hit => { if (live) setOverwrote(hit && hit.value ? hit.value.at || true : null); })
      .catch(() => {});
    return () => { live = false; };
  }, [ticket]);
  const dismissOverwrote = () => {
    setOverwrote(null);
    OfflineCache.remove(overwroteKey(ticket));
  };

  useEffect(() => {
    if (!job || loadingTicket) return;
    let live = true;
    OfflineCache.read(wipKey)
      .then(hit => {
        if (!live) return;
        const w = hit && hit.value;
        if (w && hasEntries(w.weldLines || [], w.otherLines || [], w.crew || [], w.delays || "", w.orphanLines || [])) {
          wipRestored.current = true;
          // The stored ticket in the shape the form holds it: what stands in
          // for anything the copy doesn't carry, and the material a line the
          // card has dropped since is rebuilt from. Only a reopened draft has
          // rows — this effect waits on loadingTicket, so by here the loader
          // has been and gone — and only then is the catalog certain to have
          // arrived, which is why both are asked for rather than assumed.
          const stored = draftRows.current && rates
            ? linesToForm(draftRows.current, true, rates)
            : { welds: [], others: [], orphans: [] };
          const merged = reconcileRecoveredLines({
            weldLines: w.weldLines || stored.welds,
            otherLines: w.otherLines || stored.others,
            // The off-card charges as the copy left them — a removed one has
            // to stay removed. An empty list is a real answer here, unlike the
            // fields below, so it is the key's presence that decides: a copy
            // written before this was saved has none, and the stored rows
            // answer for it instead of being emptied.
            orphanLines: Array.isArray(w.orphanLines) ? w.orphanLines : stored.orphans
          }, draftRows.current, rates);
          setWeldLines(merged.weldLines);
          setOtherLines(merged.otherLines);
          setOrphanLines(merged.orphanLines);
          if (w.crew) setCrew(w.crew);
          // What the Create ticket dialog chose just now — the day, this
          // ticket's reps — outranks what the recovery copy remembers: the
          // copy is keyed by job, so it may be yesterday's half-ticket, and
          // a date picked on purpose must not be quietly swapped for it.
          if (w.workDate && !(seed && seed.workDate)) setWorkDate(w.workDate);
          if (w.delays) setDelays(w.delays);
          if (w.clientKey) setClientKey(w.clientKey);
          if (w.clientContact && !(seed && seed.clientContact)) setTicketClientContact(w.clientContact);
          if (w.contractorContact && !(seed && seed.contractorContact)) setTicketContractorContact(w.contractorContact);
          setRecovered(hit.at || null);
        }
        wipReady.current = true;
      })
      .catch(() => { wipReady.current = true; });
    return () => { live = false; };
  }, [job ? job.dbId : null, ticket, loadingTicket]);

  useEffect(() => {
    // "Start empty" on a reopened draft reloads the stored ticket, and that
    // reload lands here as a change like any other — so the copy that was
    // just thrown away was written straight back, and the banner offering it
    // returned the next time the ticket was opened, for ever. The one run
    // this reload causes writes nothing; a real edit after it does.
    if (skipWipWrite.current) { skipWipWrite.current = false; return; }
    if (!job || loadingTicket || !wipReady.current) return;
    // Only what someone actually entered is worth keeping. An untouched form
    // is cleared instead, so opening the screen and backing out doesn't leave
    // a phantom to recover next time.
    if (!hasEntries(weldLines, otherLines, crew, delays, orphanLines)) { OfflineCache.remove(wipKey); return; }
    const t = setTimeout(() => {
      OfflineCache.put(wipKey, {
        weldLines, otherLines, orphanLines, crew, workDate, delays, clientKey,
        clientContact: ticketClientContact, contractorContact: ticketContractorContact
      });
    }, 700);
    return () => clearTimeout(t);
    // The reps and the idempotency key are written into the copy, so they
    // have to be watched for it too: with only the lines and hours here, a
    // rep changed after the last weld was typed never reached the copy, and
    // the recovery brought the ticket back addressed to the wrong person.
    // The off-card lines for the same reason: they are money on the ticket
    // and they can be removed, and with them missing from the copy a charge
    // taken off came back the next time the draft was recovered.
  }, [weldLines, otherLines, orphanLines, crew, workDate, delays, loadingTicket,
      ticketClientContact, ticketContractorContact, clientKey]);

  const discardRecovered = () => {
    OfflineCache.remove(wipKey);
    setRecovered(null);
    // On a reopened draft the recovery copy holds unsaved CHANGES, not the
    // ticket: throwing it away means going back to the stored ticket, which
    // is what the loader reads. Blanking the form here instead emptied the
    // lines, zeroed the crew and cleared the reps — and the next Save wrote
    // that emptiness over a real ticket, because updateTicket replaces
    // lines and crew wholesale.
    //
    // The one write the reload would otherwise trigger is suppressed: what
    // it puts on screen is the stored ticket, which is not unsaved work and
    // must not become a recovery copy the moment one was discarded.
    if (ticket) { skipWipWrite.current = true; loadDraft(); return; }
    // Back to what a fresh ticket opens with: nothing — and the day and the
    // reps the Create ticket dialog chose, when it chose them. "Start empty"
    // used to clear the lines and keep the recovered copy's date, delays
    // and key, which is a different ticket wearing an empty face.
    setWeldLines([]);
    setOtherLines([]);
    setCrew(p => p.map(c => ({ ...c, ...Object.fromEntries(CREW_FIGURES.map(k => [k, 0])) })));
    setDelays("");
    setWorkDate((seed && seed.workDate) || todayLocal());
    setTicketClientContact((seed && seed.clientContact) || "");
    setTicketContractorContact((seed && seed.contractorContact) || "");
    setClientKey(crypto.randomUUID ? crypto.randomUUID() : null);
  };

  // Catalog maps — rebuilt only when the catalog itself arrives or changes.
  const weldItemsByKey = useMemo(() => rates ? Object.fromEntries(rates.welds.map(w => [w.key, w])) : {}, [rates]);
  const serviceByKey = useMemo(() => rates ? Object.fromEntries(rates.others.map(s => [s.key, s])) : {}, [rates]);

  // The sanity prompt's answer, remembered for this ticket and keyed on the
  // figures it was given for: a legitimate big number is not argued with on
  // every resave, and a newly typed one is still asked about. Declared up
  // here with the other hooks, above the early returns — below them it ran
  // only on some renders and React refused the screen.
  const oddConfirmed = useRef("");

  if (!job) return <NoJobSelected what="a billing ticket" />;
  if (queued) return <QueuedPanel what="this ticket" onDone={onSaved} />;
  if (loadError) {
    return <div className="page"><Blueprint style={{ padding: 20 }}><ErrorBox>{loadError}</ErrorBox></Blueprint></div>;
  }
  if (!rates || loadingTicket) {
    return <div className="page"><Loading label={loadingTicket ? "Opening ticket…" : "Loading rates…"} /></div>;
  }

  // Lines joined to their catalog items, dropping anything the card no
  // longer offers — a key can go stale between a device's recovered
  // work-in-progress and a card edited in the meantime, and an unknown key
  // must degrade to "not on this ticket", never to a crash or a $0 line.
  const weldRows = weldLines.map(l => ({ ...l, item: weldItemsByKey[l.key] })).filter(r => r.item);
  const otherRows = otherLines.map(l => ({ ...l, item: serviceByKey[l.key] })).filter(r => r.item);

  // Summed in integer cents of per-line totals — the same formula the
  // database stores, so the total on this screen is the total on the bill.
  const centsOf = rows => rows.reduce((s, r) => s + Math.round(lineTotal(r.qty, r.item.rate) * 100), 0);
  const weldCount = weldRows.filter(r => r.item.isWeld).reduce((s, r) => s + r.qty, 0);
  const weldDollars = centsOf(weldRows) / 100;
  const otherDollars = centsOf(otherRows) / 100;
  // Off-card lines are money on the ticket like any other, and they go back
  // to the database on the next save — so they are summed the same way, in
  // integer cents, and the figure on this screen stays the figure db.js
  // stores.
  const orphanCents = orphanLines.reduce((s, l) => s + Math.round(lineTotal(l.quantity, l.unit_rate) * 100), 0);
  const orphanDollars = orphanCents / 100;
  const total = (centsOf(weldRows) + centsOf(otherRows) + orphanCents) / 100;
  // This client's own GST rate, which is 5% for almost everyone and zero for
  // the exempt ones. Read off the job because that is where the client is;
  // gstRateOf reads a job with no rate on it — one cached before the column
  // existed — as 5%, never as exempt.
  const gstRate = gstRateOf(job && job.clientGstRate);
  const gst = gstOn(total, gstRate);
  // The figure with the tax on it — what the rep signs for. Worked out once,
  // in integer cents, because the totals block and the bar at the foot of the
  // screen both show it and they must never read a cent apart.
  const totalIncGst = Math.round(total * 100 + gst * 100) / 100;

  const availableWeld = rates.welds.filter(w => !weldLines.some(l => l.key === w.key));
  const availableService = rates.others.filter(s => !otherLines.some(l => l.key === s.key));
  // A line the card hasn't priced yet bills $0, which is the worst way for a
  // number to be wrong: the ticket totals up short and nothing says so. It
  // stays on the menu — the admin may price it before the day is billed —
  // but it is badged, and the ticket cannot go to the client carrying one.
  const unpriced = [...weldRows, ...otherRows].filter(r => !Number(r.item.rate));
  const isUnpriced = item => !Number(item.rate);
  // The dropdown picks fall back to the first item still available, so the
  // selects are never pointing at something already added or off the card.
  const effServicePick = availableService.some(s => s.key === servicePick) ? servicePick : (availableService[0] || {}).key || "";

  // Per Kyle, film, CR and DR each get their own dropdown; methods (and the
  // odd legacy one-cell weld line) share a fourth. Catalog keys are
  // kind:label, so the group is right there in the key, and inside a mode's
  // own dropdown the " · RT film" suffix is noise — the added line still
  // shows its full name.
  const WELD_GROUPS = [
    { id: "rt_film", title: "Film" },
    { id: "rt_cr", title: "CR" },
    { id: "rt_dr", title: "DR" },
    { id: "other", title: "Methods" }
  ];
  const weldGroupOf = key => {
    const kind = key.split(":")[0];
    return kind === "rt_film" || kind === "rt_cr" || kind === "rt_dr" ? kind : "other";
  };
  const shortWeldLabel = (group, label) =>
    group === "other" ? label : label.replace(/ · RT (film|CR|DR)$/, "");

  // What the client is billed for hours — the figure the crew split is
  // measured against. A crew line can legitimately differ from it (crew-hours
  // billed once, worked by two people), so this informs rather than enforces.
  // Solo hours are a rate distinction inside those hours, not extra time, so
  // they're excluded from the comparison. Looked up by label — the card
  // decides the keys now.
  // Matched the way the blended line is, by what the label says rather than
  // by two exact strings: a client card that calls its hours line "Crew
  // straight time" billed zero under the old lookup, so the cross-check
  // read amber the moment anyone entered an hour — permanently, for that
  // client — and taught the crew to ignore it.
  const billedWhere = test => rates.others
    .filter(o => o.unit === "h" && test(String(o.label || "").toLowerCase()))
    .reduce((s, o) => { const row = otherLines.find(l => l.key === o.key); return s + (row ? row.qty : 0); }, 0);
  const billedStraight = billedWhere(l => !l.includes("blended") && (l.includes("straight") || l.includes("regular")));
  const billedOt = billedWhere(l => !l.includes("blended") && (l.includes("overtime") || /\bot\b/.test(l)));
  // Blended hours are billable hours: one negotiated figure standing in for
  // straight + OT together, per Kyle. Found by name, since it is a custom
  // line each card carries (or doesn't) on its own terms.
  const billedBlended = rates.others
    .filter(o => o.unit === "h" && o.label.toLowerCase().includes("blended"))
    .reduce((s, o) => { const row = otherLines.find(l => l.key === o.key); return s + (row ? row.qty : 0); }, 0);
  const assignedStraight = crew.reduce((s, c) => s + (c.straight || 0), 0);
  const assignedOt = crew.reduce((s, c) => s + (c.ot || 0), 0);
  // With blended hours on the ticket, straight and OT can't be compared
  // bucket by bucket — the blended figure covers both — so the comparison
  // falls back to totals. Compared at two decimals: summing typed decimal
  // hours in floats can differ from the billed figure by a quadrillionth,
  // and that must not read as a crew-hours discrepancy.
  const h2 = n => Math.round(n * 100) / 100;
  const hoursMismatch = billedBlended > 0
    ? h2(assignedStraight + assignedOt) !== h2(billedStraight + billedOt + billedBlended)
    : (h2(assignedStraight) !== h2(billedStraight) || h2(assignedOt) !== h2(billedOt));
  const availablePeople = people.filter(p => !crew.some(c => c.profileId === p.id));
  // The crew picker searches rather than lists: forty-odd names in a
  // dropdown was a long scroll in a truck. Name, initials or id code all
  // match, technicians before helpers as the dropdown grouped them, and a
  // pick adds the person straight away in the role their group decides (a
  // helper is a helper wherever they are picked from), so it cannot be set
  // wrong. Only people not already on the crew are offered, so the same
  // person cannot go on twice however many times they are picked.
  const searchCrew = (text, max) => {
    const q = text.trim().toLowerCase();
    // Split on whitespace — this read /s+/ once, the letter s, and the
    // initials arm of the picker never matched anybody.
    const initials = p => String(p.displayName || "").split(/\s+/).map(w => w[0] || "").join("").toLowerCase();
    const hit = p => !q
      || String(p.displayName || "").toLowerCase().includes(q)
      || initials(p).startsWith(q)
      || String(p.id_code || "").toLowerCase().includes(q);
    const rows = [...availablePeople.filter(p => crewRoleFor(p) !== "Helper" && hit(p)),
                  ...availablePeople.filter(p => crewRoleFor(p) === "Helper" && hit(p))];
    return { rows: rows.slice(0, max), total: rows.length };
  };
  const addCrewMember = p => {
    if (!p || crew.some(c => c.profileId === p.id)) return;
    clearSaveError();
    setCrew(c => c.some(x => x.profileId === p.id) ? c
      : [...c, { profileId: p.id, name: p.displayName, isSub: p.is_subcontractor, role: crewRoleFor(p), straight: 0, ot: 0, solo: 0, soloOt: 0, dose: 0, mileage: 0 }]);
  };

  // A refusal is about the figures that were on screen when Save was pressed.
  // It used to be cleared only at the top of the next save, so a $4.49 ticket
  // sat under "This ticket adds up to $198,000,010…" long after the quantity
  // was corrected, reading as if it were still refused. The first edit to
  // anything the message could be about takes it down.
  const clearSaveError = () => setSaveError(e => e ? "" : e);

  const setCrewField = (profileId, key, value) => {
    clearSaveError();
    setCrew(p => p.map(c => c.profileId === profileId ? { ...c, [key]: Math.max(0, value) } : c));
  };

  const setWeldQty = (key, qty) => { clearSaveError(); setWeldLines(p => p.map(l => l.key === key ? { ...l, qty: Math.max(0, qty) } : l)); };
  const setOtherQty = (key, qty) => { clearSaveError(); setOtherLines(p => p.map(l => l.key === key ? { ...l, qty: Math.max(0, qty) } : l)); };
  const removeWeld = key => { clearSaveError(); setWeldLines(p => p.filter(l => l.key !== key)); };
  const removeOther = key => { clearSaveError(); setOtherLines(p => p.filter(l => l.key !== key)); };
  // By position: an off-card line has no catalog key to be known by.
  const removeOrphan = i => { clearSaveError(); setOrphanLines(p => p.filter((_, j) => j !== i)); };

  // Stored — and therefore printed on the field invoice — in the card's
  // order, not the order lines were tapped in: the invoice reads like the
  // rate card the client agreed to, with Blended Rate sitting where the
  // hours sit rather than wherever it was added.
  const buildLines = () => {
    const weldOrder = new Map(rates.welds.map((w, i) => [w.key, i]));
    const otherOrder = new Map(rates.others.map((s, i) => [s.key, i]));
    return [
      ...[...weldRows].sort((a, b) => weldOrder.get(a.key) - weldOrder.get(b.key))
        .map(r => ({ kind: "weld", label: r.item.label, unit: "weld", quantity: r.qty, unit_rate: r.item.rate })),
      ...[...otherRows].sort((a, b) => otherOrder.get(a.key) - otherOrder.get(b.key))
        .map(r => ({ kind: "charge", label: r.item.label, unit: r.item.unit, quantity: r.qty, unit_rate: r.item.rate })),
      // Off the card, so there is no place in the card's order for them:
      // they follow, verbatim, at the price they were billed at. Left out,
      // they would be deleted by the very next save.
      ...orphanLines.map(l => ({ kind: l.kind, label: l.label, unit: l.unit, quantity: l.quantity, unit_rate: l.unit_rate }))
    ];
  };

  // Which hours field a crew figure came from, in the words the row uses.
  const CREW_HOUR_FIELDS = [
    ["straight", "reg"], ["ot", "OT"], ["solo", "solo"], ["soloOt", "solo OT"]
  ];

  // Figures nobody could have worked. Nothing here refuses a save — a big
  // number is sometimes the right number — it is the question the ticket
  // screen never asked: the only guard was the database's eight-figure
  // ceiling, so 12,000 welds at $8 saved in silence and billed $96,000.
  const oddFigures = () => {
    const out = [];
    for (const l of buildLines()) {
      if (l.quantity > saneQuantityCeiling(l.unit)) {
        const unit = l.unit === "weld" ? "welds" : l.unit;
        out.push(`${l.label} has ${Number(l.quantity).toLocaleString("en-CA")} ${unit}`);
      }
    }
    for (const c of crew) {
      for (const [key, label] of CREW_HOUR_FIELDS) {
        if ((c[key] || 0) > SANE_CREW_HOURS) out.push(`${c.name} has ${hours(c[key])} ${label} hours`);
      }
    }
    return out;
  };

  const save = async sendForApproval => {
    // Only sending needs charges — an empty draft is a legitimate
    // placeholder, but a client can't be asked to sign a blank ticket.
    if (sendForApproval && total <= 0) {
      setSaveError("This ticket has no charges on it yet — enter the day's quantities first.");
      return;
    }
    // If sending is the goal, find the address before writing anything: a
    // missing rep email used to surface only after the ticket was already in
    // the database, and the retry then collided with its own primary key.
    let to = null;
    if (sendForApproval) {
      try { to = approvalEmail(ticketClientContact || jobRecord.clientRep); }
      catch (e) { setSaveError(e.message); return; }
      // PO = AFE is what the client's accounts payable pays against. A
      // ticket without one can still go out — some jobs run on a verbal —
      // but not without being asked.
      if (!String(jobRecord.afe || "").trim()
          && !confirm(`${job.id} has no AFE / PO on file. The client's accounts payable pays against it — send this ticket for approval anyway?`)) return;
    }

    // Asked before anything is written, and asked once: the figure is named
    // so the answer is about this line rather than about a warning in general.
    const odd = oddFigures();
    const oddKey = odd.join(" · ");
    if (odd.length && oddKey !== oddConfirmed.current) {
      const others = odd.length - 1;
      const rest = others ? ` (and ${others} other figure${others === 1 ? "" : "s"} like it)` : "";
      if (!confirm(`${odd[0]}${rest} — save it anyway?`)) return;
      oddConfirmed.current = oddKey;
    }

    setSaving(true);
    setSavingSend(!!sendForApproval);
    setSaveError("");
    setEmailFailed(false);
    // What goes to the database is what is on screen at this moment. Until
    // the save lands the form is frozen (see the frame below) and the
    // keyboard is put away — a number corrected while "Saving…" spun used
    // to be discarded silently, because the successful save wiped the
    // recovery copy and left the screen with the old figure stored.
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    // Declared outside the try so the catch reads the same truth the save
    // path wrote — see the note on `inDb` below. `stage` records how far
    // the save actually got: a crew-save failure used to be reported as
    // "the approval email didn't go out", pointing the tech at a resend
    // when the real problem was lines or hours that never landed.
    let savedId = ticketId;
    let inDb = created;
    let stage = "save";

    // The outbox is reached two ways — the radio dropped the answer, or the
    // device said up front there was no signal — and both want the same
    // payload written the same way, so both come through here. It reads
    // savedId, inDb and stage at the moment it is called, which is why they
    // are declared above it. It ends the save either way — the queued panel,
    // or the outbox's own refusal on screen — so every caller returns after
    // it.
    const queueThisTicket = async () => {
      try {
        await OfflineQueue.enqueue("ticket", {
          // No ticketId on a ticket that was never created: the number is
          // minted when this replays, so hours offline can't reserve a number
          // somebody else has since been given.
          ticketId: inDb ? savedId : null,
          initials: initialsOf(currentUser.name),
          jobDbId: job.dbId, technicianId: currentUser.id, workDate,
          clientContact: { name: ticketClientContact || jobRecord.clientRep }, contractorContact: { name: ticketContractorContact || jobRecord.contractorRep },
          lines: buildLines(), status: "Draft",
          crew, delays, alreadyCreated: inDb, sendForApproval, approvalTo: to, clientKey,
          // What this edit started from, so a replay can say if it wrote over
          // somebody else's later save (App.jsx, ticketFingerprint.js). A ticket
          // never created has no base and is never compared.
          baseFingerprint: inDb ? Db.lastKnownTicketFingerprint(savedId) : null,
          // Marked when it was the SEND whose answer went missing, not the
          // save — `stage` is "email" only once sendTicketApproval has been
          // called. The send is what moves the row to Awaiting approval, so
          // one that landed after the radio dropped the reply leaves this
          // item looking exactly like a ticket the office sent out from
          // under it: the next flush meets the refused update, sounds the
          // alarm about billing nobody re-entered, and parks a ticket that
          // was in fact complete. The queue sets the same flag on its own
          // send for the same reason (App.jsx). Only a send the radio lost
          // is ambiguous — a save that never left this device is not one.
          sendAttempted: stage === "email"
        });
      } catch (queueErr) {
        // The outbox is IndexedDB, and it can refuse — private browsing, a
        // full disk, a wedged database. Unguarded, that threw straight out
        // of save: the button stayed on "Saving…" for ever and nobody was
        // told. The recovery copy stays put, so the day's figures are still
        // here to try again with.
        setSaving(false);
        setSaveError("No signal, and this device couldn't hold the ticket either — stay on this screen and press Save again once you're in range.");
        return;
      }
      // Queued counts as safe: the work is on the device in the outbox now,
      // which is a better home for it than the recovery copy.
      await OfflineCache.remove(wipKey);
      setQueued(true);
    };

    // There is nothing to learn from asking a radio that is already off.
    // Waiting for the answer took about eight seconds — a token refresh and
    // then the request, each having to time out — and the form sat dimmed
    // and silent for all of it before arriving at this same outbox, which in
    // a truck reads as a hung app and gets the button pressed again. Nothing
    // has been attempted at this point, so the ticket is neither created nor
    // sent and the payload is the one this screen started with.
    if (deviceOffline()) { await queueThisTicket(); return; }

    try {
      // Saved first, emailed second — and saved as a Draft either way.
      //
      // This used to write "Awaiting approval" here, before the send was
      // attempted, so a send that failed left a ticket claiming the client
      // had it. With Postmark unconfigured that is every send, and the
      // tracker showed tickets waiting on a signature nobody had been asked
      // for. send-ticket-approval promotes the status itself once the mail
      // is actually away, so there is one place that decides it and it is
      // the one that knows whether anything left the building.
      // `created` records that the write landed, so a retry after a failed
      // send doesn't try to insert the same ticket number twice.
      // Everything after the insert has to use the number the database
      // actually minted, not the preview this screen has been showing.
      //
      // `inDb` is the local twin of `created`: setState doesn't change what
      // this invocation reads back, so the catch block below was seeing the
      // render-time value — a crew-save failure right after a successful
      // insert queued the ticket as never-created, and the replay minted a
      // second ticket with the same billing lines. The local flips the
      // moment the row exists; the state catches up for later renders.
      if (!inDb) {
        const saved = await Db.createTicket({
          initials: initialsOf(currentUser.name), jobDbId: job.dbId, technicianId: currentUser.id, workDate,
          clientContact: { name: ticketClientContact || jobRecord.clientRep }, contractorContact: { name: ticketContractorContact || jobRecord.contractorRep },
          lines: buildLines(), status: "Draft",
          delays, clientKey
        });
        savedId = saved.id;
        setTicketId(savedId);
        inDb = true;
        setCreated(true);
        // A row that already existed for this key (the first save's answer
        // was lost) may hold an older set of lines: write today's over it.
        if (saved.existing) await Db.updateTicket({
          ticketId: savedId,
          clientContact: { name: ticketClientContact || jobRecord.clientRep }, contractorContact: { name: ticketContractorContact || jobRecord.contractorRep },
          lines: buildLines(), status: "Draft", delays
        });
        await Db.saveCrewForTicket(savedId, crew);
      } else {
        // Already in the database — either a reopened draft, or a retry after
        // the approval email failed. Both want the same thing: write what is on
        // screen now over what is stored. The reps included: they are editable
        // on this screen, and leaving them out of the patch silently kept the
        // stored pair while the recovery copy was deleted as saved.
        await Db.updateTicket({
          ticketId: savedId,
          clientContact: { name: ticketClientContact || jobRecord.clientRep }, contractorContact: { name: ticketContractorContact || jobRecord.contractorRep },
          lines: buildLines(),
          status: "Draft",
          delays
        });
        await Db.saveCrewForTicket(savedId, crew);
      }
      if (sendForApproval) { stage = "email"; await Db.sendTicketApproval({ ticketId: savedId, to }); }
      // Safely stored — the on-device copy has nothing left to protect, and
      // leaving it would offer this ticket back as unsaved work next time.
      await OfflineCache.remove(wipKey);
      onSaved();
    } catch (e) {
      // A refusal the server actually gave is a reason whatever the radio is
      // doing now: isNetworkError calls any error "offline" while
      // navigator.onLine is false, so a plain refusal met in a dead spot would
      // be queued as work to retry instead of shown. Same order oqFlushOnce
      // keeps (offlineQueue.js).
      if (!e.plain && OfflineQueue.isNetworkError(e)) {
        await queueThisTicket();
        return;
      }
      setSaving(false);
      if (e.ticketGone) {
        // The ticket vanished under this editor — cancelled on another
        // device. The entries on screen are still good, so flip back to
        // insert mode: the next Save mints a fresh number and raises them
        // as a new ticket instead of re-failing against the dead id.
        setCreated(false);
        setSaveError(`${e.message} Everything on this screen is still here — press Save draft to raise it as a new ticket.`);
      } else if (e.plain) {
        // Complete in itself (someone else's ticket, just approved, signed
        // out) — the generic "press Save again" wrapper would be a lie.
        setSaveError(e.message);
      } else if (inDb && stage === "email") {
        setEmailFailed(true);
        setSaveError(`Ticket ${savedId} is saved, but the approval email didn't go out: ${e.message || "the email service didn't respond."} It's in the billing tracker — you can chase it from there.`);
      } else if (inDb) {
        setSaveError(`Ticket ${savedId} exists, but your latest changes didn't all save: ${e.message || "the save failed partway."} Press Save again — nothing on screen is lost.`);
      } else {
        setSaveError(e.message || "Couldn't save the ticket — try again.");
      }
    }
  };

  // The job record stores the rep as a display string ("T. Beaudry · (780)…"),
  // so pull the address out of it rather than mailing the whole label.
  function approvalEmail(rep) {
    const found = emailIn(rep);
    if (!found) throw new Error("No client rep email to send to — add one on this ticket, or in the job record, first.");
    return found;
  }

  // Cancelling a ticket raised by mistake. Only offered once the ticket exists
  // — before that, leaving the screen is the cancel.
  async function cancelTicket() {
    if (!confirm(`Cancel ticket ${ticketId}? It is deleted outright, along with any hours and dose recorded on it. This can't be undone.`)) return;
    setCancelling(true);
    setSaveError("");
    try {
      await Db.deleteTicket(ticketId);
      onSaved();
    } catch (e) {
      // Already cancelled on another device is the outcome that was asked
      // for — leave the dead ticket's editor like any successful cancel.
      if (e.ticketGone) { onSaved(); return; }
      setCancelling(false);
      setSaveError(e.message || "Couldn't cancel that ticket.");
    }
  }

  return (
    // Room at the foot of the page for the fixed bar below — two rows of it
    // once the figure and the buttons stop sharing a line on a phone, plus
    // the home indicator on an iPhone. Without it the last crew row, or
    // Cancel this ticket, sits under the bar and cannot be reached.
    <div className="page" style={{ paddingBottom: "calc(150px + env(safe-area-inset-bottom, 0px))" }}>
      <div className="phone-shell">
        {/* Frozen while a save is in flight: an edit typed during the save
            would be lost to it (see save()). pointer-events off keeps taps
            from reaching the inputs; the page itself still scrolls. */}
        <Blueprint className="phone-frame" aria-busy={saving || undefined}
          style={saving ? { pointerEvents: "none", opacity: 0.7 } : undefined}>
          <div style={{ display: "flex", alignItems: "center", fontSize: 11, textTransform: "uppercase" }}>
            <span style={{ width: 7, height: 7, background: "var(--color-accent)", marginRight: 6, flex: "none" }} />
            Draft ticket
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="tabular" style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 20 }}>{ticketId || "…"}</span>
              {provisionalNumber && <TagX variant="outline">provisional</TagX>}
            </div>
            {provisionalNumber && (
              <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                Worked out on this device while offline. The final number is set when this ticket syncs — check it before writing it on paperwork.
              </div>
            )}
            {/* The work date is on the face of the ticket now — it decides
                which pay period the crew's hours land in. Until the ticket
                exists it can be changed here (writing up yesterday at
                06:00 used to be impossible from Home: the date was today,
                full stop); once saved, the number carries the date and it
                is fixed. The number re-mints when the day changes. */}
            {!created && (
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginTop: 4 }}>
                <span style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Work date</span>
                <input type="date" className="input" value={workDate} max={todayLocal()} aria-label="Work date"
                  style={{ minHeight: 36, width: "auto", fontSize: 14 }}
                  onChange={e => { if (e.target.value) setWorkDate(e.target.value); }} />
              </label>
            )}
            <div className="tabular" style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
              {dayMonth(localDate(workDate))} · {job.client}{jobRecord.afe ? ` · ${jobRecord.afe}` : ""}{jobRecord.lsd ? ` · ${jobRecord.lsd}` : ""}
            </div>
          </div>

          {/* Work found on the device that never made it to the database.
              Brought back automatically — losing a day's entry is the bad
              outcome here, and an untouched form is never stored — but said
              out loud, with a way to throw it away. */}
          {overwrote && (
            <div role="status" style={{
              fontSize: 12, padding: "8px 10px",
              border: "1px solid var(--color-accent-700)",
              background: "color-mix(in srgb, var(--color-accent) 8%, transparent)",
              display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap"
            }}>
              <span>{overwroteWords(overwrote === true ? null : overwrote)}</span>
              <button type="button" onClick={dismissOverwrote}
                style={{ marginLeft: "auto", background: "none", border: "none", textDecoration: "underline", cursor: "pointer", color: "inherit", font: "inherit", padding: 0, whiteSpace: "nowrap" }}>
                I've checked
              </button>
            </div>
          )}

          {recovered && (
            <div style={{
              fontSize: 12, padding: "8px 10px",
              border: "1px solid var(--color-accent-700)",
              background: "color-mix(in srgb, var(--color-accent) 8%, transparent)",
              display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap"
            }}>
              {/* On a reopened draft the copy is the unsaved edits, not the
                  ticket — so it says so, and throwing it away goes back to
                  the stored ticket rather than to a blank form. */}
              <span>
                {ticket ? "Brought back the changes you were making" : "Brought back what you were entering"}
                {recovered ? ` at ${new Date(recovered).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" })}` : ""}
                {ticket ? " — they were never saved." : " — it was never saved."}
              </span>
              <button type="button" onClick={discardRecovered}
                style={{ marginLeft: "auto", background: "none", border: "none", textDecoration: "underline", cursor: "pointer", color: "inherit", font: "inherit", padding: 0 }}>
                {ticket ? "Discard changes" : "Start empty"}
              </button>
            </div>
          )}

          {/* Multi-day jobs repeat. This copies the shape of the last ticket
              — which lines, which crew — and nothing else. */}
          {lastTicket && !copiedFrom && !recovered && (
            <Btn variant="secondary" block onClick={startFromLast}
              title="Copies the lines and crew from the last ticket on this job. Quantities and hours start at zero.">
              Start from {lastTicket.id}{lastTicket.workDate ? ` · ${dayMonth(localDate(lastTicket.workDate))}` : ""}
            </Btn>
          )}
          {copiedFrom && (
            <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
              Lines and crew copied from {copiedFrom}. Quantities and hours start at zero — enter today's.
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center" }}>
            <span style={{ fontSize: 13, fontFamily: "var(--font-heading)", fontWeight: 600 }}>Per-weld charges</span>
            <span className="tabular" style={{ marginLeft: "auto", fontSize: 12, color: "var(--color-accent)" }}>{weldCount} welds · {money(weldDollars)}</span>
          </div>
          {weldRows.length === 0 && (
            <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
              Nothing billed yet — pick a line below and tap Add.
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {weldRows.map(r => {
              const rate = r.item.rate;
              return (
                <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid color-mix(in srgb, var(--color-text) 8%, transparent)", paddingBottom: 6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15 }}>{r.item.label} {isUnpriced(r.item) && <TagX variant="outline">unpriced</TagX>}</div>
                    <div className="tabular" style={{ fontSize: 10, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{money(rate)} / weld</div>
                  </div>
                  {/* Typed, like Other charges below. These were − / + only,
                      so a day of 40 welds was 40 taps. A weld is a whole
                      one: step 1 is what takes the decimal point off the
                      keypad, the way the hours and mileage boxes state
                      theirs — without it 3.5 welds saved and was billed. */}
                  <NumField style={{ width: 66, textAlign: "right" }} step="1" value={r.qty}
                    aria-label={r.item.label} onChange={v => setWeldQty(r.key, v)} />
                  <span style={{ fontSize: 11, width: 22 }}>welds</span>
                  <span className="tabular" style={{ width: 62, textAlign: "right", fontSize: 14 }}>{money(lineTotal(r.qty, rate))}</span>
                  <button onClick={() => removeWeld(r.key)} style={{ background: "none", border: "none", cursor: "pointer", color: "color-mix(in srgb, var(--color-text) 50%, transparent)", fontSize: 16 }}>×</button>
                </div>
              );
            })}
          </div>
          {WELD_GROUPS.map(g => {
            const avail = availableWeld.filter(w => weldGroupOf(w.key) === g.id);
            if (!avail.length) return null;
            const pick = avail.some(w => w.key === weldPicks[g.id]) ? weldPicks[g.id] : avail[0].key;
            return (
              <div key={g.id} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 11, width: 52, flex: "none", textTransform: "uppercase", letterSpacing: ".04em", color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>{g.title}</span>
                <select className="input" value={pick} aria-label={`Add a ${g.title} line`}
                  onChange={e => setWeldPicks(p => ({ ...p, [g.id]: e.target.value }))} style={{ flex: 1, minWidth: 0 }}>
                  {avail.map(w => <option key={w.key} value={w.key}>{shortWeldLabel(g.id, w.label)}{isUnpriced(w) ? " (unpriced)" : ""}</option>)}
                </select>
                <Btn variant="secondary" onClick={() => {
                  clearSaveError();
                  setWeldLines(p => [...p, { key: pick, qty: 1 }]);
                  const rest = avail.filter(w => w.key !== pick);
                  setWeldPicks(p => ({ ...p, [g.id]: rest[0] ? rest[0].key : "" }));
                }}>Add</Btn>
              </div>
            );
          })}

          <div style={{ display: "flex", alignItems: "center", marginTop: 6 }}>
            <span style={{ fontSize: 13, fontFamily: "var(--font-heading)", fontWeight: 600 }}>Other charges</span>
            <span className="tabular" style={{ marginLeft: "auto", fontSize: 12, color: "var(--color-accent)" }}>{money(otherDollars)}</span>
          </div>
          {otherRows.length === 0 && (
            <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
              Nothing billed yet — pick a line below and tap Add.
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {otherRows.map(r => {
              const rate = r.item.rate;
              return (
                <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid color-mix(in srgb, var(--color-text) 8%, transparent)", paddingBottom: 6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14 }}>{r.item.label} {isUnpriced(r.item) && <TagX variant="outline">unpriced</TagX>}</div>
                    <div className="tabular" style={{ fontSize: 10, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{money(rate)} / {r.item.unit}</div>
                  </div>
                  <NumField style={{ width: 66, textAlign: "right" }} step={r.item.step} value={r.qty}
                    onChange={v => setOtherQty(r.key, v)} />
                  <span style={{ fontSize: 11, width: 22 }}>{r.item.unit}</span>
                  <span className="tabular" style={{ width: 62, textAlign: "right", fontSize: 14 }}>{money(lineTotal(r.qty, rate))}</span>
                  <button onClick={() => removeOther(r.key)} style={{ background: "none", border: "none", cursor: "pointer", color: "color-mix(in srgb, var(--color-text) 50%, transparent)", fontSize: 16 }}>×</button>
                </div>
              );
            })}
          </div>
          {availableService.length > 0 && (
            <div style={{ display: "flex", gap: 6 }}>
              <select className="input" value={effServicePick} onChange={e => setServicePick(e.target.value)} style={{ flex: 1 }}>
                {availableService.map(s => <option key={s.key} value={s.key}>{s.label}{isUnpriced(s) ? " (unpriced)" : ""}</option>)}
              </select>
              <Btn variant="secondary" onClick={() => { const pick = effServicePick; if (!pick) return; clearSaveError(); setOtherLines(p => [...p, { key: pick, qty: 1 }]); const rest = availableService.filter(s => s.key !== pick); if (rest[0]) setServicePick(rest[0].key); }}>Add</Btn>
            </div>
          )}

          {/* Charges this ticket was billed with that the client's card no
              longer offers. Shown so nobody is surprised by a number they
              can't find a dropdown for, and kept read-only: without a
              catalog line behind them there is no rate to re-price against.
              They stay on the ticket unless someone takes one off here. */}
          {orphanLines.length > 0 && (
            <>
              <div style={{ display: "flex", alignItems: "center", marginTop: 6 }}>
                <span style={{ fontSize: 13, fontFamily: "var(--font-heading)", fontWeight: 600 }}>No longer on the rate card</span>
                <span className="tabular" style={{ marginLeft: "auto", fontSize: 12, color: "var(--color-accent)" }}>{money(orphanDollars)}</span>
              </div>
              <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginTop: -4 }}>
                Billed on this ticket at the price shown, and still counted in the total. They can't be edited here — an admin would have to put the line back on {job.client}'s rate card. Remove one only if it shouldn't be charged.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {orphanLines.map((l, i) => (
                  <div key={`${l.kind}:${l.label}:${i}`} style={{ display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid color-mix(in srgb, var(--color-text) 8%, transparent)", paddingBottom: 6 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14 }}>{l.label} <TagX variant="outline">off card</TagX></div>
                      <div className="tabular" style={{ fontSize: 10, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{money(l.unit_rate)} / {l.unit}</div>
                    </div>
                    <span className="tabular" style={{ fontSize: 14 }}>{l.quantity}</span>
                    <span style={{ fontSize: 11, width: 22 }}>{l.unit}</span>
                    <span className="tabular" style={{ width: 62, textAlign: "right", fontSize: 14 }}>{money(lineTotal(l.quantity, l.unit_rate))}</span>
                    <button onClick={() => removeOrphan(i)} aria-label={`Remove ${l.label}`}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "color-mix(in srgb, var(--color-text) 50%, transparent)", fontSize: 16 }}>×</button>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* The figure the rep signs for is the one with tax on it; the
              subtotal alone read as "the total" and a technician quoting
              the screen was quoting a different number than the page the
              client signs. Same integer-cent GST as the invoice, at this
              client's own rate — an exempt client's ticket says so on the
              screen rather than being corrected by hand afterwards. */}
          <Blueprint style={{ padding: "12px 14px", background: "color-mix(in srgb, var(--color-accent) 8%, transparent)" }}>
            <div style={{ fontSize: 10, textTransform: "uppercase", color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
              {gstRate === 0 ? "Ticket total · GST exempt" : "Ticket total · including GST"}
            </div>
            <div className="tabular" style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 30 }}>{money(totalIncGst)}</div>
            <div className="tabular" style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
              {money(total)} before GST · {gstLabel(gstRate)}{gstRate === 0 ? "" : ` ${money(gst)}`}
            </div>
          </Blueprint>

          <div style={{ display: "flex", alignItems: "center", marginTop: 6 }}>
            <span style={{ fontSize: 13, fontFamily: "var(--font-heading)", fontWeight: 600 }}>Crew &amp; dose</span>
            <span className="tabular" style={{ marginLeft: "auto", fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
              billed {hours(billedStraight)} + {hours(billedOt)} OT{billedBlended > 0 ? <> + {hours(billedBlended)} blended</> : null}
            </span>
          </div>
          <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginTop: -4 }}>
            Hours here go to each person's timesheet. Solo hours are hours worked without an assistant — part of the regular figure, not on top of it. Dose is per person, in mR.
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {crew.map(c => (
              <div key={c.profileId} style={{ borderBottom: "1px solid color-mix(in srgb, var(--color-text) 8%, transparent)", paddingBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>{c.name}</span>
                  {c.role === "Helper" && <TagX variant="neutral">Helper</TagX>}
                  {c.isSub && <TagX variant="outline">Sub</TagX>}
                  {crew.length > 1 && (
                    <button onClick={() => { clearSaveError(); setCrew(p => p.filter(x => x.profileId !== c.profileId)); }}
                      aria-label={`Remove ${c.name}`}
                      style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", color: "color-mix(in srgb, var(--color-text) 50%, transparent)", fontSize: 16 }}>×</button>
                  )}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  <Field label="Reg hrs">
                    <NumField step="0.5" style={{ textAlign: "right" }} value={c.straight}
                      onChange={v => setCrewField(c.profileId, "straight", v)} />
                  </Field>
                  <Field label="OT hrs">
                    <NumField step="0.5" style={{ textAlign: "right" }} value={c.ot}
                      onChange={v => setCrewField(c.profileId, "ot", v)} />
                  </Field>
                  {/* Solo hours are hours worked without an assistant; a
                      helper is the assistant, so the two boxes are
                      meaningless on their row — and four fewer fields on
                      the longest form in the app. */}
                  {c.role !== "Helper" && (<>
                    <Field label="Solo reg hrs">
                      <NumField step="0.5" style={{ textAlign: "right" }} value={c.solo}
                        onChange={v => setCrewField(c.profileId, "solo", v)} />
                    </Field>
                    <Field label="Solo OT hrs">
                      <NumField step="0.5" style={{ textAlign: "right" }} value={c.soloOt}
                        onChange={v => setCrewField(c.profileId, "soloOt", v)} />
                    </Field>
                  </>)}
                  <Field label="Dose mR">
                    <NumField step="0.1" style={{ textAlign: "right" }} value={c.dose}
                      onChange={v => setCrewField(c.profileId, "dose", v)} />
                  </Field>
                  {c.isSub && (
                    <Field label="Mileage km">
                      <NumField step="1" style={{ textAlign: "right" }} value={c.mileage}
                        onChange={v => setCrewField(c.profileId, "mileage", v)} />
                    </Field>
                  )}
                </div>
              </div>
            ))}
          </div>

          {hoursMismatch && (
            <div className="tabular" style={{ fontSize: 11, color: "var(--color-accent-700)" }}>
              Crew totals {hours(assignedStraight)} + {hours(assignedOt)} OT — differs from what's billed. Fine for crew-rate work; worth a second look otherwise.
            </div>
          )}

          {availablePeople.length > 0 && (
            <SearchSelect style={{ flex: "none", maxWidth: "none" }} listId="ticket-crew-list"
              ariaLabel="Add someone to the crew" placeholder="Add to the crew — type a name…"
              search={searchCrew} optionKey={p => p.id} onPick={addCrewMember}
              renderOption={p => (
                <>
                  <div style={{ fontSize: 15 }}>{p.displayName}</div>
                  <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
                    {crewRoleFor(p) === "Helper" ? "Helper" : "Technician"}{p.id_code ? ` · ${p.id_code}` : ""}{p.is_subcontractor ? " · subcontractor" : ""}
                  </div>
                </>
              )} />
          )}

          {/* Job delays — standby, waiting on the line, a road ban. It prints
              on the client's field invoice under the crew, which is where the
              rep expects to read it when they are asked to sign for a day
              that ran long. Free text on purpose: the reason is never one of
              a fixed five. */}
          <div style={{ marginTop: 4 }}>
            <span style={{ fontSize: 13, fontFamily: "var(--font-heading)", fontWeight: 600 }}>Job delays</span>
            <textarea className="input" rows={2} value={delays}
              onChange={e => { clearSaveError(); setDelays(e.target.value); }}
              placeholder="Standby, waiting on the line, road ban… — leave blank if the day ran clean"
              style={{ marginTop: 6, resize: "vertical", fontFamily: "inherit" }} />
          </div>

          {/* Where the approval goes is this ticket's rep — the job's by
              default, and changeable right here: the rep on site today is
              not always the job's rep, and leaving the screen to fix that
              lost the entries. */}
          <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span>
              {(ticketClientContact || jobRecord.clientRep)
                ? `Approval link will go to ${ticketClientContact || jobRecord.clientRep}`
                : "No client rep on this ticket yet — add one below, or in the job record, before sending for approval."}
            </span>
            <button type="button" onClick={() => setEditingTo(v => !v)}
              style={{ background: "none", border: 0, padding: 0, font: "inherit", color: "var(--color-accent-700)", cursor: "pointer", textDecoration: "underline" }}>
              {editingTo ? "Done" : "Change"}
            </button>
          </div>
          {editingTo && (
            <Field label="Send the approval to">
              <input className="input" list="ticket-rep-options" value={ticketClientContact} autoFocus
                placeholder="Name <email@client.com>"
                onChange={e => setTicketClientContact(e.target.value)} />
              <datalist id="ticket-rep-options">
                {clientContacts.map(c => <option key={c.id} value={`${c.name}${c.email ? ` <${c.email}>` : ""}`}>{c.title || ""}</option>)}
              </datalist>
            </Field>
          )}
          <ErrorBox>{saveError}</ErrorBox>
          {unpriced.length > 0 && (
            <div style={{ border: "1px solid var(--color-accent-700)", padding: "10px 12px", fontSize: 12 }}>
              {unpriced.length === 1 ? `${unpriced[0].item.label} isn't priced on this client's rate card yet` : `${unpriced.length} lines aren't priced on this client's rate card yet`} — the ticket can be saved, but it can't go to the client until an admin prices {unpriced.length === 1 ? "it" : "them"} in Rate admin, or {unpriced.length === 1 ? "it comes" : "they come"} off the ticket.
            </div>
          )}
          {openJha && (
            <div style={{ border: "1px solid var(--color-accent)", padding: "10px 12px", fontSize: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ flex: "1 1 200px" }}>The JHA for this job is still open. Close it out on Job detail once you have the end readings off the DRDs.</span>
              {onOpenJob && <Btn variant="secondary" onClick={onOpenJob} style={{ minHeight: 36 }}>Go to Job detail</Btn>}
            </div>
          )}
          {/* Save draft and Email for approval are not here any more — they
              are in the bar pinned to the foot of the screen, below. This
              form is several phone-screens long, and they sat under the last
              crew row. Cancelling is not: it is the rare, destructive one,
              and it belongs at the end of the form rather than under a thumb
              on every screenful. */}
          {created && (
            <Btn variant="ghost" block style={{ minHeight: 44, marginTop: 4 }} disabled={saving || cancelling} onClick={cancelTicket}>
              {cancelling ? "Cancelling…" : "Cancel this ticket"}
            </Btn>
          )}
        </Blueprint>

        <div className="phone-explain">
          <p>Build the day's billing in a truck at dusk. Type the count straight in — every weld line and time/expense line is quantity × the client's on-file rate, pulled live from the published rate schedule.</p>
          <p>The crew block is what feeds Timesheets: each person's hours, their dose in mR, and — for subcontractors — their own mileage to lift into an invoice.</p>
        </div>
      </div>

      {/* The day's figure and the two ways out of this screen, on the glass
          however far down the welds someone has scrolled. Deliberately
          OUTSIDE the frame above: that frame is dimmed and made deaf to taps
          while a save is in flight, and this bar is where the save reports
          itself. The buttons carry the same labels and the same disabled
          rules they had at the bottom of the form. */}
      <div className="screen-foot">
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          <div className="tabular" style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 20, lineHeight: 1.15 }}>
            {money(totalIncGst)}
          </div>
          <div className="tabular" style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
            {gstRate === 0 ? "GST exempt" : "incl. GST"} · Draft{ticketId ? ` ${ticketId}` : ""}{provisionalNumber ? " · provisional" : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flex: "1 1 230px", justifyContent: "flex-end" }}>
          {/* No total gate on the draft, unlike sending: a draft with nothing
              on it yet is a legitimate placeholder for the day — it parks in
              the tracker and Open tickets until it's finished. Only asking
              the client to sign requires something to sign for. */}
          <Btn variant="secondary" style={{ minHeight: 48 }} onClick={() => save(false)} disabled={saving || !ticketId}>
            {saving && !savingSend ? savingLabel(savingMs, "Saving…") : "Save draft"}
          </Btn>
          <Btn variant="primary" style={{ minHeight: 48, fontSize: 15 }} onClick={() => save(true)} disabled={saving || !ticketId || total <= 0 || unpriced.length > 0}
            title={unpriced.length ? "An unpriced line is on this ticket — see the note on the ticket" : undefined}>
            {saving && savingSend ? savingLabel(savingMs, "Sending…") : emailFailed ? "Retry approval email" : "Email for approval"}
          </Btn>
        </div>
      </div>
    </div>
  );
}

