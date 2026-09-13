// Tests for the sign-in restore path.
//
// Run with: node --test src/session.test.mjs
//
// This is the one piece of the app whose failure modes only appear when the
// network is gone, which is exactly when they are hardest to reproduce by
// hand — the bug these cover ("stuck on Loading…", and being signed out for
// going out of range) was found by cutting a laptop's wifi, not by clicking.

import test from "node:test";
import assert from "node:assert/strict";
import { restoreSession, identityFrom } from "./session.js";

const PROFILE = { id: "u1", name: "K. Keith", role: "Technician", cert: "Lvl II", tab_access: ["board", "job", "ticket"] };
const SESSION = { data: { session: { user: { id: "u1", email: "k@example.ca" } } } };
const CACHED = { id: "u1", name: "K. Keith", email: "k@example.ca", role: "Technician", cert: "Lvl II", tabs: ["board", "job", "ticket", "contacts"] };

const never = () => new Promise(() => {});
const isNetworkError = e => /failed to fetch|networkerror/i.test((e && e.message) || "");

const base = over => ({
  getSession: async () => SESSION,
  fetchProfile: async () => ({ data: PROFILE, error: null }),
  signOut: async () => { throw new Error("signOut should not have been called"); },
  readIdentity: async () => null,
  writeIdentity: async () => {},
  isNetworkError,
  timeoutMs: 50,
  ...over
});

test("signs in normally when everything answers", async () => {
  let written = null;
  const r = await restoreSession(base({ writeIdentity: async i => { written = i; } }));
  assert.equal(r.user.name, "K. Keith");
  assert.ok(r.user.tabs.includes("contacts"), "universal tab is added");
  assert.equal(written.id, "u1", "identity is remembered for the next offline start");
  assert.ok(!r.offline);
});

test("a getSession() that never settles does not hang the app", async () => {
  const r = await restoreSession(base({ getSession: never, readIdentity: async () => CACHED }));
  assert.equal(r.user.name, "K. Keith", "falls back to the identity saved on this device");
  assert.equal(r.offline, true);
  assert.equal(r.reason, "session-timeout");
});

test("a profile read that never settles does not hang the app", async () => {
  const r = await restoreSession(base({ fetchProfile: never, readIdentity: async () => CACHED }));
  assert.equal(r.user.name, "K. Keith");
  assert.equal(r.reason, "profile-timeout");
});

test("a network failure never signs the user out", async () => {
  // supabase-js reports a failed request as an error object, not a throw.
  const r = await restoreSession(base({
    fetchProfile: async () => ({ data: null, error: new TypeError("Failed to fetch") }),
    readIdentity: async () => CACHED
    // signOut in `base` throws if called, which is the assertion
  }));
  assert.equal(r.user.name, "K. Keith");
  assert.equal(r.reason, "profile-unreadable");
  assert.ok(!r.signedOut);
});

test("a server error is a failed read too, and never signs the user out", async () => {
  // The one that cost a tablet its morning: Supabase answers 502 through
  // Cloudflare on a device with perfect signal, so isNetworkError says no,
  // the old guard let it through as "this account has no profile", and
  // App.jsx answered signedOut by clearing the cache — every WIP ticket and
  // assessment with it. Any error is an unread profile, full stop.
  for (const error of [
    { code: "500", message: "Internal Server Error" },
    { code: "PGRST301", message: "JWT expired" },
    { message: "<html><title>502 Bad Gateway</title></html>" }
  ]) {
    const r = await restoreSession(base({
      fetchProfile: async () => ({ data: null, error }),
      readIdentity: async () => CACHED
      // signOut in `base` throws if called, which is the assertion
    }));
    assert.equal(r.user.name, "K. Keith", error.message);
    assert.equal(r.reason, "profile-unreadable");
    assert.ok(!r.signedOut);
  }
});

