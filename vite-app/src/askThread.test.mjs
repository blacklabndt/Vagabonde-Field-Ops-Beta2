import test from "node:test";
import assert from "node:assert/strict";
import { askTurns, pushTurn, threadForSend, forgetAskThread, dropAction, dropLearned, isConfirmAction, confirmLabel, jobLinks, mergeDictation, foldTranscripts, ASK_KEEP } from "./askThread.js";

test("an answer keeps what was learned, and the × drops one note from the turn alone", () => {
  forgetAskThread();
  pushTurn("user", "cancel approval is on the ticket row");
  pushTurn("assistant", "Noted.", [], null, [{ id: "n1", note: "Cancel approval is on the ticket row.", extra: "dropped" }, { id: "n2", note: "Two." }]);
  assert.deepEqual(askTurns()[1].learned, [{ id: "n1", note: "Cancel approval is on the ticket row." }, { id: "n2", note: "Two." }]);
  dropLearned(1, "n1");
  assert.deepEqual(askTurns()[1].learned, [{ id: "n2", note: "Two." }]);
  assert.equal(askTurns()[1].text, "Noted.");
  dropLearned(1, "n2");
  assert.equal("learned" in askTurns()[1], false);
  pushTurn("assistant", "Nothing.", [], null, []);
  assert.equal("learned" in askTurns()[2], false);
  pushTurn("assistant", "Here.", [], null, [], [{ name: "t.csv", kind: "csv", words: "t.csv (1 rows)", table: { columns: ["a"], rows: [[1]] } }]);
  assert.equal(askTurns()[3].files[0].name, "t.csv");
  assert.equal("files" in askTurns()[2], false);
  forgetAskThread();
});

test("a proposal the card confirms in place is told from a draft by its kind, and the button says what it does", () => {
  assert.equal(isConfirmAction({ kind: "send_jha" }), true);
  assert.equal(isConfirmAction({ kind: "send_ticket_approval" }), true);
  assert.equal(isConfirmAction({ kind: "schedule_send" }), true);
  assert.equal(isConfirmAction({ kind: "cancel_scheduled" }), true);
  assert.equal(isConfirmAction({ kind: "reschedule_send" }), true);
  assert.equal(isConfirmAction({ kind: "forget_learned" }), true);
  assert.equal(isConfirmAction({ kind: "draft_jha" }), false);
  assert.equal(isConfirmAction(null), false);
  assert.equal(isConfirmAction({}), false);
  assert.equal(confirmLabel({ kind: "send_jha" }), "Send");
  assert.equal(confirmLabel({ kind: "send_ticket_approval" }), "Send");
  assert.equal(confirmLabel({ kind: "schedule_send" }), "Schedule");
  assert.equal(confirmLabel({ kind: "cancel_scheduled" }), "Cancel it");
  assert.equal(confirmLabel({ kind: "reschedule_send" }), "Reschedule");
  assert.equal(confirmLabel({ kind: "forget_learned" }), "Forget it");
  assert.equal(confirmLabel(null), "");
});

test("an action rides the answer turn for the card, never the send, and Not now drops it", () => {
  forgetAskThread();
  const action = { kind: "draft_job", summary: "New job for Pembina.", seed: { project: "RT" } };
  pushTurn("user", "new job for pembina");
  pushTurn("assistant", "Ready.", ["looked up client \"pembina\""], action);
  assert.deepEqual(askTurns()[1], { role: "assistant", text: "Ready.", trace: ["looked up client \"pembina\""], action });
  assert.deepEqual(threadForSend(), [{ role: "user", text: "new job for pembina" }, { role: "assistant", text: "Ready." }]);
  dropAction(1);
  assert.deepEqual(askTurns()[1], { role: "assistant", text: "Ready.", trace: ["looked up client \"pembina\""] });
  dropAction(0);
  assert.deepEqual(askTurns()[0], { role: "user", text: "new job for pembina" });
  forgetAskThread();
});

test("foldTranscripts takes segments in order and cumulative repeats once", () => {
  assert.equal(foldTranscripts(["which tickets", "are over sixty"]), "which tickets are over sixty");
  assert.equal(foldTranscripts(["which", "which tickets", "which tickets are"]), "which tickets are");
  assert.equal(foldTranscripts(["which", "which", "Which tickets"]), "Which tickets");
  assert.equal(foldTranscripts(["which tickets are", "which"]), "which tickets are");
  assert.equal(foldTranscripts(["  only ", "", null, "Pembina"]), "only Pembina");
  assert.equal(foldTranscripts([]), "");
  assert.equal(foldTranscripts(undefined), "");
});

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
