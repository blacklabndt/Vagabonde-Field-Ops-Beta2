// One place that says "that saved".
//
// The confirmation used to live on the two screens that happened to have one,
// so most of the app saved silently — you typed, something went quiet, and you
// found out later whether it landed. Rather than adding a toast to thirty call
// sites and missing some, the data layer announces its own writes and this
// carries the message to the single Toast in App.
//
// Deliberately not React: db.js is UI-agnostic and should stay that way. It
// emits a string; who draws it is not its business.

const listeners = new Set();

// Bulk actions call the same write in a loop — chasing twenty unsigned tickets
// is twenty sends. Repeating one message twenty times is noise, so an
// identical message inside this window is dropped.
const DEDUPE_MS = 1200;
let last = { text: "", at: 0 };
// What is on screen right now, so a screen on its way out can take down its
// own Undo without silencing somebody else's confirmation.
let showing = null;

// Replaying the offline queue calls the same Db methods a person would, but
// nobody pressed anything — the work was queued hours ago on a lease with no
// signal. The queue has its own badge and panel to report that, so toasts stay
// out of the way while it drains.
let muted = 0;

export const Toasts = {
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  // `force` is for the one message a muted replay must still deliver: the
  // outbox completed an item but could not apply all of it, and nobody
  // would otherwise hear.
  // `action` is an optional { label, onClick } the toast draws as a button —
  // the "Undo" on a reversible removal. It rides through here so the single
  // Toast in App can render it without every caller reaching into App.
  show(text, tone = "ok", force = false, action = null) {
    if (!text || (muted && !force)) return;
    const now = Date.now();
    // A toast with an Undo on it is never noise: the same "Removed Bob"
    // inside the window is a second removal — × , Undo, × again — and
    // dropping it took the person's hours off with no way back.
    if (!action && text === last.text && now - last.at < DEDUPE_MS) return;
    last = { text, at: now };
    showing = { text, tone, at: now, action };
    listeners.forEach(fn => { fn(showing); });
  },

  // Take down a toast that is carrying an action. An Undo means something
  // only on the screen that raised it, and only until the removal has been
  // written: left up, it followed a saved ticket onto the job page, where
  // pressing it set state on a component that had gone — the button vanished
  // and nothing came back. A plain confirmation is left alone, so "Ticket
  // saved" still gets its moment.
  clearAction() {
    if (!showing || !showing.action) return;
    showing = null;
    last = { text: "", at: 0 };
    listeners.forEach(fn => { fn(null); });
  },

  // Counted rather than boolean, so overlapping replays can't unmute early.
  mute() { muted++; },
  unmute() { muted = Math.max(0, muted - 1); }
};
