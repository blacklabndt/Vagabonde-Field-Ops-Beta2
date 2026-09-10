import React, { useState, useEffect, useMemo, useRef, Suspense, lazy } from "react";
import { sbClient, forgetStoredSession } from "./config.js";
import { TABS, CONTEXT_TABS, EMPTY_JOB_RECORD, Store } from "./data.js";
import { Db, forgetChatMediaUrls } from "./db.js";
import { tabList, Blueprint, Btn, ErrorBox, ErrorBoundary, TagX, Toast, Loading, Switch } from "./components/common.jsx";
import { Toasts } from "./toastBus.js";
import { forgetHeldDrafts } from "./chatDrafts.js";
import { forgetDosimetryAsked } from "./dosimetryPrompt.js";
import { QueueBadge, QueueDialog } from "./components/queuePanel.jsx";
import { FeatureRequestDialog } from "./components/featureRequest.jsx";
import { HelpTip } from "./components/helpTip.jsx";
import { helpFor } from "./help.js";
import { tipDue, noteTipSeen, stopTips, tipRun } from "./helpTips.js";
import { OfflineQueue } from "./offlineQueue.js";
import { ticketFingerprint, replacedNewerWork } from "./ticketFingerprint.js";
import { overwroteKey } from "./overwriteNote.js";
import { OfflineCache } from "./offlineCache.js";
import { SwUpdates } from "./swUpdates.js";
import { restoreSession, IDENTITY_KEY } from "./session.js";
import { parseRoute, formatRoute, landingRoute, historyStep } from "./route.js";

// How long a device may keep opening the app as its last signed-in person
// with no signal to check — the "12 h" the sign-in screen promises.
const IDENTITY_TTL_MS = 12 * 60 * 60 * 1000;
import { Recovery } from "./recovery.js";
import { SignInScreen, SetNewPasswordScreen } from "./components/auth.jsx";
import { HomeScreen } from "./components/home.jsx";
import { JobDetailScreen } from "./components/jobDetail.jsx";
import { JhaBuilderScreen } from "./components/jhaMobile.jsx";
import { UploadMobileScreen } from "./components/uploadMobile.jsx";
import { TicketMobileScreen } from "./components/ticketMobile.jsx";
import { OpenTicketsScreen } from "./components/openTickets.jsx";

// The core field flow (Home, Job detail, JHA/upload/ticket) loads eagerly —
// it's what every session opens with. The office-facing screens below are
// visited far less often per session, so they're split into their own
// chunks: a technician who never opens Rate admin or Users & access no
// longer downloads that code on first load, which matters most on a phone
// on field data.
const FilesScreen = lazy(() => import("./components/files.jsx").then(m => ({ default: m.FilesScreen })));
const ContactsScreen = lazy(() => import("./components/contacts.jsx").then(m => ({ default: m.ContactsScreen })));
const EquipmentScreen = lazy(() => import("./components/equipment.jsx").then(m => ({ default: m.EquipmentScreen })));
const RateAdminScreen = lazy(() => import("./components/rateAdmin.jsx").then(m => ({ default: m.RateAdminScreen })));
const BillingTrackerScreen = lazy(() => import("./components/billingTracker.jsx").then(m => ({ default: m.BillingTrackerScreen })));
const TimesheetsScreen = lazy(() => import("./components/timesheets.jsx").then(m => ({ default: m.TimesheetsScreen })));
const UsersAccessScreen = lazy(() => import("./components/usersAccess.jsx").then(m => ({ default: m.UsersAccessScreen })));
const TeamChatScreen = lazy(() => import("./components/teamChat.jsx").then(m => ({ default: m.TeamChatScreen })));
const AdminSetupScreen = lazy(() => import("./components/adminSetup.jsx").then(m => ({ default: m.AdminSetupScreen })));
// Not screens. Each its own chunk so a technician on field data never
// downloads a game they have not gone looking for — the first lives behind
// the drawer-footer name, the second behind the top-bar one.
const Flappy880 = lazy(() => import("./components/flappy880.jsx").then(m => ({ default: m.Flappy880 })));

const ScreenFallback = () => (
  <div className="page"><Loading /></div>
);

// The address this load arrived on, read once at import. It has to be read
// here and not in an effect: the ?goto= handler below rewrites the URL to the
// bare path as soon as the app mounts, and the recovery gate rewrites it
// again, so by the time a component could look there may be nothing left to
// find. A recovery hash is not a route and parseRoute refuses it — see
// route.js for the one character that separates the two.
const LANDING_ROUTE = typeof window !== "undefined" ? landingRoute(parseRoute(window.location.hash)) : null;

// Two letters for the top bar on a phone, where the full name is hidden. One
// word gives one letter rather than a doubled one, because "Kyle" as "KK" is
// a different person to anyone reading quickly.
function initialsOf(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (parts[0][0] + last).toUpperCase();
}

// Focus, Tab and the page's scroll while a panel covers the screen. Dialog
// (common.jsx) has done all three properly for a long while and the drawer
// did none of them: focus stayed on the hamburger behind it, Tab walked
// straight into the page underneath, and the page scrolled under the open
// menu. This is the same treatment written out inline, because the drawer is
// not a Dialog — it slides, it has no title, and it stays mounted through its
// own exit animation.
function useModalPanel(open, ref) {
  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () => Array.from(ref.current
      ? ref.current.querySelectorAll('input, select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])')
      : []).filter(el => !el.disabled && el.offsetParent !== null);
    const first = focusable()[0];
    if (first) first.focus();
    const onKey = e => {
      if (e.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const edge = e.shiftKey ? items[0] : items[items.length - 1];
      if (document.activeElement === edge) {
        e.preventDefault();
        (e.shiftKey ? items[items.length - 1] : items[0]).focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      // Back to the control that opened it, not to the top of the document —
      // otherwise closing the menu loses a keyboard user their place.
      if (opener && opener.focus) opener.focus();
    };
  }, [open]);
}

// The page entrance, with the transform taken back off afterwards. The
// class must not linger: an animated transform makes this wrapper the
// containing block for the fixed-position dialogs rendered inside, and
// Chromium keeps that capture for as long as a filled animation exists —
// which once centred every popup against the page instead of the
// viewport. Dropping the class on animationend means the transform
// exists only for the entrance's quarter-second, when no dialog can be
// open yet, and re-renders afterwards never restart it.
function ScreenIn({ children }) {
  const [settled, setSettled] = useState(false);
  return (
    <div
      className={settled ? undefined : "screen-in"}
      onAnimationEnd={e => { if (e.target === e.currentTarget) setSettled(true); }}
    >
      {children}
    </div>
  );
}

// The egg renders outside the screen ErrorBoundary, so a crash inside it —
// or its chunk failing to load — would unmount the whole shell to a white
// screen. The screen boundary's full-page fallback is wrong here too: with
// the backdrop gone there is nothing to click to dismiss it. A game earns
// the same treatment its scoreboard gets — log it, close it, carry on.
class EggBoundary extends React.Component {
  constructor(props) { super(props); this.state = { broken: false }; }
  static getDerivedStateFromError() { return { broken: true }; }
  componentDidCatch(error) {
    console.error("Easter egg crashed:", error);
    this.props.onBroken();
  }
  render() { return this.state.broken ? null : this.props.children; }
}

// The update banner. It never interrupts: the new version sits waiting
// while the running one keeps working, so "When I'm done" is a real
// choice — it collapses to the top-bar chip (signed in) or just steps
// aside (sign-in screen), and the update also applies by itself on the
// next full close-and-reopen.
function UpdateBanner({ onLater }) {
  return (
    <div role="status" style={{
      // Same safe-area lesson the Toast in common.jsx already paid for:
      // without the inset, the buttons sit in the iPhone home-indicator
      // gesture zone and a tap swipes the app away instead of restarting.
      position: "fixed", left: "50%", bottom: "calc(18px + env(safe-area-inset-bottom, 0px))", transform: "translateX(-50%)",
      zIndex: 55, width: "min(440px, calc(100vw - 24px))",
      background: "var(--color-bg)", border: "1px solid var(--color-accent)",
      boxShadow: "var(--shadow-md)", padding: "14px 16px"
    }}>
      <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
        A new version is ready
      </div>
      <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 70%, transparent)", marginBottom: 12 }}>
        Restart when it suits you — nothing changes until then. Anything queued or auto-saved on this device survives the restart.
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Btn variant="secondary" onClick={onLater}>Postpone</Btn>
        <Btn variant="primary" onClick={() => SwUpdates.apply()}>Restart now</Btn>
      </div>
    </div>
  );
}

// The ticket's editable content as it stands this moment, fingerprinted — or
// null when it cannot be read, or read but not trusted.
//
// Never throws. This is one sentence at the end of a replay, and a replay
// that has the day's work in its hands must not fail over a nicety: an
// unreadable row simply goes uncompared, and the write below happens exactly
// as it always did.
async function currentTicketFingerprint(ticketId) {
  try {
    const [row, crew] = await Promise.all([Db.getTicket(ticketId), Db.listCrewForTicket(ticketId)]);
    const lines = row.ticket_lines || [];
    // No lines on a ticket that carries money means the lines are there and
    // this account cannot see them — prices are Admins' and Technicians', and
    // the policy hides the rows rather than refusing the read (the same trap
    // updateTicket guards before it replaces them). Comparing against that
    // would accuse every save of overwriting somebody.
    if (!lines.length && Number(row.total || 0) > 0) return null;
    return ticketFingerprint(lines, crew, row.delays);
  } catch (e) {
    console.warn("Couldn't check whether this queued ticket overwrote a newer save:", e.message);
    return null;
  }
}

