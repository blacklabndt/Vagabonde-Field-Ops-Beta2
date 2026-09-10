import { useState, useEffect, useRef } from "react";
import { STANDARD_RATE_LINES, money, gstRateOf, GST_RATE_DEFAULT } from "../data.js";
import { Db, DEFAULT_SCHEDULE } from "../db.js";
import { Toasts } from "../toastBus.js";
import { Blueprint, Btn, useDebounced, TagX, Field, Dialog, ErrorBox, Switch, NumField, useMissingFields, SearchSelect, TableScroll, Loading } from "./common.jsx";

// A GST rate as it comes out of a box somebody is typing in, clamped to what
// the column will hold. Not gstRateOf: that reads anything outside 0-100 as
// "no rate given" and answers 5, which is right for a row read back from the
// database and wrong here — a typed 101 would snap to 5% with nothing on
// screen to say it had. Clamped, the box shows the ceiling it hit.
const typedGstRate = value => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : GST_RATE_DEFAULT;
};

export function RateAdminScreen() {
  const [clients, setClients] = useState([]);
  const [selected, setSelected] = useState(null);
  const [schedule, setSchedule] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [lines, setLines] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // An answer rather than a failure — "there was nothing to restore" is the
  // button having done its job. It used to go in the red box, which carries
  // role="alert" and sent the admin looking for a problem.
  const [note, setNote] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [justPublished, setJustPublished] = useState(false);
  const [showNewClient, setShowNewClient] = useState(false);
  const [showNewOverride, setShowNewOverride] = useState(false);
  // Who follows the house card, and which schedule the house card is. null
  // until the read lands, so the header says nothing rather than flashing
  // "No client follows this card yet" at an admin whose clients all do.
  const [follow, setFollow] = useState(null);
  const [showFollowers, setShowFollowers] = useState(false);

  const loadClients = async () => {
    try {
      const cs = await Db.listClients();
      setClients(cs);
      setSelected(s => s || DEFAULT_SCHEDULE);
    } catch (e) { setError(e.message || "Couldn't load clients."); }
  };
  const loadOverrides = async () => {
    try { setOverrides(await Db.listOverrides()); }
    // "None on file." is what the table says over an empty list, so a failed
    // read reads as a job with no special price on it. These are prices.
    catch (e) { Toasts.show(`Couldn't read the job-level overrides: ${e.message || "the read failed."} The list below is not the whole story.`, "error"); }
  };
  // Who follows the house card is a courtesy, not the rates themselves — a
  // failed read leaves the count off the header rather than a red box over a
  // screen whose figures loaded fine.
  const loadFollow = async () => {
    try { setFollow(await Db.listScheduleFollowers()); }
    catch (e) { console.error("Couldn't load who follows the house card:", e.message); }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: the three reference reads happen once at open and take nothing from the render
  useEffect(() => { loadClients(); loadOverrides(); loadFollow(); }, []);

  // The `live` flag on the effect below only stops a *later* load starting —
  // once one is in flight its setState is unguarded, so switching clients
  // quickly could paint one client's rates under another's name. These are
  // the figures the client gets billed at, so the last request wins and the
  // rest are dropped.
  const loadSeq = useRef(0);
  const loadSchedule = async (keepError = false) => {
    if (!selected) return;
    const mine = ++loadSeq.current;
    setLoading(true);
    // A recovery reload from a failed save passes keepError so it doesn't
    // wipe the error banner the failing caller just set.
    if (!keepError) setError("");
    // The note is about the card on screen, so it goes when another one is
    // loaded — including the reload restoreStandard itself does.
    setNote("");
    try {
      const { schedule: s, lines: l } = await Db.getEditableSchedule(selected);
      // A card that follows the house card displays the house card — the
      // client's own dormant lines would read as what they're billed, and
      // they aren't while the switch is on.
      let shown = l;
      if (s.follows_default && selected !== DEFAULT_SCHEDULE) {
        const def = await Db.getEditableSchedule(DEFAULT_SCHEDULE);
        shown = def.lines;
      }
      if (mine !== loadSeq.current) return;
      setSchedule(s); setLines(shown);
    } catch (e) {
      if (mine !== loadSeq.current) return;
      setError(e.message || "Couldn't load rates.");
    }
    if (mine === loadSeq.current) setLoading(false);
  };
  // Switching schedules writes out anything still sitting in the debounce
  // first. Each pending write is keyed by rate-line id so it lands on the
  // right schedule either way, but flushing here means the grid that loads
  // next can't show a stale figure for a rate just typed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the chosen client changes; the flush is fixed and the load reads that client
  useEffect(() => {
    let live = true;
    (async () => {
      await persistRate.flush();
      if (live) loadSchedule();
    })();
    return () => { live = false; };
  }, [selected]);

  const isDefault = selected === DEFAULT_SCHEDULE;
  const client = clients.find(c => c.id === selected);
  const line = (kind, label) => lines.find(l => l.kind === kind && l.label === label);
  const customLines = kind => lines.filter(l => l.kind === kind);
  // The switch: this client's tickets price from the house card, and the
  // lines on screen are the house card's, read-only here.
  const following = !isDefault && !!(schedule && schedule.follows_default);
  // How many clients an edit to the house card reprices, and who they are.
  // The count comes from the ids, the names from the client list already
  // loaded — a name that can't be matched is left out of the list rather
  // than shown blank, and the count still says how many there are.
  const followerCount = follow ? follow.followerIds.length : 0;
  const followerNames = follow
    ? follow.followerIds
      .map(id => { const c = clients.find(x => x.id === id); return c ? c.name : ""; })
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
    : [];
  const followerPhrase = followerCount === 1 ? "1 client follows" : `${followerCount} clients follow`;
  // A group's rates render as plain figures when it can't be edited —
  // while its rows are being reordered, or while the card follows the
  // house card. They are money, and they go through money() like every
  // other figure in the app: a bare "125" beside "$125.00" in the rate
  // history read as two different numbers.
  const locked = group => following || reorderGroup === group;

  // ── Row order ──────────────────────────────────────────────────────────
  // Each group's rows follow rate_lines.position, dragged into place below.
  // Lines from before the position column existed have none and fall back to
  // the standard order, so nothing ever jumps around unprompted.
  const posOf = l => (l && l.position != null ? l.position : Infinity);
  const stdIdx = (kind, label) => {
    const i = STANDARD_RATE_LINES.findIndex(s => s.kind === kind && s.label === label);
    return i < 0 ? 900 : i;
  };
  const byPos = (a, b) => a.pos - b.pos || a.fallback - b.fallback || (a.label || "").localeCompare(b.label || "");

  const SIZE_KINDS = ["rt_film", "rt_cr", "rt_dr"];
  // One row per size — its three kind-lines move as one — with custom weld
  // lines interleaved wherever they were dragged.
  const sizeRows = (() => {
    const bySize = new Map();
    lines.filter(l => SIZE_KINDS.includes(l.kind)).forEach(l => {
      const seen = bySize.has(l.label) ? bySize.get(l.label) : Infinity;
      bySize.set(l.label, Math.min(seen, posOf(l)));
    });
    return [
      ...[...bySize.entries()].map(([label, pos]) => ({
        key: "size:" + label, label, pos, fallback: stdIdx("rt_film", label),
        ids: SIZE_KINDS.map(k => line(k, label)).filter(Boolean).map(l => l.id)
      })),
      ...customLines("custom_weld").map(c => ({
        key: "cw:" + c.id, label: c.label, pos: posOf(c), fallback: 950, line: c, ids: [c.id]
      }))
    ].sort(byPos);
  })();

  const rowsOf = (standardKind, customKind) => lines
    .filter(l => l.kind === standardKind || l.kind === customKind)
    .map(l => ({
      key: l.kind + ":" + l.id, label: l.label, pos: posOf(l),
      fallback: l.kind === standardKind ? stdIdx(standardKind, l.label) : 950,
      line: l, ids: [l.id]
    }))
    .sort(byPos);
  const methodRows = rowsOf("method", "custom_method");
  // Data-driven where it used to be a fixed five-label list — which is also
  // what finally puts the two Travel lines on screen: they have been on
  // every schedule since the travel migration, priced tickets through
  // rates.exp, and had no row here to edit them by.
  const expenseRows = rowsOf("expense", "custom_expense");

  // ── Reordering ─────────────────────────────────────────────────────────
  // One group at a time. The button under a group swaps its remove buttons
  // for up/down arrows; every move writes the whole group's positions
  // through the same saving/saved status the rates use.
  //
  // Arrows, after two rounds of drag-and-drop: the HTML5 drag API never
  // fires from a touch at all, and the pointer-events rewrite still lost
  // the gesture to page scrolling on a real phone. A tap on an arrow has no
  // gesture for the browser to argue about.
  const [reorderGroup, setReorderGroup] = useState("");

  const persistOrder = async rows => {
    const updates = rows.flatMap((r, i) => r.ids.map(id => ({ id, position: i })));
    setLines(p => p.map(l => {
      const u = updates.find(x => x.id === l.id);
      return u ? { ...l, position: u.position } : l;
    }));
    setJustPublished(false);
    beginWrite();
    try {
      await Db.reorderRateLines(updates);
      endWrite();
    } catch (e) {
      anyFailed.current = true;
      inFlight.current--;
      setSaveState("failed");
      setError(e.message || "Couldn't save the new order.");
      await loadSchedule(true);
    }
  };

  const moveRow = (rows, i, delta) => {
    const j = i + delta;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    persistOrder(next);
  };

  const MoveButtons = ({ rows, i }) => (
    <span style={{ display: "inline-flex", gap: 4 }}>
      <button className="row-x" aria-label="Move up" disabled={i === 0}
        style={i === 0 ? { opacity: .25, cursor: "default" } : undefined}
        onClick={() => moveRow(rows, i, -1)}>↑</button>
      <button className="row-x" aria-label="Move down" disabled={i === rows.length - 1}
        style={i === rows.length - 1 ? { opacity: .25, cursor: "default" } : undefined}
        onClick={() => moveRow(rows, i, 1)}>↓</button>
    </span>
  );

  const ReorderToggle = ({ group }) => (
    <Btn variant={reorderGroup === group ? "primary" : "secondary"} style={{ whiteSpace: "nowrap", marginTop: 6 }}
      onClick={() => setReorderGroup(g => (g === group ? "" : group))}>
      {reorderGroup === group ? "Done" : "Reorder"}
    </Btn>
  );

  // The follows-the-house-card switch. On: this client's tickets price from
  // Default rates, live, and the card below shows the house card read-only.
  // Off: their own card prices again — topped up from the house card first,
  // so a client coming off house rates starts from the figures they were
  // just on rather than a sheet of zeros. Their own edits are never
  // overwritten by the top-up.
  const [switching, setSwitching] = useState(false);
  const toggleFollow = async () => {
    if (!schedule || isDefault || switching) return;
    const name = client ? client.name : "this client";
    if (!following && !confirm(`Price ${name}'s new tickets from the house card? Their own rates stay saved and come back when the switch is turned off.`)) return;
    await persistRate.flush();
    setSwitching(true);
    setError("");
    try {
      if (following) {
        // Turning follow OFF: copy the house card in FIRST, then stop
        // following. Order matters — copyDefaultInto is idempotent (it only
        // fills missing lines), so if it fails the schedule stays safely
        // following the house card; if the copy lands but the flag flip
        // then fails, the copied lines lie dormant and the client still
        // follows. The old order (flip first) could leave the schedule not
        // following AND with no lines, which blocks every ticket for the
        // client at "No published rate schedule."
        Toasts.mute();
        try { await Db.copyDefaultInto(schedule.id); }
        finally { Toasts.unmute(); }
        await Db.setFollowsDefault(schedule.id, false);
      } else {
        await Db.setFollowsDefault(schedule.id, true);
      }
      await loadSchedule();
      // The switch just changed the count the house card's header shows.
      await loadFollow();
    } catch (e) {
      setError(e.message || "Couldn't change who prices this client's tickets.");
      // Reconcile the switch with what actually landed — without this the
      // toggle keeps showing its old position after a mid-flight failure.
      await loadSchedule(true).catch(() => {});
    }
    setSwitching(false);
  };

  // There is no save button on this screen because there is nothing to save:
  // every rate is written as you type. That is only reassuring if you can see
  // it happening, hence the status beside the heading — without it the screen
  // looks identical whether the last figure reached the database or not.
  const [saveState, setSaveState] = useState("idle");
  const inFlight = useRef(0);
  // Whether any write in the CURRENT in-flight cycle failed. The inFlight
  // counter alone can't tell "saved" from "one of these failed": a later
  // write reaching 0 would flip the indicator back to ✓ even though an
  // earlier one was rejected and its rate silently reverted. This latches a
  // failure for the cycle and clears only when a fresh cycle begins.
  const anyFailed = useRef(false);
  const beginWrite = () => {
    if (inFlight.current === 0) anyFailed.current = false;
    inFlight.current++;
    setSaveState("saving");
  };
  const endWrite = () => {
    if (--inFlight.current === 0) setSaveState(anyFailed.current ? "failed" : "saved");
  };

  // The grid updates immediately; the write waits until typing stops. Keyed
  // by line id, so editing two rates in quick succession doesn't cancel one.
  const persistRate = useDebounced(async (id, rate) => {
    beginWrite();
    try {
      await Db.setRateLine(id, rate);
      // Only settles once the last outstanding write lands, so editing several
      // rates quickly gets one confirmation at the end rather than a queue of
      // them, and never claims "saved" while others are still in flight — or
      // if any of them failed (see anyFailed).
      endWrite();
    } catch (e) {
      anyFailed.current = true;
      inFlight.current--;
      setSaveState("failed");
      setError(e.message || "Couldn't save that rate.");
      await loadSchedule(true);
    }
  }, 500);

  const setRate = (id, rate) => {
    setLines(p => p.map(l => l.id === id ? { ...l, rate } : l));
    setJustPublished(false);
    setSaveState("saving");
    persistRate(id, rate);
  };

  // ── The client's GST rate ──────────────────────────────────────────────
  // Not a rate-card line: it is the tax on whatever the card prices, so it
  // stays editable while the client follows the house card, and it applies
  // to their own card just the same. Zero is exempt — a band, a Crown
  // agency, a client billing through an exempt entity — and the office was
  // deleting the GST line off those tickets by hand every time.
  //
  // Written as you type through the same debounce and the same saving
  // indicator as a rate, so there is nothing extra to press and nothing to
  // forget. The database refuses the column to anyone but an Admin
  // (private.guard_client_update), and the refusal is what lands in the
  // error box.
  const clientGst = gstRateOf(client && client.gst_rate);
  const persistGst = useDebounced(async (id, rate) => {
    beginWrite();
    try {
      await Db.updateClientGst(id, rate);
      endWrite();
    } catch (e) {
      anyFailed.current = true;
      inFlight.current--;
      setSaveState("failed");
      setError(e.message || "Couldn't save that GST rate.");
      // Back to what the database actually holds, so the box never shows a
      // rate this client's tickets are not being billed at.
      await loadClients();
    }
  }, 500);
  const setClientGst = rate => {
    if (!client) return;
    // A tax rate above 100% is a typo, and the column's check constraint
    // would refuse it after the round trip. Caught here so the box shows
    // the figure that will be saved.
    const next = typedGstRate(rate);
    setClients(cs => cs.map(c => c.id === client.id ? { ...c, gst_rate: next } : c));
    setSaveState("saving");
    persistGst(client.id, next);
  };

  const addCustom = async (kind, label, unit) => {
    if (!label || !schedule) return;
    // New lines land at the end of their group's dragged order.
    const groupKinds = {
      custom_weld: [...SIZE_KINDS, "custom_weld"],
      custom_method: ["method", "custom_method"],
      custom_expense: ["expense", "custom_expense"]
    }[kind] || [kind];
    // A label already in this group, whatever kind carries it. The ticket
    // screen matches a saved line back to the card by its label alone, so
    // two rows reading the same reprice a saved ticket at the other one's
    // rate on the next save. The size row has always refused a duplicate.
    if (lines.some(l => groupKinds.includes(l.kind) && l.label === label)) {
      setError(`"${label}" is already on this schedule.`);
      return;
    }
    const ps = lines.filter(l => groupKinds.includes(l.kind) && l.position != null).map(l => l.position);
    try {
      const created = await Db.addRateLine({
        scheduleId: schedule.id, kind, label,
        unit: unit || (kind === "custom_expense" ? "ea" : "per weld"), rate: 0,
        position: ps.length ? Math.max(...ps) + 1 : null
      });
      setLines(p => [...p, created]);
      setJustPublished(false);
    } catch (e) { setError(e.message || "Couldn't add that line."); }
  };
  const removeCustom = async id => {
    const gone = lines.find(l => l.id === id);
    if (!gone) return;
    // The × is 24px away from a rate box people are typing in, and it takes
    // a priced line with it. "Restore removed lines" only puts the standard
    // ones back, at zero, so a Travel or a blended rate typed once is gone
    // with its price. The size row beside it has always asked.
    if (!confirm(`Remove ${gone.label}, priced at ${money(gone.rate)}? This can't be undone — "Restore removed lines" puts a standard line back unpriced, and a line added by hand does not come back at all.`)) return;
    setError("");
    try { await Db.deleteRateLine(id); setLines(p => p.filter(l => l.id !== id)); setJustPublished(false); }
    catch (e) { setError(e.message || "Couldn't remove that line."); }
  };

  // A new size is a real size: all three RT kinds at once, like the
  // standards. Adding one used to create a single film-only custom line
  // with no CR or DR cell to type into. (Lines added back then keep their
  // one cell — remove and re-add to get the full row.)
  const addSizeRow = async label => {
    if (!label || !schedule) return;
    const clean = label.trim();
    if (SIZE_KINDS.some(k => line(k, clean)) || customLines("custom_weld").some(c => c.label === clean)) {
      setError(`"${clean}" is already on this schedule.`);
      return;
    }
    const ps = lines.filter(l => (SIZE_KINDS.includes(l.kind) || l.kind === "custom_weld") && l.position != null).map(l => l.position);
    const position = ps.length ? Math.max(...ps) + 1 : null;
    try {
      const created = await Promise.all(SIZE_KINDS.map(kind =>
        Db.addRateLine({ scheduleId: schedule.id, kind, label: clean, unit: "weld", rate: 0, position })));
      setLines(p => [...p, ...created]);
      setJustPublished(false);
    } catch (e) {
      setError(e.message || "Couldn't add that size.");
      // One of the three inserts failing would leave a partial row on
      // screen; the reload shows what actually landed.
      await loadSchedule();
    }
  };

  // An RT size is three lines (film, CR, DR) shown as one row, so removing it
  // has to take all three — otherwise the row half-disappears.
  const removeSizeRow = async label => {
    const ids = ["rt_film", "rt_cr", "rt_dr"].map(k => line(k, label)).filter(Boolean).map(l => l.id);
    if (!ids.length) return;
    // One × takes three priced lines with it, which is not what a single
    // tap looks like. Restore brings a standard size back, but at zero —
    // the rates typed against it are gone.
    if (!confirm(`Delete the ${label} row? Its Film, CR and DR rates go with it. This can't be undone — "Restore removed lines" puts a standard size back unpriced.`)) return;
    try {
      await Promise.all(ids.map(id => Db.deleteRateLine(id)));
      setLines(p => p.filter(l => !ids.includes(l.id)));
      setJustPublished(false);
    } catch (e) { setError(e.message || "Couldn't remove that size."); }
  };

  // Anything removed can be brought back: re-adds every standard line this
  // schedule is missing, at zero, so a mis-click is not permanent.
  const [restoring, setRestoring] = useState(false);
  const restoreStandard = async () => {
    if (!schedule) return;
    await persistRate.flush();
    setRestoring(true);
    setError("");
    setNote("");
    const wanted = STANDARD_RATE_LINES;
    const missing = wanted.filter(w => !lines.some(l => l.kind === w.kind && l.label === w.label));
    try {
      // In parallel — twenty sequential round trips was a visible stall.
      await Promise.all(missing.map(m => Db.addRateLine({ scheduleId: schedule.id, ...m, rate: 0 })));
      await loadSchedule();
      if (!missing.length) setNote("Nothing to restore — every standard line is already on this schedule.");
    } catch (e) { setError(e.message || "Couldn't restore the standard lines."); }
    setRestoring(false);
  };

  const publish = async () => {
    if (!schedule) return;
    // Publishing is what every new ticket prices against, so it gets a
    // confirmation — it was a single click with no way back.
    const who = isDefault ? "the house default schedule" : `${client ? client.name : "this client"}'s schedule`;
    if (!confirm(`Publish ${who}? New tickets will price against these rates from now on.`)) return;
    await persistRate.flush();
    setPublishing(true);
    setError("");
    try {
      await Db.publishSchedule(schedule.id);
      setJustPublished(true);
      await loadSchedule();
    }
    catch (e) { setError(e.message || "Couldn't publish."); }
    setPublishing(false);
  };

  const removeOverride = async o => {
    if (o.locked) {
      setError("That override is locked — a ticket on the job has already been approved against it.");
      return;
    }
    if (!confirm(`Remove the ${o.description || "override"} on ${o.jobs ? o.jobs.job_number : "this job"}? Tickets already raised keep the rate they were priced at.`)) return;
    setError("");
    try { await Db.deleteOverride(o.id); setOverrides(p => p.filter(x => x.id !== o.id)); }
    catch (e) { setError(e.message || "Couldn't remove that override."); await loadOverrides(); }
  };

  const toggleOverride = async o => {
    setOverrides(p => p.map(x => x.id === o.id ? { ...x, active: !x.active } : x));
    try { await Db.toggleOverrideActive(o.id, !o.active); }
    catch (e) { setError(e.message || "Couldn't update that override — it may be locked."); await loadOverrides(); }
  };

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
        <div>
          {/* One name for one screen: the drawer, the README and this
              heading all say Rate admin now. "Billing rates" in the heading
              and "Rate admin" in the menu was a tech looking for a section
              that wasn't in the list. */}
          <div className="kicker">Admin · Rate admin</div>
          <h2 style={{ fontSize: 34, margin: "2px 0 0" }}>Rate admin</h2>
        </div>
        <span style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 50%, transparent)" }}>
          {following ? "Follows the house card"
            : justPublished ? "Published just now"
            : schedule && schedule.published_at ? "Published — edits go live as they save"
            : "Not yet published"}
        </span>
        {/* Two different things, deliberately worded apart: rates are saved
            the moment you type them, but they don't price anything until the
            schedule is published. */}
        <span aria-live="polite" style={{
          fontSize: 12, fontWeight: 600,
          color: saveState === "failed" ? "var(--color-accent-700)"
            : saveState === "saved" ? "var(--color-accent-700)"
            : "color-mix(in srgb, var(--color-text) 50%, transparent)"
        }}>
          {saveState === "saving" ? "Saving…"
            : saveState === "saved" ? "✓ Rates saved"
            : saveState === "failed" ? "Not saved — see above"
            : "Rates save as you type"}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <Btn variant="secondary" onClick={() => setShowHistory(true)} disabled={!schedule}>Rate history</Btn>
          {/* Publishing matters exactly once per card — it's the gate that
              lets tickets price from it at all; after that, every edit is
              live the moment it saves. So the button only exists while
              there is a gate to open: never-published, and not following
              the house card (a follower prices from the house card's own
              publish). Per Kyle — a permanent button implied a step that
              wasn't there. */}
          {schedule && !schedule.published_at && !following && (
            <Btn variant="primary" onClick={publish} disabled={publishing}>
              {publishing ? "Publishing…" : "Publish schedule"}
            </Btn>
          )}
        </div>
      </div>
      <ErrorBox>{error}</ErrorBox>
      {note && (
        <div role="status" style={{ fontSize: 13, marginBottom: 12, color: "color-mix(in srgb, var(--color-text) 70%, transparent)" }}>{note}</div>
      )}

      {/* Whose rates: one search box, with the house card as the first row
          of the list rather than a button beside it — per Kyle. Clients are
          already loaded in full, so the search runs here rather than going
          back to the server for a list it already has. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <SearchSelect
          // Narrower than the default so the box and "+ New client" stay on
          // one line down to a small laptop; the search box is the thing
          // that can afford to give up the width.
          style={{ flex: "1 1 200px", maxWidth: 380 }}
          listId="rate-client-list"
          ariaLabel="Search clients"
          placeholder={isDefault ? "Default rates — search to change…"
            : client ? `${client.name} — search to change…` : "Search clients…"}
          search={text => {
            const q = text.trim().toLowerCase();
            const matched = q
              ? clients.filter(c => (c.name || "").toLowerCase().includes(q))
              : clients;
            // The house card leads the list whenever it fits what was typed
            // — an empty box always shows it first.
            const withDefault = !q || "default rates house card".includes(q) || q.includes("default")
              ? [{ id: DEFAULT_SCHEDULE, isDefaultCard: true }, ...matched]
              : matched;
            // Sliced, but the true count goes back so the list can say how
            // many it is not showing.
            return { rows: withDefault.slice(0, 25), total: withDefault.length };
          }}
          optionKey={c => c.id}
          onPick={c => setSelected(c.id)}
          onError={setError}
          renderOption={c => {
            if (c.isDefaultCard) {
              return (
                <>
                  <div style={{ fontSize: 15 }}>Default rates</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                    <TagX variant="accent">House rate card</TagX>
                    <span>What a new client starts on</span>
                  </div>
                </>
              );
            }
            const n = overrides.filter(o => o.jobs && o.jobs.client_id === c.id).length;
            return (
              <>
                <div style={{ fontSize: 15 }}>{c.name}</div>
                {n > 0 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                    <TagX variant="outline">{n} override{n > 1 ? "s" : ""}</TagX>
                  </div>
                )}
              </>
            );
          }}
        />
        <Btn variant="secondary" style={{ whiteSpace: "nowrap" }}
          onClick={() => setShowNewClient(true)}>+ New client</Btn>
      </div>

      <div>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {loading || (!client && !isDefault) ? (
            <Blueprint style={{ padding: 20 }}><Loading /></Blueprint>
          ) : (
            <Blueprint style={{ padding: "18px 20px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
                <h4 style={{ margin: 0, fontSize: 19 }}>{isDefault ? "Default rates" : client.name}</h4>
                {isDefault && <TagX variant="accent">House rate card</TagX>}
                {!isDefault && client.effective_from && <span style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>effective {client.effective_from}</span>}
                {!isDefault && (
                  <div style={{ marginLeft: "auto", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, opacity: switching ? 0.6 : 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: following ? "var(--color-accent-700)" : "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                        {switching ? "Saving…" : "Follows the house card"}
                      </span>
                      <Switch on={following} onClick={toggleFollow} label="Follows the house card" />
                    </div>
                    {/* Beside the switch that decides it: where this client's
                        prices actually come from, and how much company they
                        keep — one edit to the house card moves all of them. */}
                    {following && follow && (
                      <span style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                        Prices come from the house card — {followerPhrase} it
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginBottom: 4 }}>
                {isDefault
                  ? "The house rate card. What a new client starts on, and what every client with the switch on prices from — edit a rate here and their next tickets follow it."
                  : following
                    ? "This client's tickets price from the house card, live — the rates below are Default rates, read-only here. Turn the switch off to give them their own card; it starts from these figures."
                    : "This client has their own card. Turning the switch on prices their tickets from the house card instead; nothing here is lost, and it comes back when the switch is turned off."}
              </div>

              {/* Who a rate typed on this card is about to reprice. The names
                  are on hover for a quick look and in the list for a proper
                  one — "raise the 6in film rate" is a different decision at
                  one client than at eleven. */}
              {isDefault && follow && (
                <div style={{ fontSize: 12, marginBottom: 4 }}>
                  {followerCount === 0 || !followerNames.length ? (
                    <span style={{ color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
                      {followerCount === 0
                        ? "No client follows this card yet"
                        : `${followerPhrase} this card`}
                    </span>
                  ) : (
                    <>
                      <button type="button"
                        title={followerNames.join(", ")}
                        aria-expanded={showFollowers}
                        aria-controls="house-card-followers"
                        onClick={() => setShowFollowers(v => !v)}
                        style={{
                          background: "none", border: 0, padding: 0, font: "inherit",
                          color: "var(--color-accent-700)", fontWeight: 600,
                          textDecoration: "underline", cursor: "pointer"
                        }}>
                        {followerPhrase} this card
                      </button>
                      <span style={{ color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
                        {" "}— an edit here reprices {followerCount === 1 ? "them" : "all of them"}
                      </span>
                      {showFollowers && (
                        <ul id="house-card-followers" style={{ margin: "6px 0 0", paddingLeft: 18, color: "color-mix(in srgb, var(--color-text) 70%, transparent)" }}>
                          {followerNames.map(n => <li key={n}>{n}</li>)}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              )}



              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", margin: "14px 0 6px" }}>RT rate per weld by size</div>
              <div>
              {/* Wrapped like every other table — bare, this one stretched a
                  phone's viewport to 397px and the whole screen panned. */}
              <TableScroll><table className="table">
                <thead><tr><th>Size</th><th style={{ width: 92 }}>Film</th><th style={{ width: 92 }}>CR</th><th style={{ width: 92 }}>DR</th><th style={{ width: 44 }}></th></tr></thead>
                <tbody>
                  {sizeRows.map((r, i) => (
                    <tr key={r.key}>
                      <td>{r.label}</td>
                      {r.line ? (
                        <>
                          <td>{locked("sizes")
                            ? <span className="tabular">{money(r.line.rate)}</span>
                            : <RateInput value={r.line.rate} onChange={v => setRate(r.line.id, v)} />}</td>
                          <td></td>
                          <td></td>
                        </>
                      ) : (
                        SIZE_KINDS.map(kind => {
                          const l = line(kind, r.label);
                          return <td key={kind}>{l && (locked("sizes")
                            ? <span className="tabular">{money(l.rate)}</span>
                            : <RateInput value={l.rate} onChange={v => setRate(l.id, v)} />)}</td>;
                        })
                      )}
                      <td style={{ textAlign: "right" }}>
                        {following ? null
                          : reorderGroup === "sizes"
                          ? <MoveButtons rows={sizeRows} i={i} />
                          : (r.ids.length > 0 && (
                            <button className="row-x btn-danger" aria-label={`Remove ${r.label}`}
                              onClick={() => r.line ? removeCustom(r.line.id) : removeSizeRow(r.label)}>×</button>
                          ))}
                      </td>
                    </tr>
                  ))}
                  {!isDefault && <tr><td colSpan={5} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Minimum call-out — {client.minimum_callout || "not set"}</td></tr>}
                  {!isDefault && (
                    <tr><td colSpan={5} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span>GST on their tickets</span>
                        <NumField value={clientGst} step="0.01" onChange={setClientGst}
                          aria-label={`GST rate for ${client.name}, in percent`}
                          style={{ width: 78 }} />
                        <span>%</span>
                        <span>{clientGst === 0
                          ? "Exempt — their tickets and invoices carry no GST."
                          : "0 = exempt. It applies to every ticket priced from now on."}</span>
                      </span>
                    </td></tr>
                  )}
                </tbody>
              </table></TableScroll>
              {!following && (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}><AddLineBox onAdd={addSizeRow} placeholder='e.g. 16" NPS' /></div>
                  <ReorderToggle group="sizes" />
                </div>
              )}

              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", margin: "16px 0 6px" }}>Other methods — rate per weld</div>
              <TableScroll><table className="table">
                <thead><tr><th>Method</th><th style={{ width: 92 }}>Rate</th><th style={{ width: 44 }}></th></tr></thead>
                <tbody>
                  {methodRows.map((r, i) => (
                    <tr key={r.key}>
                      <td>{r.label}</td>
                      <td>{locked("methods")
                        ? <span className="tabular">{money(r.line.rate)}</span>
                        : <RateInput value={r.line.rate} onChange={v => setRate(r.line.id, v)} />}</td>
                      <td style={{ textAlign: "right" }}>
                        {following ? null
                          : reorderGroup === "methods"
                          ? <MoveButtons rows={methodRows} i={i} />
                          : <button className="row-x btn-danger" onClick={() => removeCustom(r.line.id)} aria-label={`Remove ${r.label}`}>×</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></TableScroll>
              {!following && (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}><AddLineBox onAdd={label => addCustom("custom_method", label)} placeholder="e.g. PAUT" /></div>
                  <ReorderToggle group="methods" />
                </div>
              )}

              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", margin: "16px 0 6px" }}>Time &amp; expense</div>
              <TableScroll><table className="table">
                <thead><tr><th>Item</th><th style={{ width: 92 }}>Rate</th><th style={{ width: 44 }}></th></tr></thead>
                <tbody>
                  {expenseRows.map((r, i) => (
                    <tr key={r.key}>
                      <td>{r.label}<div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{r.line.unit}</div></td>
                      <td>{locked("expense")
                        ? <span className="tabular">{money(r.line.rate)}</span>
                        : <RateInput value={r.line.rate} onChange={v => setRate(r.line.id, v)} />}</td>
                      <td style={{ textAlign: "right" }}>
                        {following ? null
                          : reorderGroup === "expense"
                          ? <MoveButtons rows={expenseRows} i={i} />
                          : <button className="row-x btn-danger" onClick={() => removeCustom(r.line.id)} aria-label={`Remove ${r.label}`}>×</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></TableScroll>
              {!following && (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}><AddLineBox onAdd={(label, unit) => addCustom("custom_expense", label, unit)} units={["h", "ea", "days", "km"]} placeholder="e.g. Blended rate" /></div>
                  <ReorderToggle group="expense" />
                </div>
              )}
              </div>


              {!following && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 18, paddingTop: 12, borderTop: "1px solid var(--color-divider)" }}>
                  <span style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                    Removing a line takes it off this schedule only — tickets already raised keep the rate they were priced at.
                  </span>
                  {/* Named for what it does. "Set standard lines" read like a
                      save, and it is the opposite: it puts missing standard
                      lines back at zero, ready to be priced. */}
                  <Btn variant="secondary" style={{ marginLeft: "auto", padding: "4px 12px", whiteSpace: "nowrap" }}
                    onClick={restoreStandard} disabled={restoring}
                    title="Puts back any standard line removed from this schedule, at zero. Rates already entered are untouched.">
                    {restoring ? "Restoring…" : "Restore removed lines"}
                  </Btn>
                </div>
              )}
            </Blueprint>
          )}

          <Blueprint style={{ padding: "18px 20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <h4 style={{ margin: 0, fontSize: 19 }}>Job-level overrides</h4>
              <Btn variant="secondary" style={{ marginLeft: "auto", padding: "4px 12px" }}
                onClick={() => setShowNewOverride(true)}>+ New override</Btn>
            </div>
            <TableScroll><table className="table">
              <thead><tr><th>Job</th><th>Scope</th><th>Basis</th><th>Bid reference</th><th style={{ width: 90 }}></th></tr></thead>
              <tbody>
                {overrides.length === 0 && <tr><td colSpan={5} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>None on file.</td></tr>}
                {overrides.map(o => (
                  <tr key={o.id}>
                    <td style={{ fontFamily: "var(--font-heading)", fontWeight: 600 }}>{o.jobs ? o.jobs.job_number : ""}</td>
                    <td>{o.description}</td>
                    <td>{o.basis}<div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{o.bid_ref}</div></td>
                    <td>{o.locked && <TagX variant="outline">Locked</TagX>}</td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
                        <Switch on={o.active} label={`Override for ${o.jobs ? o.jobs.job_number : "job"}`}
                          onClick={() => !o.locked && toggleOverride(o)} />
                        {!o.locked && (
                          <button className="row-x btn-danger" aria-label={`Remove override for ${o.jobs ? o.jobs.job_number : "job"}`}
                            onClick={() => removeOverride(o)}>×</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></TableScroll>
            <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginTop: 10 }}>Overrides lock automatically once a ticket on the job is client-approved.</div>
          </Blueprint>
        </div>
      </div>

      {showNewOverride && (
        <NewOverrideDialog
          onClose={() => setShowNewOverride(false)}
          onCreated={created => {
            setShowNewOverride(false);
            setOverrides(p => [...p, created]);
          }}
        />
      )}

      {showNewClient && (
        <NewClientDialog
          // The list is already loaded for the search box above, and it is
          // what "Copy rates from" chooses out of.
          clients={clients}
          onClose={() => setShowNewClient(false)}
          onCreated={async created => {
            setShowNewClient(false);
            await loadClients();
            // A new client starts on the house card, so the header's count
            // has just gone up by one — unless their rates were copied from
            // another client, which takes them off it again; either way the
            // count is read back rather than worked out here.
            loadFollow();
            setSelected(created.id);
          }}
        />
      )}

      {showHistory && schedule && (
        <RateHistoryDialog
          scheduleId={schedule.id}
          // A follower's own history is empty by definition — the house card
          // is what repriced them — so the dialog is given the house card to
          // read as well. Only while the switch is on: a client back on their
          // own card is asking about their own figures.
          houseScheduleId={following && follow ? follow.defaultScheduleId : null}
          onClose={() => setShowHistory(false)}
        />
      )}

    </div>
  );
}

// The money boxes on this screen: NumField's floor at zero, in cents, at the
// width the rate columns are laid out for.
function RateInput({ value, onChange }) {
  return <NumField style={{ width: 78 }} step="0.01" value={value} onChange={onChange} />;
}

// Every rate change ever made to this client's schedule, newest first —
// backed by the trigger that logs old/new value + who + when on every
// rate_lines update (see migrations).
function RateHistoryDialog({ scheduleId, houseScheduleId, onClose }) {
  const [rows, setRows] = useState([]);
  const [houseRows, setHouseRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // The house card is passed only for a client that follows it, and the
  // dialog was answering "why did our prices go up?" with an empty list —
  // the change is on the house card, not on theirs.
  const alsoHouse = !!houseScheduleId && houseScheduleId !== scheduleId;

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([
      Db.getRateLineHistory(scheduleId),
      alsoHouse ? Db.getRateLineHistory(houseScheduleId) : Promise.resolve([])
    ])
      .then(([own, house]) => { if (live) { setRows(own); setHouseRows(house); } })
      .catch(e => { if (live) setError(e.message || "Couldn't load rate history."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [scheduleId, houseScheduleId, alsoHouse]);

  return (
    <Dialog title="Rate history" maxWidth={620} onClose={onClose} actions={<Btn variant="secondary" onClick={onClose}>Close</Btn>}>
      <ErrorBox>{error}</ErrorBox>
      {loading && <Loading />}
      {!loading && !alsoHouse && !rows.length && (
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
          No rate changes recorded yet for this schedule.
        </div>
      )}
      {!loading && !alsoHouse && rows.length > 0 && <RateHistoryRows rows={rows} />}
      {!loading && alsoHouse && (
        <div style={{ display: "grid", gap: 14, maxHeight: 460, overflowY: "auto" }}>
          <div>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", marginBottom: 6 }}>
              This client's own card
            </div>
            {rows.length ? <RateHistoryRows rows={rows} scroll={false} /> : (
              <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
                Nothing has changed on this client's own card — the house card prices their tickets.
              </div>
            )}
          </div>
          <div>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", marginBottom: 6 }}>
              Changes to the house card, which this client follows
            </div>
            {houseRows.length ? <RateHistoryRows rows={houseRows} scroll={false} /> : (
              <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
                No rate changes recorded yet on the house card.
              </div>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

// One list of rate changes. Its own scroller when it is the whole dialog;
// inside the two headings it isn't, or the dialog would carry a scrollbar
// within a scrollbar.
function RateHistoryRows({ rows, scroll = true }) {
  return (
    <div style={{ display: "grid", gap: 10, ...(scroll ? { maxHeight: 420, overflowY: "auto" } : {}) }}>
      {rows.map(h => (
        <div key={h.id} style={{ borderBottom: "1px solid var(--color-neutral-300)", paddingBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 14 }}>
            <span style={{ fontWeight: 600 }}>{h.label}</span>
            {/* money(), like every other figure in the app: this dialog
                is where an argument about a price gets settled, and it
                was the one screen printing $1250.00. */}
            <span className="tabular">{money(h.oldRate)} → {money(h.newRate)}</span>
          </div>
          <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            {h.changedBy} · {new Date(h.changedAt).toLocaleString("en-CA", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })}
          </div>
        </div>
      ))}
    </div>
  );
}

// A bid won at rates other than the client's schedule. Recorded against the
// job rather than the client, so the schedule stays the standing agreement
// and the exception is visible next to the job it belongs to.
function NewOverrideDialog({ onClose, onCreated }) {
  // The job the override is filed against, kept whole so the box can say
  // which one is chosen; only its dbId goes to the server.
  const [job, setJob] = useState(null);
  const [form, setForm] = useState({ jobId: "", description: "", basis: "Bid rate", bidRef: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const miss = useMissingFields();
  const set = (k, v) => { miss.fixed(k); setForm(p => ({ ...p, [k]: v })); };
  const pickJob = j => { setJob(j); set("jobId", j.dbId); };

  const submit = async () => {
    if (!form.jobId) { miss.flag("jobId"); setError("Pick the job this override applies to."); return; }
    if (!form.description.trim()) { miss.flag("description"); setError("Say what the override covers — it is what the billing tracker shows."); return; }
    miss.clear();
    setSaving(true);
    setError("");
    try {
      const created = await Db.createOverride({
        jobId: form.jobId, description: form.description.trim(),
        basis: form.basis, bidRef: form.bidRef.trim()
      });
      onCreated(created);
    } catch (e) {
      setSaving(false);
      setError(e.message || "Couldn't add that override.");
    }
  };

  return (
    <Dialog title="New job override" maxWidth={460} onClose={onClose}
      actions={<><Btn variant="secondary" onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={submit} disabled={saving}>{saving ? "Adding…" : "Add override"}</Btn></>}>
      <ErrorBox>{error}</ErrorBox>
      {/* Searched, not listed: every job ever raised is thousands of rows
          and megabytes to drop into a menu, and an override is filed
          against one job whose number is already known. An empty box shows
          the jobs with the most recent activity, so the one being priced
          today is usually the first row. */}
      <Field label="Job" missing={miss.is("jobId")}>
        <SearchSelect
          style={{ maxWidth: "none" }}
          listId="override-job-list"
          ariaLabel="Search jobs"
          placeholder={job ? `${job.id} — search to change…` : "Search by job #, project or site…"}
          search={text => Db.searchJobs({ page: 0, pageSize: 25, search: text, searchField: "any" })}
          optionKey={j => j.dbId}
          onPick={pickJob}
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
      <Field label="What it covers" missing={miss.is("description")}>
        <input {...miss.props("description")} autoFocus value={form.description} onChange={e => set("description", e.target.value)}
          placeholder='All 6" and 8" welds' />
      </Field>
      <Field label="Basis">
        <select className="input" value={form.basis} onChange={e => set("basis", e.target.value)}>
          <option>Bid rate</option>
          <option>Lump sum</option>
          <option>Day rate</option>
          <option>Discount</option>
        </select>
      </Field>
      <Field label="Bid reference">
        <input className="input" value={form.bidRef} onChange={e => set("bidRef", e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submit(); }} placeholder="Q-2026-114" />
      </Field>
    </Dialog>
  );
}

function NewClientDialog({ clients, onClose, onCreated }) {
  // The GST rate starts at the ordinary 5%: an exempt client is the rare
  // one, and a client added with 0 by accident is undercharged tax on every
  // ticket until somebody notices.
  const [form, setForm] = useState({ name: "", minimumCallout: "", gstRate: GST_RATE_DEFAULT });
  // Whose card to start this one from. "" is the house card, which is what a
  // new client has always started on and stays the default.
  const [copyFrom, setCopyFrom] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // The client, once the insert has landed. A copy that fails afterwards must
  // not send the admin back to a button that would try to add them a second
  // time — the name is on file by then and the app would refuse it as a
  // duplicate. Held here, pressing again retries the copy alone.
  const [made, setMade] = useState(null);
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  // A copy, not a follow, and the difference is the point: following means
  // this client's prices move whenever the card they follow moves, which is
  // right for the house card and wrong for another client — nobody means "and
  // reprice them again next time Peace River negotiates". So the lines are
  // taken once, as figures of their own, and the switch goes off. From then on
  // the two cards are strangers.
  //
  // A source that is itself following the house card has no live figures of
  // its own — the house card is what prices its tickets — so the house card is
  // what gets copied, which is exactly what the source's own screen shows.
  const copyCardInto = async newClientId => {
    const [source, mine] = await Promise.all([
      Db.getEditableSchedule(copyFrom),
      Db.getEditableSchedule(newClientId)
    ]);
    // Order as in the follows-the-house-card switch, for the same reason: the
    // copy first, the flag after. If the copy fails the client is still
    // following the house card and priced, rather than left on a card with
    // nothing on it and every ticket refused.
    Toasts.mute();
    try { await Db.copyDefaultInto(mine.schedule.id, source.schedule.follows_default ? null : source.schedule.id); }
    finally { Toasts.unmute(); }
    await Db.setFollowsDefault(mine.schedule.id, false);
  };

  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      let client = made;
      if (!client) {
        client = await Db.createClient(form);
        setMade(client);
      }
      if (copyFrom) await copyCardInto(client.id);
      await onCreated(client);
    } catch (e) {
      setSaving(false);
      setError(e.message || "Couldn't add that client.");
    }
  };

  // Giving up after the client was added is not a cancel: they are on file,
  // on the house card, and the screen behind this should open their card
  // rather than pretend nothing happened.
  const leave = () => { if (made) onCreated(made); else onClose(); };

  return (
    <Dialog title="New client" maxWidth={460} onClose={leave}
      actions={<><Btn variant="secondary" onClick={leave}>{made ? "Leave them on the house card" : "Cancel"}</Btn><Btn variant="primary" onClick={submit} disabled={saving}>{saving ? (made ? "Copying…" : "Adding…") : made ? "Copy the rates again" : "Add client"}</Btn></>}>
      <ErrorBox>{error}</ErrorBox>
      {/* The client is on file and only the rates are outstanding, so the
          boxes that made them are done with. */}
      {made && (
        <div style={{ fontSize: 13, marginBottom: 8 }}>
          <strong>{made.name} is on file</strong> and priced from the house card. Only the copy of the other
          client&rsquo;s rates is left to do.
        </div>
      )}
      <Field label="Client name">
        <input className="input" autoFocus value={form.name} onChange={e => set("name", e.target.value)} disabled={!!made}
          onKeyDown={e => { if (e.key === "Enter") submit(); }} placeholder="Peace River Midstream" />
      </Field>
      <Field label="Minimum call-out">
        <input className="input" value={form.minimumCallout} onChange={e => set("minimumCallout", e.target.value)} disabled={!!made} placeholder="4 h + mobilization" />
      </Field>
      {/* Almost every client pays 5%; an exempt one — a band, a Crown agency
          — is entered as 0 here rather than having the GST line deleted off
          each of their tickets afterwards. */}
      <Field label="GST %">
        <NumField value={form.gstRate} step="0.01" style={{ width: 78 }} disabled={!!made}
          onChange={v => set("gstRate", typedGstRate(v))} />
      </Field>
      <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginTop: -6, marginBottom: 8 }}>
        0 = exempt. Almost every client pays 5%.
      </div>
      {/* Most new clients are priced like a client already on file rather than
          off the house card, and the way to do that was to add them, turn the
          switch off, then retype sixty figures. */}
      <Field label="Copy rates from">
        <select className="input" value={copyFrom} onChange={e => setCopyFrom(e.target.value)} disabled={saving}>
          <option value="">The house card (Default rates)</option>
          {(clients || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
        {copyFrom
          ? "Their card is copied across as figures of this client's own and the two are then unconnected — a later change to that client's rates does not move these. Every rate can be edited afterwards."
          : "The client starts on the house card — their tickets price at Default rates until the switch on their rate card is turned off to give them their own."}
      </div>
    </Dialog>
  );
}

// `units`, when given, adds a unit picker beside the label — a custom
// expense can be hourly (a blended rate standing in for straight + OT),
// per each, per day or per km, and the unit decides how the ticket screen
// steps it. Groups whose unit is fixed (per-weld lines) just omit it.
function AddLineBox({ onAdd, placeholder, units }) {
  const [v, setV] = useState("");
  const [unit, setUnit] = useState(units ? units[0] : "");
  const add = () => { const t = v.trim(); if (!t) return; onAdd(t, unit || undefined); setV(""); };
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
      <input className="input" style={{ flex: 1, minWidth: 0 }} placeholder={placeholder} value={v}
        aria-label={placeholder}
        onChange={e => setV(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
      {units && (
        <select className="input" value={unit} aria-label="Unit" style={{ width: 76, flex: "none" }}
          onChange={e => setUnit(e.target.value)}>
          {units.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
      )}
      <Btn variant="secondary" onClick={add} disabled={!v.trim()}>Add</Btn>
    </div>
  );
}

