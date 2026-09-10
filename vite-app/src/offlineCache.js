// The read half of working offline.
//
// The offline queue keeps work that is on its way *out*. This keeps the last
// known copy of what the field screens need on the way *in* — the jobs board,
// a job's record and history, the client's rates, who is on the crew — so a
// technician who opens the app on a lease with no signal sees the day's work
// instead of an empty table and "Failed to fetch".
//
// Deliberately a fallback, never a first choice: every read goes to Supabase
// first and only drops to the cache when the network genuinely fails. A stale
// rate that quietly looked live would be a worse problem than no rate at all,
// which is why anything served from here also flips the banner that says so.
//
// Kept in its own IndexedDB database rather than a store inside the queue's,
// so the two never share an upgrade path — losing queued work to a schema
// bump on the cache would be an absurd way to lose a day of billing.

import { isNetworkError } from "./offlineQueue.js";
// Only the key name — session.js is plain logic over data.js, no env, no
// browser, so the tests still load this module.
import { IDENTITY_KEY } from "./session.js";

const OC_DB_NAME = "nde-offline-cache";
const OC_STORE = "reads";

// Whose remembered data this device is holding. Written beside the data
// itself rather than derived from the session, because the session is the
// thing that goes away: a lapsed session takes the remembered identity with
// it (see App.jsx's boot) and the half-entered tickets it leaves behind still
// have to be recognisable as the same person's when they sign back in.
//
// It is never an answer to "who is allowed in" — only to "whose is this".
export const CACHE_OWNER_KEY = "cache.owner";

