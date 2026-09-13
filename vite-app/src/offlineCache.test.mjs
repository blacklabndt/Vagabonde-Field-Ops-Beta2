// Tests for the other half of working offline — what the field screens read.
//
// Run with: node --test src/offlineCache.test.mjs
//
// The contract is narrow on purpose and every clause of it has teeth: the
// network is asked first, always; the remembered copy is served only for a
// genuine connectivity failure, never for a server that answered "no"; and
// anything served from memory flips the banner that admits it. A stale rate
// that quietly looked live is a worse problem than no rate at all.

// IndexedDB before the module, same as the queue's tests.
import "fake-indexeddb/auto";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

// isNetworkError (imported by the cache from the queue) reads navigator.onLine.
// It is a getter-only global in node, so it has to be defined over rather than
// assigned.
const nav = { onLine: true };
Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });

const { OfflineCache, CACHE_OWNER_KEY } = await import("./offlineCache.js");
const { IDENTITY_KEY } = await import("./session.js");

// Makes one key unreadable — a store that faults rather than a key that is
// absent, which is the distinction the handover turns on. The get is where
// IndexedDB reports it, so that is where this bites.
async function withUnreadable(key, fn) {
  const real = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (k) {
    if (k === key) throw new Error("the store would not read");
    return real.call(this, k);
  };
  try { return await fn(); }
  finally { IDBObjectStore.prototype.get = real; }
}

