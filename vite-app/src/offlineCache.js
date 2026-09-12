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

// ---------------------------------------------------------------------------
// The lease.
//
// IndexedDB is shared by every tab on the origin, and the owner marker on its
// own only ever answered "whose is this *now*". That is not enough for work
// that STARTED earlier: tab A asks for a job's tickets, tab B signs in as
// somebody else and empties the store, A's answer lands a second later and is
// written under B's name — and B, out of range that afternoon, reads A's
// client totals off their own device. Nothing about A's screen explains that
// away; the row is on the disk after A has gone.
//
// So a marker is `{ owner, epoch }` and a tab holds a LEASE: the exact pair it
// claimed. Every fenced read and every fenced write re-reads the marker inside
// the SAME IndexedDB transaction as the data it is touching and compares. A
// write whose lease no longer matches is dropped — never merged — and a read
// whose lease no longer matches is a miss, not a stale answer. The lease is
// captured before the async work starts, so what is compared is the state the
// work was begun under and not whatever happens to be true when it finishes.
//
// The epoch is what makes an A -> clear -> A cycle safe: the store the second
// A claims is a different store, empty, and every token minted against the
// first one is dead for good. It only ever goes up.
//
// A tab with no lease does nothing fenced at all. It may still ask who owns
// the device and what identity was remembered — that is the boot's explicit
// business, below — but it may not read or write a row, and it never adopts
// a lease another tab took. Binding is only ever `claimFor` or `adopt`.
const OWNERLESS = null;

function asMarker(value) {
  // Devices that were claimed before the epoch existed hold the bare user id.
  // They are epoch 0 of that owner — the same store, honestly described.
  if (typeof value === "string") return { owner: value, epoch: 0 };
  if (value && typeof value === "object" && typeof value.epoch === "number") {
    return { owner: typeof value.owner === "string" ? value.owner : OWNERLESS, epoch: value.epoch };
  }
  return null;
}

// The lease this tab holds, or null. Set only after a claim has actually
// committed: a claim that aborted leaves the marker, the data and this tab's
// binding exactly as they were.
let lease = null;

function matches(markerValue, held) {
  if (!held) return false;
  const marker = asMarker(markerValue);
  return !!marker && marker.owner === held.owner && marker.epoch === held.epoch;
}

// The same comparison where BOTH sides may be "no marker at all" — what the
// boot's own clear is fenced on. `null` there is a real state (a store no
// account has ever claimed) and not the absence of an expectation, so an
// ownerless marker left by somebody's sign-out does not answer to it.
function sameMarker(markerValue, expect) {
  const marker = asMarker(markerValue);
  if (!marker || !expect) return !marker && !expect;
  return marker.owner === expect.owner && marker.epoch === expect.epoch;
}

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

// Marks the answer of a transaction that found the lease had moved on. It is
// deliberately its own value and not `null`/`undefined`, so a caller can tell
// "the store says nothing is there" from "this was not yours to ask".
const REFUSED = Symbol("lease-moved-on");

