// The "?" in the top bar is for the first two days. After that the screen
// is known and the button is clutter beside the section name, so it goes —
// on every screen at once, because the clock is the account's on this
// device, not a screen's. Run with: node --test src/helpWindow.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { HELP_WINDOW_MS, helpWindowKey, helpOffered, noteHelpFirstSeen } from "./helpWindow.js";

const DAY = 24 * 60 * 60 * 1000;

test("the window is two days", () => {
  assert.equal(HELP_WINDOW_MS, 2 * DAY);
});

test("the button is offered inside the window and gone after it", () => {
  const seen = 1_700_000_000_000;
  assert.equal(helpOffered(seen, seen), true);
  assert.equal(helpOffered(seen, seen + DAY), true);
  assert.equal(helpOffered(seen, seen + HELP_WINDOW_MS - 1), true);
  assert.equal(helpOffered(seen, seen + HELP_WINDOW_MS), false);
  assert.equal(helpOffered(seen, seen + 30 * DAY), false);
});

test("a first-seen that is missing or not a time keeps the button rather than taking it", () => {
  const now = 1_700_000_000_000;
  assert.equal(helpOffered(null, now), true);
  assert.equal(helpOffered(undefined, now), true);
  assert.equal(helpOffered(NaN, now), true);
  assert.equal(helpOffered("yesterday", now), true);
});

test("a clock that went backwards is still inside the window", () => {
  const seen = 1_700_000_000_000;
  assert.equal(helpOffered(seen, seen - DAY), true);
});

function fakeStore() {
  const rows = {};
  return {
    rows,
    load: (k, fb) => (k in rows ? rows[k] : fb),
    save: (k, v) => { rows[k] = v; }
  };
}

test("the first sight is written once, per account, and read back after", () => {
  const store = fakeStore();
  const first = noteHelpFirstSeen(store, "abc", 1000);
  assert.equal(first, 1000);
  assert.equal(store.rows[helpWindowKey("abc")], 1000);
  // A later sign-in reads the original, never moves it.
  assert.equal(noteHelpFirstSeen(store, "abc", 5000), 1000);
  assert.equal(store.rows[helpWindowKey("abc")], 1000);
  // Another account on the same tablet has its own clock.
  assert.equal(noteHelpFirstSeen(store, "def", 5000), 5000);
  assert.notEqual(helpWindowKey("abc"), helpWindowKey("def"));
});

test("a stored value that is not a time is replaced with now", () => {
  const store = fakeStore();
  store.save(helpWindowKey("abc"), "soon");
  assert.equal(noteHelpFirstSeen(store, "abc", 7000), 7000);
  assert.equal(store.rows[helpWindowKey("abc")], 7000);
});

test("no account means no record and no clock", () => {
  const store = fakeStore();
  assert.equal(noteHelpFirstSeen(store, null, 7000), null);
  assert.equal(noteHelpFirstSeen(store, "", 7000), null);
  assert.deepEqual(Object.keys(store.rows), []);
});
