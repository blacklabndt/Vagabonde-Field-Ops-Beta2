import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { askTurns, pushTurn, threadForSend, forgetAskThread, dropAction, dropLearned, isConfirmAction, confirmLabel, formLabel, jobLinks, mergeDictation, foldTranscripts, ASK_KEEP } from "./askThread.js";

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

test("a note that could not be kept rides with its answer, and silence is not an answer", () => {
  // What this replaced: the write's answer was discarded, so a note the
  // database refused looked exactly like one that landed — nothing on the
  // card, and nothing in the table either.
  forgetAskThread();
  pushTurn("user", "how do reports go out?");
  pushTurn("assistant", "From Job detail.", [], null, [], [],
    "That account has already taught Ask as much as it can hold (40 notes). Delete one before adding another.");
  assert.match(askTurns()[1].learnTrouble, /as much as it can hold/);
  assert.equal(askTurns()[1].text, "From Job detail.", "the answer itself is untouched");
  assert.equal("learned" in askTurns()[1], false, "and nothing is claimed to have been kept");

  // Both may be true at once: one note kept, another refused.
  pushTurn("assistant", "Both.", [], null, [{ id: "n1", note: "One landed." }], [], "and one did not");
  assert.deepEqual(askTurns()[2].learned, [{ id: "n1", note: "One landed." }]);
  assert.equal(askTurns()[2].learnTrouble, "and one did not");

  // Nothing wrong, nothing said.
  pushTurn("assistant", "Fine.", [], null, [], [], "");
  assert.equal("learnTrouble" in askTurns()[3], false);
  pushTurn("assistant", "Fine.", [], null, []);
  assert.equal("learnTrouble" in askTurns()[4], false);
  forgetAskThread();
});

test("the words for a refused note never carry the database's own", () => {
  // S6: a raw PostgREST message names columns and constraints and is written
  // for whoever runs the database. The cap's sentence is ours and is meant
  // to be read, so it passes; everything else is one fixed sentence, and the
  // real words go to function_errors where the office reads them.
  const src = readFileSync(new URL("../../supabase/functions/ask/index.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("function learnTrouble("), src.indexOf("function learnTrouble(") + 220);
  assert.match(fn, /as much as it can hold/, "the cap's own sentence is recognised");
  assert.match(fn, /LEARN_TROUBLE/, "and anything else becomes the fixed one");
  assert.doesNotMatch(fn, /\$\{message\}/, "the database's words are never interpolated for the browser");
  // And they are not merely dropped: both failure paths log what happened.
  const learn = src.slice(src.indexOf("async function learn("), src.indexOf("const LEARN_TROUBLE"));
  assert.equal((learn.match(/await logError\("ask"/g) ?? []).length, 2,
    "a correction that failed and a note that failed are each recorded");
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
  assert.equal(isConfirmAction({ kind: "chase" }), true);
  assert.equal(isConfirmAction({ kind: "set_reminder" }), true);
  assert.equal(isConfirmAction({ kind: "draft_contact" }), false);
  assert.equal(isConfirmAction({ kind: "draft_organisation" }), false);
  assert.equal(confirmLabel({ kind: "chase" }), "Chase");
  assert.equal(confirmLabel({ kind: "set_reminder" }), "Set it");
  assert.equal(isConfirmAction({ kind: "cancel_approval" }), true);
  assert.equal(confirmLabel({ kind: "cancel_approval" }), "Cancel approval");
  assert.equal(isConfirmAction({ kind: "open" }), false);
  assert.equal(formLabel({ kind: "open" }), "Open");
  assert.equal(formLabel({ kind: "draft_jha" }), "Open the form");
  assert.equal(formLabel(null), "Open the form");
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
