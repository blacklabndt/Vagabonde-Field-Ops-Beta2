// What a save says while it is still waiting, and the one question that lets
// it not wait at all.
//
// Out of range, a save has to fail before the outbox can take the work, and
// the token refresh in front of it has to time out first: measured in the
// field, about eight seconds of a dimmed, frozen form saying "Saving…" and
// nothing else. In a truck that reads as a hung app, and the natural response
// is to press the button again. Two things fix it — not asking at all when
// the device already knows there is no signal, and saying so while the wait
// is happening when it doesn't.
//
// Both live here, away from React, so three screens share one decision that a
// test can read back rather than three copies of a ternary.

// Long enough that a save made in signal never shows the second wording —
// those land well inside two seconds — and short enough that a long wait is
// only silent for a quarter of itself.
export const SLOW_SAVE_MS = 2000;

// Names what is happening and where the work ends up if the radio never
// answers, because the outbox is exactly what the person is afraid isn't
// there.
export const SLOW_SAVE_WORDS = "Still trying — no signal? It will be kept on this device.";

// `base` is the screen's own word for what it is doing — "Saving…",
// "Filing…", "Sending…" — and it keeps saying that until the wait is long
// enough to need explaining. A time that is not a number is treated as the
// start of the wait: a broken clock must not put the screen into its
// worried wording.
export function savingLabel(elapsedMs, base) {
  const ms = Number(elapsedMs);
  if (!Number.isFinite(ms) || ms < SLOW_SAVE_MS) return base;
  return SLOW_SAVE_WORDS;
}

// Whether the device itself already knows it has no connection. Only a flat
// `false` counts: `onLine` reads true for a tablet sitting on a truck's wifi
// with nothing behind it, so a true answer means "ask the server", never "we
// are online". The navigator comes in as a parameter so this can be read
// back without a browser.
export function deviceOffline(nav = typeof navigator === "undefined" ? null : navigator) {
  return !!nav && nav.onLine === false;
}

// What one failed read is worth saying out loud. A PostgREST error carries a
// code beside its message, and the code is the half that says whose problem
// it is: 42501 is a missing GRANT in the database, which no amount of
// reloading or signing in again will fix and which the person looking at the
// screen can do nothing about but report. Saying so — with the code, so the
// office can look it up — beats a sentence about permissions that reads like
// the account's own fault.
//
// Everything else is passed through as the server worded it: a network
// failure, a timeout and a broken filter all read better in their own words
// than under a category this function would have to guess at.
export function readFailure(err) {
  const msg = (err && err.message) || "";
  const code = (err && err.code) || "";
  if (code === "42501" || /permission denied/i.test(msg)) {
    return `${msg || "permission denied"} (database grant ${code || "42501"} — the office's to fix, not yours)`;
  }
  return msg || "the read failed";
}