test("a remembered identity is not restored for a different account", async () => {
  // The session says u2; the device remembers u1. That is the last person's
  // identity, and handing it over would put their name and tabs on somebody
  // else's session. Sign-in, not a handover — and still no sign-out, because
  // nothing was read about u2 either way.
  const r = await restoreSession(base({
    getSession: async () => ({ data: { session: { user: { id: "u2", email: "b@example.ca" } } } }),
    fetchProfile: async () => ({ data: null, error: { code: "500", message: "Internal Server Error" } }),
    readIdentity: async () => CACHED
  }));
  assert.equal(r.user, null);
  assert.equal(r.offline, true);
  assert.ok(!r.signedOut);
});

test("offline with nothing remembered lands on sign-in, not a spinner", async () => {
  const r = await restoreSession(base({ getSession: never, readIdentity: async () => null }));
  assert.equal(r.user, null);
  assert.equal(r.offline, true);
});

test("an account the server says has no access is still signed out", async () => {
  let signedOut = false;
  const r = await restoreSession(base({
    fetchProfile: async () => ({ data: { ...PROFILE, tab_access: [] }, error: null }),
    signOut: async () => { signedOut = true; }
  }));
  assert.equal(r.user, null);
  assert.equal(signedOut, true, "a real answer of 'no access' still ends the session");
  assert.equal(r.signedOut, true);
});

test("no session at all, while online, shows sign-in", async () => {
  const r = await restoreSession(base({
    getSession: async () => ({ data: { session: null } }),
    isOffline: () => false
  }));
  assert.equal(r.user, null);
  assert.ok(!r.offline);
});

// The one that actually bit: any session older than an hour needs refreshing,
// and offline that refresh fails. supabase-js reports the result as an
// ordinary "no session" — so this looked identical to signing out, and the
// app answered it with a login form that cannot reach the server.
test("an expired token that could not refresh offline restores from cache", async () => {
  const r = await restoreSession(base({
    getSession: async () => ({ data: { session: null }, error: new TypeError("Failed to fetch") }),
    readIdentity: async () => CACHED,
    isOffline: () => false   // proved by the error alone, not just the flag
  }));
  assert.equal(r.user.name, "K. Keith");
  assert.equal(r.reason, "no-session-offline");
});

test("no session while the browser knows it is offline restores from cache", async () => {
  const r = await restoreSession(base({
    getSession: async () => ({ data: { session: null } }),
    readIdentity: async () => CACHED,
    isOffline: () => true
  }));
  assert.equal(r.user.name, "K. Keith");
  assert.equal(r.reason, "no-session-offline");
});

// The mirror of the above: signing out clears this device's cache, so there
// is nothing to restore and the sign-in screen is correct even offline.
test("a deliberate sign-out still lands on sign-in, even with no network", async () => {
  const r = await restoreSession(base({
    getSession: async () => ({ data: { session: null } }),
    readIdentity: async () => null,
    isOffline: () => true
  }));
  assert.equal(r.user, null);
});

// The boot treats "offline and nobody remembered" as an unclaimed device.
// A rejected IndexedDB read used to arrive as exactly that, so a transient
// storage fault looked like a tablet nobody owns.
test("an unreadable identity is reported as unreadable, not as nobody", async () => {
  const r = await restoreSession(base({
    getSession: never,
    readIdentity: async () => { throw new Error("IDB transaction aborted"); }
  }));
  assert.equal(r.user, null);
  assert.equal(r.offline, true);
  assert.equal(r.identityUnreadable, true);
});

test("an identity that is simply absent is not called unreadable", async () => {
  const r = await restoreSession(base({ getSession: never, readIdentity: async () => null }));
  assert.equal(r.user, null);
  assert.equal(r.identityUnreadable, false);
});

test("identityFrom refuses an account with no tabs", () => {
  assert.equal(identityFrom({ id: "u", tab_access: [] }, "a@b.c"), null);
  assert.equal(identityFrom(null, "a@b.c"), null);
});
