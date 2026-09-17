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
import { fetchWithCeiling } from "./fetchCeiling.js";
import { markStatus, runRow, dbWhy, sentUnrecorded } from "../../supabase/functions/_shared/scheduledSends.ts";
import { refuse, loggedWords, publicWords } from "../../supabase/functions/_shared/publicError.ts";

const BASE = "https://eielmvxzdwwprmmfamlq.supabase.co";
const REST = `${BASE}/rest/v1/scheduled_sends?select=id`;
const FUTURE = JSON.stringify({ code: "PGRST303", details: null, hint: null, message: "JWT issued at future" });
const refusal = () => new Response(FUTURE, { status: 401, headers: { "Content-Type": "application/json" } });
const ok = () => new Response('[{"id":"S-1"}]', { status: 200 });

// Instant waits, in a list. Anything the wrapper schedules is answered at
// once; the delays it asked for are what the tests read back.
function withFastClock(fn) {
  const real = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  const waits = [];
  // Every timer that was set, with what it was set for, and every id that
  // was cleared: counting a ceiling being STARTED says nothing about whether
  // it was put out, and a timer left running is the leak.
  const set = [], cleared = new Set();
  globalThis.setTimeout = (cb, ms) => { const id = real(cb, 0); waits.push(ms); set.push({ ms, id }); return id; };
  globalThis.clearTimeout = id => { cleared.add(id); return realClear(id); };
  const clock = { set, cleared, clearedFor: ms => set.filter(t => t.ms === ms && cleared.has(t.id)).length };
  return Promise.resolve(fn(waits, clock))
    .finally(() => { globalThis.setTimeout = real; globalThis.clearTimeout = realClear; });
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

// ── The browser's real pair: the ceiling inside the retry ────────────────
// Not a source assertion — `fetchWithCeiling` itself, wrapped by the real
// `futureJwtRetrying`, over a fetch we script. What is being proved is the
// composition: three attempts, each with its OWN ceiling and its own
// listener on the caller's signal, and nothing of either left behind.
function withNetwork(answers, fn) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (input, init) => {
    calls.push({ input, init });
    const next = answers[Math.min(calls.length - 1, answers.length - 1)];
    return Promise.resolve(next(init));
  };
  return Promise.resolve(fn(calls)).finally(() => { globalThis.fetch = realFetch; });
}

// A signal that says how many listeners it is carrying — a real one will not.
function countingSignal() {
  const live = new Set();
  return {
    live,
    signal: {
      aborted: false,
      addEventListener: (_t, fn) => live.add(fn),
      removeEventListener: (_t, fn) => live.delete(fn)
    }
  };
}

test("the browser's ceiling and the retry compose: three attempts, three ceilings", () => withFastClock(async (waits, clock) => {
  const { signal, live } = countingSignal();
  const wrapped = futureJwtRetrying(fetchWithCeiling, BASE);
  await withNetwork([refusal], async calls => {
    const res = await wrapped(REST, { method: "GET", signal });
    assert.equal(calls.length, 3, "the ceiling passed each refusal through and the retry asked again");
    assert.equal(res.status, 401, "the refusal that stood is what the caller gets");
    assert.equal(JSON.parse(await res.text()).code, "PGRST303", "and it is still readable");
    // Each attempt got a signal of the ceiling's own making, not the
    // caller's — and a fresh 30-second timer, so a retry never inherits
    // what is left of the last attempt's.
    for (const c of calls) {
      assert.ok(c.init.signal && c.init.signal !== signal, "the ceiling's own signal goes out");
    }
    const ceilings = waits.filter(ms => ms === 30000);
    assert.equal(ceilings.length, 3, "one fresh 30s ceiling per attempt");
    assert.deepEqual(waits.filter(ms => ms !== 30000), FUTURE_JWT_DELAYS_MS, "and the two backoffs between them");
    // Started is not the same as put out: each attempt's ceiling was
    // CLEARED when its request settled, so nothing is left running to abort
    // a later attempt — or the caller's next request — thirty seconds on.
    assert.equal(clock.clearedFor(30000), 3, "every ceiling was cleared when its attempt settled");
    // Three requests over one caller signal, and nothing still holding it.
    assert.equal(live.size, 0, "every attempt let go of the caller's signal");
  });
}));

