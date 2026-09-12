// The assistant's daily allowance: the pure decisions, and the wiring in
// ask/index.ts that they rest on.
//
// The decisions are askBudget.ts's and are exercised directly. The wiring is
// read back out of the function's source, because the thing most likely to go
// wrong is not the arithmetic — it is a second paid call added later that
// goes through `fetch` instead of the metered transport, which no arithmetic
// here would notice.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LEASE_STALE_SECONDS, ONE_CALL_MAX, worstOvershoot, usageTokens,
  reserveFor, billedNothing, BUSY_WORDS, SPENT_WORDS, LEARN_SPENT_WORDS, LEARN_TROUBLE_WORDS,
  WORKER_WALL_MS, CLEANUP_RESERVE_MS, CALL_TIMEOUT_MS, LEARN_TIMEOUT_MS, LEARN_MIN_MS, MIN_CALL_MS,
  requestDeadline, readUntil, callTimeout, timeToLearn, OUT_OF_TIME_WORDS, LEARN_NO_TIME_WORDS
} from "../../supabase/functions/_shared/askBudget.ts";
import { ASK_MODEL } from "../../supabase/functions/_shared/askLoop.ts";
import { LEARN_MODEL, LEARN_MAX_TOKENS } from "../../supabase/functions/_shared/askLearn.ts";

const read = p => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const ask = read("supabase/functions/ask/index.ts");

test("the usage counted is every input the provider names, not just the first", () => {
  // `input_tokens` alone is the undercount that arrives silently on the day
  // prompt caching is switched on: a cached prefix is billed under two other
  // names, and a ceiling that cannot see them spends past itself for ever.
  assert.deepEqual(usageTokens({ usage: { input_tokens: 100, output_tokens: 7 } }), { input: 100, output: 7 });
  assert.deepEqual(
    usageTokens({ usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 300, output_tokens: 7 } }),
    { input: 420, output: 7 });
});

test("an unreadable bill is not a free call", () => {
  // Every one of these answers null and never {0,0}: a nought written over a
  // cost nobody could read is the ceiling's own blind spot.
  for (const body of [null, undefined, "", 42, {}, { usage: null }, { usage: "12" }, { usage: {} }, { usage: [] }]) {
    assert.equal(usageTokens(body), null, `${JSON.stringify(body)} must not read as a free call`);
  }
});

test("a malformed counter makes the whole bill unreadable, not the field nought", () => {
  // CODEX'S FINDING, and it was right: the old reading coerced field by
  // field, so every one of these settled a real call at 0 in and 0 out — a
  // nought written over a cost nobody could read, which is the single thing
  // this whole file exists to refuse.
  const malformed = [
    { input_tokens: null, output_tokens: 7 },          // the reported case
    { output_tokens: 7 },                              // input missing
    { input_tokens: 5 },                               // output missing
    { input_tokens: -9, output_tokens: 7 },            // negative
    { input_tokens: 5, output_tokens: -1 },
    { input_tokens: 3.9, output_tokens: 2 },           // not whole
    { input_tokens: "100", output_tokens: 7 },         // a string that looks like one
    { input_tokens: 5, output_tokens: "x" },
    { input_tokens: Number.NaN, output_tokens: 7 },
    { input_tokens: Number.POSITIVE_INFINITY, output_tokens: 7 },
    { input_tokens: true, output_tokens: 7 },
    // An optional counter that IS there and cannot be read makes the total
    // unknown, not smaller.
    { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: "300" },
    { input_tokens: 5, output_tokens: 7, cache_creation_input_tokens: -20 },
    { input_tokens: 5, output_tokens: 7, cache_creation_input_tokens: 1.5 }
  ];
  for (const usage of malformed) {
    assert.equal(usageTokens({ usage }), null, `${JSON.stringify(usage)} must not read as a free call`);
  }
  // And what a good bill looks like: both mandatory counters whole, zero
  // allowed, and the cache pair absent or explicitly null — that is how "no
  // caching on this call" has been spelled, and holding a maximum against a
  // good call is its own kind of wrong.
  assert.deepEqual(usageTokens({ usage: { input_tokens: 0, output_tokens: 0 } }), { input: 0, output: 0 });
  assert.deepEqual(
    usageTokens({ usage: { input_tokens: 5, output_tokens: 7, cache_creation_input_tokens: null, cache_read_input_tokens: null } }),
    { input: 5, output: 7 });
});

