// A screen says its piece once per run of the app and comes back on the
// next launch; "No more tips" ends them everywhere for good. The kill
// switch is per account on this device, so a shared tablet does not silence
// the next person's help. Run with: node --test src/helpTips.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tipsOffKey, tipsAreOff, tipDue, noteTipSeen, stopTips, tipRun
} from "./helpTips.js";

function fakeStore() {
  const rows = {};
  return {
    rows,
    load: (k, fb) => (k in rows ? rows[k] : fb),
    save: (k, v) => { rows[k] = v; }
  };
}

test("a screen speaks once a run, and the other screens still speak", () => {
  const store = fakeStore();
  const run = tipRun();
  assert.equal(tipDue(store, "abc", "board", run), true);
  noteTipSeen(run, "board");
  assert.equal(tipDue(store, "abc", "board", run), false);
  // Leaving a screen and coming back to it is not a second introduction.
  assert.equal(tipDue(store, "abc", "board", run), false);
  // Every other screen is still owed its own.
  assert.equal(tipDue(store, "abc", "ticket", run), true);
});

test("the next run of the app starts the tips over", () => {
  const store = fakeStore();
  const first = tipRun();
  noteTipSeen(first, "board");
  noteTipSeen(first, "chat");
  // A reload, a fresh tab, the icon on a tablet: a new run, nothing said.
  const second = tipRun();
  assert.equal(tipDue(store, "abc", "board", second), true);
  assert.equal(tipDue(store, "abc", "chat", second), true);
  // Nothing about a run is written down.
  assert.deepEqual(Object.keys(store.rows), []);
});

test("no more tips is the kill switch, this account alone", () => {
  const store = fakeStore();
  stopTips(store, "abc");
  assert.equal(tipsAreOff(store, "abc"), true);
  assert.equal(tipDue(store, "abc", "board", tipRun()), false);
  assert.equal(tipDue(store, "abc", "chat", tipRun()), false);
  // And it outlives the run that pressed it — the point of writing it down.
  assert.equal(tipDue(store, "abc", "board", tipRun()), false);
  assert.equal(tipsAreOff(store, "def"), false);
  assert.equal(tipDue(store, "def", "board", tipRun()), true);
  assert.notEqual(tipsOffKey("abc"), tipsOffKey("def"));
});

test("a record that is not the word yes leaves the help where it is", () => {
  const store = fakeStore();
  store.save(tipsOffKey("abc"), "quiet");
  assert.equal(tipsAreOff(store, "abc"), false);
  assert.equal(tipDue(store, "abc", "board", tipRun()), true);
});

test("no account and no screen mean nothing is owed; a missing run does not", () => {
  const store = fakeStore();
  assert.equal(tipDue(store, null, "board", tipRun()), false);
  assert.equal(tipDue(store, "abc", "", tipRun()), false);
  // A missing run is not an excuse to stay silent — the screen has said
  // nothing, so it is owed.
  assert.equal(tipDue(store, "abc", "board", null), true);
  noteTipSeen(null, "board");
  stopTips(store, "");
  assert.deepEqual(Object.keys(store.rows), []);
});