// Every fenced operation. The marker is read FIRST and the work is issued from
// inside that read's own success handler, so the check and the access are one
// transaction and nothing can slip between them. `run(store)` issues its
// requests synchronously and returns a thunk read after the commit.
async function leased(mode, run, held = lease) {
  if (!held) return REFUSED;
  const db = await ocOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OC_STORE, mode);
    const store = tx.objectStore(OC_STORE);
    let answer = () => REFUSED;
    const req = store.get(CACHE_OWNER_KEY);
    req.onsuccess = () => {
      if (!matches(req.result ? req.result.value : null, held)) return;
      answer = run(store);
    };
    tx.oncomplete = () => resolve(answer());
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// The two unfenced reads, and the one unfenced delete: the boot has to be able
// to ask who owns this device and who it last had signed in before it can
// claim anything, and a session that has lapsed has to be able to forget the
// identity whether or not this tab ever held a lease. Neither is a row of
// anybody's work. Nothing else bypasses the fence.
async function ocGetRaw(key) {
  const db = await ocOpenDb();
  const tx = db.transaction(OC_STORE, "readonly");
  const req = tx.objectStore(OC_STORE).get(key);
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function ocDeleteRaw(key) {
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

// Every change of lease empties the skip-unchanged guard. It is keyed by
// cache key alone, so a serialization remembered under the last account would
// let the next one's identical fetch skip the write it actually needs.
const onBind = new Set();
function bind(next) {
  lease = next;
  rtLastWritten.clear();
  // Everything else in the app that remembers a row in MEMORY is told at the
  // same instant, from the one place a lease can change, so no transition can
  // be missed by a call site forgetting to say so. db.js's reference-data
  // cache is the one that matters: it has no owner concept at all, its keys
  // are account-blind ("contacts", "profiles"), and a walk already in flight
  // when the device changes hands would otherwise settle into it.
  onBind.forEach(fn => { try { fn(next); } catch { /* a listener is not the claim's problem */ } });
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

  // Told whenever this tab's lease changes — a claim, an adoption, a clear.
  // For anything holding rows in memory, which the fence cannot reach: see
  // bind() above. Registered once at module load and never removed.
  onLeaseChange(fn) { onBind.add(fn); return () => onBind.delete(fn); },

  // The lease to write an answer under, taken BEFORE the work that produces
  // it starts. A caller that fetches and then puts must hold one across the
  // fetch — passing it to put/remove/read is what makes the answer land (or
  // be dropped) according to who this device belonged to when it was asked
  // for, rather than who it belongs to when the radio finally replies.
  hold() { return lease; },

  // Store without reading — for values fetched as part of a bigger response
  // (the jobs page carries every job on it, so each one is worth keeping).
  async put(key, value, held = lease) {
    // Stamped when the caller asked, not when the transaction opened: the
    // fence puts a real IndexedDB read in front of every write now, and the
    // banner's "this is what was here at 14:32" is about the answer, not
    // about the disk.
    const at = Date.now();
    try {
      await leased("readwrite", store => {
        store.put({ key, value, at });
        return () => true;
      }, held);
    } catch { /* a cache write is never worth failing a read over */ }
  },

  async read(key, held = lease) {
    const hit = await leased("readonly", store => {
      const req = store.get(key);
      return () => req.result || null;
    }, held);
    return hit === REFUSED ? null : hit;
  },

  // Every remembered key that starts with `prefix`. How sign-out finds the
  // half-entered tickets and assessments it is about to wipe, and how a
  // job's deletion finds the per-client job lists that still name it.
  async keys(prefix = "", held = lease) {
    const all = await leased("readonly", store => {
      const req = store.getAllKeys();
      return () => req.result || [];
    }, held);
    if (all === REFUSED) return [];
    return all.filter(k => typeof k === "string" && k.startsWith(prefix));
  },

  // Drop one entry. Used by the ticket screen to throw away its in-progress
  // copy once the real thing is safely stored — a leftover would otherwise be
  // offered back the next time that job's ticket screen opens.
  // The skip-unchanged guard forgets the key too, or the next identical
  // fetch would skip the write and leave the offline copy missing.
  async remove(key, held = lease) {
    rtLastWritten.delete(key);
    try {
      await leased("readwrite", store => {
        store.delete(key);
        return () => true;
      }, held);
    } catch { /* likewise */ }
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
    const hit = await ocGetRaw(CACHE_OWNER_KEY);
    const marker = asMarker(hit ? hit.value : null);
    return marker ? marker.owner : null;
  },

  // The whole marker, owner and epoch, for a caller that has to come back to
  // this exact state later: the boot reads it before it asks the server
  // anything, and hands it back to clear() as the authority for a wipe it
  // holds no lease for. Unfenced for the same reason owner() is — it is the
  // question that decides the claim, so it cannot be behind one.
  async marker() {
    const hit = await ocGetRaw(CACHE_OWNER_KEY);
    return asMarker(hit ? hit.value : null);
  },

  // The boot's explicit, unfenced doors, and the only ones. Reading who
  // was last signed in here is what DECIDES the claim, so it cannot be
  // behind the claim; forgetting them is never a disclosure.
  async readIdentity() { return ocGetRaw(IDENTITY_KEY); },
  async forgetIdentity() { return ocDeleteRaw(IDENTITY_KEY); },

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
  // The whole decision is ONE transaction: the marker, the remembered
  // identity, the clear and the new marker. Read-then-write across two would
  // let a second tab claim between them, and the loser would empty a store
  // the winner had already filled. The lease is bound only once that
  // transaction has committed — a claim that aborted leaves this tab holding
  // nothing, which is the same refusal as before, and leaves the data and
  // the marker untouched.
  async claimFor(userId) {
    const settled = await settleOwner(userId, true);
    return settled ? settled.cleared : false;
  },

  // The same claim without the clear, for a session restored from this
  // device's own memory with no network: the owner is normally this same
  // person, and a boot with no signal is exactly when a wipe would be
  // unrecoverable. A stranger's store is not emptied and not adopted — the
  // tab simply binds nothing, and every fenced read and write refuses for
  // the rest of it. Fail closed: the screens show an error, not somebody
  // else's jobs.
  async adopt(userId) {
    const settled = await settleOwner(userId, false);
    if (!settled) {
      // Refused, and the refusal RETIRES whatever this tab was holding. The
      // marker names somebody else, which is proof this device changed hands
      // since — so the lease from before it did describes a store that is no
      // longer there, and reading a row under it would serve the previous
      // account's data to the account that was just refused the device. A
      // storage FAILURE is not this: settleOwner throws on one, and the
      // binding is left exactly as it was, because an IndexedDB blip is not
      // evidence of anything.
      bind(null);
      return false;
    }
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
    // Taken before the fetch, not at the write: the answer belongs to
    // whoever this device belonged to when it was asked for. See the lease.
    const held = lease;
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
        //
        // The guard is only updated while the lease still stands, or a write
        // the fence dropped would be remembered as one that landed.
        const at = Date.now();
        leased("readwrite", store => {
          store.put({ key, value, at });
          return () => true;
        }, held).then(
          done => { if (done === true) rtLastWritten.set(key, serialized); else rtLastWritten.delete(key); },
          () => rtLastWritten.delete(key)
        );
      }
      return value;
    } catch (e) {
      // Inside liveOnly nothing may be answered from memory — the caller has
      // said a remembered copy would be worse than an error.
      if (liveOnlyDepth > 0) throw e;
      if (!isNetworkError(e)) throw e;
      // Fenced on the lease this read began under: a device that changed
      // hands mid-request has no remembered copy to offer this caller, and
      // the failure is the honest answer.
      const hit = await leased("readonly", store => {
        const req = store.get(key);
        return () => req.result || null;
      }, held).catch(() => null);
      if (!hit || hit === REFUSED) throw e;
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
  //
  // What it leaves behind is one ownerless marker at the NEXT epoch. An empty
  // store with no marker at all would let every lease minted against the old
  // one match again the moment the same person signed back in — the store
  // would be a different store and the tokens for it would still be good.
  // A tab that HOLDS a lease may only empty the store that lease names. A
  // sign-out arriving late from a tab whose account was replaced an hour ago
  // is not this device's sign-out, and emptying on it takes the half-entered
  // tickets of whoever is using the tablet now. It answers false in that case
  // and lets go of its lease: what it meant to delete is already gone.
  //
  // A tab holding NO lease empties NOTHING. Having no authority is not a
  // kind of authority: a stale tab that has already been refused once would
  // otherwise succeed on its second try, and a boot whose answer about a
  // retired account came back a minute late would empty the store another
  // tab had claimed and filled meanwhile.
  //
  // The boot's own wipe — the account the server has just retired, decided
  // before anything is claimed — passes `{ expect }`: the marker it read
  // BEFORE it asked the server, re-read inside this transaction and required
  // to be unchanged. That is an authority captured at a known moment, not one
  // conjured out of holding nothing. `expect: null` is itself a state (a
  // store nobody has ever claimed) and matches only that.
  async clear(opts) {
    // The guard map has to empty with the store: after a sign-out it still
    // held the last serializations, so the next session's unchanged fetches
    // skipped their writes and the offline fallback was silently gone.
    rtLastWritten.clear();
    const stated = !!opts && Object.prototype.hasOwnProperty.call(opts, "expect");
    const expect = stated ? asMarker(opts.expect) : lease;
    // Neither a lease nor a stated expectation: nothing to be sure of, so
    // nothing is deleted. The tab is left as it was — it holds no lease
    // anyway — and the caller is told it emptied nothing.
    if (!stated && !lease) return false;
    const db = await ocOpenDb();
    const emptied = await new Promise((resolve, reject) => {
      const tx = db.transaction(OC_STORE, "readwrite");
      const store = tx.objectStore(OC_STORE);
      let did = false;
      const req = store.get(CACHE_OWNER_KEY);
      req.onsuccess = () => {
        const value = req.result ? req.result.value : null;
        if (!sameMarker(value, expect)) return;
        const marker = asMarker(value);
        store.clear();
        store.put({ key: CACHE_OWNER_KEY, value: { owner: OWNERLESS, epoch: (marker ? marker.epoch : 0) + 1 }, at: Date.now() });
        did = true;
      };
      tx.oncomplete = () => resolve(did);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    // This tab's own lease went with the store it named, whether or not the
    // store was this tab's to empty. Whoever signs in next binds a new one;
    // until then nothing fenced is read or written.
    bind(null);
    setState({ servingCached: false, at: null });
    return emptied;
  }
};

// The one place an owner marker is decided and written. `mayClear` is the
// difference between signing in (a stranger's store is emptied at the door)
// and restoring this device's own remembered session with no signal (a
// stranger's store is left alone and simply not adopted).
//
// Answers the marker it settled on, or null for "not this tab's to hold".
async function settleOwner(userId, mayClear) {
  if (!userId) return null;
  const db = await ocOpenDb();
  const settled = await new Promise((resolve, reject) => {
    const tx = db.transaction(OC_STORE, "readwrite");
    const store = tx.objectStore(OC_STORE);
    let out = null;
    const wipe = marker => {
      store.clear();
      const next = { owner: userId, epoch: (marker ? marker.epoch : 0) + 1 };
      store.put({ key: CACHE_OWNER_KEY, value: next, at: Date.now() });
      return { marker: next, cleared: true };
    };
    // A read or a write that faults inside the decision ends the whole
    // transaction and is reported as itself. Swallowed, an unreadable marker
    // or identity becomes "a stranger's" and takes the clear with it — which
    // is how a moment's IndexedDB fault once cost a device its own owner's
    // half-entered tickets, and recorded them as the new owner of what it had
    // just deleted.
    const failed = e => { out = null; try { tx.abort(); } catch { /* already gone */ } reject(e); };
    const decide = marker => {
      if (marker && marker.owner === userId) {
        // Already theirs. The epoch stands: nothing was emptied, so every
        // lease against it is still describing the store it describes.
        out = { marker, cleared: false };
        return;
      }
      if (!marker || marker.owner === OWNERLESS) {
        // "Nobody has claimed this" is not the same as "this is a
        // stranger's". Owners started being recorded after the store did, so
        // the first online start once that shipped finds every tablet in the
        // crew unclaimed — and clearing on that basis would empty the store
        // of the very person signing in, half-entered tickets and all. The
        // remembered identity settles it: if this device's last identity is
        // already this account, it is theirs, so record the claim and keep
        // the work. A remembered stranger, or no identity at all, is still
        // emptied at the door.
        //
        // Read in this same transaction, and a read that faults aborts the
        // whole of it rather than quietly becoming "a stranger's" and taking
        // the clear below with it.
        const iReq = store.get(IDENTITY_KEY);
        iReq.onsuccess = () => {
          try {
            const hit = iReq.result;
            if (hit && hit.value && hit.value.id === userId) {
              const next = { owner: userId, epoch: marker ? marker.epoch : 0 };
              store.put({ key: CACHE_OWNER_KEY, value: next, at: Date.now() });
              out = { marker: next, cleared: false };
            } else if (mayClear) {
              out = wipe(marker);
            }
          } catch (e) { failed(e); }
        };
        return;
      }
      if (mayClear) out = wipe(marker);
    };
    let mReq;
    try { mReq = store.get(CACHE_OWNER_KEY); } catch (e) { failed(e); return; }
    mReq.onsuccess = () => {
      try { decide(asMarker(mReq.result ? mReq.result.value : null)); }
      catch (e) { failed(e); }
    };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  // Bound only now the transaction has committed.
  if (!settled) return null;
  bind(settled.marker);
  if (settled.cleared) setState({ servingCached: false, at: null });
  return settled;
}