export function App() {
  const [currentUser, setCurrentUser] = useState(null);
  // Who is signed in *now*, for reads that resolve later. A closure holds the
  // person of the render that made it, which is exactly the one that can no
  // longer be trusted once the next technician has taken the tablet.
  const signedInId = useRef(null);
  signedInId.current = currentUser ? currentUser.id : null;
  const [checkingSession, setCheckingSession] = useState(true);
  // Why the boot put them back on the sign-in screen when a session did in
  // fact exist. Only one thing sets it so far — a device that would not empty
  // itself for the account being restored — and it has to be said, because
  // signing in again is the fix and nothing else on that screen suggests it.
  const [bootError, setBootError] = useState("");
  // A password-reset link lands here with recovery tokens in the URL hash;
  // the session it starts is only for choosing a new password, so the app
  // gates on that screen instead of quietly opening. Detection lives in
  // recovery.js at module scope — supabase-js can consume the hash and
  // fire its one-shot PASSWORD_RECOVERY event before React mounts, so a
  // component-level check here loses that race on slow devices.
  const [recovering, setRecovering] = useState(Recovery.pending);
  useEffect(() => Recovery.subscribe(setRecovering), []);
  // A push notification's tap lands on /?goto=chat — honoured here so
  // tapping "Kyle — Team chat" opens the room, not the board. The
  // service worker sends both the closed and the already-open app
  // through this same URL (see public/push-sw.js).
  //
  // Otherwise: whatever section the address named, so a reload stays where
  // you were. A job route is not settled here — it needs a read and an
  // account to make it for — so it waits in pendingRoute below.
  const [screen, setScreen] = useState(() => {
    if (new URLSearchParams(window.location.search).get("goto") === "chat") return "chat";
    return LANDING_ROUTE && !LANDING_ROUTE.job ? LANDING_ROUTE.screen : "board";
  });
  // The landing address, still to be honoured, and cleared the moment it is.
  // It outlives the URL on purpose: signing in happens on a screen that has
  // already rewritten the address bar, and a deep link followed while signed
  // out should still open its job once there is somebody to open it for.
  const pendingRoute = useRef(LANDING_ROUTE);
  // The goto parameter is a one-time instruction, consumed above — left
  // in the URL it would re-route every later manual reload to the chat.
  // The hash is the app's own route (route.js) and stays, and so does any
  // other query parameter — the same rule the backup panel's strip keeps.
  useEffect(() => {
    if (window.location.search.includes("goto=")) {
      const params = new URLSearchParams(window.location.search);
      params.delete("goto");
      const rest = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash);
    }
  }, []);
  const [menuOpen, setMenuOpen] = useState(false);
  // The drawer outlives menuOpen by one exit animation: it stays mounted
  // while it slides away, and animationend is what finally unmounts it.
  // Every existing setMenuOpen(false) keeps working untouched.
  const [menuVisible, setMenuVisible] = useState(false);
  useEffect(() => { if (menuOpen) setMenuVisible(true); }, [menuOpen]);
  // Focus, Tab and the page's scroll while the drawer is over the screen.
  // Keyed on both flags because the panel is mounted by the second one: on
  // menuOpen alone the effect would run a render too early, with nothing in
  // the ref to move focus into.
  const drawerRef = useRef(null);
  useModalPanel(menuOpen && menuVisible, drawerRef);
  const [theme, setTheme] = useState(() => Store.load("theme", "light"));
  // Motion is the app's own choice, not the OS's: Windows machines with
  // animation effects off were silently flattening every animation, and
  // Kyle chose an in-app switch over inheriting that. Defaults on; the
  // drawer toggle below is the escape hatch for anyone motion-sensitive.
  const [motion, setMotion] = useState(() => Store.load("motion", "on"));

  // The drawer is the only navigation now, at every width, so there is no
  // breakpoint at which an open menu becomes stray buttons — but Escape should
  // still close it, the same as a dialog.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = e => { if (e.key === "Escape") setMenuOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // Wired to Supabase (see db.js):
  const [clients, setClients] = useState([]);
  const [contractors, setContractors] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [activeJob, setActiveJob] = useState(null);
  const [myTickets, setMyTickets] = useState([]);
  const [myTicketsLoading, setMyTicketsLoading] = useState(true);
  // Why the last read failed, or null: Open tickets states an empty list as
  // fact ("Nothing to send"), and must not say it to somebody whose drafts
  // it could not read.
  const [myTicketsError, setMyTicketsError] = useState(null);
  const [loadError, setLoadError] = useState("");

  // Sourced from the open job (see Db.getJobRecord) — Job detail fills this in
  // as soon as a job is opened.
  const [jobRecord, setJobRecord] = useState(EMPTY_JOB_RECORD);
  // The draft being edited on the billing screen, when it was opened from a
  // job rather than from the menu.
  const [activeTicket, setActiveTicket] = useState(null);
  // What a NEW ticket starts with when Job detail's Create ticket dialog
  // opened it: the work date and this ticket's own reps, plus a nonce that
  // remounts the editor. Declared here, above the sign-in early return —
  // a hook below it renders only once signed in, and React refuses a
  // component whose hook count grows between renders.
  const [ticketSeed, setTicketSeed] = useState(null);
  // This person's hazard assessments still waiting for end readings, across
  // every job — listed on Open tickets, loaded with the draft list.
  const [myOpenJhas, setMyOpenJhas] = useState([]);
  // A screen reached from a button inside another screen, which stays reachable
  // even when it isn't one of the sections in this account's menu.
  const [contextScreen, setContextScreen] = useState("");
  const [queued, setQueued] = useState([]);
  // A new version has downloaded and is waiting. The banner offers restart
  // now or later; "later" collapses it to a top-bar chip so it stays one
  // tap away without standing in front of a half-entered ticket.
  const [updateReady, setUpdateReady] = useState(false);
  const [updateDeferred, setUpdateDeferred] = useState(false);
  useEffect(() => SwUpdates.subscribe(setUpdateReady), []);
  const [showQueue, setShowQueue] = useState(false);
  const [showFeature, setShowFeature] = useState(false);
  // The screen tip: the popup that says what a screen is for, once per run
  // of the app. It holds the screen key it is about rather than a flag, so
  // a screen that changes out from under it takes the tip with it. Held
  // here, above the early returns, with every other hook — one put below a
  // return crashed the ticket screen. It is not part of the address: a tip
  // is a thing that happens on the screen you are on, not somewhere a
  // reload should land you.
  const [tipScreen, setTipScreen] = useState(null);
  // Which screens have spoken this run. In memory and nowhere else, which
  // is what brings the tips back the next time the app is opened; only the
  // "No more tips" kill switch is written down (helpTips.js). A new account
  // signing in on this device gets a new run, so the tablet's next crew
  // member is introduced to the screens rather than inheriting the silence.
  const userId = currentUser ? currentUser.id : null;
  const tipsThisRun = useRef(tipRun());
  const tipsRunFor = useRef(userId);
  if (tipsRunFor.current !== userId) { tipsRunFor.current = userId; tipsThisRun.current = tipRun(); }
  // Noted as the popup goes up, not when Ok is pressed: a tip closed with
  // Escape or the backdrop has still had its say, and raising it again the
  // moment somebody comes back to the screen is how a tip turns into a
  // nuisance. Ok is for this run; the next launch says it all again.
  useEffect(() => {
    if (!userId || !helpFor(screen) || !tipDue(Store, userId, screen, tipsThisRun.current)) { setTipScreen(null); return; }
    noteTipSeen(tipsThisRun.current, screen);
    setTipScreen(screen);
  }, [userId, screen]);
  const [egg, setEgg] = useState(false);
  // Every save in the app arrives here, from db.js by way of the toast bus.
  const [toast, setToast] = useState(null);
  useEffect(() => Toasts.subscribe(setToast), []);

  // Replays anything saved locally while offline, the moment the browser is
  // back — and once on load, in case items were queued in a previous session
  // that ended before the signal came back. Held in a memo rather than inlined
  // so "Try again now" in the queue panel replays through the same handlers.
  const queueHandlers = useMemo(() => ({
    // Jobs replay before anything raised against them: the queue is walked in
    // the order things were saved, and a job is always saved before the JHA
    // or ticket that names it.
    job: payload => Db.createJob(payload),
    jha: payload => Db.createJha(payload),
    // The two multi-step handlers checkpoint after the write that creates a
    // row, because everything after that point can be safely repeated and
    // that first step cannot. Signal dropping between step one and step two
    // is ordinary out there, and without the checkpoint the retry starts
    // from the top and files the work a second time.
    report: async (payload, checkpoint) => {
      let reportId = payload.reportId;
      if (!reportId) {
        const report = await Db.uploadReport({
          jobDbId: payload.jobDbId, jobNumber: payload.jobNumber, file: payload.file,
          welds: payload.welds, result: "Accept", interpretedBy: payload.interpretedBy,
          send: false, sendTo: payload.recipient, clientKey: payload.clientKey || null
        });
        reportId = report.id;
        await checkpoint({ reportId });
      }
      if (payload.recipient) {
        try { await Db.sendReportEmail({ reportId, to: payload.recipient, cc: "", message: "" }); }
        catch (e) {
          // The report is filed; only the email is missing. A console line
          // was the whole record of that, and a report the contractor never
          // received sat as Pending until somebody wondered. Said once, and
          // forced: toasts are muted while the outbox drains and the item is
          // deleted when it finishes, so this is the only chance to hear it.
          // A network failure is not "refused" — the send is not retried on
          // its own, so it is still said, with the next step either way.
          console.warn("Queued report synced, but its email didn't send:", e.message);
          Toasts.show(`The report for ${payload.jobNumber || "this job"} is filed, but the email to ${payload.recipient} didn't go out — send it from the job's Radiographic reports.`, "error", true);
        }
      }
    },
    ticket: async (payload, checkpoint) => {
      // A ticket that never reached the database gets its number now, on the
      // way in — not when it was built in the field hours ago.
      let id = payload.ticketId;
      // True once the row turns out to be with the client for signature, so
      // the lines in this payload were not applied. It changes what still
      // runs below and what the technician is told at the end.
      // Holds the refusal itself, not a flag: the tail below re-raises it so
      // the item stays in the outbox with the reason on it.
      let linesRefused = null;
      if (!payload.alreadyCreated) {
        // With the key the editor minted: this is the one replay that can
        // double-file a day — the insert lands, the answer is lost on the
        // radio, the item stays queued — and the key is what turns the
        // second attempt into a lookup of the row that already exists.
        // (The ticketGone branch below always carried it; this one didn't.)
        const saved = await Db.createTicket({
          initials: payload.initials, jobDbId: payload.jobDbId, technicianId: payload.technicianId,
          workDate: payload.workDate, clientContact: payload.clientContact, contractorContact: payload.contractorContact,
          lines: payload.lines, status: payload.status, delays: payload.delays,
          clientKey: payload.clientKey || null
        });
        id = saved.id;
        // The row and its number exist now. Anything that fails below this
        // line must resume against *this* ticket, not mint another one.
        await checkpoint({ alreadyCreated: true, ticketId: id });
        // A row found by its key was the first attempt's, whose lines may
        // never have landed: write today's over it, as the editor does.
        if (saved.existing) {
          try {
            await Db.updateTicket({
              ticketId: id, clientContact: payload.clientContact, contractorContact: payload.contractorContact,
              lines: payload.lines, status: payload.status, delays: payload.delays
            });
          } catch (e) {
            // The same refusal the branch below handles, reached the other
            // way round: the first attempt's row went to the client for
            // signature while this item sat in the outbox. Thrown from here
            // it parked the item with the crew unfiled and nobody told, so
            // it takes the same line — carry on to the tail, which saves the
            // hours and says which half of the ticket was not applied.
            if (e.sentForApproval) linesRefused = e;
            else throw e;
          }
        }
      } else {
        // Somebody else may have saved this ticket while the payload sat in
        // the outbox. Last write wins — the payload is the whole day as the
        // field left it, and nothing here knows better than the person who
        // worked it — but an overwrite nobody is told about is how the
        // office's afternoon correction disappears at 18:00 with no trace
        // anywhere. So read the row before writing over it and compare it
        // with what this device had when it loaded the draft. Afterwards is
        // too late: by then the row is this payload.
        // Not read again once it has been told: a truck between towers fires
        // `online` all afternoon and each one re-runs this item.
        // Asked once, whatever the answer: a replay whose lines landed and
        // whose crew then failed on the radio comes back to a row that is
        // this item's lines over the old crew — which matches neither what it
        // started from nor what it is writing, and would read as somebody
        // else's work. The checkpoint below records that the question has
        // been put, so a partial replay is never accused of itself.
        const overwrote = payload.baseFingerprint && !payload.overwroteChecked
          ? replacedNewerWork(
            payload.baseFingerprint,
            ticketFingerprint(payload.lines, payload.crew, payload.delays),
            await currentTicketFingerprint(id))
          : false;
        try {
          // The reps ride along: the payload is the whole ticket as the field
          // left it, and a rep edited on a reopened draft is part of it.
          await Db.updateTicket({
            ticketId: id, clientContact: payload.clientContact, contractorContact: payload.contractorContact,
            lines: payload.lines, status: payload.status, delays: payload.delays
          });
        } catch (e) {
          // The office sent this ticket to the client while it sat in the
          // outbox, so its billing is now the client's document and the
          // update is refused (db.js flags that refusal `sentForApproval`).
          // The refusal used to end the replay here, which threw away the
          // half of the payload the database would still have taken: crew
          // rows stay writable until the client signs, and those hours are
          // the day's pay and the crew's dose. So the item carries on
          // without its lines, and says so — a ticket the client is signing
          // for figures nobody re-entered is worth a sentence.
          if (e.sentForApproval) {
            linesRefused = e;
          } else {
            // The row was cancelled on another device while this sat in the
            // outbox. The payload still holds the whole day — the only copy
            // of it — so raise it as a fresh ticket rather than stranding it
            // behind a dead id forever.
            if (!e.ticketGone) throw e;
            const saved = await Db.createTicket({
              initials: payload.initials, jobDbId: payload.jobDbId, technicianId: payload.technicianId,
              workDate: payload.workDate, clientContact: payload.clientContact, contractorContact: payload.contractorContact,
              lines: payload.lines, status: payload.status, delays: payload.delays,
              clientKey: payload.clientKey || null
            });
            id = saved.id;
            await checkpoint({ alreadyCreated: true, ticketId: id });
          }
        }
        // The write landed on top of work somebody else had saved. Say it
        // once, and forced, the way the signature refusal is: toasts are
        // muted while the outbox drains, and an item that finishes is deleted
        // — this is the only chance anybody has to hear it. The checkpoint is
        // what keeps the next reconnect quiet.
        //
        // Not for a refusal, whose lines never landed, and not for a ticket
        // that turned out to be gone: raised fresh under a new number, it
        // replaced nothing.
        if (overwrote && !linesRefused && id === payload.ticketId) {
          Toasts.show(`Your queued copy of ${id} replaced changes somebody else saved while you were out of range — open the ticket and check the figures.`, "error", true);
          // And a copy that outlives the toast: the editor shows it as a
          // banner when this ticket is next opened on this device, until the
          // technician says they have looked (overwriteNote.js).
          try { await OfflineCache.put(overwroteKey(id), { at: Date.now() }); } catch (_) { /* the toast was said */ }
          await checkpoint({ overwroteNewer: true });
        }
      }
      // The question is recorded as asked only once the lines have landed:
      // written before the update, a save that then failed on the radio
      // would come back with the question skipped and write over the
      // office's correction in silence — the one case the question is for.
      // Not on the refusal (lines never landed) and not on the re-raise.
      if (payload.baseFingerprint && !payload.overwroteChecked && !linesRefused && id === payload.ticketId) {
        await checkpoint({ overwroteChecked: true });
      }
      // Crew is a delete-then-insert, so replaying it is harmless.
      await Db.saveCrewForTicket(id, payload.crew);
      // Not when the row is already awaiting approval: that send is what
      // refused the update above, so the client has the link already and a
      // second one would only reset their token mid-signature.
      if (payload.sendForApproval && !linesRefused) {
        // Marked when the send's answer is lost. The send is what moves the
        // row to Awaiting approval, so a reply lost on the radio leaves an
        // item whose own send landed looking exactly like one the office
        // sent out from under it — and the next flush met the refusal,
        // sounded the alarm and parked a ticket that was in fact complete,
        // its lines written by this same item moments earlier.
        // Only a send the radio lost is ambiguous. One the server refused
        // (a 403, a bad address) never moved the row, so marking it would
        // make a later send by the office look like this item's own.
        try {
          await Db.sendTicketApproval({ ticketId: id, to: payload.approvalTo });
        } catch (e) {
          if (OfflineQueue.isNetworkError(e)) await checkpoint({ sendAttempted: true });
          throw e;
        }
      }
      // This item's own send having landed is not the office's send: the
      // lines on that row are this device's, already applied, and there is
      // nothing to tell anybody. Finish quietly.
      if (linesRefused && payload.sendAttempted) return;
      if (linesRefused) {
        // Once, not on every reconnect. A truck between towers fires `online`
        // all afternoon, and each one re-runs this item — the refusal is the
        // same every time, and a forced toast repeating it all day teaches
        // people to swipe it away. The queue badge and its panel are what
        // carry it from here.
        if (!payload.refusalTold) {
          Toasts.show(`Ticket ${id} had already gone to the client for signature — the crew hours from this device were saved, but its welds and charges were not. Check the ticket and, if the figures are wrong, cancel the approval and re-enter them.`, "error", true);
          await checkpoint({ refusalTold: true });
        }
        // A toast is 2.6 seconds on whatever screen happens to be open, and
        // this item used to be deleted right after it: a tablet in a pocket
        // meant nobody ever learned the billing hadn't landed. Raising the
        // refusal keeps the item in the outbox with the reason attached, so
        // the badge stays lit and the queue panel says what is owed until
        // somebody decides. Retrying costs one refused update and one crew
        // re-write (delete-then-insert), and lands here again unchanged —
        // discarding is how it ends, once the ticket has been looked at.
        throw linesRefused;
      }
    }
  }), []);

  // Re-attached per signed-in account: the queue is scoped to whoever
  // queued each item (shared tablets), so a sign-in is also the moment that
  // person's own outbox gets its flush — the mount-time one ran as nobody.
  // onSynced reaches loadMyTickets through a ref: the handler is defined
  // further down, and the flush must call the current one, not the one
  // this effect closed over at sign-in.
  const onSyncedRef = useRef(() => {});
  useEffect(() => {
    OfflineQueue.setOwner(currentUser ? currentUser.id : null);
    if (!currentUser) return undefined;
    return OfflineQueue.attachAutoFlush(queueHandlers, () => onSyncedRef.current());
  }, [queueHandlers, currentUser ? currentUser.id : null]);
  // Re-subscribed per signed-in account: the list is filtered to the owner,
  // so a sign-in must re-read it, not keep the previous person's.
  useEffect(() => OfflineQueue.subscribe(setQueued), [currentUser ? currentUser.id : null]);
  const [cacheState, setCacheState] = useState({ servingCached: false, at: null });
  useEffect(() => OfflineCache.subscribe(setCacheState), []);
  const retryQueue = () => OfflineQueue.flush(queueHandlers).then(r => { if (r && r.synced && !r.joined) onSyncedRef.current(); return r; });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    Store.save("theme", theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-motion", motion);
    Store.save("motion", motion);
  }, [motion]);

  // Hiding a section is not locking a door: if the screen someone is on stops
  // being one of theirs, move them to the first section they do have rather
  // than parking them on a "not available" panel.
  useEffect(() => {
    if (!currentUser) return;
    const tabs = tabList(currentUser.tabs);
    // Never onto a contextual screen (job, jha, upload, ticket): those open
    // from a job, and an account without the board was being parked on
    // "No job selected — pick one from Home" with no Home in its menu.
    const first = tabs.filter(t => !CONTEXT_TABS.includes(t))[0] || tabs[0];
    if (tabs.length && !tabs.includes(screen) && screen !== contextScreen) setScreen(first);
  }, [currentUser, screen, contextScreen]);

  // True when this session was restored from what the device remembered
  // rather than from a live token — see the recheck below.
  const restoredOffline = useRef(false);

  // Everything of the person's that lives in this component's state, put
  // back. One function for both ways a session ends — Sign out, and the
  // lapsed-session recheck just below. Declared up here, above the screen's
  // early returns: the recheck effect is registered on the first render,
  // which returns early while the session is still being checked, and a
  // function declared below that return is not initialised when the
  // listener captures it. The recheck used to call
  // setCurrentUser(null) alone: with the drawer open when it fired, the
  // focus trap never released, the page stayed scroll-locked on the sign-in
  // screen, and the drawer came up open over the next person's board.
  const clearSessionState = () => {
    setMenuOpen(false);
    setMenuVisible(false);
    setChatUnread(0);
    // And the data that was theirs: the open job and its record, the ticket
    // being edited, the draft list behind the badge. All of it survived into
    // the next session before, and the draft list in particular rendered
    // the last technician's tickets to the next until a refetch replaced it.
    setMyTickets([]);
    setBootError("");
    setMyOpenJhas([]);
    setActiveJob(null);
    setJobRecord(EMPTY_JOB_RECORD);
    setActiveTicket(null);
    setTicketSeed(null);
    setContextScreen("");
    forgetHeldDrafts();
    forgetDosimetryAsked();
    forgetChatMediaUrls();
    setCurrentUser(null);
  };

  // Coming back into range. Usually supabase-js refreshes the token and
  // everything carries on. If it can't, the account really is signed out, and
  // saying so beats leaving someone looking signed in while every save fails.
  // Nothing queued is lost by this: the queue is separate from the identity
  // and survives until it syncs.
  useEffect(() => {
    const recheck = async () => {
      if (!restoredOffline.current) return;
      // `online` means attached to a network, not that anything answers —
      // a truck between towers fires it all afternoon. A refresh that fails
      // on the network is therefore not an answer, and the person stays
      // signed in from the device's memory until one arrives; only the
      // server actually saying "no session" signs anyone out. (session.js
      // holds the same line for the initial restore.)
      let data = null, error = null;
      try { ({ data, error } = await sbClient.auth.getSession()); }
      catch (e) { error = e; }
      if (data && data.session) { restoredOffline.current = false; OfflineCache.markLive(); return; }
      const inconclusive = error && (error.name === "AuthRetryableFetchError" || OfflineQueue.isNetworkError(error));
      if (inconclusive) return;
      restoredOffline.current = false;
      console.warn("Back online, but the session had lapsed — signing in again is needed.");
      // The identity goes. Without that it outlived the server's "no
      // session": close and reopen the app out of range and it opened as
      // this person again, for the rest of the identity's twelve hours — a
      // locked account included.
      //
      // What they were working on stays, exactly as the boot's lapsed-session
      // branch leaves it: a token that expired while the truck was out of
      // range is not a reason to throw away a half-entered ticket without
      // asking, and the next sign-in empties the store anyway if it is
      // somebody else (OfflineCache.claimFor).
      try { await OfflineCache.remove(IDENTITY_KEY); } catch (e) { console.error("Couldn't forget this device's remembered identity:", e); }
      // The stored session too: this branch is reached for any answer that
      // is not a network failure, a 5xx from the token endpoint included, and
      // auth-js only removes the session itself when the server said "no
      // session". Every sign-out path forgets it (CLAUDE.md), this one now
      // as well, or the next reload signs the tablet straight back in.
      forgetStoredSession();
      clearSessionState();
    };
    window.addEventListener("online", recheck);
    return () => window.removeEventListener("online", recheck);
  }, []);

  // A job named by an address rather than tapped on the board: a link pasted
  // into chat, a bookmark, or a reload of the job somebody was standing on.
  // It goes through the same read Home uses, so a cold start reaches the job
  // exactly as a warm one does; a job that cannot be read leaves the person
  // on the screen they landed on with the reason said out loud, the way
  // openJobByNumber does. Nothing points the app at a job it never loaded.
  const openLandingJob = async number => {
    try {
      const job = await Db.getJobByNumber(number);
      setActiveJob(job);
      setContextScreen("job");
      setScreen("job");
      return true;
    } catch (e) {
      console.error("Couldn't open the job that link names:", e.message);
      Toasts.show(`Couldn't open ${number}: ${e.message || "try again."}`, "error");
      return false;
    }
  };

  // The first screen of a session, in order of who has the better claim: the
  // address this load arrived on, then the push notification's ?goto=chat,
  // then this account's own first section. A section the account no longer
  // holds is not honoured — hiding a tab is a permission, and an address is
  // not a way around it — but a job always is, because the contextual screens
  // open from a job whether or not that section is in anybody's menu.
  const landOn = user => {
    const tabs = tabList(user.tabs);
    const first = tabs.filter(t => !CONTEXT_TABS.includes(t))[0] || "board";
    const route = pendingRoute.current;
    pendingRoute.current = null;
    if (route && route.job) {
      setScreen(first);
      openLandingJob(route.job);
      return;
    }
    if (route && tabs.includes(route.screen)) { setScreen(route.screen); return; }
    // Overwriting the chat seed here sent every notification tap on a
    // restored session to the board instead of the room — exactly what the
    // goto handling above exists to prevent.
    setScreen(s => (s === "chat" && tabs.includes("chat")) ? "chat" : first);
  };

  // Restore an existing session on load. Bounded at every step and tolerant of
  // having no network — see session.js for why each of those matters.
  //
  // Not while a password reset is in flight, though: restoreSession treats
  // "session with no usable profile" as something to sign out — and doing
  // that to a recovery session destroys the single-use reset link while
  // its owner is mid-typing on the set-password screen. The gate's onDone
  // runs this same boot once the recovery is settled.
  const bootSession = async () => {
    setBootError("");
    // Set by writeIdentity below when this device would not empty itself for
    // the account being restored. See there for why it travels as a flag.
    let claimFailed = null;
    try {
      const { user, offline, reason, signedOut, identityUnreadable } = await restoreSession({
          getSession: () => sbClient.auth.getSession(),
          fetchProfile: id => sbClient.from("profiles").select("*").eq("id", id).single(),
          // Guarded: if a recovery landing is detected while this boot is
          // already in flight, the "no usable profile" sign-out must not
          // destroy the recovery session mid-reset.
          // A signOut that answers with an error has not removed the stored
          // session — see forgetStoredSession. An account with nothing
          // behind it must not be left one to refresh from.
          signOut: async () => {
            if (Recovery.pending()) return;
            const { error } = await sbClient.auth.signOut();
            if (error) forgetStoredSession();
          },
          // The sign-in screen promises "offline sign-in cached for 12 h",
          // and this is where the promise is kept: a remembered identity
          // older than that is not an identity, it is a lost tablet's last
          // user. Every successful online restore writes it afresh.
          readIdentity: () => OfflineCache.read(IDENTITY_KEY).then(hit => {
            if (!hit) return null;
            if (Date.now() - (hit.at || 0) > IDENTITY_TTL_MS) { OfflineCache.remove(IDENTITY_KEY).catch(() => {}); return null; }
            return hit.value;
          }),
          // The same claim the sign-in screen makes, for the same reason:
          // this device's remembered data belongs to one account, and a
          // session restored for anyone else — a reset link followed on
          // somebody else's tablet gets one without ever passing the
          // sign-in screen — empties it before reading a word. For the
          // usual case (the same person again) it is one read and nothing
          // else, and it is what keeps their own drafts from looking like
          // a stranger's the next time they sign in.
          // A clear that would not land leaves the last account's work on
          // this device, and claimFor records no owner in that case. Writing
          // the identity over that would open the app as this person on top
          // of somebody else's jobs and half-entered tickets — so record the
          // failure and write nothing. restoreSession swallows whatever
          // writeIdentity throws (an identity that could not be remembered
          // is no reason to fail a sign-in that worked), which is why it is
          // a flag and not an exception that stops the boot below.
          writeIdentity: async identity => {
            try { await OfflineCache.claimFor(identity.id); }
            catch (e) {
              console.error("Couldn't clear the previous account's cached data:", e);
              claimFailed = e;
              return;
            }
            return OfflineCache.put(IDENTITY_KEY, identity);
          },
        isNetworkError: OfflineQueue.isNetworkError
      });
      // Signed in as far as Supabase is concerned, on a device still holding
      // the previous account's data. End the session rather than open the app
      // over it — a session left alive here is one a reload would restore.
      // The identity goes too, so the next offline start doesn't come back as
      // this person on a store that was never theirs.
      if (claimFailed) {
        try { const { error } = await sbClient.auth.signOut(); if (error) forgetStoredSession(); }
        catch { forgetStoredSession(); }
        try { await OfflineCache.remove(IDENTITY_KEY); } catch { /* nothing more to try */ }
        setCurrentUser(null);
        setBootError("This device couldn't clear the previous person's data — try again.");
        setCheckingSession(false);
        return;
      }
      // Three different "nobody is signed in", and they do not deserve the
      // same answer. What is on the device is the last crew's jobs, rates and
      // half-entered tickets, so the question each time is whether anybody is
      // still entitled to it.
      if (offline) {
        console.warn("Starting without a connection (" + reason + ")" + (user ? " — signed in from this device's last session." : "."));
        if (user) {
          OfflineCache.noteServingCached(Date.now());
          restoredOffline.current = true;
        } else {
          // No signal and nobody remembered — the identity has expired
          // (twelve hours) or was never here. Nothing is emptied on that
          // basis. This used to clear the store, which threw away the
          // half-entered tickets and assessments (ticket.wip.*, jha.wip.*)
          // that the branches below deliberately keep, and the person it
          // took them from is very often the same technician signing in an
          // hour later. It bought nothing either: cache.owner outlives the
          // identity, and claimFor empties this store at the door for any
          // account that is not the owner's.
          //
          // And one of the two ways to get here is not an answer at all —
          // the remembered identity could not be read (see session.js).
          // Acting on a moment's IndexedDB fault is how a fault becomes a
          // lost day.
          if (identityUnreadable) console.error("This device's remembered identity couldn't be read — opening signed out, keeping what is stored.");
        }
      } else if (signedOut) {
        // The server answered, and this account has nothing behind it any
        // more — deactivated, or stripped of every tab. Nobody is coming
        // back for this, so everything goes, drafts included.
        try { await OfflineCache.remove(IDENTITY_KEY); } catch { /* the clear below tries again */ }
        try { await OfflineCache.clear(); } catch (e) { console.error("Couldn't clear the offline cache after the account was locked:", e); }
      } else if (!user) {
        // A session that simply ended — expired, or signed out on another
        // device. The identity goes, or it outlives the server's "no session"
        // and the next offline open comes back as that person for the rest of
        // the twelve hours. The data does NOT: this is very often the same
        // technician about to sign in again, and wiping a morning's
        // half-entered ticket for a lapsed token is the thing sign-out asks
        // permission for. Whoever signs in next settles it — a different
        // account empties the store at the door (OfflineCache.claimFor).
        try { await OfflineCache.remove(IDENTITY_KEY); } catch (e) { console.error("Couldn't forget this device's remembered identity:", e); }
      }
      if (user) {
        setCurrentUser(user);
        // Where this session opens: the address, the notification, or this
        // account's own first section — never a contextual screen without
        // the job behind it. See landOn.
        landOn(user);
      }
    } catch (e) {
      console.error("Couldn't restore the session:", e.message);
    }
    setCheckingSession(false);
  };
  useEffect(() => {
    if (Recovery.pending()) { setCheckingSession(false); return; }
    bootSession();
  }, []);

  // The screen, written into the address bar.
  //
  // One effect rather than a pushState beside every setScreen: a screen is
  // arrived at half a dozen ways — a drawer tab, a job tapped on the board,
  // a ticket opened from the tracker, the tab-permission redirect above, a
  // deleted job sending you somewhere else — and they all pass through this
  // same pair of states, so they all get the same address for nothing.
  const routeWritten = useRef(false);
  useEffect(() => {
    if (!currentUser) {
      // A session that ends takes its address with it: a shared tablet should
      // not sit on the sign-in screen with the last crew member's open job
      // still in the bar. Only an address this app wrote is cleared — a
      // recovery hash belongs to Auth and is never touched.
      if (routeWritten.current && parseRoute(window.location.hash)) {
        window.history.replaceState({}, "", window.location.pathname + window.location.search);
      }
      routeWritten.current = false;
      return;
    }
    const next = formatRoute({ screen, job: activeJob ? activeJob.id : null });
    // A contextual screen with no job has no address (route.js); leave the
    // last good one in the bar rather than writing something meaningless.
    if (!next) return;
    // Nothing to do when the address already says this, which is what a
    // Back looks like from here: the handler below puts the bar right before
    // it moves the app, so a pop never pushes a duplicate of the entry it
    // just returned to.
    if (window.location.hash === next) { routeWritten.current = true; return; }
    // The first address of a session replaces the entry the app loaded on,
    // so Back from the opening screen still leaves the app rather than
    // stepping through a duplicate of it first.
    // A job and its own screens are one entry (historyStep): pushing an
    // entry per ticket made the first Back out of one look dead.
    const step = routeWritten.current
      ? historyStep(parseRoute(window.location.hash), { screen, job: activeJob ? activeJob.id : null })
      : "replace";
    if (step === "push") window.history.pushState({}, "", next);
    else window.history.replaceState({}, "", next);
    routeWritten.current = true;
  }, [currentUser, screen, activeJob]);

  // The Back gesture. On an installed Android app it is the most-used control
  // on the device, and with the open screen held only in React state it used
  // to leave the app altogether. Every entry in the history is one of the
  // app's own screens now, so going back is a matter of reading the address
  // and standing there again.
  //
  // A ticket, a JHA or a report upload is not restored, only the job under it
  // (landingRoute): those screens are half-entered work living in the editor,
  // and the address never said which draft. Going back out of a ticket lands
  // on its job, which is where the ticket is opened from anyway.
  useEffect(() => {
    if (!currentUser) return undefined;
    const onPop = () => {
      const route = landingRoute(parseRoute(window.location.hash));
      const tabs = tabList(currentUser.tabs);
      const first = tabs.filter(t => !CONTEXT_TABS.includes(t))[0] || "board";
      // An address for a section this account no longer holds is not a way
      // into it — the same rule the drawer's goto keeps. A job always is,
      // because a job opens from a link the way it opens from the board.
      const target = route && route.job ? route
        : { screen: route && tabs.includes(route.screen) ? route.screen : first, job: null };
      // The bar is put back in step here rather than left to the effect
      // above, because a Back can land on the screen already showing — a
      // ticket stepping back to its own job — and then no state changes, the
      // effect never runs, and the ticket's address would sit there for the
      // next navigation to push over.
      const settled = formatRoute(target);
      if (settled && window.location.hash !== settled) window.history.replaceState({}, "", settled);
      if (target.job) {
        // Already the open job: nothing to read, and nothing about it can
        // have changed on the way back to it.
        if (activeJob && activeJob.id === target.job) { setContextScreen("job"); setScreen("job"); return; }
        // A job that cannot be read leaves the app where it was, so put the
        // bar back to the screen that is showing — nothing changes state, so
        // the effect above would never do it, and the address would go on
        // naming a job the screen does not show.
        openLandingJob(target.job).then(opened => {
          if (opened) return;
          const back = formatRoute({ screen, job: activeJob ? activeJob.id : null });
          if (back && window.location.hash !== back) window.history.replaceState({}, "", back);
        });
        return;
      }
      setContextScreen("");
      setScreen(target.screen);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // screen as well: the failed-Back fallback writes the screen that is
    // showing back into the bar, and a closure without it wrote a stale one.
  }, [currentUser, activeJob, screen]);

  const loadReferenceData = async () => {
    setLoadError("");
    try {
      const [clientList, contractorList, contactList] = await Promise.all([
        Db.listClients(), Db.listContractors(), Db.listContacts()
      ]);
      setClients(clientList);
      setContractors(contractorList);
      setContacts(contactList);
    } catch (e) {
      console.error("Failed to load reference data:", e.message);
      setLoadError(e.message || "Couldn't reach the database. Check your connection and reload.");
    }
  };

  useEffect(() => {
    if (!currentUser) return;
    loadReferenceData();
    // Warm the most-recent job so a drawer-opened Job screen has something
    // to show — but only if the user hasn't already opened a job. The
    // functional update keeps whatever they picked: on a slow connection
    // this RPC can resolve seconds after sign-in, and it used to overwrite
    // a job the tech had already tapped into, silently binding any JHA or
    // ticket they then started to the wrong job.
    Db.getMostRecentJob().then(j => { if (j) setActiveJob(prev => prev || j); }).catch(e => console.error("Couldn't load the most recent job:", e.message));
    // Warmed on sign-in so the JHA builder still opens with this person's
    // usual hazard ratings when they're out of range.
    Db.lastHazardRatings(currentUser.id).catch(() => {});
  }, [currentUser]);

  // The chat badge: how many messages arrived since this person last had
  // the room open, counted by one indexed RPC. Refreshed on sign-in, on
  // returning to the app, and once a minute while it is visible; the chat
  // screen zeroes it directly (onRead) the moment the room is read.
  const [chatUnread, setChatUnread] = useState(0);
  useEffect(() => {
    if (!currentUser) return;
    const refresh = () => { Db.chatUnreadCount().then(setChatUnread).catch(() => {}); };
    refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 60000);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    // A push that arrives while the app is on screen is handed to the app
    // instead of shown as a notification (push-sw.js) — this is the hand-off,
    // so the drawer badge moves at once rather than at the next minute.
    const onPushed = e => { if (e.data && e.data.type === "chat-push") refresh(); };
    const sw = navigator.serviceWorker;
    if (sw) sw.addEventListener("message", onPushed);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      if (sw) sw.removeEventListener("message", onPushed);
    };
  }, [currentUser]);

  // The count on the installed app's own icon, where the OS shows it.
  // Set alongside the drawer badge, cleared with it; browsers without
  // the Badging API just never see this.
  useEffect(() => {
    if (!("setAppBadge" in navigator)) return;
    const apply = () => {
      if (chatUnread > 0) navigator.setAppBadge(chatUnread).catch(() => {});
      else if ("clearAppBadge" in navigator) navigator.clearAppBadge().catch(() => {});
    };
    apply();
    // The service worker puts a bare dot on the icon when a push arrives
    // with the app out of sight. With the room open the count stays at 0,
    // nothing re-renders, and the dot used to outlive the message it was
    // for — so it is re-applied whenever the app comes back into view.
    const onVisible = () => { if (document.visibilityState === "visible") apply(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [chatUnread]);

  // A request token, and the person the read was for — the same guard the
  // board and the tracker use, because this list races two ways. Sign-in,
  // arriving at the screen and the outbox draining can each start a load, so
  // an older one could land last and win; and on a shared tablet a slow read
  // for the technician who just signed out used to arrive after the next one
  // had signed in, putting their drafts on someone else's Open tickets and
  // behind their badge. Nothing is kept unless this is still the newest read
  // AND still the same person.
  const myTicketsSeq = useRef(0);
  const loadMyTickets = async () => {
    const mine = ++myTicketsSeq.current;
    const forUser = currentUser ? currentUser.id : null;
    const stillMine = () => mine === myTicketsSeq.current && forUser === signedInId.current;
    setMyTicketsLoading(true);
    // The open assessments ride along, best effort — a failed read leaves
    // the last list rather than blanking the drafts, which are the screen.
    Db.listMyOpenJhas(forUser).then(r => { if (stillMine()) setMyOpenJhas(r); }).catch(e => console.warn("Couldn't load open JHAs:", e.message));
    try { const rows = await Db.listMyTickets(forUser); if (stillMine()) { setMyTickets(rows); setMyTicketsError(null); } }
    catch (e) {
      console.error("Failed to load your tickets:", e.message);
      if (stillMine()) setMyTicketsError(e.message || "no reply from the server");
    }
    if (stillMine()) setMyTicketsLoading(false);
  };
  // Once on sign-in, because the drawer badge needs a count before the screen
  // has been opened… The list is emptied first: it is the previous person's
  // until the read lands, and if the read fails (no signal is the ordinary
  // condition) it stayed theirs — their drafts, on the next person's screen.
  useEffect(() => { setMyTickets([]); setMyOpenJhas([]); if (currentUser) loadMyTickets(); }, [currentUser]);
  // …and again on arriving at the screen. Keyed on `screen` alone: keyed on
  // both, signing in ran this a second time for the same list.
  useEffect(() => { if (currentUser && screen === "mytickets") loadMyTickets(); }, [screen]);
  onSyncedRef.current = () => { if (currentUser) loadMyTickets(); };
  // …and whenever the outbox drains: a queued draft that just synced is a
  // draft the badge didn't know about. Told by the flush itself (onSynced
  // below), once per drain — watching the badge's count shrink ran this
  // reload once per synced item, two paged reads each, on the marginal
  // connection that had queued the work in the first place.
  // The same set Open tickets shows: drafts still to be sent to the client.
  const openMyTicketsCount = myTickets.filter(t => t.status === "Draft").length;

  if (checkingSession) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
        <Loading label="Signing you in…" style={{ width: "min(280px, 80vw)" }} />
      </div>
    );
  }
  // Ahead of the signed-in/signed-out fork: the recovery session exists
  // whether or not the profile has loaded yet, and this screen is the only
  // thing a reset link should ever open onto.
  if (recovering) {
    return <SetNewPasswordScreen onDone={saved => {
      // Done either way (saved, or kept the old one): clear the recovery
      // tokens from the URL so a reload doesn't reopen this screen, then
      // run the boot this gate suppressed — the recovery session signs
      // the person straight in, or its absence lands them at sign-in.
      window.history.replaceState({}, "", window.location.pathname);
      Recovery.clear();
      setRecovering(false);
      if (saved) Toasts.show("Password updated");
      bootSession();
    }} />;
  }

  if (!currentUser) {
    // The banner rides along here too: a shared tablet parked on the
    // sign-in screen is exactly the device nobody ever updates.
    return <>
      {/* landOn, not just the first tab: somebody who followed a link to a
          job while signed out should arrive at that job once they are in,
          not at the board with the address quietly thrown away. */}
      <SignInScreen notice={bootError} onSignIn={u => { setCurrentUser(u); landOn(u); }} />
      {updateReady && !updateDeferred && <UpdateBanner onLater={() => setUpdateDeferred(true)} />}
    </>;
  }

  const myTabs = tabList(currentUser.tabs);
  // The drawer never lists the contextual screens, whatever the account may
  // access — see CONTEXT_TABS. They are reached from a job, deliberately.
  const allowedTabs = TABS.filter(t => myTabs.includes(t.key) && !CONTEXT_TABS.includes(t.key));
  const goto = key => { if (myTabs.includes(key)) { if (key === "ticket") setActiveTicket(null); setContextScreen(""); setScreen(key); setMenuOpen(false); } };
  // Reached from a button inside another screen (a job card, "Start JHA",
  // "New ticket") rather than the tab menu — always allowed, even when the
  // account's admin has hidden that tab from the menu. Hiding a tab only
  // hides the shortcut; it was never meant to block the work itself.
  const gotoContext = key => { setContextScreen(key); setScreen(key); setMenuOpen(false); };
  // Signing out drops what this device remembered. These are shared tablets:
  // the next person to pick one up should not be able to page through the
  // last crew's jobs and rates without signing in.
  const signOut = async () => {
    // Signing out wipes this device's cache, and the recovery copies of a
    // half-entered ticket or assessment live in it; the outbox survives but
    // is this person's alone, so it won't send until they sign in again.
    // Either one is worth a warning before the tap goes through — a shared
    // tablet handed over mid-ticket used to lose the day without a word.
    try {
      // One walk of the store's keys, not one per prefix: keys() has no
      // index and enumerates everything cached either way.
      const all = await OfflineCache.keys("");
      const wip = all.filter(k => k.startsWith("ticket.wip."));
      const jhaWip = all.filter(k => k.startsWith("jha.wip."));
      const drafts = wip.length + jhaWip.length;
      const parts = [];
      if (drafts) parts.push(`${drafts === 1 ? "a half-entered ticket or hazard assessment" : `${drafts} half-entered tickets or assessments`} on this device that ${drafts === 1 ? "hasn't" : "haven't"} been saved yet — signing out discards ${drafts === 1 ? "it" : "them"}`);
      if (queued.length) parts.push(`${queued.length} item${queued.length === 1 ? "" : "s"} waiting to sync, which won't go out until you sign in again`);
      if (parts.length && !window.confirm(`You have ${parts.join(", and ")}. Sign out anyway?`)) return;
    } catch { /* the check is a courtesy; sign-out itself must never be blocked by it */ }
    // The push subscription belongs to the device, and the row naming this
    // person must not keep buzzing the tablet with the next person's chat.
    // Best effort, before the session that RLS needs for the delete is gone;
    // muted so the sign-out doesn't announce "Notifications off".
    Toasts.mute();
    try { await Db.disableChatPush(); } catch { /* no subscription, or no signal */ }
    finally { Toasts.unmute(); }
    // Offline, with the access token already expired, auth-js reports the
    // failed refresh and returns before it has removed the stored session —
    // so the person is shown the sign-in screen while the session is still
    // on disk, and the next reload in signal signs them straight back in
    // without a password. On a shared tablet that is exactly the handover
    // this whole function exists to make safe, so the session is removed by
    // hand when the sign-out says it failed.
    const { error: signOutErr } = await sbClient.auth.signOut();
    if (signOutErr) {
      console.warn("Sign-out couldn't reach the server; removing the stored session locally:", signOutErr.message || signOutErr);
      forgetStoredSession();
    }
    // The remembered identity goes first, on its own: it is the one record
    // that lets the next person open this tablet as the last one with no
    // signal, so it must not wait on — or be lost behind — the bulk clear.
    try { await OfflineCache.remove(IDENTITY_KEY); } catch { /* the clear below tries again */ }
    // Signing out always completes — nobody gets trapped in a session because
    // a cache would not empty. But a wipe that failed is not a wipe, and the
    // person holding the tablet is the only one who can act on it, so it is
    // said out loud rather than swallowed.
    try {
      await OfflineCache.clear();
    } catch (e) {
      Toasts.show(e.message || "Couldn't clear this device's cached data.", "error");
      console.error("Sign-out could not clear the offline cache:", e);
    }
    // Reset the session-scoped UI too, or the next person to sign in on this
    // shared tablet inherits it: the drawer was opened to reach Sign out, so
    // menuOpen/menuVisible are true and would render the nav drawer open over
    // their board; and chatUnread still holds the last crew member's count,
    // which the app icon badge would keep showing (and expose) until a fresh
    // count resolves. Zeroing chatUnread also drives the badge effect to
    // clear the OS icon.
    clearSessionState();
  };

  // Opening a specific ticket from a job. Deliberately not gated on the tab:
  // the button on the job is the way tickets are meant to be reached, whether
  // or not the billing section is in this person's menu.
  //
  // The record has to be this job's before the editor sees it, for the same
  // reason startTicketForJob loads one: the editor reads the AFE, the LSD and
  // the client rep off it, so a draft opened over a record still belonging to
  // the last job would show that job's details and address its approval to
  // that job's rep. The record names the job it was built for, so the check
  // is that name — no fetch on the ordinary path, where Job detail has
  // already loaded it. `haveRecord` is openTicket saying it loaded the record
  // itself a moment ago, which this render's state hasn't been told yet.
  const openTicketDraft = async (ticketId, haveRecord = false) => {
    if (!haveRecord && (!activeJob || jobRecord.job !== activeJob.id)) {
      if (!activeJob) return;
      const record = await recordFor(activeJob, "ticket");
      if (!record) return;
      setJobRecord(record);
    }
    setActiveTicket(ticketId);
    setContextScreen("ticket");
    setScreen("ticket");
    setMenuOpen(false);
  };

  // The board's rows come from search_jobs, which carries no client GST
  // rate, so the ticket editor read an exempt client's job opened from Home
  // as the ordinary 5% while the emailed invoice said exempt. The full row
  // is read behind the open (through the cache) and swapped in when it
  // lands; a read that fails leaves the row as it was, which the editor
  // reads as 5%, never as exempt.
  const openJob = job => {
    setActiveJob(job);
    gotoContext("job");
    if (job && job.dbId && job.clientGstRate == null) {
      Db.getJob(job.dbId)
        .then(full => setActiveJob(prev => (prev && prev.dbId === job.dbId ? full : prev)))
        .catch(e => console.error("Couldn't read this job's client rate:", e.message));
    }
  };
  // A job named by its number alone (the open-JHA list carries no job row).
  const openJobByNumber = async number => {
    try { openJob(await Db.getJobByNumber(number)); }
    catch (e) {
      console.error("Couldn't open that job:", e.message);
      Toasts.show(`Couldn't open ${number}: ${e.message || "try again."}`, "error");
    }
  };

  // Straight from the board to a blank ticket for a chosen job.
  //
  // The job record is loaded here rather than left to the billing screen for
  // the same reason openTicket does it: going directly to a ticket skips the
  // job screen, which is what normally loads the record — and a stale one
  // would put the previous job's client rep on this ticket.
  // `seed` is what Job detail's Create ticket dialog chose — the work date
  // and this ticket's own reps (state declared with activeTicket above).
  // Nothing is inserted until the editor saves, so the dialog no longer
  // leaves empty drafts behind, and it works with no signal (the editor
  // queues). The nonce remounts the editor per seed.
  // The job's record, loaded before a field screen opens on it. Without it
  // the screen would carry whatever job was opened last — its client rep,
  // and so the address an approval goes to, or the contractor rep a hazard
  // assessment is reviewed with. Better no screen than one filed against
  // the wrong job. Returns the record, or null once the failure is shown.
  const recordFor = async (job, what) => {
    try { return await Db.getJobRecord(job); }
    catch (e) {
      console.error(`Couldn't load the job record for the new ${what}:`, e.message);
      Toasts.show(OfflineQueue.isNetworkError(e)
        ? `No connection, and ${job.id} hasn't been opened on this device yet — open the job once in range, then its ${what}s work offline.`
        : `Couldn't load ${job.id}'s details: ${e.message || "try again."}`, "error");
      return null;
    }
  };
  // Answers whether the ticket screen actually opened: Job detail's Create
  // ticket dialog is holding the work date and the reps somebody just typed,
  // and it can only keep them if it knows the record never arrived.
  // The record already held is reused when it is provably this job's and
  // complete — the same test openTicketDraft makes — so Job detail's own
  // buttons, which wait on that record before they enable, do not read it
  // again behind "Opening…". Home's "+ Ticket" and the tracker fetch.
  const heldRecordFor = job => (jobRecord.job === job.id && !jobRecord.repsUnknown ? jobRecord : null);
  const startTicketForJob = async (job, seed = null) => {
    if (!job) return false;
    // Nothing changes until the record is in hand: the job and the seed used
    // to be set before the await, so a failure left Home pointing at a job
    // nobody had opened.
    const record = heldRecordFor(job) || await recordFor(job, "ticket");
    if (!record) return false;
    setJobRecord(record);
    setActiveJob(job);
    // Always a nonce: the editor is keyed on it, and a seedless ticket used
    // to key as a constant, so two blank tickets in a row would have shared
    // one mount — and the once-only idempotency key minted in it.
    setTicketSeed({ ...(seed || {}), nonce: Date.now() });
    setActiveTicket(null);
    setContextScreen("ticket");
    setScreen("ticket");
    setMenuOpen(false);
    return true;
  };
  // "+ New JHA" on Job detail, with the same guard the ticket has: the
  // builder seeds the site rep from the job record at mount, and Job detail
  // replaces that record asynchronously — tapped before it resolved, the
  // assessment opened naming the previous job's contractor rep.
  const startJhaForJob = async job => {
    if (!job) return;
    const record = heldRecordFor(job) || await recordFor(job, "hazard assessment");
    if (!record) return;
    setJobRecord(record);
    gotoContext("jha");
  };
  // From the billing tracker: a draft opens in the billing screen to be
  // finished, anything already sent opens its job (there is nothing left to
  // edit on it). The job record is loaded here rather than left to the job
  // screen, because going straight to the ticket skips it — and a stale record
  // would show the previous job's rep on this ticket.
  const openTicket = async t => {
    // Nothing moves until the ticket's own job is in hand. This used to start
    // from whatever job happened to be open and keep it when the read failed
    // — no signal, or the job renumbered out from under the tracker — so the
    // ticket opened against the last job: its header, "Start from last ticket"
    // copying its lines, its client rep on the approval email, and its id on
    // a queued replay. Say so and stay put instead, the way openJobByNumber
    // does.
    let job;
    try { job = await Db.getJobByNumber(t.job); }
    catch (e) {
      console.error("Couldn't load that ticket's job:", e.message);
      Toasts.show(`Couldn't open ${t.job}: ${e.message || "try again."}`, "error");
      return;
    }
    setActiveJob(job);
    if (t.status === "Draft") {
      // Same rule as startTicketForJob: a draft opened over another job's
      // record would read that job's rep. So the job's own record is read
      // first and the draft opens over it — the editor, which loadDraft
      // refuses for another technician's ticket unless this is an Admin;
      // the tracker offers "Cancel and edit" to an Admin alone for that.
      try { setJobRecord(await Db.getJobRecord(job)); }
      catch (e) {
        console.error("Couldn't load the job record for that ticket:", e.message);
        Toasts.show(`Couldn't load ${job.id}'s details — opening the job instead.`, "error");
        gotoContext("job");
        return;
      }
      openTicketDraft(t.id, true);
      return;
    }
    gotoContext("job");
  };
  const createJob = async ({ id, job }) => {
    // A job started with no signal comes back already shaped — there is
    // nothing to fetch, and fetching is exactly what didn't work.
    if (job) { setActiveJob(job); return; }
    try {
      const created = await Db.getJobByNumber(id);
      setActiveJob(created);
      Db.listContractors().then(setContractors).catch(() => {});
    } catch (e) {
      // The job was raised — this is only the read-back that fills the board's
      // row in. Left silent, the dialog closed on nothing and the job that had
      // in fact been created looked like a save that vanished. activeJob is
      // deliberately untouched: standing the previous job in for this one is
      // the mistake openTicket used to make.
      console.error("Couldn't load the new job:", e.message);
      Toasts.show(`${id} was created, but couldn't be opened: ${e.message || "open it from the board."}`, "error");
    }
  };

  let body;
  switch (screen) {
    case "board":
      body = (
        <HomeScreen
          onCreateJob={createJob} onOpenJob={openJob} onStartTicket={startTicketForJob}
          currentUser={currentUser} clients={clients} contractors={contractors} contacts={contacts}
        />
      );
      break;
    case "job":
      body = activeJob ? (
        <JobDetailScreen
          // Keyed by job id: if activeJob is swapped on this same instance
          // (e.g. the delete-and-redirect path), React remounts the screen
          // fresh rather than carrying the previous job's edit state (draft,
          // editingRecord) — which a save would otherwise write onto the new
          // job's record.
          key={activeJob.dbId || activeJob.id}
          job={activeJob} currentUser={currentUser}
          onStartJha={() => startJhaForJob(activeJob)}
          onOpenTicket={openTicketDraft}
          onStartTicket={seed => startTicketForJob(activeJob, seed)}
          // The screen you are standing on has just been deleted. Move to the
          // job its contents went to if there was one — that is where the work
          // now lives — otherwise back to the board.
          onJobDeleted={movedTo => {
            setJobRecord(EMPTY_JOB_RECORD);
            setActiveTicket(null);
            if (movedTo) { setActiveJob(movedTo); gotoContext("job"); }
            else { setActiveJob(null); setContextScreen(""); setScreen("board"); }
          }}
          jobRecord={jobRecord} setJobRecord={setJobRecord}
          onJobChanged={async () => {
            // Patch this one job's row in place instead of refetching every
            // job, client, contractor and contact to get it. If that read
            // fails the job on screen simply stays as it was — the previous
            // fallback here called loadReferenceData(), which returns nothing
            // and loads no jobs, so it threw inside the error path.
            try {
              setActiveJob(await Db.getJob(activeJob.dbId));
            } catch (e) {
              console.error("Couldn't refresh this job:", e.message);
            }
          }}
        />
      ) : <div className="page">No job selected — pick one from Home.</div>;
      break;
    case "jha":
      body = <JhaBuilderScreen job={activeJob} jobRecord={jobRecord} currentUser={currentUser} onSubmitted={() => gotoContext("job")} onCancel={() => gotoContext("job")} />;
      break;
    case "upload":
      body = <UploadMobileScreen job={activeJob} jobRecord={jobRecord} currentUser={currentUser} onSent={() => gotoContext("job")} />;
      break;
    case "ticket":
      body = <TicketMobileScreen key={activeTicket || ("new-" + (ticketSeed ? ticketSeed.nonce : ""))} job={activeJob} jobRecord={jobRecord} currentUser={currentUser} ticket={activeTicket} seed={activeTicket ? null : ticketSeed}
        // A save changes the draft list the badge counts; refresh it on the
        // way back rather than when the screen is next opened.
        onSaved={() => { gotoContext("job"); loadMyTickets(); }}
        onOpenJob={() => gotoContext("job")} />;
      break;
    case "files":
      body = <FilesScreen currentUser={currentUser} />;
      break;
    case "contacts":
      body = <ContactsScreen currentUser={currentUser} />;
      break;
    case "equipment":
      body = <EquipmentScreen currentUser={currentUser} />;
      break;
    case "rates":
      body = <RateAdminScreen />;
      break;
    case "tracker":
      body = <BillingTrackerScreen onOpenTicket={openTicket} currentUser={currentUser} />;
      break;
    case "mytickets":
      // Two shapes reach this: the half-entered strip hands over a job record
      // it has already read (it needed the job number to name the row), and
      // the open-JHA list knows only the number. Reading the row back by
      // number when it is already in hand would be a network call the strip
      // has no signal to make.
      body = <OpenTicketsScreen tickets={myTickets} loading={myTicketsLoading} loadError={myTicketsError} onOpenTicket={openTicket} currentUser={currentUser}
        openJhas={myOpenJhas} onOpenJob={j => (j.dbId ? openJob(j) : openJobByNumber(j.job))}
        // After a bulk cancel the drawer badge has to move with the list; this
        // is the same read that fills it on arrival.
        onReload={loadMyTickets} />;
      break;
    case "timesheets":
      body = <TimesheetsScreen currentUser={currentUser} />;
      break;
    case "users":
      body = <UsersAccessScreen currentUser={currentUser} />;
      break;
    case "mail":
      // The archive's clear is the one bulk delete in the app, and the job
      // it takes out may be the one still held open behind this screen — its
      // record, its ticket, and its drafts in the badge. Let go of all of it
      // the way a single deleted job does, rather than leaving the drawer
      // pointing at a job number that no longer exists.
      body = <AdminSetupScreen currentUser={currentUser}
        onArchiveCleared={() => {
          setActiveJob(null);
          setJobRecord(EMPTY_JOB_RECORD);
          setActiveTicket(null);
          setContextScreen("");
          loadMyTickets();
        }} />;
      break;
    case "chat":
      body = <TeamChatScreen currentUser={currentUser} onOpenJob={openJob} onRead={() => setChatUnread(0)} />;
      break;
    default:
      body = (
        <div className="page">
          <Blueprint style={{ padding: "22px 20px", maxWidth: 480 }}>
            <h4 style={{ margin: "0 0 6px", fontSize: 19 }}>Not one of your sections</h4>
            <div style={{ fontSize: 14, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
              This one isn't in your menu. Open the menu beside the wordmark to pick another, or ask an admin to add it.
            </div>
          </Blueprint>
        </div>
      );
  }

  return (
    <div style={{ minHeight: "100vh" }}>
      <header className="topbar">
        <button className="nav-toggle" aria-label="Sections" aria-expanded={menuOpen}
          onClick={() => setMenuOpen(v => !v)}>
          <span /><span /><span />
        </button>
        <button
          type="button"
          className="topbar-brand"
          aria-label="VagaboNDE — go to home"
          title="VagaboNDE"
          onClick={() => goto("board")}
          style={{ appearance: "none", border: "none", padding: 0, cursor: "pointer" }}
        />
        {/* The current section, named in the bar — with the tabs gone there is
            otherwise nothing telling you where you are. */}
        <span className="topbar-section" title={(TABS.find(t => t.key === screen) || {}).label || ""}
          style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 14, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--color-accent)" }}>
          {(TABS.find(t => t.key === screen) || {}).label || ""}
        </span>
        {cacheState.servingCached && (
          <TagX variant="warn" title={`No connection. Showing what this device saved at ${new Date(cacheState.at).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hour12: false })}.`}>
            Offline
          </TagX>
        )}
        <QueueBadge items={queued} onOpen={() => setShowQueue(true)} />
        {updateReady && updateDeferred && (
          <button
            type="button"
            className="tag tag-ok"
            onClick={() => SwUpdates.apply()}
            style={{ cursor: "pointer", font: "inherit" }}
            title="A new version is ready — tap to restart into it. Anything queued or auto-saved on this device survives the restart."
          >
            Update ready
          </button>
        )}
        {/* Just who is signed in. Signing out lives in the drawer, which is
            the only place it exists on a phone anyway, so having it in both
            was a second button for the same job on exactly one screen size.
            Below 760px the name has nowhere to go and becomes initials
            rather than nothing: these are shared tablets, and "am I still
            signed in as the last shift?" was two taps to answer. The chip
            carries the full name for anything reading the page aloud. */}
        <div className="topbar-who" style={{ fontSize: 13, display: "flex", alignItems: "center", marginLeft: "auto" }}>
          <span className="topbar-name">{currentUser.name}</span>
          <span className="topbar-initials" role="img" aria-label={`Signed in as ${currentUser.name}`}
            title={currentUser.name}>
            {initialsOf(currentUser.name)}
          </span>
        </div>
      </header>

      {/* The drawer, phone only. Rendered outside the bar so it can cover the
          screen, and only when open so its buttons are not in the tab order
          on a desktop where it is invisible. */}
      {menuVisible && (
        <div
          className={menuOpen ? "drawer-backdrop" : "drawer-backdrop closing"}
          onClick={() => setMenuOpen(false)}
          onAnimationEnd={() => { if (!menuOpen) setMenuVisible(false); }}
        >
          {/* A modal that says so. It covers the screen and takes Escape and
              a backdrop tap like a dialog, so it carries a dialog's promises
              too: focus moves in, Tab stays inside, focus goes back to the
              hamburger on the way out and the page behind stops scrolling —
              all of it in useModalPanel above. */}
          <nav className="drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-label="Sections"
            onClick={e => e.stopPropagation()}>
            <div className="topbar-brand" aria-hidden="true" style={{ margin: "18px auto 8px" }} />
            {allowedTabs.map(t => (
              <button key={t.key} className={screen === t.key ? "active" : ""}
                aria-current={screen === t.key ? "page" : undefined}
                onClick={() => goto(t.key)}>
                {t.label}
                {t.key === "mytickets" && openMyTicketsCount > 0 && (
                  <TagX variant="accent" style={{ marginLeft: 8 }}>{openMyTicketsCount}</TagX>
                )}
                {t.key === "chat" && chatUnread > 0 && (
                  <TagX variant="accent" style={{ marginLeft: 8 }}>{chatUnread}</TagX>
                )}
              </button>
            ))}
            <div className="drawer-foot">
              {/* Double-click your own name. Nothing announces it and nothing
                  depends on it; a double-click on a label is not something
                  anyone does by accident on the way to signing out. */}
              {/* The name yields first on a narrow drawer — an ellipsis on
                  your own name beats the theme buttons wrapping away. */}
              <span onDoubleClick={() => setEgg(true)}
                style={{ userSelect: "none", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {currentUser.name}
              </span>
              <Btn variant="secondary" onClick={signOut}>Sign out</Btn>
              {/* The bar drops the theme switch on the narrowest phones, so
                  the drawer carries it — in line with Sign out, where the
                  settings corner of the drawer lives. */}
              <div className="seg-theme" role="group" aria-label="Colour theme" style={{ display: "flex", marginLeft: "auto" }}>
                <button className={theme === "light" ? "active" : ""} aria-pressed={theme === "light"} onClick={() => setTheme("light")}>Light</button>
                <button className={theme === "dark" ? "active" : ""} aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>Dark</button>
              </div>
            </div>
            {/* The Switch carries no visible text of its own — the word
                beside it is the label people actually read. */}
            <div className="drawer-foot">
              {/* Not a screen: it opens a form that mails the office, and it
                  sits down here with the settings rather than in the tab
                  list — one more 52px row there made the drawer scroll on a
                  phone. The tabs are what the account may open; this is
                  for everyone. */}
              <Btn variant="secondary" onClick={() => { setMenuOpen(false); setShowFeature(true); }}>Feature request</Btn>
              <span style={{ marginLeft: "auto", color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>Animations</span>
              <Switch on={motion === "on"} onClick={() => setMotion(motion === "on" ? "off" : "on")} label="Animations" />
            </div>
            {/* Which build this device is on — name, commit, day — so "is
                everyone on the same version?" is a glance at each drawer,
                not a guess. Pinned to the drawer's bottom edge (the auto
                margin takes the slack), clear of the controls above.
                65% of the ink, not 40%: at 40% this measured 3.44:1 in dark
                and 2.41:1 in light, and it is the one line somebody is asked
                to read out loud over the radio. 65% is 4.93:1 light,
                6.99:1 dark. */}
            <div style={{ marginTop: "auto", padding: "12px 16px 0", textAlign: "center", fontSize: 10.5, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
              Version {typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev"}
            </div>
          </nav>
        </div>
      )}
      {egg && (
        <EggBoundary onBroken={() => setEgg(false)}>
          <Suspense fallback={null}>
            <Flappy880 onClose={() => setEgg(false)} me={currentUser} />
          </Suspense>
        </EggBoundary>
      )}

      {loadError && (
        <div className="page" style={{ paddingBottom: 0 }}>
          <ErrorBox>{loadError}</ErrorBox>
        </div>
      )}
      <main>
        {/* Keyed on the screen so switching tabs clears a crash rather than
            leaving the app stuck on the boundary's fallback. */}
        <ErrorBoundary resetKey={screen}>
          <Suspense fallback={<ScreenFallback />}>
            {/* Keyed on the screen so arriving anywhere plays the same
                short entrance; ScreenIn strips its own class once the
                entrance ends — see its comment for why that matters. */}
            <ScreenIn key={screen}>{body}</ScreenIn>
          </Suspense>
        </ErrorBoundary>
      </main>
      {/* The app's only save confirmation. It lives here rather than on each
          screen so every write is announced the same way and in the same
          place — and outside the ErrorBoundary and Suspense, so it survives a
          screen swap and isn't torn down mid-fade by a lazy chunk loading. */}
      {/* After main, not before it: a dialog rendered ahead of main sat under
          the jobs table — the table showed through the form and took the
          click meant for Send. The outbox panel was the same bug found a
          second time, still sitting above <main> while the fix for it was
          three lines below: on Job detail the record's own labels printed
          across the panel and the loading bar took the taps meant for Close
          and Try again now, which is the worst screen in the app to have
          unusable, since it is the one a technician opens when they are
          worried about unsent work. Both live here now, and .dialog-backdrop
          has a z-index (app.css) so the class of bug is shut rather than the
          two instances of it. */}
      {showQueue && (
        <QueueDialog items={queued} onRetry={retryQueue} onClose={() => setShowQueue(false)} />
      )}
      {showFeature && (
        <FeatureRequestDialog onClose={() => setShowFeature(false)} />
      )}
      {/* The screen's own introduction, the first time this account opens
          it. Gated on the screen the tip was raised for still being the
          screen underneath: one that changes out from under it — an account
          that loses a tab mid-session is moved elsewhere — would otherwise
          leave the last screen's words standing over the new one. */}
      {tipScreen && tipScreen === screen && (
        <HelpTip
          screenKey={tipScreen}
          onOk={() => setTipScreen(null)}
          onNoMore={() => { stopTips(Store, userId); setTipScreen(null); }}
        />
      )}
      {updateReady && !updateDeferred && <UpdateBanner onLater={() => setUpdateDeferred(true)} />}
      <Toast message={toast && toast.text} tone={toast && toast.tone} action={toast && toast.action}
        duration={toast && toast.action ? 6000 : undefined} onDone={() => setToast(null)} />
    </div>
  );
}
