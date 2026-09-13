// Tests for the save-confirmation bus.
//
// Run with: node --test src/toastBus.test.mjs
//
// Worth testing because the two rules that make it usable are both invisible
// until they misbehave. The dedupe window is what stops a bulk action firing
// twenty identical toasts; the mute is what stops the offline queue announcing
// work nobody just did. Neither shows up in a screenshot, and both are the
// kind of thing a later refactor quietly breaks.

import test from "node:test";
import assert from "node:assert/strict";
import { Toasts } from "./toastBus.js";
import { readFileSync } from "node:fs";

// Each test collects what the bus emitted, then detaches.
function collect() {
  const seen = [];
  const off = Toasts.subscribe(t => seen.push(t.text));
  return { seen, off };
}

// The dedupe window is keyed on the message text, so distinct text in each
// test keeps them from interfering with one another.
let n = 0;
const unique = () => `msg-${++n}`;

test("a save reaches every subscriber", () => {
  const a = collect(), b = collect();
  const m = unique();
  Toasts.show(m);
  a.off(); b.off();
  assert.deepEqual(a.seen, [m]);
  assert.deepEqual(b.seen, [m], "a second subscriber should see it too");
});

test("unsubscribing stops delivery", () => {
  const { seen, off } = collect();
  off();
  Toasts.show(unique());
  assert.deepEqual(seen, [], "nothing should arrive after unsubscribe");
});

test("the same message twice in quick succession is announced once", () => {
  const { seen, off } = collect();
  const m = unique();
  Toasts.show(m);
  Toasts.show(m);
  Toasts.show(m);
  off();
  assert.deepEqual(seen, [m], "chasing twenty tickets should say it once");
});

test("different messages are not deduped against each other", () => {
  const { seen, off } = collect();
  const a = unique(), b = unique();
  Toasts.show(a);
  Toasts.show(b);
  off();
  assert.deepEqual(seen, [a, b]);
});

test("an empty message is not announced", () => {
  const { seen, off } = collect();
  Toasts.show("");
  Toasts.show(null);
  Toasts.show(undefined);
  off();
  assert.deepEqual(seen, []);
});

test("muting silences saves, and unmuting restores them", () => {
  const { seen, off } = collect();
  const during = unique(), after = unique();
  Toasts.mute();
  Toasts.show(during);
  Toasts.unmute();
  Toasts.show(after);
  off();
  assert.deepEqual(seen, [after], "only the un-muted save should be heard");
});

test("mute is counted, so nesting cannot unmute early", () => {
  const { seen, off } = collect();
  const inner = unique(), outer = unique(), done = unique();
  Toasts.mute();          // e.g. a queue replay
  Toasts.mute();          // e.g. createClient seeding its rate card inside it
  Toasts.unmute();        // the inner one finishes...
  Toasts.show(inner);     // ...and must still be silent
  Toasts.unmute();        // now the outer one finishes
  Toasts.show(outer);
  off();
  assert.deepEqual(seen, [outer], "a nested unmute must not reopen the gate");
  assert.ok(!seen.includes(inner));
  assert.ok(!seen.includes(done));
});

test("an unbalanced unmute cannot drive the counter negative", () => {
  const { seen, off } = collect();
  const m = unique();
  // A stray unmute — a `finally` running twice, say — must not leave the bus
  // in a state where a later mute() no longer mutes.
  Toasts.unmute();
  Toasts.unmute();
  Toasts.mute();
  Toasts.show(m);
  Toasts.unmute();
  off();
  assert.deepEqual(seen, [], "mute must still work after a stray unmute");
});

test("a tone is carried through to the subscriber", () => {
  const seen = [];
  const off = Toasts.subscribe(t => seen.push(t));
  Toasts.show(unique(), "error");
  off();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tone, "error");
});

test("tone defaults to ok", () => {
  const seen = [];
  const off = Toasts.subscribe(t => seen.push(t));
  Toasts.show(unique());
  off();
  assert.equal(seen[0].tone, "ok");
});

test("a toast carrying an action is never deduped: the same removal twice is two Undos", () => {
  const seen = [];
  const off = Toasts.subscribe(t => seen.push(t));
  const m = unique();
  const action = { label: "Undo", onClick() {} };
  Toasts.show(m, "ok", false, action);
  Toasts.show(m, "ok", false, action);
  off();
  assert.equal(seen.length, 2, "x, Undo, x again must offer the Undo again");
  assert.equal(seen[1].action, action);
});

test("clearAction takes down an action toast and leaves a plain one alone", () => {
  const seen = [];
  const off = Toasts.subscribe(t => seen.push(t));
  Toasts.show(unique(), "ok", false, { label: "Undo", onClick() {} });
  Toasts.clearAction();
  assert.equal(seen.length, 2);
  assert.equal(seen[1], null, "an action toast is cleared with a null");
  const plain = unique();
  Toasts.show(plain);
  Toasts.clearAction();
  off();
  assert.equal(seen.length, 3, "a plain confirmation is not cleared");
  assert.equal(seen[2].text, plain);
});

test("a screen clears its own action toast and not another's", () => {
  const seen = [];
  const off = Toasts.subscribe(t => seen.push(t));
  // The chase from Ask puts its Stop button up...
  Toasts.show(unique(), "ok", true, { label: "Stop", owner: "chase", onClick() {} });
  // ...and the ticket editor unmounts underneath it.
  Toasts.clearAction("ticket-editor");
  assert.equal(seen.length, 1, "the chase's Stop must survive somebody else's unmount");
  Toasts.clearAction("chase");
  off();
  assert.equal(seen.length, 2);
  assert.equal(seen[1], null, "the owner takes down its own");
});

test("an unowned action toast is still cleared by anyone", () => {
  const seen = [];
  const off = Toasts.subscribe(t => seen.push(t));
  Toasts.show(unique(), "ok", false, { label: "Undo", onClick() {} });
  Toasts.clearAction("chase");
  off();
  assert.equal(seen[1], null, "a caller that names no owner keeps the old behaviour");
});

test("each toast carries its own stamp, so the same words twice are two toasts", () => {
  const seen = [];
  const off = Toasts.subscribe(t => seen.push(t));
  const m = unique();
  const action = { label: "Undo", owner: "ticket-editor", onClick() {} };
  Toasts.show(m, "ok", false, action);
  const first = seen[0].at;
  // Busy-wait a millisecond: the stamp is what the Toast component keys its
  // countdown on, and two toasts sharing one are one timer for two removals.
  const spin = Date.now();
  while (Date.now() === spin) { /* one tick */ }
  Toasts.show(m, "ok", false, action);
  off();
  assert.equal(seen.length, 2);
  assert.notEqual(seen[1].at, first, "the second removal needs its own clock");
});

// The stamp is only worth emitting if the drawing end keys its countdown on
// it, and that half is JSX the node suite cannot mount. Read it back instead.
test("the Toast re-arms its countdown per toast, not per wording", () => {
  const common = readFileSync(new URL("./components/common.jsx", import.meta.url), "utf8");
  assert.match(common, /\}, \[message, duration, tone, at\]\);/,
    "the timer effect must list `at`, or two identical messages share one clock");
  const app = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  assert.match(app, /at=\{toast \? toast\.at : 0\}/, "and App must hand the stamp down");
});
