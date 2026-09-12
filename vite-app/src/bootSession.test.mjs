import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { restoreSession } from "./session.js";

// App.jsx's own bootSession, lifted out and run. session.test.mjs covers
// restoreSession's decisions and recovery.test.mjs covers the latch; neither
// touches what the BOOT then does with those answers, which is where the
// destructive acts live — the sign-out, forgetStoredSession, and the two
// cache wipes. Everything it reads from its closure is handed in, so a
// change to any of those acts shows up here.
const source = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
const start = source.indexOf("const bootSession = async () => {");
const end = source.indexOf("\n  };", source.indexOf("console.error(\"Couldn't restore the session:", start)) + 5;
assert.ok(start > 0 && end > start, "App.jsx must still hold bootSession");
const region = source.slice(start, end);
assert.match(region, /if \(claimFailed\) \{/, "the claim-failure branch must be in the lifted region");

const DEPS = ["setBootError", "restoreSession", "sbClient", "forgetStoredSession", "Recovery",
  "OfflineCache", "IDENTITY_KEY", "IDENTITY_TTL_MS", "OfflineQueue", "console",
  "setCurrentUser", "setCheckingSession", "landOn", "restoredOffline"];
const build = deps =>
  new Function(...DEPS, region + "\nreturn bootSession;")(...DEPS.map(k => deps[k]));

// One boot's worth of world, with everything destructive recorded rather
// than done.
function world({ session, profile, hinted = false, claimThrows = false, identity = null,
                 marker = { owner: "A", epoch: 1 }, markerThrows = false }) {
  const did = { signedOut: false, forgot: false, cleared: false, clearedWith: undefined, identityRemoved: false, claimed: null, user: null, bootError: "", checking: true };
  const store = new Map();
  if (identity) store.set("session.identity", { at: Date.now(), value: identity });
  const deps = {
    did,
    setBootError: t => { did.bootError = t; },
    restoreSession,
    sbClient: { auth: { getSession: async () => session, signOut: async () => { did.signedOut = true; return { error: null }; } },
      from: () => ({ select: () => ({ eq: () => ({ single: async () => profile }) }) }) },
    forgetStoredSession: () => { did.forgot = true; },
    Recovery: { hinted: () => hinted },
    OfflineCache: {
      read: async k => store.get(k) || null,
      put: async (k, v) => { store.set(k, v); },
      remove: async k => { if (k === "session.identity") did.identityRemoved = true; store.delete(k); },
      readIdentity: async () => store.get("session.identity") || null,
      forgetIdentity: async () => { did.identityRemoved = true; store.delete("session.identity"); },
      // The offline restore's own claim: it never reaches writeIdentity, so
      // this is where a boot with no signal takes the lease its reads need.
      adopt: async id => { did.adopted = id; return true; },
      // Read before the server is asked, and handed back to clear() as the
      // authority for the retired-account wipe — the boot holds no lease of
      // its own at that point. See OfflineCache.clear.
      marker: async () => { if (markerThrows) throw new Error("IndexedDB is unavailable"); return marker; },
      clear: async opts => { did.cleared = true; did.clearedWith = opts; store.clear(); return true; },
      claimFor: async id => { if (claimThrows) throw new Error("IndexedDB is unavailable"); did.claimed = id; },
      noteServingCached: () => {}
    },
    IDENTITY_KEY: "session.identity",
    IDENTITY_TTL_MS: 12 * 60 * 60 * 1000,
    OfflineQueue: { isNetworkError: e => /network|fetch/i.test(e && e.message || "") },
    console: { warn() {}, error() {} },
    setCurrentUser: u => { did.user = u; },
    setCheckingSession: v => { did.checking = v; },
    landOn: () => {},
    restoredOffline: { current: false }
  };
  return { deps, did, boot: build(deps) };
}

const LIVE = { data: { session: { user: { id: "A" } } }, error: null };
const PROFILE_A = { data: { id: "A", name: "Kyle", role: "Admin", tab_access: ["board"] }, error: null };
const NO_PROFILE = { data: null, error: null };

test("the ordinary boot: the account is claimed and opened, nothing is destroyed", async () => {
  const { did, boot } = world({ session: LIVE, profile: PROFILE_A });
  await boot();
  assert.equal(did.claimed, "A");
  assert.ok(did.user);
  assert.equal(did.signedOut, false);
  assert.equal(did.cleared, false);
  assert.equal(did.checking, false);
});

test("a claim that fails ends the session — the ordinary case is unchanged", async () => {
  const { did, boot } = world({ session: LIVE, profile: PROFILE_A, claimThrows: true });
  await boot();
  // The previous person's data is still on this device, so the app must not
  // open over it.
  assert.equal(did.signedOut, true);
  assert.equal(did.identityRemoved, true);
  assert.equal(did.user, null);
  assert.match(did.bootError, /couldn't clear the previous person's data/);
});

test("a claim that fails during a recovery landing keeps the session", async () => {
  const { did, boot } = world({ session: LIVE, profile: PROFILE_A, claimThrows: true, hinted: true });
  await boot();
  // The session is the only thing a new password can be set with. Ending it
  // here left the person on a dead link having done nothing wrong.
  assert.equal(did.signedOut, false);
  assert.equal(did.forgot, false);
  assert.equal(did.identityRemoved, false);
  // And nothing is opened on the strength of the hint.
  assert.equal(did.user, null);
  assert.equal(did.checking, false);
});

test("the missing-profile sign-out is suppressed during a recovery landing, and the wipe with it", async () => {
  const { did, boot } = world({ session: LIVE, profile: NO_PROFILE, hinted: true });
  await boot();
  assert.equal(did.signedOut, false);
  assert.equal(did.cleared, false);
  assert.equal(did.identityRemoved, false);
});

test("the same missing profile with no recovery in play signs out and wipes", async () => {
  const { did, boot } = world({ session: LIVE, profile: NO_PROFILE });
  await boot();
  assert.equal(did.signedOut, true);
  assert.equal(did.cleared, true);
  assert.equal(did.identityRemoved, true);
  // Fenced on who this device belonged to before the server was asked. The
  // boot holds no lease — nothing has been claimed — so this is the whole of
  // the wipe's authority, and a device claimed by another tab meanwhile is
  // not emptied by it.
  assert.deepEqual(did.clearedWith, { expect: { owner: "A", epoch: 1 } });
});

test("a device nobody has claimed is still the boot's to empty", async () => {
  const { did, boot } = world({ session: LIVE, profile: NO_PROFILE, marker: null });
  await boot();
  assert.equal(did.cleared, true);
  assert.deepEqual(did.clearedWith, { expect: null }, "no marker is a state, not the absence of one");
});

test("an unreadable owner leaves the retired account's data alone", async () => {
  // Unreadable is not nobody: a moment's IndexedDB fault must not become the
  // authority for a wipe this tab holds no lease for.
  const { did, boot } = world({ session: LIVE, profile: NO_PROFILE, markerThrows: true });
  await boot();
  assert.equal(did.signedOut, true);
  assert.equal(did.identityRemoved, true);
  assert.equal(did.cleared, false);
});

test("a lapsed session forgets the identity and keeps the work", async () => {
  const { did, boot } = world({ session: { data: { session: null }, error: null }, profile: NO_PROFILE, identity: { id: "A" } });
  await boot();
  assert.equal(did.identityRemoved, true);
  assert.equal(did.cleared, false);
});
