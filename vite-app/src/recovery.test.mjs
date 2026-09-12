// Tests for the password-reset catch — the one module whose whole job is to
// win a race, and which therefore cannot be checked by clicking.
//
// Run with: node --test src/recovery.test.mjs
//
// What it guards: supabase-js starts consuming the recovery hash at module
// evaluation and fires PASSWORD_RECOVERY exactly once, to whoever is already
// subscribed. Miss it and the person who followed a reset link lands on the
// sign-in screen with a session they cannot use. So most of what is asserted
// here is about *when*: the hash is read during import, the subscription
// exists before the event can fire, and a refused link's complaint is read
// out of the same hash in the same breath.
//
// recovery.js imports the Supabase client from config.js, which reads
// import.meta.env — so it cannot simply be imported here. It is loaded from
// source instead, with that one import swapped for a stub, which keeps the
// code under test the real code rather than a copy that can drift. The swap
// is asserted, so a change to the import line fails the test rather than
// quietly testing nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("./recovery.js", import.meta.url), "utf8");
const IMPORT_LINE = /^import\s*\{\s*sbClient\s*\}\s*from\s*["']\.\/config\.js["'];?$/m;

let nonce = 0;

// Loads a fresh copy of recovery.js with `window` set to the landing URL and
// a stub client in place of the real one. Returns the module plus `fire`,
// which plays an auth event the way supabase-js would.
async function loadRecovery(hash) {
  assert.match(SOURCE, IMPORT_LINE,
    "recovery.js no longer imports sbClient the way this test stubs it — update the stub");

  let handler = null;
  globalThis.__recoveryStub = { sbClient: { auth: { onAuthStateChange: fn => { handler = fn; } } } };
  // A history stub as well as a location: a hash that says "recovery" without
  // a token is taken out of the address bar on the way past, and that is a
  // behaviour worth asserting rather than one to leave unobserved.
  const rewrites = [];
  globalThis.window = {
    location: { hash, pathname: "/", search: "" },
    history: { replaceState: (_state, _title, url) => { rewrites.push(url); } }
  };

  const patched = SOURCE.replace(IMPORT_LINE, "const { sbClient } = globalThis.__recoveryStub;");
  // A distinct comment per load, because Node caches a data: module by its
  // exact text and each test wants its own module state.
  const mod = await import("data:text/javascript;base64," +
    Buffer.from(`${patched}\n// #${nonce++}\n`, "utf8").toString("base64"));

  return { mod, handler, rewrites, fire: event => handler(event, null) };
}

test("a recovery landing is noticed during import, before anything subscribes", async () => {
  // The hash is read at module evaluation, and it is read as a HINT: enough
  // to hold the boot off its destructive work, never enough to open the
  // set-password screen. Only the auth event does that.
  const { mod, handler } = await loadRecovery("#access_token=abc&refresh_token=xyz&type=recovery");
  assert.equal(mod.Recovery.hinted(), true, "the hash was read at module evaluation");
  assert.equal(mod.Recovery.pending(), false, "but a URL is not authority to change a password");
  assert.equal(typeof handler, "function", "and the auth subscription was already in place");
});

test("an ordinary landing is not a recovery", async () => {
  const { mod } = await loadRecovery("");
  assert.equal(mod.Recovery.pending(), false);
  assert.equal(mod.Recovery.hinted(), false, "and nothing to hold the boot off for");
  const { mod: withOtherHash } = await loadRecovery("#access_token=abc&refresh_token=xyz&type=signup");
  assert.equal(withOtherHash.Recovery.pending(), false, "only type=recovery counts");
  assert.equal(withOtherHash.Recovery.hinted(), false, "a whole session under another word is still not a reset");
});

test("the word without the token is not a recovery, and is stripped", async () => {
  // A bare `#type=recovery` used to open the real set-a-new-password screen
  // over whoever was signed in, with no token involved — and chat linkifies
  // URLs, so the address could arrive in a message. It is not a recovery
  // session, so it is not a recovery, and it does not stay in the address
  // bar to ask again on the next load.
  const { mod, rewrites } = await loadRecovery("#type=recovery");
  assert.equal(mod.Recovery.pending(), false);
  assert.equal(mod.Recovery.hinted(), false);
  assert.deepEqual(rewrites, ["/"], "the hash was taken out of the URL");

  // Auth sends the whole recovery session or none of it, so half a hash is
  // half a forgery — and neither half is left in the bar to ask again.
  const { mod: refresh, rewrites: refreshRewrites } = await loadRecovery("#refresh_token=abc&type=recovery");
  assert.equal(refresh.Recovery.hinted(), false, "the access token is half of what makes the session");
  assert.deepEqual(refreshRewrites, ["/"]);

  const { mod: access, rewrites: accessRewrites } = await loadRecovery("#access_token=abc&type=recovery");
  assert.equal(access.Recovery.hinted(), false, "and the refresh token is the other half");
  assert.equal(access.Recovery.pending(), false);
  assert.deepEqual(accessRewrites, ["/"]);
});

test("a real recovery landing is left in the address bar for supabase-js", async () => {
  const { rewrites } = await loadRecovery("#access_token=abc&refresh_token=xyz&type=recovery");
  assert.deepEqual(rewrites, [], "nothing else may eat the hash before the client reads it");
});

test("the event arriving after import wakes every subscriber", async () => {
  const { mod, fire } = await loadRecovery("");
  const seen = [];
  mod.Recovery.subscribe(v => seen.push(v));
  mod.Recovery.subscribe(v => seen.push(v));

  fire("SIGNED_IN");
  assert.deepEqual(seen, [], "an unrelated auth event is not a reset");

  fire("PASSWORD_RECOVERY");
  assert.deepEqual(seen, [true, true], "both subscribers heard it");
  assert.equal(mod.Recovery.pending(), true, "and a later subscriber can still read the state");
});

test("unsubscribing stops the callback", async () => {
  const { mod, fire } = await loadRecovery("");
  let calls = 0;
  const off = mod.Recovery.subscribe(() => { calls++; });
  off();
  fire("PASSWORD_RECOVERY");
  assert.equal(calls, 0);
  assert.equal(mod.Recovery.pending(), true, "the flag is still set — only the callback went away");
});

test("the hash opens nothing on its own — the event is what does", async () => {
  // The two sightings are not equal. The hash is whatever was sent to this
  // device; the event is supabase-js reporting a session it minted from it.
  // A hinted landing therefore still waits, and the event still wakes the
  // screen, because that is the only thing that may.
  const { mod, fire } = await loadRecovery("#access_token=abc&refresh_token=xyz&type=recovery");
  const seen = [];
  mod.Recovery.subscribe(v => seen.push(v));
  assert.deepEqual(seen, [], "the hash was read at import and told nobody");
  assert.equal(mod.Recovery.pending(), false);

  fire("PASSWORD_RECOVERY");
  assert.deepEqual(seen, [true], "the session Auth made is what opens it");
  assert.equal(mod.Recovery.pending(), true);
});

test("a forged recovery hash opens nothing at all", async () => {
  // Team chat linkifies URLs, so this address can arrive in a message: the
  // word plus two strings anybody can type. It used to be enough to open the
  // real "Set a new password" screen over a live session. It buys a forger
  // one thing now — the boot leaves this device's data alone — and that is
  // deliberate, because a wipe not done can harm nobody.
  const { mod } = await loadRecovery("#access_token=not-a-token&refresh_token=nor-this&type=recovery");
  assert.equal(mod.Recovery.hinted(), true, "the boot holds off its destructive work");
  assert.equal(mod.Recovery.pending(), false, "and the screen does not open");

  let calls = 0;
  mod.Recovery.subscribe(() => { calls++; });
  assert.equal(calls, 0, "nobody is told a reset is happening");
});

test("an event that lands before a subscriber is replayed to it", async () => {
  // The gap this closes is real and narrow: App.jsx reads pending() for its
  // initial state and subscribes in an effect, and PASSWORD_RECOVERY is a
  // one-shot supabase-js never replays. An event arriving between those two
  // moments was heard by nobody once the hash stopped standing in for it.
  const { mod, fire } = await loadRecovery("#access_token=abc&refresh_token=xyz&type=recovery");
  fire("PASSWORD_RECOVERY");

  const seen = [];
  mod.Recovery.subscribe(v => seen.push(v));
  assert.deepEqual(seen, [true], "told at once, synchronously, rather than never");

  const later = [];
  mod.Recovery.subscribe(v => later.push(v));
  assert.deepEqual(later, [true], "and so is the next one");
});

// ── the dead link ────────────────────────────────────────────────────────
// A link Auth refuses never becomes a session, so there is no event and no
// pending recovery — only a complaint in the hash. Read at import for the
// same reason as the rest of this module: nothing else is going to still be
// there by the time a component asks.

test("an ordinary start has nothing to say", async () => {
  const { mod } = await loadRecovery("");
  assert.equal(mod.Recovery.error(), null);
  const { mod: signedIn } = await loadRecovery("#access_token=abc&refresh_token=xyz&type=recovery");
  assert.equal(signedIn.Recovery.error(), null, "a working link is not an error");
});

test("an expired link says so, and says what to do", async () => {
  const { mod } = await loadRecovery(
    "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");
  const said = mod.Recovery.error();
  assert.match(said, /expired or has already been used/);
  assert.match(said, /Forgot password/);
  assert.equal(mod.Recovery.pending(), false, "a refused link is not a recovery session");
});

test("expiry is recognised from the description as well as the code", async () => {
  // Auth has changed which of the two it sends before now; either alone is
  // enough, because the advice is the same and a wrong guess sends someone
  // to support instead of to the Forgot password button.
  const { mod } = await loadRecovery("#error=access_denied&error_description=Email+link+has+expired");
  assert.match(mod.Recovery.error(), /expired or has already been used/);
});

test("any other complaint is passed on in Auth's own words, once", async () => {
  const { mod } = await loadRecovery("#error=server_error&error_description=Something+went+wrong.");
  assert.equal(mod.Recovery.error(), "Something went wrong. Tap Forgot password for a fresh one.",
    "the trailing full stop is not doubled");

  const { mod: bare } = await loadRecovery("#error=server_error");
  assert.equal(bare.Recovery.error(), "That password link didn't work. Tap Forgot password for a fresh one.");
});

test("clear() puts it back, and a later reset is caught again", async () => {
  const { mod, fire } = await loadRecovery("#access_token=abc&refresh_token=xyz&type=recovery");
  assert.equal(mod.Recovery.hinted(), true);
  fire("PASSWORD_RECOVERY");
  assert.equal(mod.Recovery.pending(), true);
  mod.Recovery.clear();
  assert.equal(mod.Recovery.pending(), false, "the set-password screen is done with it");
  assert.equal(mod.Recovery.hinted(), false, "and the hash it landed on is spent with it");

  const seen = [];
  mod.Recovery.subscribe(v => seen.push(v));
  fire("PASSWORD_RECOVERY");
  assert.equal(mod.Recovery.pending(), true, "a second reset in the same tab still lands");
  assert.deepEqual(seen, [true]);
});
