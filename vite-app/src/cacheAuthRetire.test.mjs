// The other half of the fence: what Auth says, against what the disk says.
//
// cacheLease.test.mjs covers two tabs racing over one store. This covers the
// gap between them — the moment supabase-js announces that the account on this
// origin has changed and the moment somebody's claim actually lands on the
// disk. The marker has not moved yet in that gap, so the disk, asked alone,
// answers "yes, still yours" for an account that has already been replaced.
// A claim is a separate transaction: it may be slow, it may belong to another
// tab, it may fail outright, and there is no promise it happens at all.
//
// So the REAL auth region is lifted out of db.js and run against the REAL
// cache module. db.js itself cannot be imported (config.js builds a live
// Supabase client at module scope), but paraphrasing the region is exactly the
// mistake this file exists to catch, so it is cut from the source instead.

import "fake-indexeddb/auto";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const nav = { onLine: true };
Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });

const OfflineCache = (await import("./offlineCache.js?tab=auth")).OfflineCache;
const other = (await import("./offlineCache.js?tab=other")).OfflineCache;

const source = readFileSync(new URL("./db.js", import.meta.url), "utf8");
function region(from, to) {
  const start = source.indexOf(from);
  assert.ok(start > 0, "db.js must still hold: " + from);
  const end = source.indexOf(to, start);
  assert.ok(end > start, "db.js must still hold: " + to);
  return source.slice(start, end + to.length);
}
const auth = region("let authGeneration = 0;", "});");
assert.match(auth, /OfflineCache\.retireUnless\(id\)/, "the auth region must retire this tab's disk authority");

function tab(cache = OfflineCache) {
  let announce = () => {};
  const sbClient = { auth: { onAuthStateChange: fn => { announce = fn; return { data: { subscription: { unsubscribe() {} } } }; } } };
  let forgotten = 0;
  new Function("OfflineCache", "sbClient", "forgetRememberedRows", auth)(
    cache, sbClient, () => { forgotten++; }
  );
  return {
    announce: id => announce(id ? "SIGNED_IN" : "SIGNED_OUT", id ? { user: { id } } : null),
    forgotten: () => forgotten
  };
}

