import test from "node:test";
import assert from "node:assert/strict";
import { askTurns, pushTurn, threadForSend, forgetAskThread, jobLinks, mergeDictation, ASK_KEEP } from "./askThread.js";

test("dictation rebuilds the box from what was typed plus what was said", () => {
  assert.equal(mergeDictation("", "which tickets ", "are over sixty days"), "which tickets are over sixty days");
  assert.equal(mergeDictation("only Pembina ", "please", ""), "only Pembina please");
  assert.equal(mergeDictation("typed", "", ""), "typed");
  assert.equal(mergeDictation("", "", "   "), "");
  assert.equal(mergeDictation(null, "a  b", undefined), "a b");
});

test("a thread is turns in order, trace kept beside the answer and not sent", () => {
  forgetAskThread();
  pushTurn("user", "how many unsigned?");
  pushTurn("assistant", "Four.", ["read the tracker's totals"]);
  assert.deepEqual(askTurns(), [
    { role: "user", text: "how many unsigned?" },
    { role: "assistant", text: "Four.", trace: ["read the tracker's totals"] }
  ]);
  assert.deepEqual(threadForSend(), [
    { role: "user", text: "how many unsigned?" }, { role: "assistant", text: "Four." }
  ]);
  forgetAskThread();
  assert.deepEqual(askTurns(), []);
});

test("only the last ASK_KEEP turns are kept", () => {
  forgetAskThread();
  for (let i = 0; i < ASK_KEEP + 6; i++) pushTurn(i % 2 ? "assistant" : "user", `t${i}`);
  const t = askTurns();
  assert.equal(t.length, ASK_KEEP);
  assert.equal(t[t.length - 1].text, `t${ASK_KEEP + 5}`);
  forgetAskThread();
});

test("jobLinks marks real job numbers by membership, never by pattern", () => {
  const nums = new Set(["S-10113", "S-10120"]);
  assert.deepEqual(jobLinks("S-10113 and S-99999 are due; see S-10120.", nums), [
    { job: "S-10113" }, { text: " and S-99999 are due; see " }, { job: "S-10120" }, { text: "." }
  ]);
  assert.deepEqual(jobLinks("nothing here", nums), [{ text: "nothing here" }]);
  assert.deepEqual(jobLinks("s-10113 lower", nums), [{ job: "s-10113" }, { text: " lower" }]);
  assert.deepEqual(jobLinks("S-10113", new Set()), [{ text: "S-10113" }]);
});
