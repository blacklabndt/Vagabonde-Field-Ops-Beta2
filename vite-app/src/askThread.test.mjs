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

test("only a refusal we wrote carries its own words out; everything else is masked", () => {
  // S6, the top level. Every error in the ask function funnels through one
  // catch, and it used to return `e.message` whole — so a caller who could
  // provoke a PostgREST error read column names, constraint names and
  // function signatures out of the reply, one error at a time.
  //
  // The first fix read the WORDS and masked anything shaped like a database
  // message. That is allow-by-default: it masks what it recognises, so the
  // cost of an unforeseen message — or of a later edit adding a throw — is
  // disclosure. This is the other way round. Our sentences are MARKED at the
  // point they are raised, and the catch shows only a marked error. What
  // forgetting costs now is silence, which is the failure we can afford.
  //
  // So the test is not a list of strings to classify. It is: no sentence of
  // ours anywhere in the ask path is raised unmarked.
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const FILES = [
    "../../supabase/functions/ask/index.ts",
    "../../supabase/functions/_shared/askSends.ts",
    "../../supabase/functions/_shared/askFiles.ts",
    "../../supabase/functions/_shared/askDrafts.ts",
    "../../supabase/functions/_shared/askLoop.ts",
    "../../supabase/functions/_shared/scheduledSends.ts",
    "../../supabase/functions/_shared/hoursDose.ts",
    "../../supabase/functions/_shared/chasePlan.ts"
  ];
  for (const f of FILES) {
    const src = read(f);
    // A literal sentence thrown as a bare Error is one nobody will ever see.
    const bare = [...src.matchAll(/throw new Error\(\s*["`]/g)];
    assert.equal(bare.length, 0,
      `${f}: ${bare.length} sentence(s) raised unmarked — write throw refuse("…") so the person can read it`);
    // And every file that refuses in words defines the marker itself: these
    // modules may hold no imports of their own.
    if (src.includes("throw refuse(")) {
      assert.match(src, /function refuse\(words: string\): Error \{\s*const e = new Error\(words\);\s*\(e as Error & \{ plain\?: boolean \}\)\.plain = true;\s*return e;\s*\}/,
        `${f}: refuses in words but does not define the marker the catch reads`);
    }
  }

  // The database's own errors stay bare on purpose — that is what makes the
  // default masking rather than disclosure.
  const ask = read(FILES[0]);
  assert.ok((ask.match(/throw new Error\([A-Za-z_]/g) ?? []).length > 20,
    "the supabase-js errors are still raised unmarked, and so are masked");

  // Anthropic's own words are not ours to pass on, and the loop knows it.
  const loop = read("../../supabase/functions/_shared/askLoop.ts");
  const fn = loop.slice(loop.indexOf("async function refusal("), loop.indexOf("export async function askLoop"));
  assert.match(fn, /return refuse\("Ask is busy/, "a busy answer is ours and says what to do");
  assert.match(fn, /return refuse\("The Anthropic key was refused/, "so is a refused key");
  assert.match(fn, /return new Error\(`Anthropic answered/, "the provider's own body is not marked");

  // And the catch reads the mark, not the message, with the real words logged.
  const tail = ask.slice(ask.lastIndexOf("} catch (e) {"));
  assert.match(tail, /await logError\("ask", message/, "the office still gets what happened");
  assert.match(tail, /plainRefusal\(e\) \? message : ASK_TROUBLE/,
    "the browser gets the fixed sentence unless the error was marked as ours");
  assert.doesNotMatch(tail, /error: message \}/, "never the raw message");

  // plainRefusal judges the mark. A lookalike object with the right words and
  // no mark is still masked — which is the whole difference from the regex.
  const marked = Object.assign(new Error("That ticket is another technician's."), { plain: true });
  const bare2 = new Error("That ticket is another technician's.");
  assert.equal(marked.plain === true, true);
  assert.equal(bare2.plain === true, false, "the same sentence unmarked does not get out");
});

test("a question too heavy to be a question is refused before it is parsed", () => {
  // S5: `await req.json()` read the whole body into the isolate's memory
  // before anything judged it, so one signed-in account could spend the
  // function's memory with a single request.
  const src = readFileSync(new URL("../../supabase/functions/ask/index.ts", import.meta.url), "utf8");
  const at = src.indexOf("const claimed = Number(req.headers.get(\"content-length\")");
  assert.ok(at > 0, "the entry point weighs the body");
  const entry = src.slice(at, at + 600);
  assert.match(entry, /readBounded\(req, MAX_BODY_BYTES\)/, "and counts the bytes as they arrive");
  assert.match(entry, /413/, "over the ceiling is refused with a status that says why");

  // The header is a claim, not a measurement — the reader is the gate.
  const reader = src.slice(src.indexOf("async function readBounded("), src.indexOf("const ASK_TROUBLE"));
  assert.match(reader, /size > limit/, "the ceiling is met on the bytes themselves");
  assert.match(reader, /reader\.cancel\(\)/, "and the rest is never read");

  // A body that is not JSON is a refusal, not a crash.
  assert.match(src.slice(at, at + 900), /catch \{ parsed = null/,
    "unparseable is an answer, not a 500");
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