async function rawDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("nde-offline-cache", 1);
    req.onupgradeneeded = () => { req.result.createObjectStore("reads", { keyPath: "key" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const rawWipe = () => rawDb().then(db => new Promise((resolve, reject) => {
  const tx = db.transaction("reads", "readwrite");
  tx.objectStore("reads").clear();
  tx.oncomplete = resolve;
  tx.onerror = () => reject(tx.error);
}));
const rawRead = key => rawDb().then(db => new Promise((resolve, reject) => {
  const req = db.transaction("reads", "readonly").objectStore("reads").get(key);
  req.onsuccess = () => resolve(req.result || null);
  req.onerror = () => reject(req.error);
}));
// readThrough does not await the write it starts.
const settle = () => new Promise(r => setTimeout(r, 5));

beforeEach(async () => {
  nav.onLine = true;
  await OfflineCache.clear().catch(() => {});
  await other.clear().catch(() => {});
  await rawWipe();
});

test("a new read after the account changed is not answered off the last account's disk", async () => {
  const app = tab();
  app.announce("tech-a");
  await OfflineCache.claimFor("tech-a");
  await OfflineCache.put("contacts", ["A's client reps"]);
  assert.deepEqual((await OfflineCache.read("contacts")).value, ["A's client reps"]);

  // B's session is announced. Nothing has claimed anything yet — that
  // transaction is still to come, and may never come.
  app.announce("tech-b");
  assert.equal(await OfflineCache.read("contacts"), null, "B is not handed A's contacts");
  assert.equal(OfflineCache.hold(), null, "and the tab holds no authority to read anything");
  assert.ok(app.forgotten() >= 1, "memory was emptied too");
  assert.notEqual(await rawRead("contacts"), null, "A's row is still on the disk — this deletes nothing");
});

test("the offline fallback is refused in that gap too", async () => {
  const app = tab();
  app.announce("tech-a");
  await OfflineCache.claimFor("tech-a");
  await OfflineCache.readThrough("catalog.9", async () => ({ film: 1200 }));
  await settle();

  app.announce("tech-b");
  nav.onLine = false;
  await assert.rejects(
    () => OfflineCache.readThrough("catalog.9", () => { throw new TypeError("Failed to fetch"); }),
    /Failed to fetch/,
    "out of range, B gets a failure and not A's rate card"
  );
  assert.equal(OfflineCache.state.servingCached, false, "and no banner says otherwise");
});

test("a new write in that gap lands nowhere", async () => {
  const app = tab();
  app.announce("tech-a");
  await OfflineCache.claimFor("tech-a");
  app.announce("tech-b");
  await OfflineCache.put("ticket.wip.J-77", { welds: 12 });
  assert.equal(await rawRead("ticket.wip.J-77"), null, "nothing of B's is written under A's marker");
});

test("a token captured before the change is refused after it, marker unmoved", async () => {
  const app = tab();
  app.announce("tech-a");
  await OfflineCache.claimFor("tech-a");
  const held = OfflineCache.hold();
  const markerBefore = await rawRead("cache.owner");

  app.announce("tech-b");
  const markerAfter = await rawRead("cache.owner");
  assert.deepEqual(markerAfter.value, markerBefore.value, "the disk has not moved — nobody has claimed yet");

  await OfflineCache.put("tickets.J-77", [{ total: 4120.5 }], held);
  assert.equal(await rawRead("tickets.J-77"), null, "the delayed write is dropped all the same");
  assert.equal(await OfflineCache.read("tickets.J-77", held), null, "and the delayed read is a miss, not a stale answer");
});

test("the same account announced again keeps the lease and the work in flight", async () => {
  const app = tab();
  app.announce("tech-a");
  await OfflineCache.claimFor("tech-a");
  const held = OfflineCache.hold();
  const forgotten = app.forgotten();

  app.announce("tech-a");   // the hourly token refresh
  assert.equal(OfflineCache.hold(), held, "the same person is not a change of hands");
  assert.equal(app.forgotten(), forgotten, "and nothing remembered is thrown away");
  await OfflineCache.put("contacts", ["A's client reps"], held);
  assert.notEqual(await rawRead("contacts"), null, "a fetch that was in flight across it still lands");
});

test("the boot's own claim, announced after it, does not kill that minute's reads", async () => {
  const app = tab();
  await OfflineCache.claimFor("tech-a");
  const held = OfflineCache.hold();
  app.announce("tech-a");   // the first announcement, arriving after the claim
  assert.equal(OfflineCache.hold(), held);
});

test("signing out retires the authority without emptying anybody's store", async () => {
  const app = tab();
  app.announce("tech-a");
  await OfflineCache.claimFor("tech-a");
  await OfflineCache.put("contacts", ["A's client reps"]);

  app.announce(null);
  assert.equal(OfflineCache.hold(), null);
  assert.equal(await OfflineCache.read("contacts"), null, "nothing is readable");
  assert.notEqual(await rawRead("contacts"), null, "but the sign-out path's own clear is what deletes, not this");
});

test("A -> B -> A: the tab is dead until a claim, and A's own work comes back on one", async () => {
  const app = tab();
  app.announce("tech-a");
  await OfflineCache.claimFor("tech-a");
  await OfflineCache.put("ticket.wip.J-77", { welds: 12 });

  app.announce("tech-b");
  app.announce("tech-a");   // B never claimed; A is back
  assert.equal(OfflineCache.hold(), null, "an announcement is not a claim, whoever it names");
  assert.equal(await OfflineCache.read("ticket.wip.J-77"), null);

  assert.equal(await OfflineCache.claimFor("tech-a"), false, "A's own store is not emptied to give it back");
  assert.deepEqual((await OfflineCache.read("ticket.wip.J-77")).value, { welds: 12 }, "and the half-entered ticket is still there");
});

test("a claim that settles on nothing leaves the tab retired, not reading the last account", async () => {
  const app = tab();
  app.announce("tech-a");
  await OfflineCache.claimFor("tech-a");
  await OfflineCache.put("contacts", ["A's client reps"]);

  app.announce("tech-b");
  // The claim that should follow does not land — here because the id never
  // arrived, in the field because the transaction faulted or the tab was
  // closed before it ran. Whatever the reason, it is not a reason to read A.
  assert.equal(await OfflineCache.claimFor(null), false);
  assert.equal(OfflineCache.hold(), null);
  assert.equal(await OfflineCache.read("contacts"), null);
});

test("another tab's claim in that gap takes the device, and this one stays out", async () => {
  const app = tab();
  app.announce("tech-a");
  await OfflineCache.claimFor("tech-a");
  await OfflineCache.put("contacts", ["A's client reps"]);

  app.announce("tech-b");
  await other.claimFor("tech-b");          // B signs in on the other tab
  assert.equal(await rawRead("contacts"), null, "A's store was emptied at B's door");
  assert.equal(await OfflineCache.read("contacts"), null);
  assert.equal(OfflineCache.hold(), null, "and this tab never adopted B's lease");
});

// The three below are the same fault in three shapes, and all three are about
// work ALREADY IN FLIGHT when the announcement arrives. A claim, an adoption
// and a sign-out are each a transaction that takes real time; the disk does
// not move when Auth speaks, so each of them, asked on its return, still finds
// the world it was started in.

test("a claim already in flight when the account changes does not bind on landing", async () => {
  const app = tab();
  app.announce("tech-a");
  await OfflineCache.claimFor("tech-a");
  await OfflineCache.put("ticket.wip.J-90", { welds: 3 });

  const claiming = OfflineCache.claimFor("tech-a");   // A's own re-claim, in flight
  app.announce("tech-b");                             // the device changes hands mid-claim
  await claiming;

  assert.equal(OfflineCache.hold(), null, "A's claim may not hand this tab a lease after A has gone");
  assert.equal(await OfflineCache.read("ticket.wip.J-90"), null, "and nothing of A's is readable");
});

test("an adoption already in flight when the account changes is refused too", async () => {
  const app = tab();
  app.announce("tech-a");
  await OfflineCache.claimFor("tech-a");
  await OfflineCache.put("contacts", ["A's client reps"]);

  const adopting = OfflineCache.adopt("tech-a");       // the offline restore's own path
  app.announce("tech-b");
  assert.equal(await adopting, false, "an adoption that lands after the announcement is not an adoption");
  assert.equal(OfflineCache.hold(), null);
  assert.equal(await OfflineCache.read("contacts"), null);
});

test("a sign-out already in flight when the account changes empties nothing of the new owner's", async () => {
  const app = tab();
  app.announce("tech-a");
  await OfflineCache.claimFor("tech-a");

  const clearing = OfflineCache.clear();               // A signs out
  app.announce("tech-b");
  await other.claimFor("tech-b");                      // B takes the device in another tab
  await other.put("ticket.wip.J-91", { welds: 7 });
  assert.equal(await clearing, false, "A's sign-out is not this device's sign-out any more");

  assert.deepEqual((await other.read("ticket.wip.J-91")).value, { welds: 7 }, "B's half-entered ticket survives it");
  assert.ok(other.hold(), "and B's own tab still holds its lease");
});

// The gap the two tests above do not reach: a claim that has not opened its
// transaction yet when the device changes hands. Refusing its lease on the way
// out is too late — it finds a marker naming the NEW owner, calls that a
// stranger's store and empties it, and what it deletes is the half-entered
// ticket of the person sitting in front of it. The wait is the tab's own first
// database open, which is where every boot claim waits.
test("a claim in flight across the account change empties nothing of the new owner's", async () => {
  const cold = (await import("./offlineCache.js?tab=cold")).OfflineCache;
  const app = tab(cold);
  app.announce("tech-a");
  const claiming = cold.claimFor("tech-a");   // waits on this instance's first db open
  app.announce("tech-b");                     // the device changes hands across it
  await other.claimFor("tech-b");
  await other.put("ticket.wip.J-92", { welds: 7 });
  assert.equal(await claiming, false, "A's claim is not A's device any more");

  assert.deepEqual((await other.read("ticket.wip.J-92")).value, { welds: 7 }, "B's half-entered ticket is still there");
  assert.ok(other.hold(), "B's tab still holds the device");
  assert.equal(cold.hold(), null, "and the claiming tab holds nothing");
});

test("an adoption in flight across the account change writes no marker", async () => {
  const cold2 = (await import("./offlineCache.js?tab=cold2")).OfflineCache;
  const app = tab(cold2);
  app.announce("tech-a");
  const adopting = cold2.adopt("tech-a");
  app.announce("tech-b");
  await other.claimFor("tech-b");
  assert.equal(await adopting, false);
  assert.equal(cold2.hold(), null);
  assert.equal((await rawRead("cache.owner")).value.owner, "tech-b", "the marker is the account that is actually here");
});

// A→B→A. The name announced at the end is the name announced at the start, so
// anything that asks WHO IS HERE gets the answer it set out with — while B has
// owned, emptied and refilled this store in between. Only a count of arrivals
// can tell the two apart, which is why the fence is one and not a comparison
// of names. The tab holds no lease through any of it: an unleased tab was the
// half of this Codex found still open.
// The tab's first database open, held ajar so the world can move while a claim
// waits in it. Every other await inside a claim is the transaction itself,
// which is too quick to sit across a change of hands in a test; this is the
// wait that is genuinely long in a browser, and it is where every boot claim
// waits.
function heldOpen() {
  const real = indexedDB.open.bind(indexedDB);
  let release;
  const gate = new Promise(r => { release = r; });
  indexedDB.open = (...a) => {
    const req = real(...a);
    const shim = { onupgradeneeded: null, onsuccess: null, onerror: null,
      get result() { return req.result; }, get error() { return req.error; } };
    req.onupgradeneeded = e => shim.onupgradeneeded && shim.onupgradeneeded(e);
    req.onsuccess = () => { gate.then(() => shim.onsuccess && shim.onsuccess()); };
    req.onerror = () => shim.onerror && shim.onerror();
    indexedDB.open = real;                 // one open only; the rest are ordinary
    return shim;
  };
  return () => { indexedDB.open = real; release(); };
}

// A→B→A. The name announced at the end is the name announced at the start, so
// anything that asks WHO IS HERE gets the answer it set out with — while B has
// owned, emptied and refilled this store in between. Only a count of arrivals
// can tell the two apart, which is why the fence is one and not a comparison
// of names. The tab holds no lease through any of it: an unleased tab was the
// half of this Codex found still open.
test("an unleased claim that outlives A → B → A empties nothing of B's", async () => {
  const cold3 = (await import("./offlineCache.js?tab=cold3")).OfflineCache;
  const app = tab(cold3);
  app.announce("tech-a");
  const open = heldOpen();
  const claiming = cold3.claimFor("tech-a");   // waits in that open

  app.announce("tech-b");
  await other.claimFor("tech-b");              // B takes the device in another tab
  await other.put("ticket.wip.J-93", { welds: 7 });
  app.announce("tech-a");                      // and the name comes back round

  open();
  assert.equal(await claiming, false, "the device changed hands twice, whatever the name says");
  assert.deepEqual((await other.read("ticket.wip.J-93")).value, { welds: 7 }, "B's half-entered ticket is still there");
  assert.equal(cold3.hold(), null);
});

// The same question asked of the boot's wipe. Its authority is the marker it
// read before the server was asked — and a claim by the account that ALREADY
// owns the store moves nothing on the disk (nothing is emptied, so the epoch
// stands), so the marker matched afterwards and the wipe took the freshly
// claimed store with it. `authority()` carries the arrival count beside the
// marker for exactly this.
test("the boot's stated wipe is refused when somebody has arrived since it was decided", async () => {
  const cold4 = (await import("./offlineCache.js?tab=cold4")).OfflineCache;
  const booting = tab(cold4);
  await other.claimFor("tech-b");                      // the device is B's
  await other.put("ticket.wip.J-94", { welds: 3 });

  // This tab boots as tech-a and reads who the device belongs to before it
  // asks the server anything. It holds no lease: this is the whole authority.
  booting.announce("tech-a");
  const atBoot = await cold4.authority();
  assert.deepEqual(atBoot.marker, { owner: "tech-b", epoch: 1 });

  // The profile read is slow, and while it is in flight B signs in on another
  // tab — supabase-js broadcasts it here. B already owns this store, so their
  // claim empties nothing and the MARKER DOES NOT MOVE: the epoch stands.
  booting.announce("tech-b");
  await other.claimFor("tech-b");
  const after = await cold4.authority();
  assert.deepEqual(after.marker, atBoot.marker, "the marker itself is untouched");

  // The answer arrives: tech-a is locked out, empty the device. It is not
  // tech-a's device any more, and nothing on the disk says so.
  assert.equal(await cold4.clear({ expect: atBoot }), false, "an arrival since is an arrival");
  assert.deepEqual((await other.read("ticket.wip.J-94")).value, { welds: 3 }, "B's morning is untouched");

  // With nothing having arrived since it was read, the same wipe lands.
  assert.equal(await cold4.clear({ expect: after }), true);
  assert.equal(await rawRead("ticket.wip.J-94"), null);
});

// A departure is not an arrival: the sign-out's own wipe is captured while the
// session is still here and runs after it has gone, and the announcement that
// retires the lease must not refuse it. (App.jsx's sign-out does exactly this,
// in this order.)
test("a sign-out's own wipe still lands after the announcement has retired the lease", async () => {
  const app = tab();
  app.announce("tech-a");
  await OfflineCache.claimFor("tech-a");
  await OfflineCache.put("ticket.wip.J-95", { welds: 2 });

  const atSignOut = OfflineCache.heldAuthority();      // from the lease, before the session goes
  app.announce(null);                                  // supabase-js broadcasts SIGNED_OUT
  assert.equal(OfflineCache.hold(), null, "the lease is retired at the announcement");

  assert.equal(await OfflineCache.clear({ expect: atSignOut }), true, "and the wipe is still this person's to run");
  assert.equal(await rawRead("ticket.wip.J-95"), null);
});

// A refusal speaks for the world it started in. An adoption overtaken by a
// claim that has already landed and bound must not retire THAT lease on its
// way out — the account it would put out of business is the one sitting in
// front of the tablet.
test("a stale adoption's refusal leaves a newer binding alone", async () => {
  const cold5 = (await import("./offlineCache.js?tab=cold5")).OfflineCache;
  const app = tab(cold5);
  app.announce("tech-a");
  await other.claimFor("tech-b");                      // the device is B's
  await other.put("ticket.wip.J-96", { welds: 5 });

  const adopting = cold5.adopt("tech-a");              // refused: a stranger's store
  app.announce("tech-b");
  await cold5.claimFor("tech-b");                      // and this tab becomes B's
  const bound = cold5.hold();
  assert.ok(bound, "the tab holds B's lease");

  assert.equal(await adopting, false);
  assert.deepEqual(cold5.hold(), bound, "the stale refusal did not take it");
  assert.deepEqual((await cold5.read("ticket.wip.J-96")).value, { welds: 5 }, "and B reads their own work");
});


// A sign-out's authority is the LEASE it holds, never a reading of the disk.
// A tab left open through a change of hands reads the marker of whoever has
// the tablet now, and a wipe authorised by that reading deletes their work —
// the marker cannot say "this is not yours" to a tab that simply asks it who
// it belongs to. Holding no lease is holding no authority.
test("a stale tab's sign-out empties nothing of the account that replaced it", async () => {
  const cold6 = (await import("./offlineCache.js?tab=cold6")).OfflineCache;
  const app = tab(cold6);
  app.announce("tech-a");
  await cold6.claimFor("tech-a");
  await cold6.put("ticket.wip.J-97", { welds: 1 });

  app.announce("tech-b");                              // the device changes hands
  await other.claimFor("tech-b");                      // B claims and fills it
  await other.put("ticket.wip.J-98", { welds: 7 });

  // What App.jsx captures at the top of its sign-out, in this tab.
  const atSignOut = cold6.heldAuthority();
  assert.equal(atSignOut, null, "a retired tab holds no authority to empty anything");
  // And the reading it must not use instead: the disk names B, and answering
  // it would authorise deleting B's store.
  assert.equal((await cold6.authority()).marker.owner, "tech-b");

  assert.deepEqual((await other.read("ticket.wip.J-98")).value, { welds: 7 }, "B keeps their work");
});

// The FIRST announcement bumps no arrival count — it is the boot learning who
// it already is — so a wipe decided before it cannot be fenced on the count
// alone. Nor on the marker: the same account re-claiming its own store empties
// nothing, so the epoch stands exactly where the boot read it.
test("a boot wipe does not survive the first announcement and the claim behind it", async () => {
  await other.claimFor("tech-b");
  await other.put("ticket.wip.J-99", { welds: 3 });

  const cold7 = (await import("./offlineCache.js?tab=cold7")).OfflineCache;
  const atBoot = await cold7.authority();              // read before the server is asked anything
  assert.equal(atBoot.marker.owner, "tech-b");

  const app = tab(cold7);
  app.announce("tech-b");                              // the first announcement this tab hears
  await cold7.claimFor("tech-b");                      // same account: nothing emptied, epoch unmoved
  await cold7.put("ticket.wip.J-100", { welds: 4 });

  assert.equal(await cold7.clear({ expect: atBoot }), false, "the boot's wipe is out of date");
  assert.deepEqual((await cold7.read("ticket.wip.J-99")).value, { welds: 3 });
  assert.deepEqual((await cold7.read("ticket.wip.J-100")).value, { welds: 4 });
  assert.ok(cold7.hold(), "and the claim that landed keeps its lease");
});

// WHERE the capture sits in App.jsx is the whole of it. The sign-out body
// awaits twice before it reaches the wipe — the draft scan reads the whole
// store, the push cleanup goes to the network — and a shared tablet changes
// hands across exactly that. Captured after them, the authority is the
// ARRIVING person's and the wipe deletes their work. So the source is read
// back: heldAuthority() must come before the first await in that function.
test("App.jsx captures the sign-out's authority before its first await", () => {
  const app = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("const signOut = async () => {");
  assert.ok(start > 0, "App.jsx must still hold the sign-out");
  const end = app.indexOf("\n  };", start);
  assert.ok(end > start);
  const body = app.slice(start, end);
  const capture = body.indexOf("OfflineCache.heldAuthority()");
  const firstAwait = body.indexOf("await ");
  assert.ok(capture > 0, "the sign-out must capture the authority it wipes on");
  assert.ok(firstAwait > 0, "the sign-out must still do asynchronous work");
  assert.ok(capture < firstAwait, "the capture must come before the first await, not after the cleanup");
});

// And the behaviour that assertion stands for: the device changes hands while
// the sign-out is inside its cleanup. Captured at entry, the authority is the
// leaving person's and their (now empty) store is what the wipe would touch;
// the arriving account's work is not this sign-out's to delete.
test("a sign-out whose device changes hands mid-cleanup keeps the new account's work", async () => {
  const cold8 = (await import("./offlineCache.js?tab=cold8")).OfflineCache;
  const app = tab(cold8);
  app.announce("tech-a");
  await cold8.claimFor("tech-a");
  await cold8.put("ticket.wip.J-101", { welds: 1 });

  // Entry. Everything after this is the cleanup the tablet changes hands in.
  const atEntry = cold8.heldAuthority();
  assert.ok(atEntry, "this tab holds tech-a's lease at entry");

  app.announce("tech-b");                              // handed over mid-sign-out
  await other.claimFor("tech-b");                      // B claims: A's store goes, B's begins
  await other.put("ticket.wip.J-102", { welds: 9 });

  // The capture App.jsx must NOT make — after the cleanup, it names B.
  assert.equal(cold8.heldAuthority(), null, "the retired tab holds nothing by then");

  assert.equal(await cold8.clear({ expect: atEntry }), false, "and the wipe is out of date");
  assert.deepEqual((await other.read("ticket.wip.J-102")).value, { welds: 9 }, "B's work stands");
});
