// The offline cache's account fence, tested the only way it can honestly be
// tested: TWO module instances over ONE IndexedDB.
//
// Run with: node --test src/cacheLease.test.mjs
//
// A tab is a module instance. The store is the origin's, shared by all of
// them, and the bug this exists for is not a same-tab one: tab A asks for a
// job's tickets, tab B signs in as somebody else and empties the store, and
// A's answer lands a second later and is written under B's name. B, out of
// range that afternoon, then reads A's client totals off their own device —
// after A has closed the tab and with nothing on any screen to explain it.
//
// So every test below holds two instances at once and makes the second one
// move while the first one's work is in the air. A module-scoped fence cannot
// pass any of them; that is the point of the file.

import "fake-indexeddb/auto";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

const nav = { onLine: true };
Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });

// Two instances of the same module. Node keeps one per resolved URL, so the
// query string is what makes the second a separate tab rather than the same
// one twice — it has its own lease variable, its own guard map and its own
// notion of who this device belongs to, exactly like a second browser tab.
const tabA = (await import("./offlineCache.js?tab=a")).OfflineCache;
const tabB = (await import("./offlineCache.js?tab=b")).OfflineCache;
const { IDENTITY_KEY } = await import("./session.js");

async function rawDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("nde-offline-cache", 1);
    req.onupgradeneeded = () => { req.result.createObjectStore("reads", { keyPath: "key" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function rawWrite(run) {
  return rawDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction("reads", "readwrite");
    run(tx.objectStore("reads"));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}
const rawWipe = () => rawWrite(store => store.clear());
const rawPut = (key, value) => rawWrite(store => store.put({ key, value, at: Date.now() }));
const rawRead = key => rawDb().then(db => new Promise((resolve, reject) => {
  const req = db.transaction("reads", "readonly").objectStore("reads").get(key);
  req.onsuccess = () => resolve(req.result || null);
  req.onerror = () => reject(req.error);
}));
const rawMarker = async () => {
  const hit = await rawRead("cache.owner");
  return hit ? hit.value : null;
};

// readThrough does not await the write it starts.
async function settle() { await rawPut("_probe", Date.now()); }

beforeEach(async () => {
  nav.onLine = true;
  // Both tabs let go of whatever they were holding, THEN the store is emptied
  // behind their backs. Epochs restart from nothing each time, so a lease left
  // over from the previous test would otherwise match by coincidence — which
  // is a property of the fixture, not of the app, where the store is never
  // rewound.
  await tabA.clear().catch(() => {});
  await tabB.clear().catch(() => {});
  await rawWipe();
});

test("A's answer, landing after B has taken the device, is not written", async () => {
  await tabA.claimFor("tech-a");
  // The read A is in the middle of when the tablet changes hands. Held open
  // deliberately: this is the second between tapping a job and the reply.
  let answer;
  const inFlight = tabA.readThrough("tickets.J-77", () => new Promise(r => { answer = r; }));

  assert.equal(await tabB.claimFor("tech-b"), true, "B signs in and the store is emptied");
  answer([{ id: "KK-0912-26-01", total: 4120.5 }]);
  assert.deepEqual(await inFlight, [{ id: "KK-0912-26-01", total: 4120.5 }], "A's own screen still gets its answer");
  await settle();

  assert.equal(await rawRead("tickets.J-77"), null, "but B's device does not keep A's money");
  assert.equal(await tabB.read("tickets.J-77"), null, "and B cannot read it out of range either");
});

test("A's fallback, after B has taken the device, is a failure and not B's data", async () => {
  await tabA.claimFor("tech-a");
  await tabA.readThrough("catalog.9", async () => ({ film: 1200 }));
  await settle();

  // B takes the device and reads a card of their own under the same key.
  await tabB.claimFor("tech-b");
  await tabB.readThrough("catalog.9", async () => ({ film: 99 }));
  await settle();

  // A, still open, loses signal. It must not be handed B's card, and it must
  // not be handed its own from before the handover either — that store is gone.
  await assert.rejects(
    () => tabA.readThrough("catalog.9", () => { throw new TypeError("Failed to fetch"); }),
    /Failed to fetch/,
    "a device that changed hands has no remembered copy to offer the last owner"
  );
  assert.equal(tabA.state.servingCached, false, "and no banner claims it served one");
  assert.deepEqual((await tabB.read("catalog.9")).value, { film: 99 }, "B's own card is untouched");
});

test("A's late remove and late clear cannot reach B's half-entered ticket", async () => {
  await tabA.claimFor("tech-a");
  const held = tabA.hold();
  await tabB.claimFor("tech-b");
  await tabB.put("ticket.wip.J-77", { weldLines: [{ key: "rt_film:2in", qty: 14 }] });

  // The shape db.js is full of: a lease taken before the network call, used
  // when the reply finally lands. The key is the same string for everybody,
  // so without the fence this deletes B's morning.
  await tabA.remove("ticket.wip.J-77", held);
  assert.ok(await rawRead("ticket.wip.J-77"), "B's welds are still there");

  // And the whole-store version: A's own sign-out, arriving late.
  await tabA.clear();
  assert.ok(await rawRead("ticket.wip.J-77"), "a stale tab's sign-out is not B's sign-out");
});

test("A -> clear -> A does not bring the old tab's tokens back to life", async () => {
  await tabA.claimFor("tech-a");
  const before = tabA.hold();
  // The same person signs out and straight back in on the same tablet. The
  // store is a different store now; a lease minted against the old one is
  // describing data that no longer exists, and the owner alone cannot tell.
  await tabA.clear();
  await tabA.claimFor("tech-a");

  await tabA.put("job.J-9", { id: "J-9" }, before);
  assert.equal(await rawRead("job.J-9"), null, "the epoch is what makes the two stores different");
  assert.equal(await tabA.read("job.J-9", before), null, "and reading on it is a miss, not a stale answer");

  // The lease it holds NOW is of course fine.
  await tabA.put("job.J-9", { id: "J-9" });
  assert.ok(await rawRead("job.J-9"));
});

test("an emptied store keeps an ownerless marker at the next epoch", async () => {
  await tabA.claimFor("tech-a");
  const first = await rawMarker();
  await tabA.clear();
  const after = await rawMarker();

  assert.equal(await tabA.owner(), null, "nobody owns an empty store");
  assert.ok(after && after.epoch > first.epoch, "but the store remembers that it is a later one");
});

test("a claim that could not empty the device leaves everything as it was", async () => {
  await tabA.claimFor("tech-a");
  await tabA.put("ticket.wip.J-77", { weldLines: [] });
  const held = tabA.hold();
  const markerBefore = await rawMarker();

  const realClear = IDBObjectStore.prototype.clear;
  IDBObjectStore.prototype.clear = () => { throw new Error("the store would not empty"); };
  try {
    await assert.rejects(() => tabB.claimFor("tech-b"), /would not empty/);
  } finally {
    IDBObjectStore.prototype.clear = realClear;
  }

  assert.deepEqual(await rawMarker(), markerBefore, "still A's device, so the next attempt clears again");
  assert.ok(await rawRead("ticket.wip.J-77"), "and A's half-entered ticket is still on it");
  // B bound nothing, so B does nothing.
  await tabB.put("job.J-9", { id: "J-9" });
  assert.equal(await rawRead("job.J-9"), null, "a claim that failed is not a lease");
  // A's own binding is untouched.
  await tabA.put("job.J-8", { id: "J-8" }, held);
  assert.ok(await rawRead("job.J-8"), "A never stopped owning this device");
});

test("adopt takes what is already this person's and never anybody else's", async () => {
  // The offline boot: a session restored from this device's own memory, with
  // no network and so no claimFor. Same owner — bind, change nothing.
  await tabA.claimFor("tech-a");
  await tabA.put("ticket.wip.J-77", { weldLines: [{ key: "rt_film:2in", qty: 14 }] });
  const marker = await rawMarker();

  assert.equal(await tabB.adopt("tech-a"), true, "a second tab of the same account may read the same store");
  assert.deepEqual(await rawMarker(), marker, "and adopting changes nothing about the device");
  assert.ok(await tabB.read("ticket.wip.J-77"), "their own morning's work is readable");

  // Legacy: a store from before owners were recorded, with this person's
  // identity beside it. Adopted, work kept, marker written.
  await rawWipe();
  await rawPut(IDENTITY_KEY, { id: "tech-a", name: "Kyle Keith" });
  await rawPut("ticket.wip.J-77", { weldLines: [] });
  assert.equal(await tabA.adopt("tech-a"), true);
  assert.equal(await tabA.owner(), "tech-a", "the device is claimed from now on");
  assert.ok(await rawRead("ticket.wip.J-77"), "and nothing was emptied to do it");
});

test("adopt refuses a stranger's device — and empties nothing to say so", async () => {
  await tabA.claimFor("tech-a");
  await tabA.put("ticket.wip.J-77", { weldLines: [{ key: "rt_film:2in", qty: 14 }] });

  // B's twelve-hour-old identity, restored with no signal on A's tablet. A
  // wipe here is the one that cannot be undone, so nothing is wiped: B simply
  // holds no lease, and every fenced read refuses for the rest of the session.
  assert.equal(await tabB.adopt("tech-b"), false);
  assert.equal(await tabB.owner(), "tech-a", "still A's device");
  assert.ok(await rawRead("ticket.wip.J-77"), "and A's work is all still on it");

  assert.equal(await tabB.read("ticket.wip.J-77"), null, "B is shown nothing rather than A's ticket");
  assert.deepEqual(await tabB.keys(""), [], "including by listing");
  await tabB.put("job.J-9", { id: "J-9" });
  assert.equal(await rawRead("job.J-9"), null, "and writes nothing into A's store");
  await tabB.remove("ticket.wip.J-77");
  assert.ok(await rawRead("ticket.wip.J-77"), "and deletes nothing out of it");
});

test("a fetch-then-put of the db.js shape is fenced on the lease it began under", async () => {
  // Not readThrough: the board, the job patches and the ticket-number cache
  // all fetch first and then write what they got, several awaits later. Those
  // are the paths that hold a lease across the call (Db's `held`).
  await tabA.claimFor("tech-a");
  const held = tabA.hold();

  const reply = await new Promise(r => setTimeout(() => r({ rows: [{ dbId: "J-77" }], total: 1 }), 0));
  await tabB.claimFor("tech-b");          // the tablet changes hands mid-call

  await tabA.put("jobs.recent", reply, held);
  assert.equal(await rawRead("jobs.recent"), null, "the last owner's board is not written into the new owner's store");

  // Whereas the same code holding no stale lease writes normally.
  await tabB.put("jobs.recent", reply);
  assert.ok(await rawRead("jobs.recent"));
});

test("every change of lease is announced, which is how the memory caches empty", async () => {
  // The IndexedDB fence cannot see db.js's in-memory reference lists — they
  // are account-blind keys ("contacts", "profiles") held in a plain object.
  // db.js subscribes to this and drops both maps, so a walk that was only in
  // flight when the device changed hands settles into nothing.
  const seen = [];
  const stop = tabA.onLeaseChange(l => seen.push(l ? l.owner : null));

  await tabA.claimFor("tech-a");
  await tabA.adopt("tech-a");
  await tabA.clear();
  await tabA.claimFor("tech-b");
  stop();
  await tabA.clear();

  assert.deepEqual(seen, ["tech-a", "tech-a", null, "tech-b"], "a claim, an adoption and a clear each say so");
});

test("a stale tab's clear is refused every time it is tried, not just the first", async () => {
  await tabA.claimFor("tech-a");
  await tabB.claimFor("tech-b");
  await tabB.put("ticket.wip.J-77", { weldLines: [{ key: "rt_film:2in", qty: 14 }] });

  // The first refusal lets go of A's lease — it named a store that is gone.
  assert.equal(await tabA.clear(), false);
  // Which must NOT leave the tab holding a blank cheque. Having no authority
  // is not a kind of authority; a second press of Sign out, a retry after the
  // toast, or the boot's own clean-up would otherwise empty B's store.
  assert.equal(await tabA.clear(), false, "the second try is refused too");
  assert.equal(await tabA.clear(), false, "and the third");
  assert.ok(await rawRead("ticket.wip.J-77"), "B's welds are still there");
});

test("the boot's own wipe is fenced on the marker it read before asking the server", async () => {
  await tabA.claimFor("tech-a");
  await tabA.put("ticket.wip.J-77", { weldLines: [{ key: "rt_film:2in", qty: 14 }] });

  // Tab B boots. It holds no lease yet — nothing has been claimed — and reads
  // who this device belongs to BEFORE it asks the server about the session.
  const atBoot = await tabB.marker();
  assert.deepEqual(atBoot, { owner: "tech-a", epoch: 1 });

  // The profile read is slow, and while it is in flight somebody signs in on
  // another tab and starts working.
  await tabA.claimFor("tech-c");
  await tabA.put("ticket.wip.J-90", { weldLines: [{ key: "rt_film:6in", qty: 3 }] });

  // The answer finally arrives: tech-a is locked out, empty the device. It is
  // not this device any more, and the wipe does not happen.
  assert.equal(await tabB.clear({ expect: atBoot }), false);
  assert.ok(await rawRead("ticket.wip.J-90"), "the new owner's morning is untouched");

  // And with nothing having moved, the same wipe lands.
  const now = await tabB.marker();
  assert.equal(await tabB.clear({ expect: now }), true);
  assert.equal(await rawRead("ticket.wip.J-90"), null);
});

test("an unleased tab empties nothing unless it says what it expects", async () => {
  await tabA.claimFor("tech-a");
  await tabA.put("ticket.wip.J-77", { weldLines: [] });
  assert.equal(tabB.hold(), null, "B has claimed nothing");
  assert.equal(await tabB.clear(), false);
  assert.ok(await rawRead("ticket.wip.J-77"), "and deleted nothing");
});

test("the boot's wipe of a device nobody has ever claimed", async () => {
  // `expect: null` is a state of its own — a store with no marker at all —
  // and not the absence of an expectation.
  await rawPut("ticket.wip.J-77", { weldLines: [] });
  assert.equal(await tabA.marker(), null);
  await tabB.claimFor("tech-b");                    // claimed while the boot thought
  assert.equal(await tabA.clear({ expect: null }), false);
  await rawWipe();
  await rawPut("ticket.wip.J-77", { weldLines: [] });
  assert.equal(await tabA.clear({ expect: null }), true, "an unclaimed store is the boot's to empty");
  assert.equal(await rawRead("ticket.wip.J-77"), null);
});

test("an adoption that is refused retires the lease the tab was holding", async () => {
  await tabA.claimFor("tech-a");
  await tabA.put("ticket.wip.J-77", { weldLines: [{ key: "rt_film:2in", qty: 14 }] });
  assert.ok(tabA.hold());

  // The same tab reopens for somebody else with no signal — a twelve-hour-old
  // identity for tech-b restored on tech-a's tablet. The store is not emptied
  // (a boot with no signal is the last moment for that), and the refusal is
  // not merely "no new lease": the one this tab still holds is A's, and every
  // fenced read under it would hand A's ticket to B's session.
  assert.equal(await tabA.adopt("tech-b"), false);
  assert.equal(tabA.hold(), null, "the old binding is retired by the refusal");
  assert.equal(await tabA.read("ticket.wip.J-77"), null, "so nothing of A's is read back");
  assert.deepEqual(await tabA.keys(""), []);
  await tabA.remove("ticket.wip.J-77");
  assert.ok(await rawRead("ticket.wip.J-77"), "and nothing of A's is deleted either");
  assert.equal(await tabA.clear(), false, "and the store is not B's to empty");
  assert.ok(await rawRead("ticket.wip.J-77"));
});

test("a same-account adoption keeps the lease it already had", async () => {
  await tabA.claimFor("tech-a");
  await tabA.put("ticket.wip.J-77", { weldLines: [] });
  assert.equal(await tabA.adopt("tech-a"), true);
  assert.ok(tabA.hold());
  assert.ok(await tabA.read("ticket.wip.J-77"), "the same person's own drafts survive the restore");
});

// The one helper db.js calls AFTER a round trip has already been awaited, from
// inside two adapters that took their lease before it. Lifted out of db.js and
// run — db.js itself cannot be imported here, config.js builds a live Supabase
// client at module scope — because the bug it fixes is one call deeper than
// the adapters' own fences: a helper that takes a FRESH lease at the moment it
// runs is the old owner's sweep reaching the new owner's store.
const dbSource = (await import("node:fs")).readFileSync(new URL("./db.js", import.meta.url), "utf8");
const helperStart = dbSource.indexOf("const dropClientJobLists = async");
const helperEnd = dbSource.indexOf("\n};", helperStart) + 3;
assert.ok(helperStart > 0 && helperEnd > helperStart, "db.js must still hold dropClientJobLists");
const dropSource = dbSource.slice(helperStart, helperEnd);
const dropClientJobLists = new Function("OfflineCache", dropSource + "\nreturn dropClientJobLists;")(tabA);

test("the per-client job lists are swept under the caller's lease, not a fresh one", async () => {
  await tabA.claimFor("tech-a");
  const held = tabA.hold();                       // taken at the top of deleteJob
  await tabB.claimFor("tech-b");                  // the tablet changes hands
  await tabB.put("jobs.client.acme", [{ id: "J-1" }]);

  await dropClientJobLists(held);
  assert.ok(await rawRead("jobs.client.acme"), "A's delete does not sweep B's lists");

  // And under a lease that still stands it does its job.
  await dropClientJobLists(tabB.hold());
  assert.equal(await rawRead("jobs.client.acme"), null);
});

test("both adapters hand that helper the lease they started with", () => {
  // The threading is at the call sites, which are inside async methods on a
  // live Supabase client and cannot be run here. Read back instead: a bare
  // dropClientJobLists() from either of them is the bug returning.
  const calls = dbSource.match(/dropClientJobLists\([^)]*\)/g) || [];
  const called = calls.filter(c => c !== "dropClientJobLists(held = OfflineCache.hold())");
  assert.equal(called.length, 2, "deleteJob and setJobComplete are the two callers");
  for (const c of called) assert.equal(c, "dropClientJobLists(held)");
});
