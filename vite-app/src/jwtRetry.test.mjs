// The clock retry: what it asks again, and everything it does not.
//
// The wrapper is driven with a fetch of our own, so these are the wrapper's
// real behaviour and not a classifier's opinion of it. setTimeout is
// replaced for the duration so the waits are instant AND recorded — the
// delays are part of what is being tested.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { futureJwtRetrying, isFutureJwtRefusal, FUTURE_JWT_DELAYS_MS } from "./jwtRetry.js";

const REST = "https://eielmvxzdwwprmmfamlq.supabase.co/rest/v1/scheduled_sends?select=id";
const FUTURE = JSON.stringify({ code: "PGRST303", details: null, hint: null, message: "JWT issued at future" });
const refusal = () => new Response(FUTURE, { status: 401, headers: { "Content-Type": "application/json" } });
const ok = () => new Response('[{"id":"S-1"}]', { status: 200 });

// Instant waits, in a list. Anything the wrapper schedules is answered at
// once; the delays it asked for are what the tests read back.
function withFastClock(fn) {
  const real = globalThis.setTimeout;
  const waits = [];
  globalThis.setTimeout = (cb, ms) => { waits.push(ms); return real(cb, 0); };
  return Promise.resolve(fn(waits)).finally(() => { globalThis.setTimeout = real; });
}

// A fetch that answers from a script and records every call it was given.
function scripted(answers) {
  const calls = [];
  const fetchImpl = (input, init) => {
    calls.push({ input, init });
    const next = answers[Math.min(calls.length - 1, answers.length - 1)];
    return Promise.resolve(next());
  };
  return { fetchImpl, calls };
}

test("a clock refusal is asked again, and the second answer stands", () => withFastClock(async waits => {
  const { fetchImpl, calls } = scripted([refusal, ok]);
  const res = await futureJwtRetrying(fetchImpl)(REST, { method: "GET" });
  assert.equal(calls.length, 2);
  assert.equal(res.status, 200);
  // The caller reads its own body: the wrapper read a clone, never this.
  assert.equal(await res.text(), '[{"id":"S-1"}]');
  assert.deepEqual(waits, [FUTURE_JWT_DELAYS_MS[0]]);
}));

test("three attempts is the end of it, and the refusal comes back readable", () => withFastClock(async waits => {
  const { fetchImpl, calls } = scripted([refusal]);
  const res = await futureJwtRetrying(fetchImpl)(REST, { method: "GET" });
  assert.equal(calls.length, 1 + FUTURE_JWT_DELAYS_MS.length);
  assert.equal(calls.length, 3);
  assert.equal(res.status, 401);
  assert.deepEqual(waits, FUTURE_JWT_DELAYS_MS);
  // Two clones were read along the way; the body the caller gets is whole.
  assert.equal(JSON.parse(await res.text()).code, "PGRST303");
}));

test("every attempt is sent the caller's own request, unchanged", () => withFastClock(async () => {
  const { fetchImpl, calls } = scripted([refusal, refusal, ok]);
  const init = { method: "POST", body: '{"status":"sending"}', headers: { apikey: "k" } };
  await futureJwtRetrying(fetchImpl)(REST, init);
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.input, REST);
    assert.equal(c.init, init);
    assert.equal(c.init.body, '{"status":"sending"}');
  }
}));

test("nothing else is asked again", () => withFastClock(async () => {
  const others = [
    ["an expired token", () => new Response(JSON.stringify({ code: "PGRST303", message: "JWT expired" }), { status: 401 })],
    ["another claims failure", () => new Response(JSON.stringify({ code: "PGRST301", message: "JWT expired" }), { status: 401 })],
    ["a policy refusal", () => new Response(JSON.stringify({ code: "42501", message: "permission denied" }), { status: 403 })],
    ["the same words at 403", () => new Response(JSON.stringify({ code: "PGRST303", message: "JWT issued at future" }), { status: 403 })],
    ["a gateway page", () => new Response("<html>502</html>", { status: 502 })],
    ["an empty 401", () => new Response("", { status: 401 })],
  ];
  for (const [what, answer] of others) {
    const { fetchImpl, calls } = scripted([answer]);
    const res = await futureJwtRetrying(fetchImpl)(REST, {});
    assert.equal(calls.length, 1, `${what} must not be retried`);
    assert.ok(res.status === 401 || res.status === 403 || res.status === 502);
  }
}));

test("only the database's endpoint — auth, storage and functions are left alone", () => withFastClock(async () => {
  const elsewhere = [
    "https://eielmvxzdwwprmmfamlq.supabase.co/auth/v1/token?grant_type=refresh_token",
    "https://eielmvxzdwwprmmfamlq.supabase.co/storage/v1/object/reports/x.pdf",
    "https://eielmvxzdwwprmmfamlq.supabase.co/functions/v1/send-report",
  ];
  for (const url of elsewhere) {
    const { fetchImpl, calls } = scripted([refusal]);
    const res = await futureJwtRetrying(fetchImpl)(url, {});
    assert.equal(calls.length, 1, `${url} must not be retried`);
    assert.equal(res.status, 401);
  }
  // A Request object is spent by the first attempt and is never resent.
  const { fetchImpl, calls } = scripted([refusal]);
  await futureJwtRetrying(fetchImpl)(new Request(REST, { method: "POST", body: "{}" }), {});
  assert.equal(calls.length, 1);
}));

