import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { seesPrices } from "./data.js";

// The capability guard's own source, lifted out of db.js and run — never a
// re-typed copy of it. db.js imports config.js, which builds a live Supabase
// client at module scope, so the region between the auth-generation fence
// and priceRoleAnswer is evaluated here with the three things it reads from
// module scope handed in. A rewrite in db.js that dropped the fence would
// fail these tests; a paraphrase of it in this file would not.
const source = readFileSync(new URL("./db.js", import.meta.url), "utf8");
const start = source.indexOf("let authGeneration = 0;");
const end = source.indexOf("\n}", source.indexOf("async function priceRoleAnswer")) + 2;
assert.ok(start > 0 && end > start, "db.js must still hold the price-role region");
const region = source.slice(start, end);
assert.match(region, /now\.gen !== answer\.gen/, "the generation fence must be in the lifted region");

const build = ({ sbClient, plainError }) =>
  new Function("sbClient", "plainError", "seesPrices",
    region + "\nreturn { startPriceRoleLookup, priceRoleAnswer };"
  )(sbClient, plainError, seesPrices);

// A client whose signed-in account can be changed mid-flight, the way a
// shared tablet's is, and whose profiles read is held open until the test
// lets it answer.
function fakeClient(startId) {
  let current = startId;
  let announce = null;
  let release = null;
  const held = new Promise(r => { release = r; });
  return {
    become(id) { current = id; if (announce) announce("SIGNED_IN", id ? { user: { id } } : null); },
    release,
    auth: {
      getSession: async () => ({ data: current ? { session: { user: { id: current } } } : { session: null }, error: null }),
      onAuthStateChange: fn => { announce = fn; return { data: { subscription: { unsubscribe() {} } } }; }
    },
    from() {
      let wanted = null;
      return {
        select() { return this; },
        eq(_c, v) { wanted = v; return this; },
        async maybeSingle() {
          await held;
          // profiles_select is staff-or-own: any staff token reads any row,
          // which is exactly why the captured id proves nothing on its own.
          const roles = { A: "Technician", B: "Coordinator" };
          return { data: roles[wanted] ? { id: wanted, role: roles[wanted] } : null, error: null };
        }
      };
    }
  };
}

const plainError = (message, flags) => Object.assign(new Error(message), flags || {});

test("the same account throughout: the role answers", async () => {
  const sb = fakeClient("A");
  const { startPriceRoleLookup, priceRoleAnswer } = build({ sbClient: sb, plainError });
  const lookup = startPriceRoleLookup();
  sb.release();
  assert.equal(await priceRoleAnswer(lookup), true);
});

test("Technician A becomes Coordinator B mid-lookup: refused, not answered under B", async () => {
  const sb = fakeClient("A");
  const { startPriceRoleLookup, priceRoleAnswer } = build({ sbClient: sb, plainError });
  const lookup = startPriceRoleLookup();
  sb.become("B");
  sb.release();
  // Without the fence this returns true — A's Technician row, read under B's
  // token, matching A's captured id — and B's save goes on to delete lines
  // B cannot read.
  await assert.rejects(priceRoleAnswer(lookup), /signed in as somebody else/);
});

test("Coordinator B becomes Technician A mid-lookup: refused, not skipped", async () => {
  const sb = fakeClient("B");
  const { startPriceRoleLookup, priceRoleAnswer } = build({ sbClient: sb, plainError });
  const lookup = startPriceRoleLookup();
  sb.become("A");
  sb.release();
  // The other direction is the quiet one: answered false, A's save would
  // return { total: null } and report itself done with the billing untouched.
  await assert.rejects(priceRoleAnswer(lookup), /signed in as somebody else/);
});

test("signed out mid-lookup: refused", async () => {
  const sb = fakeClient("A");
  const { startPriceRoleLookup, priceRoleAnswer } = build({ sbClient: sb, plainError });
  const lookup = startPriceRoleLookup();
  sb.become(null);
  sb.release();
  await assert.rejects(priceRoleAnswer(lookup), /signed in as somebody else/);
});

test("a token refresh is not a change of hands", async () => {
  const sb = fakeClient("A");
  const { startPriceRoleLookup, priceRoleAnswer } = build({ sbClient: sb, plainError });
  const lookup = startPriceRoleLookup();
  sb.become("A");  // TOKEN_REFRESHED shape: same id, new token
  sb.release();
  assert.equal(await priceRoleAnswer(lookup), true);
});

test("a profile that could not be read is raised, never read as 'no prices'", async () => {
  const sb = fakeClient("Z");
  const { startPriceRoleLookup, priceRoleAnswer } = build({ sbClient: sb, plainError });
  const lookup = startPriceRoleLookup();
  sb.release();
  await assert.rejects(priceRoleAnswer(lookup), /couldn't be checked/);
});
