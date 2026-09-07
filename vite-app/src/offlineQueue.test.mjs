// Tests for the outbox — the half of working offline that carries work *out*.
//
// Run with: node --test src/offlineQueue.test.mjs
//
// Everything here is a rule the crew depends on and nobody can see: the order
// a truck's day replays in, a half-written ticket that must not come back as
// two, an error that has to stay visible instead of quietly vanishing, and the
// shared tablet where the next technician must not inherit the last one's
// outbox. None of it is reachable by clicking — it only happens with no signal.

// IndexedDB before the module: offlineQueue.js reaches for the global the
// moment anything is queued, and there is no such thing in node.
import "fake-indexeddb/auto";
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// `navigator` is a getter-only global in node, so a plain assignment throws
// in a module (strict mode) — it has to be defined over. `window` doesn't
// exist at all, so that one is an ordinary assignment. Both are read at call
// time, never at import, but they are put in place first all the same.
const nav = { onLine: true };
Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

const { OfflineQueue, isNetworkError } = await import("./offlineQueue.js");

// The queue notifies its subscribers without being awaited (a save path must
// never hang on the badge). Poll for the outcome rather than sleeping for a
// round number and hoping.
async function eventually(fn, what = "the expected state", ms = 2000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

// Queue an item as though it were saved at a given moment. Real clock ties
// would make "replays in order" a statement about how fast the machine ran.
async function queuedAt(ts, type, payload) {
  const real = Date.now;
  Date.now = () => ts;
  try { return await OfflineQueue.enqueue(type, payload); }
  finally { Date.now = real; }
}

// One IndexedDB database for the whole file — so every test leaves it empty.
// Swept as each owner the tests sign in as, then as nobody: with no owner
// set only unstamped items are visible, so a sweep as nobody alone would
// leave a signed-in technician's items behind for the next test to trip on.
const OWNERS = ["tech-a", "tech-b", null];
async function emptyOutbox() {
  for (const owner of OWNERS) {
    OfflineQueue.setOwner(owner);
    for (const item of await OfflineQueue.list()) await OfflineQueue.remove(item.id);
  }
  OfflineQueue.setOwner(null);
  nav.onLine = true;
}
beforeEach(emptyOutbox);
afterEach(emptyOutbox);

test("a network failure is queueable; a real answer from the server is not", () => {
  assert.equal(isNetworkError(new TypeError("Failed to fetch")), true);
  assert.equal(isNetworkError(new TypeError("Load failed")), true, "Safari's wording");
  assert.equal(isNetworkError(new Error("NetworkError when attempting to fetch resource.")), true);
  assert.equal(isNetworkError(new Error("This job is completed")), false, "a real error must surface, not queue");
  assert.equal(isNetworkError(new Error("permission denied for table tickets")), false);
});

test("the browser knowing it has no signal makes any failure a connectivity one", () => {
  nav.onLine = false;
  assert.equal(isNetworkError(new Error("whatever the request managed to say")), true);
  nav.onLine = true;
  assert.equal(isNetworkError(new Error("whatever the request managed to say")), false);
});

test("the outbox replays in the order the work was done, not the order it comes off disk", async () => {
  // Queued deliberately out of order: a jobs-before-what-is-raised-against-it
  // replay is the whole reason createdAt is the sort key.
  await queuedAt(3_000, "ticket", { n: 3 });
  await queuedAt(1_000, "job", { n: 1 });
  await queuedAt(2_000, "jha", { n: 2 });

  assert.deepEqual((await OfflineQueue.list()).map(i => i.payload.n), [1, 2, 3], "and the panel lists them in that order too");

  const replayed = [];
  const record = async p => { replayed.push(p.n); };
  const r = await OfflineQueue.flush({ job: record, jha: record, ticket: record });

  assert.deepEqual(replayed, [1, 2, 3]);
  assert.deepEqual(r, { synced: 3, stillOffline: false });
  assert.deepEqual(await OfflineQueue.list(), [], "everything that synced is gone from the outbox");
});

test("a checkpoint written mid-replay is what the retry starts from", async () => {
  // The ticket handler's first write creates the row and mints its number;
  // the crew rows follow. Signal dropping between the two is the normal
  // condition out there — without the checkpoint the retry starts at the top
  // and the job ends up with a second ticket, a second number, and the first
  // left with no crew on it.
  await queuedAt(1_000, "ticket", { jobId: "J-77", ticketId: null, crew: ["a", "b"] });

  let sawFirst = null;
  const first = await OfflineQueue.flush({
    ticket: async (payload, checkpoint) => {
      sawFirst = payload;
      await checkpoint({ ticketId: "AT-0902-26-01" });
      throw new TypeError("Failed to fetch");
    }
  });
  assert.equal(sawFirst.ticketId, null, "the first attempt started from nothing");
  assert.deepEqual(first, { synced: 0, stillOffline: true });

  const parked = await OfflineQueue.list();
  assert.equal(parked.length, 1);
  assert.equal(parked[0].payload.ticketId, "AT-0902-26-01", "the checkpoint reached disk before the failure did");
  assert.equal(parked[0].lastError, null, "a lost signal is not something to report as an error");

  let sawRetry = null;
  const second = await OfflineQueue.flush({ ticket: async payload => { sawRetry = payload; } });
  assert.equal(sawRetry.ticketId, "AT-0902-26-01", "the retry picks up where the last one got to");
  assert.equal(sawRetry.jobId, "J-77", "and the rest of the payload came with it");
  assert.deepEqual(sawRetry.crew, ["a", "b"]);
  assert.equal(second.synced, 1);
  assert.deepEqual(await OfflineQueue.list(), []);
});

test("a permanent failure keeps the item with its reason, and the rest still go", async () => {
  await queuedAt(1_000, "ticket", { n: 1 });
  await queuedAt(2_000, "ticket", { n: 2 });

  const r = await OfflineQueue.flush({
    ticket: async p => {
      if (p.n === 1) throw new Error("J-77 was completed — no more tickets can be raised against it.");
    }
  });

  assert.deepEqual(r, { synced: 1, stillOffline: false }, "one refused item does not stop the truck's other work");
  const left = await OfflineQueue.list();
  assert.equal(left.length, 1);
  assert.equal(left[0].payload.n, 1, "the refused one is still here — nothing else holds a copy of it");
  assert.match(left[0].lastError, /was completed/, "with the reason attached, for the panel to show");
});

test("a lost signal stops the flush and leaves everything exactly as it was", async () => {
  await queuedAt(1_000, "ticket", { n: 1 });
  await queuedAt(2_000, "ticket", { n: 2 });

  const seen = [];
  const r = await OfflineQueue.flush({
    ticket: async p => { seen.push(p.n); throw new TypeError("Failed to fetch"); }
  });

  assert.deepEqual(seen, [1], "no point hammering the rest at a network that isn't there");
  assert.deepEqual(r, { synced: 0, stillOffline: true });
  const left = await OfflineQueue.list();
  assert.deepEqual(left.map(i => i.payload.n), [1, 2]);
  assert.deepEqual(left.map(i => i.lastError), [null, null], "and nothing is marked as stuck — it is only waiting");
});

test("a refusal the server actually gave is a reason even with the radio down", async () => {
  // The truck is between towers by the time the flush runs, but the answer
  // being replayed came from the server all the same: db.js flags those
  // `plain`. isNetworkError says "offline" for ANY error while onLine is
  // false, so without the `.plain` check first this stopped the flush, wrote
  // no reason, and left the crew with a lit badge and nothing to read.
  nav.onLine = false;
  await queuedAt(1_000, "ticket", { n: 1 });
  await queuedAt(2_000, "ticket", { n: 2 });

  const seen = [];
  const r = await OfflineQueue.flush({
    ticket: async p => {
      seen.push(p.n);
      if (p.n === 1) throw Object.assign(new Error("J-77 was completed — no more tickets can be raised against it."), { plain: true });
    }
  });

  assert.deepEqual(seen, [1, 2], "a refusal is not a dead radio: the rest of the day still goes");
  assert.deepEqual(r, { synced: 1, stillOffline: false });
  const left = await OfflineQueue.list();
  assert.equal(left.length, 1);
  assert.equal(left[0].payload.n, 1);
  assert.match(left[0].lastError, /was completed/, "the reason is on the item, not lost to the weather");
});

test("an item this build has no handler for says so instead of blinking forever", async () => {
  await queuedAt(1_000, "somethingFromANewerBuild", { n: 1 });

  const r = await OfflineQueue.flush({ ticket: async () => {} });
  assert.deepEqual(r, { synced: 0, stillOffline: false });

  const [item] = await OfflineQueue.list();
  assert.match(item.lastError, /install the update/, "the badge turns into a call to action, not a mystery");

  // A second pass must not rewrite it — the panel would flicker and the
  // "saved N min ago" line would be the only thing that ever changed.
  const before = item.lastError;
  await OfflineQueue.flush({ ticket: async () => {} });
  assert.equal((await OfflineQueue.list())[0].lastError, before);
});

test("one technician's outbox is invisible to the next person on the tablet", async () => {
  OfflineQueue.setOwner("tech-a");
  await queuedAt(1_000, "ticket", { jobId: "J-9" });
  assert.equal((await OfflineQueue.list()).length, 1);

  // Tech A signs out, tech B signs in on the same tablet. B must not see A's
  // work in the badge — and must never replay it, because the insert names A
  // and would be refused, landing in B's panel as "won't sync".
  OfflineQueue.setOwner("tech-b");
  assert.deepEqual(await OfflineQueue.list(), [], "B's badge stays dark");
  let replayed = 0;
  const r = await OfflineQueue.flush({ ticket: async () => { replayed++; } });
  assert.equal(replayed, 0, "and B's session does not send A's ticket under B's name");
  assert.deepEqual(r, { synced: 0, stillOffline: false });

  // A comes back to the tablet and the day's work is still there, untouched.
  OfflineQueue.setOwner("tech-a");
  const mine = await OfflineQueue.list();
  assert.equal(mine.length, 1);
  assert.equal(mine[0].payload.jobId, "J-9");
  assert.equal(mine[0].lastError, null);
});

test("an item queued before anyone signed in belongs to whoever is here", async () => {
  OfflineQueue.setOwner(null);
  await queuedAt(1_000, "ticket", { jobId: "J-10" });
  OfflineQueue.setOwner("tech-b");
  const mine = await OfflineQueue.list();
  assert.equal(mine.length, 1, "an unstamped item predates the owner column, not the person");
});

test("with nobody signed in, a technician's queued work stays out of sight", async () => {
  OfflineQueue.setOwner("tech-a");
  await queuedAt(1_000, "ticket", { jobId: "J-11" });
  // Signed out on the shared tablet: the outbox is nobody's to see or replay.
  OfflineQueue.setOwner(null);
  assert.deepEqual(await OfflineQueue.list(), [], "a null owner is not a master key");
  let replayed = 0;
  await OfflineQueue.flush({ ticket: async () => { replayed++; } });
  assert.equal(replayed, 0);
  OfflineQueue.setOwner("tech-a");
  assert.equal((await OfflineQueue.list()).length, 1, "and it is still there for its owner");
});

test("the badge hears the current list at once, and again on every change", async () => {
  const seen = [];
  const stop = OfflineQueue.subscribe(items => seen.push(items.length));
  await eventually(() => seen.length >= 1, "the immediate callback");
  assert.equal(seen[0], 0);

  const id = await OfflineQueue.enqueue("ticket", { jobId: "J-11" });
  await eventually(() => seen.at(-1) === 1, "the badge to light up");
  await OfflineQueue.remove(id);
  await eventually(() => seen.at(-1) === 0, "the badge to go out");

  // Unsubscribing really stops it. A second listener added now proves it:
  // one notify calls every listener in the set, so if this one heard the
  // enqueue and the first didn't, the first is genuinely gone.
  stop();
  const after = [];
  const stop2 = OfflineQueue.subscribe(items => after.push(items.length));
  await eventually(() => after.length >= 1, "the second listener's immediate callback");
  const before = seen.length;
  await OfflineQueue.enqueue("ticket", { jobId: "J-12" });
  await eventually(() => after.at(-1) === 1, "the second listener to hear the enqueue");
  assert.equal(seen.length, before, "the unsubscribed badge heard nothing");
  stop2();
});

test("attachAutoFlush replays at once and again on every `online`", async () => {
  await queuedAt(1_000, "ticket", { n: 1 });

  const listeners = [];
  globalThis.window.addEventListener = (type, fn) => { if (type === "online") listeners.push(fn); };
  globalThis.window.removeEventListener = (type, fn) => {
    const i = listeners.indexOf(fn);
    if (type === "online" && i >= 0) listeners.splice(i, 1);
  };

  let replayed = 0;
  const detach = OfflineQueue.attachAutoFlush({ ticket: async () => { replayed++; } });
  assert.equal(listeners.length, 1, "it is listening for the truck coming back into range");
  await eventually(async () => (await OfflineQueue.list()).length === 0, "the load-time flush");
  assert.equal(replayed, 1);

  // Back in range again with something new waiting.
  await queuedAt(2_000, "ticket", { n: 2 });
  listeners[0]();
  await eventually(async () => (await OfflineQueue.list()).length === 0, "the flush on `online`");
  assert.equal(replayed, 2);

  detach();
  assert.equal(listeners.length, 0, "and it stops listening when the account signs out");

  globalThis.window.addEventListener = () => {};
  globalThis.window.removeEventListener = () => {};
});

test("a flagged failure is a lost connection even with the radio showing bars", () => {
  // An Edge Function call that never left the device comes back from
  // functions-js as "Failed to send a request to the Edge Function" — words
  // no pattern here can match — so db.js flags the Error instead. Without
  // the flag the item is parked as unsyncable and the next flush cries that
  // charges weren't applied.
  nav.onLine = true;
  const flagged = new Error("Failed to send a request to the Edge Function");
  flagged.networkFailure = true;
  assert.equal(isNetworkError(flagged), true);
  assert.equal(isNetworkError(new Error("Failed to send a request to the Edge Function")), false,
    "unflagged, the same words are just words — the flag is the evidence");
});

test("a caller that joins a running flush is told so, and onSynced fires once per drain", async () => {
  // A truck between towers fires `online` several times during one drain.
  // Every one of those joins the flush already running and gets the same
  // answer — and the reload the answer triggers must run once, for the
  // caller that started the drain, not once per event.
  await queuedAt(1_000, "ticket", { n: 1 });

  let release;
  const gate = new Promise(r => { release = r; });
  const handlers = { ticket: async () => { await gate; } };

  const listeners = [];
  globalThis.window.addEventListener = (type, fn) => { if (type === "online") listeners.push(fn); };
  globalThis.window.removeEventListener = () => {};
  let synced = 0;
  const detach = OfflineQueue.attachAutoFlush(handlers, () => { synced++; });
  // The load-time flush is now parked on the gate; two `online`s and a
  // Retry press arrive while it runs.
  listeners[0](); listeners[0]();
  const joined = OfflineQueue.flush(handlers);
  release();

  const r = await joined;
  assert.equal(r.synced, 1);
  assert.equal(r.joined, true, "the later caller knows it did not start this drain");
  await eventually(async () => (await OfflineQueue.list()).length === 0, "the drain");
  await new Promise(r => setTimeout(r, 20));
  assert.equal(synced, 1, "one reload for one drain, however many events joined it");

  const own = await OfflineQueue.flush(handlers);
  assert.equal(own.joined, undefined, "a flush nobody was running is the caller's own");

  detach();
  globalThis.window.addEventListener = () => {};
  globalThis.window.removeEventListener = () => {};
});