test("the ceiling still answers for itself inside the retry", () => withFastClock(async () => {
  const wrapped = futureJwtRetrying(fetchWithCeiling, BASE);
  // A request the ceiling cuts off is a network failure, not an abort: the
  // offline queue reads it that way, and the retry must not dress it up.
  await withNetwork([init => new Promise((_res, rej) => {
    init.signal.addEventListener("abort", () => {
      const e = new Error("aborted"); e.name = "AbortError"; rej(e);
    });
  })], async () => {
    await assert.rejects(wrapped(REST, {}), /timed out/);
  });
  // An upload is exempt from the ceiling and from the retry alike.
  await withNetwork([refusal], async calls => {
    const res = await wrapped(`${BASE}/storage/v1/object/reports/x.pdf`, {});
    assert.equal(calls.length, 1);
    assert.equal(res.status, 401);
  });
}));

// ── The tick's real row: claim, send, settle, log, push ──────────────
// `runRow` is the sequence the deployed tick runs — index.ts hands it the
// live claim, `fire`, `settle`, `logError` and `tellScheduler`, and adds up
// what it answers. Here the database behind the claim and the status write
// is a scripted PostgREST behind the REAL retry, and the two transports are
// counted. What is being proved is that the count can only ever be one:
// nothing about a refused request, recovered or exhausted, sends again.
function postgrest(answers) {
  const { fetchImpl, calls } = scripted(answers);
  const db = futureJwtRetrying(fetchImpl, BASE);
  const write = async patch => {
    const res = await db(`${BASE}/rest/v1/scheduled_sends?id=eq.S-1`, { method: "PATCH", body: JSON.stringify(patch) });
    let body = null;
    try { body = JSON.parse(await res.text()); } catch { /* a gateway page */ }
    if (res.status === 200) return { data: body, error: null };
    return { data: null, error: { message: body?.message ?? `HTTP ${res.status}`, code: body?.code ?? null } };
  };
  return { write, calls };
}

const ROW = {
  id: "S-1", kind: "ticket_approval", record_id: "T-1", job_id: "J-1",
  label: "Ticket T-10231", set_by: "P-1"
};

// The tick's five dependencies, with mail and push replaced by counters.
// They are counted and not scripted on purpose: a send that goes twice shows
// up here as a 2, whatever the database did.
function tickDeps(answers, fireFails) {
  const { write, calls } = postgrest(answers);
  const sends = { mail: 0, push: 0 };
  const logs = [];
  const deps = {
    claim: async () => {
      const { data, error } = await write({ status: "sending" });
      if (error) throw new Error(`the claim: ${dbWhy(error)}`);
      return Array.isArray(data) && data.length > 0;
    },
    fire: async () => { sends.mail++; if (fireFails) throw fireFails; },
    settle: (_id, patch) => markStatus(p => write(p).then(r => ({ error: r.error })), patch, async () => {}),
    log: async (message, context) => { logs.push({ message, context }); },
    notify: async () => { sends.push++; },
    logged: loggedWords
  };
  return { deps, calls, sends, logs };
}

test("a claim that meets the clock recovers, and the send is made once", () => withFastClock(async () => {
  const { deps, calls, sends, logs } = tickDeps([refusal, ok]);
  const tally = await runRow(ROW, deps);
  assert.equal(calls.length, 3, "two attempts at the claim, then the status write");
  assert.deepEqual(tally, { fired: 1, failed: 0, unrecorded: 0, claimed: true });
  assert.equal(sends.mail, 1, "the email went once");
  assert.equal(sends.push, 1, "and the scheduler heard once");
  assert.deepEqual(logs, [], "nothing to tell the office");
}));

