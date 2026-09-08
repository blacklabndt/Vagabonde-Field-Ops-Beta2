// A screen introduces itself once, and "No more tips" means every screen.
// The records are per account on this device, so a shared tablet does not
// hand the next person somebody else's tour. Run with:
// node --test src/helpTips.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tipSeenKey, tipsOffKey, tipsAreOff, tipDue, noteTipSeen, stopTips
} from "./helpTips.js";

function fakeStore() {
  const rows = {};
  return {
    rows,
    load: (k, fb) => (k in rows ? rows[k] : fb),
    save: (k, v) => { rows[k] = v; }
  };
}

test("a screen owes its tip until it has been seen", () => {
  const store = fakeStore();
  assert.equal(tipDue(store, "abc", "board"), true);
  noteTipSeen(store, "abc", "board");
  assert.equal(tipDue(store, "abc", "board"), false);
  // Another screen is a separate introduction.
  assert.equal(tipDue(store, "abc", "ticket"), true);
});

test("each account on the tablet has its own screens seen", () => {
  const store = fakeStore();
  noteTipSeen(store, "abc", "board");
  assert.equal(tipDue(store, "def", "board"), true);
  assert.notEqual(tipSeenKey("abc", "board"), tipSeenKey("def", "board"));
});

test("no more tips silences every screen, for that account alone", () => {
  const store = fakeStore();
  stopTips(store, "abc");
  assert.equal(tipsAreOff(store, "abc"), true);
  assert.equal(tipDue(store, "abc", "board"), false);
  assert.equal(tipDue(store, "abc", "chat"), false);
  assert.equal(tipsAreOff(store, "def"), false);
  assert.equal(tipDue(store, "def", "board"), true);
  assert.notEqual(tipsOffKey("abc"), tipsOffKey("def"));
});

test("a record that is not the word yes leaves the help where it is", () => {
  const store = fakeStore();
  store.save(tipsOffKey("abc"), "quiet");
  assert.equal(tipsAreOff(store, "abc"), false);
  store.save(tipSeenKey("abc", "board"), "sort of");
  assert.equal(tipDue(store, "abc", "board"), true);
});

// The switch is one-way on purpose: there is no drawer control to start the
// tips again, so nothing in this module may quietly offer one.
test("stopping the tips is the last word on them", () => {
  const store = fakeStore();
  stopTips(store, "abc");
  stopTips(store, "abc");
  assert.equal(tipsAreOff(store, "abc"), true);
  assert.equal(tipDue(store, "abc", "board"), false);
  // A screen visited after the switch went off is not marked seen by the
  // popup that never appeared, but it stays quiet all the same.
  assert.equal(tipDue(store, "abc", "equipment"), false);
});

test("no account means no record and nothing due", () => {
  const store = fakeStore();
  assert.equal(tipDue(store, null, "board"), false);
  assert.equal(tipDue(store, "abc", ""), false);
  noteTipSeen(store, null, "board");
  stopTips(store, "");
  assert.deepEqual(Object.keys(store.rows), []);
});
