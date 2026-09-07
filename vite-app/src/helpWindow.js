// How long the "?" stays in the top bar. Two days from the first time an
// account saw it on this device; after that the screens are known and the
// button is one more thing beside the section name. It goes on every
// screen at once — the clock is the account's, not a screen's.
//
// The record is a device preference in Store (localStorage), not a column:
// sign-out empties the device cache but not Store, so signing out and back
// in does not restart the clock, while another account on the same tablet
// keeps its own. A second device starts its own two days, which is fine —
// the person is learning a new screen size too.
//
// Pure on purpose: App.jsx hands in the Store and the clock, and the test
// next door reaches everything.

const DAY_MS = 24 * 60 * 60 * 1000;
export const HELP_WINDOW_MS = 2 * DAY_MS;

export function helpWindowKey(userId) {
  return "help.firstSeen." + userId;
}

// Is the button still offered? A first-seen that is not a time keeps the
// button: a bad record must never take the help away from a new hire.
export function helpOffered(firstSeenAt, now) {
  if (typeof firstSeenAt !== "number" || !Number.isFinite(firstSeenAt)) return true;
  return now - firstSeenAt < HELP_WINDOW_MS;
}

// Read the account's first sight on this device, writing `now` when there
// is none (or the record is not a time). Returns the timestamp, or null
// when there is no account to keep it for.
export function noteHelpFirstSeen(store, userId, now) {
  if (!userId) return null;
  const key = helpWindowKey(userId);
  const stored = store.load(key, null);
  if (typeof stored === "number" && Number.isFinite(stored)) return stored;
  store.save(key, now);
  return now;
}