// readThrough deliberately does not await the write it starts — a read must
// not wait on disk. So poll for the outcome instead of sleeping.
// The deadline is performance.now() and never Date.now(), because `at()` below
// holds Date.now still — so a wait inside one that never came true polled for
// ever instead of failing, and one hung test file took the whole suite's
// summary with it.
async function eventually(fn, what = "the expected state", ms = 2000) {
  const until = performance.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (performance.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

// Run something with the clock held still, so a saved-at stamp is evidence
// rather than a race.
async function at(ts, fn) {
  const real = Date.now;
  Date.now = () => ts;
  try { return await fn(); }
  finally { Date.now = real; }
}

const failedFetch = () => { throw new TypeError("Failed to fetch"); };

// Writing straight to IndexedDB, behind the module's back. Since the lease
// went in, nothing reads or writes a row without one — which is the point —
// so a store left by an OLDER build, or by another tab, can only be set up
// from outside. Every "this is the state a real tablet is in" fixture below
// uses these; the module's own put/read are for what the app does.
async function rawDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("nde-offline-cache", 1);
    req.onupgradeneeded = () => { req.result.createObjectStore("reads", { keyPath: "key" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function rawWrite(run) {
  const db = await rawDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("reads", "readwrite");
    run(tx.objectStore("reads"));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
// An empty store with no marker at all: a device from before any of this.
const rawWipe = () => rawWrite(store => store.clear());
const rawPut = (key, value) => rawWrite(store => store.put({ key, value, at: Date.now() }));
const rawRead = async key => {
  const db = await rawDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction("reads", "readonly").objectStore("reads").get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
};

beforeEach(async () => {
  nav.onLine = true;
  // A fresh device, then somebody signs in. Every fenced read and write needs
  // a lease, and in the app one is always held by the time a screen reads a
  // row — the boot claims or adopts before anything else happens.
  await rawWipe();
  await OfflineCache.claimFor("tech-a");
});

test("a read that answers is the answer, and it is remembered", async () => {
  const value = { id: "J-77", project: "Wapiti 12-3" };
  const got = await OfflineCache.readThrough("job.J-77", async () => value);

  assert.deepEqual(got, value);
  assert.deepEqual(OfflineCache.state, { servingCached: false, at: null }, "no banner: this is live");
  const hit = await eventually(() => OfflineCache.read("job.J-77"), "the value to reach disk");
  assert.deepEqual(hit.value, value);
});

test("with the signal gone, the remembered copy is served — and says so", async () => {
  const value = { id: "J-77", project: "Wapiti 12-3" };
  await at(1_700_000_000_000, async () => {
    await OfflineCache.readThrough("job.J-77", async () => value);
    await eventually(() => OfflineCache.read("job.J-77"), "the value to reach disk");
  });

  const out = await OfflineCache.readThrough("job.J-77", failedFetch);
  assert.deepEqual(out, value, "the technician sees the day's work, not an empty table");
  assert.equal(OfflineCache.state.servingCached, true);
  assert.equal(OfflineCache.state.at, 1_700_000_000_000, "and the banner can say when this was true");

  // A read that answers again puts the app back on live data.
  await OfflineCache.readThrough("job.J-77", async () => value);
  assert.deepEqual(OfflineCache.state, { servingCached: false, at: null });
});

test("nothing remembered means the failure surfaces", async () => {
  await assert.rejects(
    () => OfflineCache.readThrough("job.never-opened-here", failedFetch),
    /Failed to fetch/,
    "an empty screen and a plain error beats inventing an answer"
  );
  assert.equal(OfflineCache.state.servingCached, false, "and no banner claims this is remembered data");
});

test("a real answer from the server is never replaced by a remembered one", async () => {
  await OfflineCache.readThrough("rates.published", async () => ({ film: 1200 }));
  await eventually(() => OfflineCache.read("rates.published"), "the value to reach disk");

  await assert.rejects(
    () => OfflineCache.readThrough("rates.published", async () => { throw new Error("permission denied for table rates"); }),
    /permission denied/,
    "a permission error is an answer, and has to be seen as one"
  );
  assert.equal(OfflineCache.state.servingCached, false);
});

test("a plain failure while the browser knows it is offline still serves the cache", async () => {
  await OfflineCache.readThrough("contacts", async () => [{ name: "Athabasca Energy" }]);
  await eventually(() => OfflineCache.read("contacts"), "the value to reach disk");

  nav.onLine = false;
  const out = await OfflineCache.readThrough("contacts", async () => { throw new Error("Load failed"); });
  assert.equal(out[0].name, "Athabasca Energy");
  assert.equal(OfflineCache.state.servingCached, true);
});

test("put, read and remove round-trip", async () => {
  await OfflineCache.put("job.J-9", { id: "J-9" });
  const hit = await OfflineCache.read("job.J-9");
  assert.equal(hit.value.id, "J-9");
  assert.ok(hit.at, "stamped, so the banner can date it");

  await OfflineCache.remove("job.J-9");
  assert.equal(await OfflineCache.read("job.J-9"), null);
  assert.equal(await OfflineCache.read("job.never-put"), null, "a key that was never here reads as nothing, not an error");
});

test("an unchanged result skips the disk; a changed one does not", async () => {
  const rates = { film: 1200 };
  await at(1_000, () => OfflineCache.readThrough("rates.default", async () => rates));
  await eventually(async () => (await OfflineCache.read("rates.default")) !== null, "the first write");
  assert.equal((await OfflineCache.read("rates.default")).at, 1_000);

  // The same bytes again — the chat polls its page for as long as the room is
  // open, and rewriting an identical blob every couple of minutes is battery
  // spent remembering what the device already knows.
  await at(2_000, async () => {
    await OfflineCache.readThrough("rates.default", async () => ({ film: 1200 }));
    // The write readThrough starts is not awaited, so prove the absence of one
    // by ordering: a readwrite transaction opened after it would have to queue
    // behind it. Once this awaited write has completed, any skipped one has
    // had its chance.
    await OfflineCache.put("_probe", 1);
  });
  assert.equal((await OfflineCache.read("rates.default")).at, 1_000, "the older saved-at stamp is honest — the content really is from then");

  // Changed bytes always land.
  await at(3_000, () => OfflineCache.readThrough("rates.default", async () => ({ film: 1350 })));
  const hit = await eventually(
    async () => { const h = await OfflineCache.read("rates.default"); return h && h.at === 3_000 ? h : null; },
    "the changed rate to be written"
  );
  assert.equal(hit.value.film, 1350);
});

test("nothing is remembered about nothing, and the last real answer survives it", async () => {
  // A null from the fetcher is an absence, not a copy — and the reads that
  // return one do it from an empty result, which is also exactly what a
  // lapsed session sees. Cached, that absence comes back offline as a fact:
  // "this client has no published rate schedule", about a client whose card
  // is fine.
  const got = await OfflineCache.readThrough("catalog.11", async () => null);
  assert.equal(got, null, "the caller still gets the answer it read");
  await OfflineCache.put("_probe", 1);   // an awaited write, so any skipped one has had its turn
  assert.equal(await OfflineCache.read("catalog.11"), null, "nothing was stored");

  // And a null after a real answer leaves the real one where it was, rather
  // than overwriting the only offline copy of the client's card with an
  // emptiness.
  await OfflineCache.readThrough("catalog.12", async () => ({ film: 1200 }));
  await eventually(() => OfflineCache.read("catalog.12"), "the real catalog to reach disk");
  await OfflineCache.readThrough("catalog.12", async () => undefined);
  await OfflineCache.put("_probe", 2);
  assert.deepEqual((await OfflineCache.read("catalog.12")).value, { film: 1200 });

  // The skip-unchanged guard was not told about the null either, so the next
  // real answer still writes.
  await OfflineCache.readThrough("catalog.11", async () => ({ film: 1350 }));
  const hit = await eventually(() => OfflineCache.read("catalog.11"), "the real catalog the null must not have silenced");
  assert.deepEqual(hit.value, { film: 1350 });
});

test("a write that failed leaves the key writable, not silenced", async () => {
  // IndexedDB refuses to store a function and JSON drops it, so this value
  // fails to write while comparing equal to the plain object after it — the
  // shape of the bug exactly. The skip-unchanged guard used to be recorded
  // before the write was known to have landed, so one failed write meant this
  // key had no offline copy for the rest of the tab's life.
  await OfflineCache.readThrough("rates.default", async () => ({ film: 1200, render: () => {} }));
  await OfflineCache.put("_probe", 1);   // an awaited write, so the failed one has had its turn
  assert.equal(await OfflineCache.read("rates.default"), null, "nothing was stored");

  await OfflineCache.readThrough("rates.default", async () => ({ film: 1200 }));
  const hit = await eventually(() => OfflineCache.read("rates.default"), "the copy the failed write still owes");
  assert.deepEqual(hit.value, { film: 1200 });
});

test("liveOnly refuses the remembered copy, and only while it runs", async () => {
  const rows = [{ id: "KK-0818-26-01" }];
  await OfflineCache.readThrough("tickets.7", async () => rows);
  await eventually(() => OfflineCache.read("tickets.7"), "the value to reach disk");

  await assert.rejects(
    () => OfflineCache.liveOnly(() => OfflineCache.readThrough("tickets.7", failedFetch)),
    /Failed to fetch/,
    "the archive would rather fail than zip what this device happens to remember"
  );
  assert.equal(OfflineCache.state.servingCached, false, "and nothing pretends the app went offline");

  // Outside it the fallback is exactly what it always was.
  assert.deepEqual(await OfflineCache.readThrough("tickets.7", failedFetch), rows);
});

test("liveOnly holds until the outermost call is done, and hands back its answer", async () => {
  await OfflineCache.readThrough("contacts", async () => [{ name: "Athabasca Energy" }]);
  await eventually(() => OfflineCache.read("contacts"), "the value to reach disk");

  const answer = await OfflineCache.liveOnly(async () => {
    // A nested call that finishes early must not take the switch with it.
    await OfflineCache.liveOnly(async () => "inner");
    await assert.rejects(() => OfflineCache.readThrough("contacts", failedFetch), /Failed to fetch/);
    return "outer";
  });
  assert.equal(answer, "outer");
  assert.deepEqual(await OfflineCache.readThrough("contacts", failedFetch), [{ name: "Athabasca Energy" }]);
});

test("signing out empties the cache — and the guard that skips writes with it", async () => {
  const rates = { film: 1200 };
  await OfflineCache.readThrough("rates.default", async () => rates);
  await OfflineCache.put("job.J-9", { id: "J-9" });
  await eventually(() => OfflineCache.read("rates.default"), "the value to reach disk");

  await OfflineCache.clear();
  assert.equal(await OfflineCache.read("rates.default"), null, "the next person cannot page through the last crew's work");
  assert.equal(await OfflineCache.read("job.J-9"), null);
  assert.deepEqual(OfflineCache.state, { servingCached: false, at: null });

  // The same fetch, unchanged, must reach disk again: the skip-unchanged guard
  // used to survive the clear, so the next session's offline copy was silently
  // never written.
  // Signing back in is what binds the next lease; nothing is written between
  // the sign-out and it.
  await OfflineCache.claimFor("tech-a");
  await OfflineCache.readThrough("rates.default", async () => rates);
  const hit = await eventually(() => OfflineCache.read("rates.default"), "the rebuilt offline copy");
  assert.deepEqual(hit.value, rates);
});

test("a different signer empties the device first; the same one keeps their work", async () => {
  await OfflineCache.claimFor("tech-a");
  // Halfway through a ticket when the session lapsed. The lapse takes the
  // remembered identity, not the work.
  await OfflineCache.put("ticket.wip.J-77", { weldLines: [{ key: "rt_film:2in", qty: 14 }] });

  assert.equal(await OfflineCache.claimFor("tech-a"), false, "signing back in is not a handover");
  assert.ok(await OfflineCache.read("ticket.wip.J-77"), "their own half-entered ticket is still here");

  assert.equal(await OfflineCache.claimFor("tech-b"), true, "a different account is");
  assert.equal(await OfflineCache.read("ticket.wip.J-77"), null, "and the last crew's hours went with the clear");
  assert.equal(await OfflineCache.owner(), "tech-b");
});

test("an unclaimed device whose remembered identity is this person keeps its cache", async () => {
  // The state every tablet in the crew is in the first time a build that
  // records owners starts up: an identity from the last sign-in, and no owner
  // beside it. Treating that as a stranger's device would empty the store of
  // the person doing the signing in, half-entered ticket and all.
  await rawWipe();
  await rawPut(IDENTITY_KEY, { id: "tech-a", name: "Kyle Keith" });
  await rawPut("ticket.wip.J-77", { weldLines: [{ key: "rt_film:2in", qty: 14 }] });
  assert.equal(await OfflineCache.owner(), null);

  assert.equal(await OfflineCache.claimFor("tech-a"), false, "adopting what is already theirs is not a handover");
  assert.ok(await OfflineCache.read("ticket.wip.J-77"), "so this morning's welds are still here");
  assert.equal(await OfflineCache.owner(), "tech-a", "and the device is claimed from now on");

  // Somebody else arriving at the same unclaimed device is still a handover.
  await rawWipe();
  await rawPut(IDENTITY_KEY, { id: "tech-a", name: "Kyle Keith" });
  await rawPut("ticket.wip.J-77", { weldLines: [] });
  assert.equal(await OfflineCache.claimFor("tech-b"), true);
  assert.equal(await OfflineCache.read("ticket.wip.J-77"), null, "the last crew's hours are not the new signer's to see");
});

test("a clear that fails leaves the device the last owner's, and says so out loud", async () => {
  // The handover's one hard guarantee: the new owner is recorded only once
  // the store has actually emptied. A claim that recorded B over a store
  // still full of A's work would make it A's hours that B reads the moment
  // the signal drops — and every later claimFor would see B as the owner and
  // never try the clear again. So it stays A's, and it throws: the sign-in
  // screen and the boot both refuse to sign anyone in on this.
  await OfflineCache.claimFor("tech-a");
  await OfflineCache.put("ticket.wip.J-77", { weldLines: [{ key: "rt_film:2in", qty: 14 }] });

  // The clear is now inside the claim's own transaction, so this is what a
  // store that will not empty looks like from in there.
  const realClear = IDBObjectStore.prototype.clear;
  IDBObjectStore.prototype.clear = () => { throw new Error("the store would not empty"); };
  try {
    await assert.rejects(() => OfflineCache.claimFor("tech-b"), /would not empty/);
  } finally {
    IDBObjectStore.prototype.clear = realClear;
  }

  assert.equal(await OfflineCache.owner(), "tech-a", "still A's device, so the next try clears again");
  assert.ok(await OfflineCache.read("ticket.wip.J-77"), "and A's half-entered ticket is still on it");
});

test("an unreadable owner record refuses the claim and clears nothing", async () => {
  // "We don't know whose this is" is not "nobody's". Read through a catch
  // that returned null, a store that faulted for a moment looked unclaimed —
  // so the claim below emptied the device of the very person signing in and
  // then recorded them as the owner of what it had just deleted, with no
  // second attempt ever, because from then on the owner really was them.
  await OfflineCache.claimFor("tech-a");
  await OfflineCache.put("ticket.wip.J-77", { weldLines: [{ key: "rt_film:2in", qty: 14 }] });

  await withUnreadable(CACHE_OWNER_KEY, async () => {
    await assert.rejects(() => OfflineCache.claimFor("tech-a"), /would not read/);
  });
  assert.ok(await OfflineCache.read("ticket.wip.J-77"), "their morning's welds are still on the device");
  assert.equal(await OfflineCache.owner(), "tech-a", "and it is still theirs, so the next try can decide properly");

  // The remembered-identity probe is the other half of the same answer: it is
  // the whole of the "unclaimed, but already theirs" case, so an unreadable
  // one must not fall through to the clear either.
  await rawWipe();
  await rawPut(IDENTITY_KEY, { id: "tech-a", name: "Kyle Keith" });
  await rawPut("ticket.wip.J-77", { weldLines: [] });

  await withUnreadable(IDENTITY_KEY, async () => {
    await assert.rejects(() => OfflineCache.claimFor("tech-a"), /would not read/);
  });
  assert.ok(await rawRead("ticket.wip.J-77"), "nothing was emptied on a read nobody could make");
  assert.equal(await OfflineCache.owner(), null, "and the device is still unclaimed");
});

test("a device nobody has claimed is emptied on the next sign-in", async () => {
  // Either a store written before owners were recorded, or one whose owner
  // was cleared with it. Unknown provenance is not "mine".
  await rawWipe();
  await rawPut("job.J-9", { id: "J-9" });
  assert.equal(await OfflineCache.owner(), null);

  assert.equal(await OfflineCache.claimFor("tech-a"), true);
  assert.equal(await OfflineCache.read("job.J-9"), null);
  assert.equal(await OfflineCache.owner(), "tech-a");

  // And a clear takes the ownership with it — an empty store belongs to
  // nobody, so the next signer isn't handed a claim over data that is gone.
  await OfflineCache.clear();
  assert.equal(await OfflineCache.owner(), null);
});

test("subscribers are told the state at once and on every change", async () => {
  const seen = [];
  const stop = OfflineCache.subscribe(s => seen.push(s.servingCached));
  assert.deepEqual(seen, [false], "called immediately with where things stand");

  await OfflineCache.readThrough("job.J-8", async () => ({ id: "J-8" }));
  await eventually(() => OfflineCache.read("job.J-8"), "the value to reach disk");
  assert.deepEqual(seen, [false], "a live read that changes nothing does not re-render the banner");

  await OfflineCache.readThrough("job.J-8", failedFetch);
  assert.deepEqual(seen, [false, true]);

  stop();
  OfflineCache.markLive();
  assert.deepEqual(seen, [false, true], "an unsubscribed listener hears nothing");
});
