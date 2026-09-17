// The clock retry: what it asks again, and everything it does not.
//
// The wrapper is driven with a fetch of our own, so these are the wrapper's
// real behaviour and not a classifier's opinion of it. The clock is
// replaced for the duration — sometimes instant and recorded, sometimes
// held, so a caller can be made to give up in the middle of a wait.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { futureJwtRetrying, isFutureJwtRefusal, isProjectRest, waitOrAbort, FUTURE_JWT_DELAYS_MS } from "./jwtRetry.js";

const BASE = "https://eielmvxzdwwprmmfamlq.supabase.co";
const REST = `${BASE}/rest/v1/scheduled_sends?select=id`;
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

// A clock that does not tick. Timers are held until the test releases one,
// so the wrapper can be caught mid-wait; cleared ids are recorded, because
// a wait the caller cut short must not leave a timer behind it.
function withHeldClock(fn) {
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  const timers = new Map();
  const cleared = [];
  let next = 1;
  globalThis.setTimeout = (cb, ms) => { const id = next++; timers.set(id, { cb, ms }); return id; };
  globalThis.clearTimeout = id => { cleared.push(id); timers.delete(id); };
  const clock = {
    timers, cleared,
    pending: () => timers.size,
    fireAll: () => { const all = [...timers.values()]; timers.clear(); for (const t of all) t.cb(); }
  };
  return Promise.resolve(fn(clock))
    .finally(() => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; });
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

// Let every pending microtask run, without a timer — the held clock has none.
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test("a clock refusal is asked again, and the second answer stands", () => withFastClock(async waits => {
  const { fetchImpl, calls } = scripted([refusal, ok]);
  const res = await futureJwtRetrying(fetchImpl, BASE)(REST, { method: "GET" });
  assert.equal(calls.length, 2);
  assert.equal(res.status, 200);
  // The caller reads its own body: the wrapper read a clone, never this.
  assert.equal(await res.text(), '[{"id":"S-1"}]');
  assert.deepEqual(waits, [FUTURE_JWT_DELAYS_MS[0]]);
}));

test("three attempts is the end of it, and the refusal comes back readable", () => withFastClock(async waits => {
  const { fetchImpl, calls } = scripted([refusal]);
  const res = await futureJwtRetrying(fetchImpl, BASE)(REST, { method: "GET" });
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
  await futureJwtRetrying(fetchImpl, BASE)(REST, init);
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
    const res = await futureJwtRetrying(fetchImpl, BASE)(REST, {});
    assert.equal(calls.length, 1, `${what} must not be retried`);
    assert.ok(res.status === 401 || res.status === 403 || res.status === 502);
  }
}));

test("this project's REST path, and nothing that merely looks like it", () => withFastClock(async () => {
  const elsewhere = [
    ["auth", `${BASE}/auth/v1/token?grant_type=refresh_token`],
    ["storage", `${BASE}/storage/v1/object/reports/x.pdf`],
    ["a function", `${BASE}/functions/v1/send-report`],
    // The characters are there; the PATH is not. A whole-string match asked
    // each of these again three times.
    ["a function carrying the path in a query", `${BASE}/functions/v1/ask?next=/rest/v1/items`],
    ["a function carrying it in a fragment", `${BASE}/functions/v1/ask#/rest/v1/items`],
    ["another project", "https://someoneelse.supabase.co/rest/v1/tickets?select=*"],
    ["another host entirely", "https://api.resend.com/rest/v1/emails"],
    ["http where we speak https", "http://eielmvxzdwwprmmfamlq.supabase.co/rest/v1/tickets"],
    ["a relative address", "/rest/v1/tickets?select=id"],
  ];
  for (const [what, url] of elsewhere) {
    const { fetchImpl, calls } = scripted([refusal]);
    const res = await futureJwtRetrying(fetchImpl, BASE)(url, {});
    assert.equal(calls.length, 1, `${what} must not be retried`);
    assert.equal(res.status, 401);
  }
  // A Request object is spent by the first attempt and is never resent.
  const { fetchImpl, calls } = scripted([refusal]);
  await futureJwtRetrying(fetchImpl, BASE)(new Request(REST, { method: "POST", body: "{}" }), {});
  assert.equal(calls.length, 1);

  // And a base that is not an address retries nothing at all.
  const noBase = scripted([refusal]);
  await futureJwtRetrying(noBase.fetchImpl, "")(REST, {});
  assert.equal(noBase.calls.length, 1);
}));