test("a call reserves the model's whole documented maximum, and holds it when it cannot settle", () => {
  // The only figure that cannot be an undercount. An unknown model takes the
  // largest known one, which is the safe direction: a name we could not read
  // must not become the cheapest guess.
  assert.equal(reserveFor(ASK_MODEL), ONE_CALL_MAX[ASK_MODEL]);
  assert.equal(reserveFor(LEARN_MODEL), ONE_CALL_MAX[LEARN_MODEL]);
  const largest = Math.max(...Object.values(ONE_CALL_MAX));
  assert.equal(reserveFor(""), largest);
  assert.equal(reserveFor("something-nobody-has-heard-of"), largest);
});

const envelope = (type, message = "no", details) =>
  JSON.stringify({ type: "error", error: details ? { type, message, details } : { type, message }, request_id: "req_011CSHoEeqs5C35K2UUqR7Fy" });

test("only a refusal the provider gave before running anything settles at nothing", () => {
  // Without this a burst of rate-limit refusals eats a day's ceiling with not
  // a token spent, which is denial by another road.
  const owned = [
    [400, "invalid_request_error"], [401, "authentication_error"], [402, "billing_error"],
    [403, "permission_error"], [404, "not_found_error"], [413, "request_too_large"]
  ];
  for (const [status, type] of owned) {
    assert.equal(billedNothing(status, envelope(type)), true, `${status} ${type} is a refusal the provider owns`);
  }
  // THE TYPE AT A STATUS THE VENDOR DOES NOT DOCUMENT IT AT IS AMBIGUOUS. The
  // errors page says `invalid_request_error` "may also be used for other 4XX
  // status codes not listed in this section" — so that type at 422 is the API
  // declining something this file has never read about, and an unread
  // decision is not a proof of nothing billed.
  for (const [status, type] of [[422, "invalid_request_error"], [499, "invalid_request_error"], [400, "not_found_error"], [403, "rate_limit_error"], [404, "request_too_large"]]) {
    assert.equal(billedNothing(status, envelope(type)), false, `${status} ${type} is not a documented pair`);
  }
  // And everything ambiguous keeps its reservation: the call may have been
  // answered and billed on the far side of a connection we lost. 408 is a
  // timeout wearing a 4xx, so it is named out with the 5xx family.
  for (const status of [408, 500, 502, 503, 504, 529, 200, 0, NaN]) {
    assert.equal(billedNothing(status, envelope("invalid_request_error")), false, `${status} must keep its reservation`);
  }
});

test("a 4xx that is not the provider's own words keeps its reservation", () => {
  // THE STATUS ALONE PROVES NOTHING. api.anthropic.com is behind Cloudflare —
  // the docs say so of 413, "Cloudflare returns this error before the request
  // reaches the API servers" — so a 4xx on this socket may have been written
  // by a middlebox that never saw whether the call it proxied was run and
  // billed. Only the documented envelope is the provider speaking.
  const notTheProvider = [
    "<!DOCTYPE html><html><head><title>403 Forbidden</title></head></html>",
    "error code: 1015",
    "",
    "{",
    JSON.stringify({ message: "Forbidden" }),
    // The envelope's shape but not its contents.
    JSON.stringify({ type: "error", error: "rate_limit_error" }),
    JSON.stringify({ type: "message", error: { type: "rate_limit_error" } })
  ];
  for (const body of notTheProvider) {
    assert.equal(billedNothing(429, body), false, `a 429 carrying ${JSON.stringify(body).slice(0, 40)} must keep its reservation`);
  }
  // An ALLOW-list, because the versioning policy says the type values "may
  // expand ... over time": a name written into the API after this file must
  // arrive as ambiguous, not as free. `conflict_error` is the live example —
  // not documented against the Messages route, so it is not on the list.
  for (const type of ["conflict_error", "api_error", "overloaded_error", "timeout_error", "something_new_error"]) {
    assert.equal(billedNothing(400, envelope(type)), false, `${type} is not a refusal we can prove cost nothing`);
  }
  // Non-strings are not envelopes either, and neither is the object shape
  // arriving already parsed by accident.
  for (const body of [null, undefined, 0, [], { type: "error" }]) {
    assert.equal(billedNothing(400, body), false, "an unreadable body keeps its reservation");
  }
});

