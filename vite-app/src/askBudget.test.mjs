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
  unsettledHold, mayCall, BUSY_WORDS, SPENT_WORDS, LEARN_SPENT_WORDS, LEARN_TROUBLE_WORDS,
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
  for (const body of [null, undefined, "", 42, {}, { usage: null }, { usage: "12" }, { usage: {} }]) {
    assert.equal(usageTokens(body), null, `${JSON.stringify(body)} must not read as a free call`);
  }
  // A reply carrying only one of the four is still a reading — a real call
  // with no output block is an input-only cost, not an unknown one.
  assert.deepEqual(usageTokens({ usage: { input_tokens: 5 } }), { input: 5, output: 0 });
  // Nonsense in a named field is nought for that field alone.
  assert.deepEqual(usageTokens({ usage: { input_tokens: -9, output_tokens: "x" } }), { input: 0, output: 0 });
  assert.deepEqual(usageTokens({ usage: { input_tokens: 3.9, output_tokens: 2.1 } }), { input: 3, output: 2 });
});

test("what cannot be settled is held at the model's whole documented maximum", () => {
  // The only figure that cannot be an undercount. An unknown model takes the
  // largest known one, which is the safe direction: a name we could not read
  // must not become the cheapest guess.
  assert.equal(unsettledHold(ASK_MODEL), ONE_CALL_MAX[ASK_MODEL]);
  assert.equal(unsettledHold(LEARN_MODEL), ONE_CALL_MAX[LEARN_MODEL]);
  const largest = Math.max(...Object.values(ONE_CALL_MAX));
  assert.equal(unsettledHold(""), largest);
  assert.equal(unsettledHold("something-nobody-has-heard-of"), largest);
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

test("no ceiling set is no ceiling, and that is what the migration alone leaves", () => {
  for (const cap of [null, undefined, 0, -1, NaN, "not a number"]) {
    assert.equal(mayCall(9e12, 9e12, cap), true, `cap ${String(cap)} must not refuse anything`);
  }
});

test("the check counts what could not be written down as well as what was", () => {
  // Settled alone would let a request whose ledger writes all fail spend the
  // day twice over — which is the half an attacker aims at, because a write
  // they can make fail is a ceiling they can switch off.
  assert.equal(mayCall(900, 0, 1000), true);
  assert.equal(mayCall(900, 99, 1000), true);
  assert.equal(mayCall(900, 100, 1000), false, "exactly at the line is spent");
  assert.equal(mayCall(0, 5000, 1000), false, "held alone must be able to stop it");
  assert.equal(mayCall(5000, 0, 1000), false);
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

test("the ceiling is read before the calls and moved by their answers", () => {
  const allowance = ask.indexOf("ask_allowance");
  const metered = ask.indexOf("const meteredFetch");
  assert.ok(allowance > 0 && metered > allowance, "the day must be read before the transport uses it");
  // Settled from the provider's figures, on a CLONE — the caller still has to
  // read the original, and a body read twice is a body the loop never sees.
  assert.match(ask, /usageTokens\(await res\.clone\(\)\.json\(\)\)/);
  // The refusal is checked before the call, not after it.
  const check = ask.indexOf("mayCall(settled, held, cap)");
  const send = ask.indexOf("res = await fetch(url, { ...init,");
  assert.ok(check > 0 && send > check, "the allowance must be checked before the money is spent");
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
  // mayCall already treats 0 as no ceiling, because that is the only safe
  // reading of a column that means "unset" when null. Which makes a saved 0
  // dangerous in the other direction: somebody typing it means "stop
  // everything" and would get "spend anything". The save refuses it in words.
  assert.equal(mayCall(1e9, 1e9, 0), true, "the function reads 0 as no ceiling");
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
  assert.match(block, /held \+= unsettledHold\(model\)/, "an aborted call must keep its whole hold");
  assert.ok(!/settled = /.test(block), "an aborted call must not move the settled figure");
  assert.match(block, /logError/, "the office must hear that a call was cut off");
});
