// Offline queue for the three field screens that need to keep working with no
// signal: the JHA builder, report upload, and the billing ticket. Queued
// items live in IndexedDB — not localStorage, since a report upload carries a
// real PDF File and localStorage can't hold one — so they survive a reload
// and replay automatically the moment the browser is back online.
//
// This never queues a real app error (a completed job, a bad value) — only a
// genuine connectivity failure. Anything else still surfaces immediately,
// same as before.

import { Toasts } from "./toastBus.js";

const OQ_DB_NAME = "nde-offline-queue";
const OQ_STORE = "queue";

// One connection for the life of the tab. Every queue operation used to open
// its own and never close it, so a session that queued and flushed a few times
// left a handful of live IndexedDB connections behind — enough to block a
// version upgrade later on.
let oqDbPromise = null;
function oqOpenDb() {
  if (oqDbPromise) return oqDbPromise;
  oqDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(OQ_DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(OQ_STORE, { keyPath: "id" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { oqDbPromise = null; reject(req.error); };
  });
  return oqDbPromise;
}

function oqPromisifyTx(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function oqPut(item) {
  const db = await oqOpenDb();
  const tx = db.transaction(OQ_STORE, "readwrite");
  tx.objectStore(OQ_STORE).put(item);
  await oqPromisifyTx(tx);
}

async function oqDelete(id) {
  const db = await oqOpenDb();
  const tx = db.transaction(OQ_STORE, "readwrite");
  tx.objectStore(OQ_STORE).delete(id);
  await oqPromisifyTx(tx);
}

// Whose outbox this is. The crew shares tablets: tech A's queued ticket must
// not replay under tech B's session (the insert is refused — the row names
// A — and lands in B's panel as "won't sync", one tap from being discarded).
// Every item is stamped with the profile that queued it, and everything
// below shows and replays only the signed-in person's own. An item with no
// owner predates the stamp and is treated as the current person's. With
// nobody signed in, only those unstamped items are anyone's: a null owner
// used to mean "everything", which was one rendered outbox away from
// showing tech A's queued day to whoever picked the tablet up next.
let oqOwner = null;
const oqMine = item => !item.owner || (!!oqOwner && item.owner === oqOwner);

async function oqGetAll() {
  const db = await oqOpenDb();
  const tx = db.transaction(OQ_STORE, "readonly");
  const req = tx.objectStore(OQ_STORE).getAll();
  const result = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return result.filter(oqMine).sort((a, b) => a.createdAt - b.createdAt);
}

// A network failure looks like a thrown TypeError from fetch ("Failed to
// fetch", "NetworkError…", "Load failed" on Safari) or the browser already
// knowing it has no connection. Anything else — a validation message, a
// permission error, a completed job — is a real error and must not be queued
// silently, or the crew never finds out something is actually wrong.
export function isNetworkError(e) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  // Some failures can only be recognised where they were caught. An Edge
  // Function call that never reached the network arrives from functions-js
  // wearing a fixed message with no network words in it, so db.js flags the
  // Error it throws (fnError) instead of hoping a pattern below matches.
  if (e && e.networkFailure) return true;
  const msg = String((e && e.message) || "");
  return /failed to fetch|networkerror|load failed|network request failed|ERR_INTERNET_DISCONNECTED/i.test(msg);
}

const oqListeners = new Set();
function oqNotify() {
  // Nobody listening, nothing to read: setOwner runs at sign-in after
  // React has torn the badge's subscription down and before it is remade,
  // and the remade one reads the list itself.
  if (!oqListeners.size) return;
  // A read that fails (IndexedDB gone, private mode) must not become an
  // unhandled rejection in whoever's save path triggered it.
  oqGetAll().then(items => oqListeners.forEach(fn => fn(items))).catch(() => {});
}

let oqFlushing = null;

async function oqFlushOnce(handlers) {
  let synced = 0, stillOffline = false;
  const items = await oqGetAll();
  for (const item of items) {
    const handler = handlers[item.type];
    if (!handler) {
      // Nothing here knows how to replay it — a build mismatch. Say so in
      // the panel instead of keeping the badge lit over an item nobody can
      // see or act on.
      if (!item.lastError) {
        await oqPut({ ...item, lastError: "This item can't be synced by this version of the app — install the update, then retry." });
        oqNotify();
      }
      continue;
    }

    // Handlers that take more than one write get a way to record what has
    // already landed. Without it, a replay that dies halfway starts again
    // from the top: a ticket whose row was created but whose crew hadn't
    // been saved yet comes back as a *second* ticket with a second number,
    // and the first is left with no crew on it. Signal dropping mid-write
    // is the normal condition out there, not the rare one.
    //
    // The checkpoint is written to IndexedDB before the next step runs, so
    // it survives the tab being closed as well as the request failing.
    let current = item;
    const checkpoint = async fields => {
      current = { ...current, payload: { ...current.payload, ...fields } };
      await oqPut(current);
    };

    try {
      await handler(item.payload, checkpoint);
      await oqDelete(item.id);
      synced++;
      oqNotify();
    } catch (e) {
      // A refusal the server actually gave is a reason, whatever the radio
      // is doing now: isNetworkError says "offline" for any error while
      // navigator.onLine is false, and a refused replay rethrown into a
      // dead spot would otherwise stop with no reason written for it.
      if (!e.plain && isNetworkError(e)) { stillOffline = true; break; }
      // A real error on replay (e.g. the job was completed meanwhile) —
      // leave it queued with the reason attached rather than dropping the
      // work silently. Whoever reviews the queue can see why it stalled.
      //
      // Written from `current`, not `item`: if the handler checkpointed
      // before it failed, saving the original payload here would throw that
      // progress away and the retry would duplicate the work it already did.
      await oqPut({ ...current, lastError: e.message || "Couldn't sync this item." });
      oqNotify();
    }
  }
  return { synced, stillOffline };
}

export const OfflineQueue = {
  isNetworkError,

  // Who the outbox belongs to from now on — set at sign-in, cleared at
  // sign-out (App.jsx). Items queued while nobody is signed in carry no
  // owner, which the filter above reads as "whoever is here".
  setOwner(profileId) {
    oqOwner = profileId || null;
    // The badge and the panel hold whatever list they were last handed;
    // a new owner means a different list, so hand it out again — without
    // this, the next person on a shared tablet saw the last one's outbox.
    oqNotify();
  },

  async enqueue(type, payload) {
    const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    await oqPut({ id, type, payload, owner: oqOwner, createdAt: Date.now(), lastError: null });
    oqNotify();
    return id;
  },

  list: oqGetAll,

  // Throwing away an item that will never sync — a ticket for a job that was
  // completed while the crew was out of range, say. Only ever called with the
  // reason on screen and a confirmation behind it: this is somebody's day of
  // work, and nothing else holds a copy.
  async remove(id) {
    await oqDelete(id);
    oqNotify();
  },

  // Called on load and whenever the browser comes back online. Replays each
  // queued item through the real handler in the order it was queued.
  //
  // One flush at a time: the load-time call and an `online` event that fires
  // moments later would otherwise both be walking the same list, and a ticket
  // whose handler was still running would be replayed — and re-sent — twice.
  async flush(handlers) {
    if (oqFlushing) return oqFlushing;
    oqFlushing = (async () => {
      // Replaying calls the same writes a person would, so without this a
      // truck coming back into signal would throw a handful of "Ticket
      // created" confirmations at whoever is holding it, for work done hours
      // ago. The queue badge and its panel are how syncing reports itself.
      Toasts.mute();
      try { return await oqFlushOnce(handlers); }
      finally { Toasts.unmute(); oqFlushing = null; }
    })();
    return oqFlushing;
  },

  // Subscribe to queue changes — used by the topbar badge. Calls back
  // immediately with the current list, then again on every change.
  subscribe(fn) {
    oqListeners.add(fn);
    oqGetAll().then(fn).catch(() => {});
    return () => oqListeners.delete(fn);
  },

  // onSynced, when given, is told once after any flush that sent at least
  // one item — a partial drain that ended still offline included — so the
  // caller can re-read what the outbox just changed, once, rather than
  // once per item as the badge's count shrinks.
  attachAutoFlush(handlers, onSynced = null) {
    const tryFlush = () => this.flush(handlers)
      .then(r => { if (onSynced && r && r.synced) onSynced(); })
      .catch(() => {});
    window.addEventListener("online", tryFlush);
    tryFlush();
    return () => window.removeEventListener("online", tryFlush);
  }
};