test("the address is parsed, not searched", () => {
  assert.equal(isProjectRest(REST, BASE), true);
  assert.equal(isProjectRest(`${BASE}/rest/v1/`, BASE), true);
  assert.equal(isProjectRest(`${BASE}/rest/v1/rpc/internal_secret`, `${BASE}/`), true);
  assert.equal(isProjectRest(`${BASE}/functions/v1/ask?next=/rest/v1/items`, BASE), false);
  assert.equal(isProjectRest("https://evil.example/x?u=https://eielmvxzdwwprmmfamlq.supabase.co/rest/v1/t", BASE), false);
  assert.equal(isProjectRest(`${BASE}/restx/v1/tickets`, BASE), false);
  assert.equal(isProjectRest(REST, "not a url"), false);
  assert.equal(isProjectRest(undefined, BASE), false);
});

test("a caller that gives up before the wait is not made to wait", () => withFastClock(async () => {
  const controller = new AbortController();
  const { fetchImpl, calls } = scripted([refusal]);
  // Aborted while the first refusal is being classified.
  const promise = futureJwtRetrying(fetchImpl, BASE)(REST, { signal: controller.signal });
  controller.abort();
  const res = await promise;
  assert.equal(calls.length, 1);
  assert.equal(res.status, 401);

  // And a signal already spent never reaches a second attempt either.
  const spent = new AbortController();
  spent.abort();
  const second = scripted([refusal]);
  await futureJwtRetrying(second.fetchImpl, BASE)(REST, { signal: spent.signal });
  assert.equal(second.calls.length, 1);
}));

test("a caller that gives up DURING the wait ends there, timer and all", () => withHeldClock(async clock => {
  const controller = new AbortController();
  const { fetchImpl, calls } = scripted([refusal, ok]);
  const promise = futureJwtRetrying(fetchImpl, BASE)(REST, { signal: controller.signal });
  // Far enough in to be sitting in the backoff, and no further: the clock
  // is held, so the wait cannot end on its own.
  await settle();
  assert.equal(calls.length, 1, "the wrapper must be waiting, not retrying");
  assert.equal(clock.pending(), 1, "a backoff timer is running");

  controller.abort();
  const res = await promise;
  assert.equal(res.status, 401, "the refusal it already had is what comes back");
  assert.equal(calls.length, 1, "no second attempt after the caller let go");
  assert.equal(clock.pending(), 0, "the backoff timer was cleared");
  assert.equal(clock.cleared.length, 1);

  // Releasing what is left changes nothing — there is nothing left.
  clock.fireAll();
  await settle();
  assert.equal(calls.length, 1);
}));

test("a wait that ends on the clock lets go of the caller's signal", () => withHeldClock(async clock => {
  // A signal of our own, because a real AbortSignal will not say how many
  // listeners it is carrying — and carrying one per request is the leak.
  const added = [], removed = [];
  const signal = {
    aborted: false,
    addEventListener: (t, fn) => added.push([t, fn]),
    removeEventListener: (t, fn) => removed.push([t, fn])
  };
  const waiting = waitOrAbort(250, signal);
  assert.equal(added.length, 1);
  assert.equal(clock.pending(), 1);
  clock.fireAll();
  assert.equal(await waiting, false, "the clock ended it, not the caller");
  assert.equal(removed.length, 1, "the listener went with it");
  assert.equal(removed[0][1], added[0][1], "and it was that same listener");

  // The other exit: the caller aborts. The timer goes.
  const added2 = [];
  const signal2 = {
    aborted: false,
    addEventListener: (_t, fn) => added2.push(fn),
    removeEventListener: () => {}
  };
  const cut = waitOrAbort(250, signal2);
  const before = clock.pending();
  added2[0]();
  assert.equal(await cut, true);
  assert.equal(clock.pending(), before - 1, "the timer was cleared");
}));

