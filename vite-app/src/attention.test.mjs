// The reading of the records that Home's attention strip and the daily
// digest both act on. The cases that matter are the four things worth
// telling the office about, and — just as much — the ordinary morning
// where the answer has to be nothing at all.

import test from "node:test";
import assert from "node:assert/strict";
import {
  attentionItems, agoPhrase, ERRORS_WINDOW_MS, OVERDUE_GRACE_MS,
  attentionSignature, attentionDismissedKey, attentionSuppressed, dismissAttention
} from "./attention.js";

const NOW = Date.parse("2026-09-06T18:00:00Z");
const agoMs = ms => new Date(NOW - ms).toISOString();
const days = n => n * 86400000;
const hours = n => n * 3600000;

const keys = items => items.map(i => i.key);
const find = (items, key) => items.find(i => i.key === key);

function fakeStore() {
  const rows = {};
  return {
    rows,
    load: (k, fb) => (k in rows ? rows[k] : fb),
    save: (k, v) => { rows[k] = v; }
  };
}

test("an ordinary morning says nothing", () => {
  const state = {
    connected: true,
    connection_error: null,
    next_run_at: new Date(NOW + hours(8)).toISOString(),
    last_run: { kind: "backup", status: "complete", finished_at: agoMs(hours(16)) }
  };
  assert.deepEqual(attentionItems(state, [], NOW), []);
});

test("nothing read at all is nothing to say, not a crash", () => {
  assert.deepEqual(attentionItems(null, null, NOW), []);
  assert.deepEqual(attentionItems({}, [], NOW), []);
});

test("a failed backup names the failure but keeps the raw error off the board", () => {
  const state = {
    connected: true,
    next_run_at: new Date(NOW + hours(2)).toISOString(),
    last_run: {
      kind: "backup", status: "failed", finished_at: agoMs(days(3)),
      error: "TypeError: error sending request … connection reset"
    }
  };
  const items = attentionItems(state, [], NOW);
  assert.deepEqual(keys(items), ["failed-run"]);
  const it = find(items, "failed-run");
  // The fact, not the stack: the reason is one click away in the log.
  assert.equal(it.text, "Last backup failed 3 days ago");
  assert.doesNotMatch(it.text, /TypeError|connection reset/);
  // And the board points at the card that holds it.
  assert.match(it.where, /Recent background errors/);
});

test("a failed restore is not called a backup", () => {
  const state = {
    connected: true,
    last_run: { kind: "restore_all", status: "failed", finished_at: agoMs(hours(2)) }
  };
  const items = attentionItems(state, [], NOW);
  assert.equal(find(items, "failed-run").text, "Last restore failed 2 hours ago");
});

test("a run that finished is not news", () => {
  const state = {
    connected: true,
    next_run_at: new Date(NOW + hours(2)).toISOString(),
    last_run: { kind: "backup", status: "complete", finished_at: agoMs(days(3)) }
  };
  assert.deepEqual(attentionItems(state, [], NOW), []);
});

test("a lapsed drive connection is the first thing said", () => {
  const state = {
    connected: true,
    connection_error: "Google refused the saved permission (invalid_grant).",
    next_run_at: agoMs(days(2)),
    last_run: { kind: "backup", status: "failed", finished_at: agoMs(days(2)) }
  };
  const items = attentionItems(state, [], NOW);
  assert.equal(items[0].key, "connection");
  assert.match(items[0].text, /needs reconnecting — Google refused/);
  assert.match(items[0].where, /connect the drive again/);
  // The overdue line is left off on purpose: the reconnect line above is
  // already the cause and the fix, and "press Back up now" cannot work
  // until the drive is back.
  assert.deepEqual(keys(items), ["connection", "failed-run"]);
});

test("a due date well in the past means nothing is picking the schedule up", () => {
  const state = {
    connected: true,
    connection_error: null,
    next_run_at: agoMs(days(2)),
    last_run: { kind: "backup", status: "complete", finished_at: agoMs(days(3)) }
  };
  const items = attentionItems(state, [], NOW);
  assert.deepEqual(keys(items), ["overdue"]);
  assert.equal(find(items, "overdue").text, "A backup was due 2 days ago and has not started");
});

test("a backup a little late is not late enough to say", () => {
  const state = { connected: true, next_run_at: agoMs(OVERDUE_GRACE_MS - hours(1)) };
  assert.deepEqual(attentionItems(state, [], NOW), []);
});

test("a drive that was never connected has no schedule to be late for", () => {
  const state = { connected: false, next_run_at: agoMs(days(5)) };
  assert.deepEqual(attentionItems(state, [], NOW), []);
});