test("a caller that gives up during the wait is not made to wait", () => withFastClock(async () => {
  const controller = new AbortController();
  const { fetchImpl, calls } = scripted([refusal]);
  // Aborted while the first refusal is being classified.
  const promise = futureJwtRetrying(fetchImpl)(REST, { signal: controller.signal });
  controller.abort();
  const res = await promise;
  assert.equal(calls.length, 1);
  assert.equal(res.status, 401);

  // And a signal already spent never reaches a second attempt either.
  const spent = new AbortController();
  spent.abort();
  const second = scripted([refusal]);
  await futureJwtRetrying(second.fetchImpl)(REST, { signal: spent.signal });
  assert.equal(second.calls.length, 1);
}));

test("the words the answer must carry", () => {
  assert.equal(isFutureJwtRefusal(401, FUTURE), true);
  assert.equal(isFutureJwtRefusal(401, JSON.stringify({ code: "PGRST303", message: "jwt ISSUED AT FUTURE" })), true);
  assert.equal(isFutureJwtRefusal(401, JSON.stringify({ code: "PGRST303", message: "JWT expired" })), false);
  assert.equal(isFutureJwtRefusal(401, JSON.stringify({ code: "PGRST302", message: "JWT issued at future" })), false);
  assert.equal(isFutureJwtRefusal(200, FUTURE), false);
  assert.equal(isFutureJwtRefusal(401, "not json"), false);
  assert.equal(isFutureJwtRefusal(401, ""), false);
  assert.equal(isFutureJwtRefusal(401, null), false);
  assert.equal(isFutureJwtRefusal(401, JSON.stringify("JWT issued at future")), false);
});

const CORE = /\/\/ ═══ shared core[^\n]*\n([\s\S]*?)\/\/ ═══ end shared core ═══/;
const coreOf = file => {
  const src = readFileSync(new URL(file, import.meta.url), "utf8");
  const m = CORE.exec(src);
  assert.ok(m, `${file} has no shared core markers`);
  return m[1];
};
const shapeOf = code => code.split("\n")
  .map(l => l.replace(/\s+/g, " ").replace(/ (?=[),;])/g, "").trim())
  .filter(Boolean).join("\n");

test("the clock retry is the same code in the browser and in the function", () => {
  const js = coreOf("./jwtRetry.js");
  const ts = coreOf("../../supabase/functions/_shared/jwtRetry.ts");
  assert.ok(js.includes("export function futureJwtRetrying"), "the core must hold the wrapper itself");
  assert.ok(/status: number, bodyText: string \| null \| undefined/.test(ts), "the function's copy is the typed one");
  assert.equal(shapeOf(stripTypeScriptTypes(ts)), shapeOf(js));
});

test("the browser's one client is wrapped, and the ceiling is inside the retry", () => {
  const src = readFileSync(new URL("./config.js", import.meta.url), "utf8");
  assert.ok(src.includes('import { futureJwtRetrying } from "./jwtRetry.js"'));
  assert.ok(src.includes("const sbFetch = futureJwtRetrying(fetchWithCeiling);"),
    "each attempt must re-enter the ceiling so its timeout starts again");
  assert.ok(src.includes("global: { fetch: sbFetch }"));
  assert.ok(!/global: \{ fetch: fetchWithCeiling \}/.test(src), "the unwrapped fetch must not still be wired up");
});

test("the tick's every database request is wrapped, and its sends are not", () => {
  const src = readFileSync(new URL("../../supabase/functions/scheduled-sends/index.ts", import.meta.url), "utf8");
  assert.ok(src.includes("futureJwtRetrying"), "the tick must use the retry");
  // One place builds the client, and it is the wrapped one. A bare
  // createClient anywhere else in this file is an unwrapped door.
  const builds = src.match(/createClient\(/g) ?? [];
  assert.equal(builds.length, 1, "only adminClient() may build the client");
  assert.ok(/const adminClient = \(\) => createClient\(/.test(src));
  assert.ok(/global: \{ fetch: futureJwtRetrying\(/.test(src));
  assert.equal((src.match(/= adminClient\(\);/g) ?? []).length, 2, "the tick and the error log both use it");
  // The retry sits on the database client alone: mail and push have their
  // own transport, so no send can be made twice by it.
  assert.ok(!/futureJwtRetrying[\s\S]{0,200}(sendPush|mailJha|mailReport|mailApproval)/.test(src));
  // A failure says which request met it.
  assert.ok(src.includes('throw dbFail("the stale sweep"'));
  assert.ok(src.includes('throw dbFail("the due read"'));
  assert.ok(src.includes('throw dbFail("the claim"'));
  assert.ok(src.includes('throw dbFail("the scheduler read"'));
  assert.ok(/error.code \? ` \[\$\{error.code\}\]`/.test(src), "the code PostgREST gave it is recorded");
});