let ocDbPromise = null;
function ocOpenDb() {
  if (ocDbPromise) return ocDbPromise;
  ocDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(OC_DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(OC_STORE, { keyPath: "key" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { ocDbPromise = null; reject(req.error); };
  });
  return ocDbPromise;
}

async function ocGet(key) {
  const db = await ocOpenDb();
  const tx = db.transaction(OC_STORE, "readonly");
  const req = tx.objectStore(OC_STORE).get(key);
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function ocPut(key, value) {
  const db = await ocOpenDb();
  const tx = db.transaction(OC_STORE, "readwrite");
  tx.objectStore(OC_STORE).put({ key, value, at: Date.now() });
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function ocDelete(key) {
  const db = await ocOpenDb();
  const tx = db.transaction(OC_STORE, "readwrite");
  tx.objectStore(OC_STORE).delete(key);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Whether the app is currently showing remembered data, and how old it is.
// One flag for the whole app rather than per-screen: "some of this page is
// from Tuesday" is not a thing anyone can act on, but "you are offline, this
// is what was here at 14:32" is.
let state = { servingCached: false, at: null };
const listeners = new Set();
// What readThrough last wrote per key, serialized — the guard that keeps
// an unchanged poll result from touching IndexedDB again.
const rtLastWritten = new Map();
// How many liveOnly calls are in flight. While any is, readThrough refuses
// to fall back: see liveOnly below.
let liveOnlyDepth = 0;
const notify = () => listeners.forEach(fn => { fn(state); });

function setState(next) {
  if (next.servingCached === state.servingCached && next.at === state.at) return;
  state = next;
  notify();
}

export const OfflineCache = {
  get state() { return state; },

  subscribe(fn) {
    listeners.add(fn);
    fn(state);
    return () => listeners.delete(fn);
  },

  // A successful read from the network means we are back; clear the banner.
  markLive() { setState({ servingCached: false, at: null }); },

  // For callers that do their own fallback rather than going through
  // readThrough (the jobs board, which serves one cached page for any query).
  noteServingCached(at) { setState({ servingCached: true, at }); },

  // Store without reading — for values fetched as part of a bigger response
  // (the jobs page carries every job on it, so each one is worth keeping).
  put(key, value) { return ocPut(key, value).catch(() => {}); },

  read(key) { return ocGet(key); },

  // Every remembered key that starts with `prefix`. How sign-out finds the
  // half-entered tickets and assessments it is about to wipe, and how a
  // job's deletion finds the per-client job lists that still name it.
  async keys(prefix = "") {
    const db = await ocOpenDb();
    const tx = db.transaction(OC_STORE, "readonly");
    const req = tx.objectStore(OC_STORE).getAllKeys();
    const all = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    return all.filter(k => typeof k === "string" && k.startsWith(prefix));
  },

  // Drop one entry. Used by the ticket screen to throw away its in-progress
  // copy once the real thing is safely stored — a leftover would otherwise be
  // offered back the next time that job's ticket screen opens.
  // The skip-unchanged guard forgets the key too, or the next identical
  // fetch would skip the write and leave the offline copy missing.
  remove(key) {
    rtLastWritten.delete(key);
    return ocDelete(key).catch(() => {});
  },

  // The account this device's cache belongs to, or null if nobody has
  // claimed it (a fresh install, or a store that has just been emptied).
  //
  // A read that faults is not "nobody" — it is "we don't know", and claimFor
  // answers "nobody" by emptying the store. Swallowed into null, one
  // unreadable read cost the device's own owner every half-entered ticket on
  // it, and recorded them as the new owner of what it had just deleted. It
  // throws instead; the callers already refuse the sign-in and say so, the
  // same as for a clear that would not land.
  async owner() {
    const hit = await ocGet(CACHE_OWNER_KEY);
    return hit ? hit.value : null;
  },

  // Called wherever an account takes this device over — signing in, and the
  // quiet restore of a session on start — before anything of theirs is
  // written.
  //
  // Cache keys are not scoped to an account — "contacts", "job.<id>",
  // "ticket.wip.<job>" — so the protection has to be at the door. The same
  // person keeps what this device remembers, including the ticket they were
  // halfway through when the session lapsed. Anyone else and the store is
  // emptied first: on a shared tablet the previous crew's hours are not the
  // new signer's to see. A device with no owner recorded falls back to the
  // remembered identity — see below.
  //
  // The new owner is recorded only once the clear has actually landed — a
  // clear that failed must not leave this device claiming to belong to
  // someone whose data is not on it. clear() throws in that case; the caller
  // decides what to say.
  async claimFor(userId) {
    if (!userId) return false;
    const owner = await this.owner();
    if (owner === userId) return false;
    // "Nobody has claimed this" is not the same as "this is a stranger's".
    // Owners started being recorded after the store did, so the first online
    // start once that shipped finds every tablet in the crew unclaimed — and
    // clearing on that basis would empty the store of the very person signing
    // in, half-entered tickets and all. The remembered identity settles it:
    // if this device's last identity is already this account, it is theirs,
    // so record the claim and keep the work. A remembered stranger, or no
    // identity at all, is still emptied at the door.
    if (owner === null) {
      // Faults out for the same reason owner() does: this read is the whole
      // of the "it is already theirs" case, so an unreadable one must not
      // quietly become "a stranger's" and take the clear below with it.
      const hit = await ocGet(IDENTITY_KEY);
      if (hit && hit.value && hit.value.id === userId) {
        await ocPut(CACHE_OWNER_KEY, userId);
        return false;
      }
    }
    await this.clear();
    await ocPut(CACHE_OWNER_KEY, userId);
    return true;
  },

  // Run something with the fallback switched off: while it runs, a failed
  // read throws instead of being answered from memory. For work whose whole
  // point is that it read the server — the archive, which is checked and then
  // used to justify deleting the jobs it holds. A signal blip mid-build would
  // otherwise hand it this device's stale (or empty) copy of a job's tickets,
  // and an archive that verifies while missing real tickets is how the one
  // bulk delete in the app loses work.
  //
  // A counter, not a flag, so overlapping and nested calls each hold it. It
  // is module-wide rather than per-call: anything else the tab reads while it
  // is set loses its fallback too, which for the seconds each job's reads
  // take is the safe way round — a screen shows an error instead of stale data.
  async liveOnly(fn) {
    liveOnlyDepth++;
    try { return await fn(); }
    finally { liveOnlyDepth--; }
  },
  // For a reader that swallows its own failures with a stand-in: inside
  // liveOnly the stand-in is exactly what the caller refused.
  isLiveOnly() { return liveOnlyDepth > 0; },

  // Network first, remembered copy second, and only ever for a real
  // connectivity failure. A permission error or a bad request is a genuine
  // answer from the server and has to surface as one.
  //
  // Unchanged results skip the disk: the chat polls its page every couple
  // of minutes for as long as the room is open, and rewriting an identical
  // 100KB blob to IndexedDB each time is battery spent remembering what
  // the device already knows. The stringify used for the comparison is an
  // order of magnitude cheaper than the write it saves. Trade: a skipped
  // write keeps the older saved-at stamp, which is honest — the content
  // really is from then.
  async readThrough(key, fetcher) {
    try {
      const value = await fetcher();
      this.markLive();
      // A null is never worth remembering. It is not a copy of anything — it
      // is "there was nothing there", and served back offline it becomes an
      // emptiness the screen states as fact: no published rate card, no job.
      // Worse, the reads that answer null do it from an empty result, and an
      // empty result is also what a lapsed session sees, so the one thing
      // most likely to be cached here is the absence caused by being signed
      // out. Left unwritten, the key keeps the last real answer it had, or
      // stays absent and lets the failure surface as a failure.
      if (value == null) return value;
      const serialized = JSON.stringify(value);
      if (rtLastWritten.get(key) !== serialized) {
        // Recorded when the write actually lands, and forgotten if it does
        // not. Setting it up front meant a single failed IndexedDB write
        // silenced that key for the life of the tab: every identical fetch
        // afterwards compared equal and skipped the write it still needed,
        // so the offline copy the guard was protecting was never there.
        ocPut(key, value).then(() => rtLastWritten.set(key, serialized), () => rtLastWritten.delete(key));
      }
      return value;
    } catch (e) {
      // Inside liveOnly nothing may be answered from memory — the caller has
      // said a remembered copy would be worse than an error.
      if (liveOnlyDepth > 0) throw e;
      if (!isNetworkError(e)) throw e;
      const hit = await ocGet(key).catch(() => null);
      if (!hit) throw e;
      setState({ servingCached: true, at: hit.at });
      return hit.value;
    }
  },

  // Everything this device remembers, dropped. Used when signing out, so the
  // next person to use the tablet cannot page through the last crew's work.
  //
  // Cache keys are not scoped to an account — "contacts", "job.<id>" — because
  // they are the same rows whoever is reading them. That is fine while a
  // session lasts and is exactly why this has to actually succeed: whatever
  // survives a sign-out is readable by the next person to sign in, the moment
  // they lose signal.
  //
  // It used to resolve on error as well as on success, so a clear that aborted
  // was indistinguishable from one that worked, and the guarantee in the
  // paragraph above was a hope. It now throws, and the caller says so.
  //
  // Emptying the store, deliberately, rather than deleting the database. A
  // deleteDatabase fallback was tried and taken back out: it is blocked by any
  // other tab holding the same origin open, which on a shared tablet with the
  // app open twice is far more likely than the aborted transaction it was
  // meant to rescue. Trading a rare silent failure for a common noisy one is
  // not a trade.
  async clear() {
    // The guard map has to empty with the store: after a sign-out it still
    // held the last serializations, so the next session's unchanged fetches
    // skipped their writes and the offline fallback was silently gone.
    rtLastWritten.clear();
    const db = await ocOpenDb();
    const tx = db.transaction(OC_STORE, "readwrite");
    tx.objectStore(OC_STORE).clear();
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    setState({ servingCached: false, at: null });
  }
};
