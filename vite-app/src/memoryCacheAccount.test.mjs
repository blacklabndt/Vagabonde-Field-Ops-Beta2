import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// db.js's in-memory row caches, run — not paraphrased. These keys are
// account-blind ("contacts", "profiles", "clients"), they are not behind the
// IndexedDB fence, and the only thing that empties them is being told the
// account changed. Two things say so and both are lifted here: the lease
// announcement (the tab that did the signing in) and the auth announcement
// (every other tab on the origin, which supabase-js broadcasts to).
//
// db.js itself cannot be imported: config.js builds a live Supabase client at
// module scope. So the two regions are cut out of the source and evaluated
// with what they read from module scope handed in.
// Line endings are the checkout's, not the repo's (core.autocrlf is true on
// the build machine), and these cuts name a newline. Fold them first, or the
// regions are missed on Windows and found in CI, which is a test that says
// nothing about the code.
const source = readFileSync(new URL("./db.js", import.meta.url), "utf8")
  .split("\r\n")
  .join("\n");

function region(from, to) {
  const start = source.indexOf(from);
  assert.ok(start > 0, "db.js must still hold: " + from);
  const end = source.indexOf(to, start);
  assert.ok(end > start, "db.js must still hold: " + to);
  return source.slice(start, end + to.length);
}

const memory = region("const _cache = {};", "  return read;\n}");
const auth = region("let authGeneration = 0;", "});");
assert.match(memory, /OfflineCache\.onLeaseChange\(forgetRememberedRows\)/);
assert.match(auth, /forgetRememberedRows\(\)/);

// A cache that answers instantly is the point of the thing, so the TTL is
// left alone and the tests stay inside it.
function build() {
  let announce = () => {};
  const sbClient = { auth: { onAuthStateChange: fn => { announce = fn; return { data: { subscription: { unsubscribe() {} } } } } } };
  let leaseChanged = () => {};
  // The disk fence's own half is cacheAuthRetire.test.mjs's; here it only has
  // to exist, because the auth region calls it beside forgetRememberedRows and
  // a stub that does not answer would hide the memory half behind a TypeError.
  const retired = [];
  const OfflineCache = {
    onLeaseChange: fn => { leaseChanged = fn; return () => {}; },
    retireUnless: id => { retired.push(id); return false; }
  };
  const api = new Function("OfflineCache", "sbClient",
    memory + "\n" + auth + "\nreturn { cached, _cache, _inflight };"
  )(OfflineCache, sbClient);
  return {
    ...api,
    retired,
    signIn: id => announce("SIGNED_IN", id ? { user: { id } } : null),
    handover: () => leaseChanged(null)
  };
}

test("a settled row is not read back after the account changed in another tab", async () => {
  const app = build();
  app.signIn("A");
  let reads = 0;
  const fetcher = async () => { reads++; return ["A's contacts"]; };
  assert.deepEqual(await app.cached("contacts", fetcher), ["A's contacts"]);
  assert.deepEqual(await app.cached("contacts", fetcher), ["A's contacts"]);
  assert.equal(reads, 1, "inside the TTL the second caller is answered from memory");
  app.signIn("B");
  const fresh = await app.cached("contacts", async () => { reads++; return ["B's contacts"]; });
  assert.deepEqual(fresh, ["B's contacts"]);
  assert.equal(reads, 2, "the account changed, so the row was read again");
});

test("a walk only in flight when the account changed settles into nothing", async () => {
  const app = build();
  app.signIn("A");
  let release;
  const held = new Promise(r => { release = r; });
  const slow = app.cached("profiles", async () => { await held; return ["A's crew"]; });
  app.signIn("B");
  release();
  // The caller that asked still gets its answer — it is A's own screen, and
  // A read those rows legitimately.
  assert.deepEqual(await slow, ["A's crew"]);
  // But nothing of A's is left for B to be handed.
  let reads = 0;
  const after = await app.cached("profiles", async () => { reads++; return ["B's crew"]; });
  assert.deepEqual(after, ["B's crew"]);
  assert.equal(reads, 1);
});

test("a joiner does not inherit the last account's walk", async () => {
  const app = build();
  app.signIn("A");
  let release;
  const held = new Promise(r => { release = r; });
  const slow = app.cached("clients", async () => { await held; return ["A's clients"]; });
  app.signIn("B");
  const joined = app.cached("clients", async () => ["B's clients"]);
  release();
  assert.deepEqual(await slow, ["A's clients"]);
  assert.deepEqual(await joined, ["B's clients"]);
});

test("a token refresh keeps the rows; a lease change empties them", async () => {
  const app = build();
  app.signIn("A");
  let reads = 0;
  const fetcher = async () => { reads++; return ["rows"]; };
  await app.cached("contacts", fetcher);
  app.signIn("A");                       // TOKEN_REFRESHED shape
  await app.cached("contacts", fetcher);
  assert.equal(reads, 1, "the same account's hourly refresh is not a handover");
  app.handover();                        // the device was claimed by somebody else
  await app.cached("contacts", fetcher);
  assert.equal(reads, 2);
});