// The shape the tick uses: the database goes through the wrapper, the send
// does not. These drive that composition and count the sends — the tick's
// own wiring (one wrapped client; mail and push on their own transport) is
// asserted against the source further down.
async function claimThenSend(dbAnswers) {
  const mail = [], push = [];
  const { fetchImpl, calls } = scripted(dbAnswers);
  const db = futureJwtRetrying(fetchImpl, BASE);
  // Mail's own transport, wrapped with the same retry on purpose and handed
  // the same refusal: a different host is never asked twice, so a send can
  // never be made twice by this.
  const mailFetch = futureJwtRetrying(() => { mail.push(1); return Promise.resolve(refusal()); }, BASE);

  const res = await db(`${BASE}/rest/v1/scheduled_sends?id=eq.S-1`, { method: "PATCH", body: '{"status":"sending"}' });
  if (res.status !== 200) throw new Error(`the claim: ${JSON.parse(await res.text()).message}`);
  const claimed = JSON.parse(await res.text());
  if (!claimed.length) return { mail: mail.length, push: push.length, dbCalls: calls.length };
  await mailFetch("https://api.resend.com/emails", { method: "POST", body: "{}" });
  push.push(1);
  return { mail: mail.length, push: push.length, dbCalls: calls.length };
}

test("a claim that recovered sends exactly once", () => withFastClock(async () => {
  const r = await claimThenSend([refusal, ok]);
  assert.equal(r.dbCalls, 2, "the claim was asked twice");
  assert.equal(r.mail, 1, "and the email went once");
  assert.equal(r.push, 1);
}));

test("a claim that ran out of attempts sends nothing", () => withFastClock(async () => {
  await assert.rejects(claimThenSend([refusal]), /the claim: JWT issued at future/);
}));

test("a claim nobody won sends nothing", () => withFastClock(async () => {
  const r = await claimThenSend([() => new Response("[]", { status: 200 })]);
  assert.equal(r.mail, 0);
  assert.equal(r.push, 0);
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

test("the browser's one client is wrapped, to its own project, ceiling inside", () => {
  const src = readFileSync(new URL("./config.js", import.meta.url), "utf8");
  assert.ok(src.includes('import { futureJwtRetrying } from "./jwtRetry.js"'));
  assert.ok(src.includes("const sbFetch = futureJwtRetrying(fetchWithCeiling, SUPABASE_URL);"),
    "each attempt re-enters the ceiling so its timeout starts again, and only this project is asked again");
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
  assert.ok(/global: \{ fetch: futureJwtRetrying\([\s\S]{0,80}Deno\.env\.get\("SUPABASE_URL"\)!\) \}/.test(src),
    "the retry is scoped to this project's own REST endpoint");
  assert.equal((src.match(/= adminClient\(\);/g) ?? []).length, 2, "the tick and the error log both use it");
  // The retry sits on the database client alone: mail and push have their
  // own transport, so no send can be made twice by it.
  assert.ok(!/futureJwtRetrying[\s\S]{0,200}(sendPush|mailJha|mailReport|mailApproval)/.test(src));
  // Every request the tick makes says which one it was.
  for (const stage of ["the authorization check", "the stale sweep", "the due read", "the claim",
    "the scheduler read", "the assessment read", "the report read",
    "the ticket read", "the device read"]) {
    assert.ok(src.includes(`dbFail("${stage}"`), `${stage} must name itself`);
  }
  assert.ok(!/throw new Error\(error\.message\)/.test(src), "a bare PostgREST message says nothing about where");
  assert.ok(/code && !message\.includes/.test(src), "the code PostgREST gave it is recorded, once");
  assert.ok(src.includes("const message = dbWhy(e as"), "the outer catch keeps the code too");
  assert.ok(src.includes("dbWhy(error)") && src.includes("dbWhy(e as Error)"),
    "a final status that could not be written says why, with its code");
  // The settings read is the last one before an email leaves.
  assert.ok(src.includes("await appSettings(admin)"), "the settings read rides the wrapped client");
});

test("a settings read goes through the caller's client when there is one", () => {
  const mail = readFileSync(new URL("../../supabase/functions/_shared/mail.ts", import.meta.url), "utf8");
  assert.ok(mail.includes("export async function appSettings(client?: SupabaseClient)"));
  assert.ok(mail.includes("const admin = client ?? createClient("), "and opens its own door only when there is none");
  assert.ok(mail.includes("const settings = opts.settings ?? await appSettings(opts.client);"));
  for (const f of ["mailJha.ts", "mailReport.ts"]) {
    const src = readFileSync(new URL(`../../supabase/functions/_shared/${f}`, import.meta.url), "utf8");
    assert.ok(/sendMail\(\{[\s\S]{0,300}client: admin,/.test(src), `${f} must hand its own client to sendMail`);
  }
});