test("a claim refused to the end sends nothing at all", () => withFastClock(async () => {
  const { deps, calls, sends, logs } = tickDeps([refusal]);
  await assert.rejects(runRow(ROW, deps), /^Error: the claim: JWT issued at future \[PGRST303\]$/);
  assert.equal(calls.length, 3, "three attempts, and then it is a failure like any other");
  assert.equal(sends.mail, 0, "a row that was never claimed is never sent");
  assert.equal(sends.push, 0);
  assert.deepEqual(logs, []);
}));

test("a claim another tick took sends nothing, and asks nothing again", () => withFastClock(async () => {
  const taken = () => new Response("[]", { status: 200 });
  const { deps, calls, sends } = tickDeps([taken]);
  const tally = await runRow(ROW, deps);
  assert.deepEqual(tally, { fired: 0, failed: 0, unrecorded: 0, claimed: false });
  assert.equal(calls.length, 1, "zero rows back is an answer, not a refusal");
  assert.equal(sends.mail, 0, "the tick that won it is the one that sends");
  assert.equal(sends.push, 0);
}));

test("a status write refused to the end after the send: told, never repeated", () => withFastClock(async () => {
  // The claim lands; everything after it meets the clock and keeps meeting it.
  const { deps, calls, sends, logs } = tickDeps([ok, refusal]);
  const tally = await runRow(ROW, deps);
  // One claim, then markStatus's two tries with three attempts inside each.
  assert.equal(calls.length, 7);
  assert.deepEqual(tally, { fired: 1, failed: 0, unrecorded: 1, claimed: true });
  assert.equal(sends.mail, 1, "the email had already gone, and goes once");
  assert.equal(sends.push, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0].message, /WAS SENT/);
  assert.match(logs[0].message, /PGRST303/, "the office is told which refusal it was");
  assert.match(logs[0].message, /Do not send it again\.$/);
  assert.equal(logs[0].context.id, "S-1");
  assert.equal(logs[0].message, sentUnrecorded(ROW.label, "JWT issued at future [PGRST303]"));
}));

test("a send that failed is failed once, and the log keeps the detail the row does not", () => withFastClock(async () => {
  const why = refuse("Couldn't read the app settings. Try again, and tell the office if it keeps happening.",
    "JWT issued at future [PGRST303]");
  const { deps, calls, sends, logs } = tickDeps([ok, refusal, ok], why);
  const tally = await runRow(ROW, deps);
  // Claim, then the failed status write: refused once, written on the retry.
  assert.equal(calls.length, 3);
  assert.deepEqual(tally, { fired: 0, failed: 1, unrecorded: 0, claimed: true });
  assert.equal(sends.mail, 1, "the send was attempted once and not again");
  assert.equal(sends.push, 1, "and the scheduler is told once, with our own words");
  assert.match(logs[0].message, /was not sent: /);
  assert.match(logs[0].message, /PGRST303/, "function_errors gets the database's reason");
}));

// markStatus itself, driven the same way: the write and nothing else.
test("a status write that meets the clock recovers", () => withFastClock(async () => {
  const { write, calls } = postgrest([refusal, ok]);
  const w = p => write(p).then(r => ({ error: r.error }));
  assert.equal(await markStatus(w, { status: "sent" }, async () => {}), null, "the row was written");
  assert.equal(calls.length, 2, "the retry asked again inside the first try");
}));

test("a status write refused to the end says so with its code, and never throws", () => withFastClock(async () => {
  const { write, calls } = postgrest([refusal]);
  const why = await markStatus(p => write(p).then(r => ({ error: r.error })), { status: "sent" }, async () => {});
  assert.equal(calls.length, 6, "three attempts inside each of markStatus's two tries");
  assert.equal(why, "JWT issued at future [PGRST303]", "the office is told which refusal it was");
  const words = sentUnrecorded("Ticket T-10231", why);
  assert.match(words, /WAS SENT/);
  assert.match(words, /PGRST303/);
  assert.match(words, /Do not send it again\.$/);
}));