test("a 429 settles at nothing only when the body names a limit checked before generation", () => {
  // CODEX'S SECOND POINT, and the docs give a reason to distrust this one
  // rather than mere silence: of the three rate limits, "ITPM rate limits are
  // estimated at the beginning of each request" and RPM is a limit on
  // requests, but "OTPM rate limits are evaluated in real time as output
  // tokens are produced". A refusal reachable while output is being produced
  // may already have been billed.
  //
  // The spend cap is the one the vendor states outright: "API usage pauses
  // until 00:00 UTC on the first day of the next month" and "While usage is
  // paused, API requests return HTTP 429". Paused usage is not billed usage,
  // and `error.details.error_code` names it.
  assert.equal(billedNothing(429, envelope(
    "rate_limit_error",
    "You have reached your API usage limits: your organization has crossed its monthly API usage threshold.",
    { error_code: "enforced_spend_limit_reached" })), true);
  // A 429 arrives "describing which rate limit was exceeded", so a message
  // naming the request or input-token limit is one of the two decided at the
  // start of a request.
  for (const said of [
    "Number of request tokens has exceeded your per-minute rate limit (input tokens per minute)",
    "This request would exceed your organization's requests per minute rate limit"
  ]) {
    assert.equal(billedNothing(429, envelope("rate_limit_error", said)), true, said);
  }
  // And everything else holds its reservation in full: output tokens, a
  // wording we have never seen (an acceleration limit, say), an empty message.
  for (const said of [
    "This request would exceed your organization's output tokens per minute rate limit",
    "You have exceeded the rate limit for this model",
    "",
    "Too Many Requests"
  ]) {
    assert.equal(billedNothing(429, envelope("rate_limit_error", said)), false, `"${said}" must keep its reservation`);
  }
  // A details object that is not the documented shape is not the statement.
  for (const details of [{ error_code: "something_else" }, { error_code: 7 }, "enforced_spend_limit_reached"]) {
    assert.equal(billedNothing(429, envelope("rate_limit_error", "", details)), false, "an unread details object keeps its reservation");
  }
});

