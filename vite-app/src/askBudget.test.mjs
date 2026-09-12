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
  unsettledHold, mayCall, BUSY_WORDS, SPENT_WORDS, LEARN_SPENT_WORDS, LEARN_TROUBLE_WORDS
} from "../../supabase/functions/_shared/askBudget.ts";
import { ASK_MODEL } from "../../supabase/functions/_shared/askLoop.ts";
import { LEARN_MODEL } from "../../supabase/functions/_shared/askLearn.ts";

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
  // be taken for a dead one.
  assert.ok(LEASE_STALE_SECONDS > 100, "the loop alone may run 100 seconds");
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
  const send = ask.indexOf("const res = await fetch(url, init);");
  assert.ok(check > 0 && send > check, "the allowance must be checked before the money is spent");
});

test("a learning pass that did not land says so", () => {
  // It used to answer `trouble: null` on any refusal, so the card said
  // nothing at all and the note was simply gone.
  assert.ok(!/if \(!res\.ok\) return \{ added: \[\], trouble: null \}/.test(ask),
    "the silent learning failure is back");
  assert.match(ask, /trouble: LEARN_TROUBLE_WORDS/);
  assert.match(ask, /LEARN_SPENT_WORDS : LEARN_TROUBLE_WORDS/);
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