test("an exhausted settings refusal reaches the log with the code and the words", () => {
  // What mail.ts raises when the settings read is refused for good: a
  // sentence for the person, the database's own reason kept as detail.
  const e = refuse("Couldn't read the app settings. Try again, and tell the office if it keeps happening.",
    "JWT issued at future [PGRST303]");
  // The row and the push: our words only.
  assert.equal(publicWords(e, "fallback"), "Couldn't read the app settings. Try again, and tell the office if it keeps happening.");
  assert.ok(!publicWords(e, "fallback").includes("PGRST303"));
  // function_errors: everything.
  assert.match(loggedWords(e), /PGRST303/);
  assert.match(loggedWords(e), /JWT issued at future/);
  assert.match(loggedWords(e), /Couldn't read the app settings/);
});

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
  assert.ok(src.includes("const message = dbWhy(e as"), "the outer catch keeps the code too");
  assert.ok(src.includes("loggedWords(e)"), "and the log takes the detail a marked refusal carries");
  assert.ok(/logError\("scheduled-sends", dbWhy\(\{ message: loggedWords\(e\)/.test(src),
    "the outer catch logs the words AND the code");
  // The per-row sequence is the shared module's, and the tick hands it the
  // live claim, send, status write, log and push. A loop that did any of it
  // itself again would be a second, untested order.
  assert.ok(/const tally = await runRow\(row as unknown as SendRow, \{/.test(src),
    "the tick runs the shared sequence");
  assert.ok(/logged: loggedWords/.test(src), "and the log takes the detail a marked refusal carries");
  for (const dep of ["claim,", "fire: () => fire(admin, row, settingsOnce)", "settle,",
    "log: (message, context) => logError(", "notify: (_r, error) => tellScheduler(admin, row, error)"]) {
    assert.ok(src.includes(dep), `${dep} must be what runRow is given`);
  }
  assert.ok(/if \(error\) throw dbFail\("the claim", error\);/.test(src), "a refused claim is not an answer about the row");
  // dbWhy and markStatus are the shared module's, and tested there against
  // the real thing rather than a copy lifted out of this file.
  const shared = readFileSync(new URL("../../supabase/functions/_shared/scheduledSends.ts", import.meta.url), "utf8");
  assert.ok(/code && !message\.includes/.test(shared), "the code PostgREST gave it is recorded, once");
  assert.ok(shared.includes("export async function markStatus("), "the final status write is the shared one");
  assert.ok(shared.includes("export async function runRow("), "and so is the order the row goes through");
  assert.ok(/failureUnrecorded\(row\.label, logged, wErr\)/.test(shared) && /was not sent: \$\{logged\}/.test(shared),
    "a row that failed is logged with its detail, and told to the person without it");
  // The settings read is the last one before an email leaves.
  assert.ok(src.includes("await appSettings(admin)"), "the settings read rides the wrapped client");
});

test("a settings read goes through the caller's client when there is one", () => {
  const mail = readFileSync(new URL("../../supabase/functions/_shared/mail.ts", import.meta.url), "utf8");
  assert.ok(mail.includes("export async function appSettings(client?: SupabaseClient)"));
  assert.ok(mail.includes("const admin = client ?? createClient("), "and opens its own door only when there is none");
  assert.ok(mail.includes("const settings = opts.settings ?? await appSettings(opts.client);"));
  // A refused settings read keeps the database's code in its detail.
  assert.ok(/error\.code \? `\$\{error\.message\} \[\$\{error\.code\}\]` : error\.message/.test(mail),
    "the settings refusal carries the code into function_errors");
  for (const f of ["mailJha.ts", "mailReport.ts"]) {
    const src = readFileSync(new URL(`../../supabase/functions/_shared/${f}`, import.meta.url), "utf8");
    assert.ok(/sendMail\(\{[\s\S]{0,300}client: admin,/.test(src), `${f} must hand its own client to sendMail`);
  }
});