test("background errors inside the day are counted and grouped by function", () => {
  const errors = [
    { function_name: "backup-run", created_at: agoMs(hours(1)) },
    { function_name: "chat-push", created_at: agoMs(hours(3)) },
    { function_name: "chat-push", created_at: agoMs(hours(4)) },
    { function_name: "chat-push", created_at: agoMs(hours(20)) }
  ];
  const items = attentionItems({}, errors, NOW);
  assert.deepEqual(keys(items), ["errors"]);
  assert.equal(
    find(items, "errors").text,
    "4 background errors since yesterday — chat-push (3), backup-run (1)"
  );
  assert.match(find(items, "errors").where, /Recent background errors/);
});

test("errors older than the day are left out, and one error is singular", () => {
  const errors = [
    { function_name: "chat-push", created_at: agoMs(hours(2)) },
    { function_name: "chat-push", created_at: agoMs(ERRORS_WINDOW_MS + hours(1)) },
    { function_name: "backup-run", created_at: agoMs(days(6)) }
  ];
  const items = attentionItems({}, errors, NOW);
  assert.equal(find(items, "errors").text, "1 background error since yesterday — chat-push (1)");
});

test("a row stamped a minute ahead of this device's clock still counts", () => {
  const errors = [{ function_name: "chat-push", created_at: new Date(NOW + 60000).toISOString() }];
  assert.equal(attentionItems({}, errors, NOW).length, 1);
});

test("agoPhrase reads like a person saying it", () => {
  assert.equal(agoPhrase(0), "less than an hour ago");
  assert.equal(agoPhrase(hours(1)), "1 hour ago");
  assert.equal(agoPhrase(hours(23)), "23 hours ago");
  assert.equal(agoPhrase(days(1)), "1 day ago");
  assert.equal(agoPhrase(days(9)), "9 days ago");
});

// ─── the dismissal signature ───────────────────────────────────────────
// The strip can be waved away once the Admin has read it, and stays down
// until the trouble itself changes: a new error, a cleared failure, a
// higher count. The signature is how "the same trouble" is recognised.

test("the signature is steady for one state and empty when there is nothing to say", () => {
  const trouble = {
    connected: true,
    next_run_at: new Date(NOW + hours(2)).toISOString(),
    last_run: { kind: "backup", status: "failed", finished_at: agoMs(hours(2)) }
  };
  const a = attentionSignature(attentionItems(trouble, [], NOW));
  const again = attentionSignature(attentionItems(trouble, [], NOW));
  assert.equal(a, again);
  assert.notEqual(a, "");

  // An ordinary morning signs as nothing, so it can never read as dismissed.
  const calm = {
    connected: true,
    next_run_at: new Date(NOW + hours(8)).toISOString(),
    last_run: { kind: "backup", status: "complete", finished_at: agoMs(hours(2)) }
  };
  assert.equal(attentionSignature(attentionItems(calm, [], NOW)), "");
  assert.equal(attentionSignature([]), "");
});

test("a new error, or one more of them, moves the signature", () => {
  const failing = { connected: true, next_run_at: new Date(NOW + hours(2)).toISOString(),
    last_run: { kind: "backup", status: "failed", finished_at: agoMs(hours(2)) } };
  const bare = attentionSignature(attentionItems(failing, [], NOW));
  const withOne = attentionSignature(attentionItems(failing, [
    { function_name: "chat-push", created_at: agoMs(hours(1)) }
  ], NOW));
  const withTwo = attentionSignature(attentionItems(failing, [
    { function_name: "chat-push", created_at: agoMs(hours(1)) },
    { function_name: "chat-push", created_at: agoMs(hours(2)) }
  ], NOW));
  // A fresh error appearing, and then a second one, each change the signature.
  assert.notEqual(withOne, bare);
  assert.notEqual(withTwo, withOne);
});

test("a dismissed strip stays down until its signature changes", () => {
  const store = fakeStore();
  const sig = "failed-run:2026-09-04";
  assert.equal(attentionSuppressed(store, "admin1", sig), false);
  dismissAttention(store, "admin1", sig);
  assert.equal(attentionSuppressed(store, "admin1", sig), true);
  // A different signature — the trouble changed — is not covered.
  assert.equal(attentionSuppressed(store, "admin1", sig + "|errors:1@z"), false);
  // Per account on the device: another Admin is not silenced by the first.
  assert.equal(attentionSuppressed(store, "admin2", sig), false);
  assert.notEqual(attentionDismissedKey("admin1"), attentionDismissedKey("admin2"));
});

test("nothing to say is never suppressed, and nothing is written for a non-signature", () => {
  const store = fakeStore();
  // An empty signature must never match a stored dismissal — else a calm
  // morning after a dismissed night would read as "still dismissed".
  dismissAttention(store, "admin1", "sig");
  assert.equal(attentionSuppressed(store, "admin1", ""), false);
  // No account, no signature: nothing is stored.
  dismissAttention(store, "", "sig");
  dismissAttention(store, "admin3", "");
  assert.deepEqual(Object.keys(store.rows), [attentionDismissedKey("admin1")]);
});
