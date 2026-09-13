// Scripted transport regression checks, NOT live model quality evaluations.
import test from "node:test";
import assert from "node:assert/strict";
import { askLoop, systemPrompt } from "../../supabase/functions/_shared/askLoop.ts";
import { createInvestigation } from "../../supabase/functions/_shared/askInvestigation.ts";
import { toolsFor, toolDefinitions, traceLine } from "../../supabase/functions/_shared/askTools.ts";

for (const scenario of [
  { name: "month comparison", current: [{ id: "T-1", total: 150, total_count: 1 }], expected: /"value":50/ },
  { name: "partial period", current: [{ id: "T-1", total: 150, total_count: 9 }], expected: /coverage is incomplete/ },
  { name: "restricted amounts", current: [{ id: "T-1", total: null, total_count: 1 }], expected: /missing, restricted/ }
]) {
  test(`scripted investigation: ${scenario.name}`, async () => {
    const investigation = createInvestigation(async (_name, input) => input.date_from === "2026-08-01" ? [{ id: "T-2", total: 100, total_count: 1 }] : scenario.current);
    const use = (id, name, input) => ({ type: "tool_use", id, name, input });
    const script = [
      [use("a", "search_tickets", { date_from: "2026-09-01", date_to: "2026-09-30" }), use("b", "search_tickets", { date_from: "2026-08-01", date_to: "2026-08-31" })],
      [use("c", "calculate", { operation: "percent_change", source_id: "read-1", compare_source_id: "read-2", field: "total" })],
      [{ type: "text", text: "Scripted answer; no live quality claim." }]
    ];
    const bodies = [];
    const fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      const content = script.shift();
      return new Response(JSON.stringify({ content, stop_reason: content[0].type === "tool_use" ? "tool_use" : "end_turn" }), { status: 200 });
    };
    const result = await askLoop([{ role: "user", text: "Compare September ticket dollars with August." }], toolDefinitions(toolsFor(["tracker"], "Admin")), systemPrompt({ name: "Test", role: "Admin" }, 0), "test", { fetch, runTool: investigation.runTool, trace: traceLine, now: () => 0, readUntil: 1000 });
    const last = bodies.at(-1).messages.at(-1).content;
    assert.match(last[0].content, scenario.expected);
    assert.equal(result.trace.length, 3);
    assert.equal(investigation.followUp().length, 2);
  });
}

// The learning pass, scripted end to end through the pure pieces ask/index.ts
// wires together: the body that goes, an extractor reply read against the
// SAME turns, and the notes then found again by a follow-up. Plumbing, not a
// claim about what a live extractor would decide.
import { learnBody, parseLearned, learningQuery, learnedLines } from "../../supabase/functions/_shared/askLearn.ts";

test("scripted learning: a taught task is kept, Ask's own unconfirmed suggestion is not, and a follow-up finds the task", async () => {
  const thread = [
    { role: "user", text: "how should the weekly handover go?" },
    { role: "assistant", text: "You could list the open tickets and post them to Team chat." },
    { role: "user", text: "we do it like this: on Friday list the open tickets, the unsigned approvals and the open queries, and post one message to Team chat. And Dave's number is 780-555-0100." }
  ];
  const answer = "Got it — and you could also email the list to the office.";
  const turns = [...thread, { role: "assistant", text: answer }];
  const { payload } = learnBody(turns, [{ id: "n1", note: "Prices are for Admins and Technicians." }]);
  const body = JSON.parse(payload);
  assert.match(body.messages[0].content, /\[3\] Ask: Got it/, "the answer just given is the last numbered turn");

  // A scripted extractor: one note the person taught, cited to their turn;
  // one Ask suggested in its own answer, cited only to itself; one with the
  // phone number, cited to the person — kept by the prompt's rule if the
  // extractor obeys it, which only a live case can show, so here it is the
  // provenance check that is on trial and the number is left to the prompt.
  const reply = JSON.stringify({
    add: [
      { note: "Task: the weekly handover; on Friday list the open tickets, unsigned approvals and open queries, and post one message to Team chat.", source_user_turns: [2] },
      { note: "Task: the weekly handover; email the list to the office.", source_user_turns: [3] },
      { note: "Task: the weekly handover; email the list to the office too.", source_user_turns: [1, 3] }
    ],
    replace: []
  });
  const decided = parseLearned(reply, ["n1"], turns);
  assert.deepEqual(decided.add, ["Task: the weekly handover; on Friday list the open tickets, unsigned approvals and open queries, and post one message to Team chat."]);

  // Next week, a fresh thread whose newest turn names nothing: the recipe is
  // ranked in by the turn before it.
  const rows = [
    ...Array.from({ length: 199 }, (_, i) => ({ id: `x${i}`, note: `Chase resends the approval link ${i}, `.padEnd(300, "y"), created_at: "x", profiles: null })),
  ];
  rows.unshift({ id: "t1", note: decided.add[0], created_at: "x", profiles: { name: "Dave", role: "Technician" } });
  const later = [
    { role: "user", text: "it's Friday, what goes in the weekly handover?" },
    { role: "assistant", text: "Here is the list." },
    { role: "user", text: "do that again" }
  ];
  const block = learnedLines(rows, "f3nc3", learningQuery(later));
  assert.match(block, /- \[a crew member\] Task: the weekly handover;/);
});