test("nothing Ask sends can carry the call past the window the ceiling rests on", () => {
  // ONE_CALL_MAX is `context window + max_tokens`, and that is an upper bound
  // only while the window itself is enforced on this request. Two documented
  // features would lift it, both silently:
  //   - server-side COMPACTION, which lets "the conversation continue past the
  //     context window limit";
  //   - server-side TOOLS, whose spend arrives under `server_tool_use`, a name
  //     the ledger does not count at all.
  // Both are reached through an `anthropic-beta` header, so its absence is the
  // thing to hold still.
  const sources = [
    "supabase/functions/_shared/askLoop.ts",
    "supabase/functions/_shared/askLearn.ts",
    "supabase/functions/_shared/askTools.ts",
    "supabase/functions/ask/index.ts"
  ];
  for (const p of sources) {
    assert.ok(!/anthropic-beta/i.test(read(p)), `${p} sends a beta header; the per-call ceiling must be re-verified against it`);
  }
  // Every tool Ask offers is ours and runs here — a server-side tool is named
  // by a bare `type` with no `input_schema`, and would be billed outside the
  // four names the ledger reads.
  const loop = read("supabase/functions/_shared/askLoop.ts");
  assert.ok(!/"type":\s*"(web_search|code_execution|computer|bash|text_editor|web_fetch|memory)/.test(loop));
});

test("both models Ask actually calls have a documented ceiling", () => {
  // The overshoot arithmetic is per model, so a model swapped in askLoop or
  // askLearn without a ceiling here would leave the bound naming a model
  // nobody calls any more. That is the drift this asserts.
  assert.ok(ONE_CALL_MAX[ASK_MODEL] > 0, `${ASK_MODEL} has no documented per-call ceiling`);
  assert.ok(ONE_CALL_MAX[LEARN_MODEL] > 0, `${LEARN_MODEL} has no documented per-call ceiling`);
  assert.equal(Object.keys(ONE_CALL_MAX).length, 2);
});

test("the overshoot is the lease count times one call, and nothing in flight is nothing over", () => {
  const one = Math.max(...Object.values(ONE_CALL_MAX));
  assert.equal(worstOvershoot(0), 0);
  assert.equal(worstOvershoot(1), one);
  assert.equal(worstOvershoot(15), 15 * one);
  assert.equal(worstOvershoot(-3), 0);
});

// The admission arithmetic is the DATABASE's now — one place, under a per-day
// advisory xact lock — so it is asserted where it lives. A check on this side
// would be a second opinion about a number two requests can be changing at
// once, which is the read-then-write window the lock exists to close.
const reserve = read("supabase/migrations/20260912034222_the_ceiling_is_charged_before_the_call.sql");

test("admission is one function, under the lock, counting reservations as well as settlements", () => {
  // The lock first, and on the DAY: two reservations for the same day must
  // not both read the pre-insert total. Verified live with two connections on
  // 12 Sept — B blocked 5,475 ms and was refused; without the lock it
  // answered true in 4 ms and the day committed 2,000 against a cap of 1,000.
  assert.match(reserve, /pg_advisory_xact_lock\(pg_catalog\.hashtext\('ask_calls'\), pg_catalog\.hashtext\(d::text\)\)/);
  // A reservation counts from the moment it exists, at its reserved figure,
  // until the provider's own number replaces it. This one line is the whole
  // mechanism; everything else follows from it.
  assert.match(reserve, /sum\(coalesce\(k\.settled, k\.reserved\)\)/);
  // The proposed reservation is counted too — a check of what is already
  // outstanding, with the new call left out, admits one call past the line
  // every time.
  assert.match(reserve, /if outstanding \+ want > c then\s*\n\s*return false;/);
  // Null or non-positive is no ceiling, which is what the migration alone
  // leaves: a project that has not chosen a number is refused nothing.
  assert.match(reserve, /if c is not null and c > 0 then/);
  // Settlement names one row and writes only while it is unsettled, so a
  // retry after an uncertain failure cannot double-count the day.
  assert.match(reserve, /where call_id = _call and settled is null/);
  // And the old door into the ledger is gone: a second way in that skipped
  // the reservation would be a second way to spend past the ceiling.
  assert.match(reserve, /drop function if exists public\.ask_record_spend/);
});

test("both the person and the office are told what to do", () => {
  // An error that names nothing is one the person answers by asking again,
  // which is the single thing each of these is trying to prevent.
  assert.match(BUSY_WORDS, /last question/i);
  assert.match(SPENT_WORDS, /tomorrow/i);
  assert.match(SPENT_WORDS, /Admin/);
  // The learning pass never fails an answer, so its two sentences have to say
  // that the answer above them still stands.
  for (const words of [LEARN_SPENT_WORDS, LEARN_TROUBLE_WORDS]) {
    assert.match(words, /answer above/i);
  }
  assert.notEqual(LEARN_SPENT_WORDS, LEARN_TROUBLE_WORDS);
  // The stale window has to outlast a whole answer or a slow question would
  // be taken for a dead one. The longest answer is now a figure rather than a
  // guess: the request deadline, which nothing may outlive.
  assert.ok(LEASE_STALE_SECONDS * 1000 > requestDeadline(0),
    "the lease must outlast the longest request the deadline allows");
});

// ── the wiring ─────────────────────────────────────────────────────────────

test("every paid call in the ask function goes through the metered transport", () => {
  // This is the assertion that matters most and the arithmetic cannot make:
  // a third model call added later, sent with a bare `fetch`, would be
  // counted nowhere and the ceiling would quietly stop being one. The
  // learning pass was exactly that until this round.
  const paid = [...ask.matchAll(/(\w+)\(API_URL,/g)].map(m => m[1]);
  assert.ok(paid.length >= 1, "the learning call could not be found");
  for (const caller of paid) {
    assert.notEqual(caller, "fetch", "a call to the model must not use a bare fetch");
  }
  // And the loop's transport is the metered one, not a pass-through.
  assert.match(ask, /fetch:\s*meteredFetch/, "askLoop must be handed the metered transport");
  assert.ok(!/fetch:\s*\(url,\s*init\)\s*=>\s*fetch\(/.test(ask), "the pass-through transport is back");
});

test("the lease is taken before any paid call and let go however the request ends", () => {
  const claim = ask.indexOf("ask_claim_lease");
  const loop = ask.indexOf("await askLoop(");
  assert.ok(claim > 0 && loop > claim, "the lease must be claimed before the loop runs");
  // In a finally, not at the end of the happy path: a refusal or a throw that
  // skipped the release would lock its own owner out for a whole stale window.
  const fin = ask.indexOf("} finally {");
  assert.ok(fin > 0, "the handler has no finally");
  assert.ok(ask.indexOf("ask_release_lease") > fin, "the release must be in the finally");
  // And it names its own request, so a request that woke after being taken
  // over cannot free the lease the taker holds.
  assert.match(ask, /ask_release_lease",\s*\{\s*_user:[^}]*_request:/);
});

test("every paid call reserves before it goes and settles from the provider's own figure", () => {
  // The order is the whole claim: a reservation written AFTER the call is a
  // hold that a retired worker loses, which is the defect this replaced.
  const reserveAt = ask.indexOf('admin.rpc("ask_reserve_call"');
  const send = ask.indexOf("res = await fetch(url, { ...init,");
  const settleAt = ask.indexOf('admin.rpc("ask_settle_call"');
  assert.ok(reserveAt > 0, "no reservation is written");
  assert.ok(send > reserveAt, "the money is spent before the reservation is written");
  assert.ok(settleAt > send, "the settlement must follow the call it settles");
  // A refusal answers false rather than throwing, so the false must refuse.
  assert.match(ask, /if \(got\.data !== true\) throw refuse\(SPENT_WORDS\);/);
  // And a reservation that could not be WRITTEN refuses too: spend-and-hope
  // makes a database somebody can trouble into the way past the ceiling.
  assert.match(ask, /if \(got\.error\) \{[\s\S]{0,600}?throw refuse\(SPENT_WORDS\);/);
  // Settled from the provider's figures, on a CLONE — the caller still has to
  // read the original, and a body read twice is a body the loop never sees.
  assert.match(ask, /usageTokens\(await res\.clone\(\)\.json\(\)\)/);
  // Nothing about the day's total may live in the isolate again: no local
  // running total, and no second reading of the allowance to go stale.
  assert.ok(!/ask_allowance/.test(ask), "the day is being read into the isolate again");
  assert.ok(!/ask_record_spend/.test(ask.replace(/\/\/[^\n]*/g, "")), "the dropped ledger door is back in the code");
});

test("an ambiguous failure keeps its reservation and only a provider refusal settles at nothing", () => {
  // The three ways a call can end without a readable bill — aborted, refused,
  // unreadable — and only the middle one may be written down as nought.
  // The body is read from a CLONE and handed to billedNothing beside the
  // status: the status alone cannot say whose refusal this was.
  assert.match(ask, /const said = await res\.clone\(\)\.text\(\)/);
  assert.match(ask, /if \(billedNothing\(res\.status, said\)\) \{\s*\n\s*const back = await admin\.rpc\("ask_settle_unbilled"/);
  // The abort path settles NOTHING: our fetch giving up proves nothing about
  // what the provider did with the request.
  const abort = ask.slice(ask.indexOf("} catch (e) {", ask.indexOf("res = await fetch(url, { ...init,")), ask.indexOf("if (!res.ok) {"));
  assert.ok(!/ask_settle/.test(abort), "an aborted call must never be settled");
  assert.match(abort, /throw refuse\(OUT_OF_TIME_WORDS\)/);
  // An unreadable bill is not a free call either: it simply is not settled.
  const unreadable = ask.slice(ask.indexOf("if (!cost) {"), ask.indexOf("let wrote = await admin.rpc"));
  assert.ok(!/ask_settle/.test(unreadable), "an unreadable bill must never be settled");
});

test("a learning pass that did not land says so", () => {
  // It used to answer `trouble: null` on any refusal, so the card said
  // nothing at all and the note was simply gone.
  assert.ok(!/if \(!res\.ok\) return \{ added: \[\], trouble: null \}/.test(ask),
    "the silent learning failure is back");
  assert.match(ask, /trouble: LEARN_TROUBLE_WORDS/);
  // Each refusal named, never "any marked refusal": a different refusal told
  // as the allowance — or as the clock — is a sentence that is simply untrue.
  assert.match(ask, /words === SPENT_WORDS \? LEARN_SPENT_WORDS/);
  assert.match(ask, /words === OUT_OF_TIME_WORDS \? LEARN_NO_TIME_WORDS : LEARN_TROUBLE_WORDS/);
});

test("the sentence sends the Admin to a screen that really has the box", () => {
  // SPENT_WORDS tells the person an Admin can raise the limit on the Admin
  // screen. For a while that was simply untrue: the column existed, the
  // function read it, and no screen could write it — so the only way to lift
  // the ceiling was SQL, which means in practice Ask would have died at the
  // default and stayed dead. An error that names what to do has to name
  // something that exists.
  assert.match(SPENT_WORDS, /Admin screen/);
  const screen = read("vite-app/src/components/adminSetup.jsx");
  const db = read("vite-app/src/db.js");
  assert.match(screen, /askDailyTokenCap/, "the Admin screen has no daily-limit box");
  assert.match(db, /ask_daily_token_cap/, "getAppSettings does not read the column back");
  // Read AND written: a box that loads the value and saves something else is
  // the shape that silently stops working.
  assert.match(db, /ask_daily_token_cap: cap/, "the save does not write the column");
  assert.match(db, /select\("resend_api_key[^"]*ask_daily_token_cap/, "the select does not name the column");
});

test("blank is no limit all the way down, and zero is refused instead of reinterpreted", () => {
  // ask_reserve_call reads 0 as no ceiling, because that is the only safe
  // reading of a column that means "unset" when null. Which makes a saved 0
  // dangerous in the other direction: somebody typing it means "stop
  // everything" and would get "spend anything". The save refuses it in words.
  assert.match(reserve, /if c is not null and c > 0 then/, "the function reads 0 as no ceiling");
  const db = read("vite-app/src/db.js");
  assert.match(db, /Number\(capText\) <= 0/, "the save no longer refuses a zero cap");
  assert.match(db, /leave it blank for no limit/i, "the refusal must say what blank does");
});

// ── the clock ──────────────────────────────────────────────────────────────
//
// The second thing an answer spends. It was being spent against a figure that
// does not exist here: ASK_BUDGET_MS was 100 s, sized for a 400 s worker, and
// this project's org is on the free plan's 150 s. The whole of that defect is
// arithmetic, so the whole of it can be asserted.

test("every millisecond the request may spend fits inside the worker's wall clock", () => {
  // The sum, start to finish: read until the derived instant, then one final
  // answer, then one learning call, then the cleanup reserve. If that sum
  // exceeds what the platform gives, a question that uses all of it is
  // retired mid-sentence and the crew get nothing — which is exactly what
  // 100 + 45 + 20 did.
  const deadline = requestDeadline(0);
  assert.equal(deadline + CLEANUP_RESERVE_MS, WORKER_WALL_MS,
    "the deadline must be the wall clock less the cleanup reserve");
  assert.equal(readUntil(deadline) + CALL_TIMEOUT_MS + LEARN_TIMEOUT_MS, deadline,
    "reading must stop exactly one final answer and one learning call before the deadline");
  assert.ok(readUntil(deadline) > 0, "there must be time left to read anything at all");
  // And the derivation moves with its parts rather than being a second
  // opinion: a longer call timeout takes the time out of READING, never out of
  // the deadline.
  assert.equal(readUntil(1_000_000), 1_000_000 - CALL_TIMEOUT_MS - LEARN_TIMEOUT_MS);
});

test("no call may outlive the deadline, however long its own ceiling is", () => {
  const deadline = requestDeadline(0);
  // Early on, a call gets its own ceiling and no more.
  assert.equal(callTimeout(deadline, 0, CALL_TIMEOUT_MS), CALL_TIMEOUT_MS);
  // Late on, it gets what is left — this is the half that was missing, and it
  // is why the abort signal is not merely protection against a hung provider.
  assert.equal(callTimeout(deadline, deadline - 5_000, CALL_TIMEOUT_MS), 5_000);
  assert.equal(callTimeout(deadline, deadline, CALL_TIMEOUT_MS), 0);
  assert.ok(callTimeout(deadline, deadline + 9_000, CALL_TIMEOUT_MS) < 0,
    "past the deadline the answer must be negative, so the floor refuses it");
  // The learning call's own ceiling is the shorter of the two: it is one short
  // round, and it is the thing that gives way when time is short.
  assert.ok(LEARN_TIMEOUT_MS < CALL_TIMEOUT_MS);
  assert.equal(callTimeout(deadline, 0, LEARN_TIMEOUT_MS), LEARN_TIMEOUT_MS);
});

test("the learning call is skipped rather than started too late to finish", () => {
  const deadline = requestDeadline(0);
  assert.equal(timeToLearn(deadline, deadline - LEARN_MIN_MS), true, "exactly at the floor is enough");
  assert.equal(timeToLearn(deadline, deadline - LEARN_MIN_MS + 1), false);
  assert.equal(timeToLearn(deadline, deadline + 1), false);
  // Asked before the body is built, let alone sent: a call that cannot finish
  // spends money for a note nobody gets.
  const learn = ask.indexOf("async function learn(");
  const asked = ask.indexOf("timeToLearn(deadline", learn);
  const built = ask.indexOf("learnBody(", learn);
  const sent = ask.indexOf("await send(API_URL", learn);
  assert.ok(asked > learn && asked < built && built < sent,
    "the clock must be asked before the learning body is built or sent");
});

test("both models' per-call ceilings are the max_tokens the code actually sends", () => {
  // Codex's requirement, and the half of ONE_CALL_MAX that can drift: the
  // context windows are the vendor's documented figures and are cited, but the
  // output halves are OURS. A raised answer budget with this table left alone
  // would leave the bound too small in the unsafe direction, nothing failing.
  const loop = read("supabase/functions/_shared/askLoop.ts");
  const sends = Number(/const MAX_TOKENS = (\d+)/.exec(loop)?.[1]);
  assert.ok(sends > 0, "askLoop's max_tokens could not be read out of the source");
  assert.equal(ONE_CALL_MAX[ASK_MODEL], 1_000_000 + sends,
    ASK_MODEL + "'s ceiling must be its context window plus the max_tokens askLoop sends");
  assert.equal(ONE_CALL_MAX[LEARN_MODEL], 200_000 + LEARN_MAX_TOKENS,
    LEARN_MODEL + "'s ceiling must be its context window plus the max_tokens askLearn sends");
  // And it bounds the SUM of all four names the ledger counts, not just the
  // one called input_tokens: the three input names are parts of one input
  // total, and the window is the ceiling on that total.
  const worst = usageTokens({ usage: {
    input_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: sends
  } });
  assert.equal(worst.input + worst.output, ONE_CALL_MAX[ASK_MODEL]);
});

// ── the wiring of the clock ────────────────────────────────────────────────

test("the wall clock is read once, and the loop carries no budget of its own", () => {
  // Two constants that must agree about the same 150 s are two constants that
  // will disagree. ASK_BUDGET_MS was the second one.
  const loop = read("supabase/functions/_shared/askLoop.ts");
  assert.ok(!/^export const ASK_BUDGET_MS/m.test(loop),
    "askLoop has its own time budget again — it must be handed readUntil instead");
  assert.match(loop, /deps\.readUntil/, "the loop must stop reading at the instant it is handed");
  assert.match(ask, /const deadline = requestDeadline\(Date\.now\(\)\)/,
    "the function must take one reading of the wall clock");
  assert.match(ask, /readUntil: readUntil\(deadline\)/,
    "the loop's reading stop must be derived from that one deadline");
  // One reading means one: a second figure sized against the wall clock
  // somewhere else is the drift this is here to catch.
  assert.ok(!/WORKER_WALL_MS/.test(ask), "the wall clock belongs in askBudget.ts, not in the function");
});

test("every paid call carries a timeout, and it is the lesser of its own and what is left", () => {
  assert.match(ask, /signal: AbortSignal\.timeout\(wait\)/, "a paid call may not wait for ever");
  assert.match(ask, /callTimeout\(deadline, Date\.now\(\), model === LEARN_MODEL \? LEARN_TIMEOUT_MS : CALL_TIMEOUT_MS\)/,
    "each call's wait must be cut to fit the one deadline");
  // Below the floor nothing is started: a refusal in words is a better end
  // than a retirement, which returns nothing at all.
  assert.match(ask, /wait < MIN_CALL_MS\) throw refuse\(OUT_OF_TIME_WORDS\)/,
    "a call with no time left must be refused in words");
  assert.ok(MIN_CALL_MS > 0 && MIN_CALL_MS < LEARN_TIMEOUT_MS);
  // Both of ours, so both travel, and both say what to do about it.
  assert.match(OUT_OF_TIME_WORDS, /narrow/i);
  assert.match(LEARN_NO_TIME_WORDS, /answer above/i);
  assert.notEqual(LEARN_NO_TIME_WORDS, LEARN_TROUBLE_WORDS);
});

test("a call we stopped waiting for is held in full, never written down as nought", () => {
  // Aborting OUR fetch proves nothing about the provider: the call may have
  // been answered, and billed, after we stopped waiting. So it settles at
  // nothing and holds the model's whole documented maximum — the same rule an
  // unreadable bill gets, and the rule Codex made a condition of the design.
  const metered = ask.indexOf("const meteredFetch");
  const loop = ask.indexOf("await askLoop(");
  const caught = ask.indexOf("} catch (e) {", metered);
  assert.ok(caught > metered && caught < loop, "the transport does not catch a failed send");
  const block = ask.slice(caught, ask.indexOf("throw refuse(OUT_OF_TIME_WORDS)", caught));
  assert.ok(!/ask_settle/.test(block), "an aborted call must never be settled — its reservation stands whole");
  assert.match(block, /reserveFor\(model\)/, "the office must be told what the call is still holding");
  assert.match(block, /logError/, "the office must hear that a call was cut off");
});
