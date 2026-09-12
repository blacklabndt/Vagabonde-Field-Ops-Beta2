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
