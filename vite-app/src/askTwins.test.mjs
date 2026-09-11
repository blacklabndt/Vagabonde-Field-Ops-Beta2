// Two small modules live twice — once for the screens, once for Ask's
// function — and this holds each pair to the same code, the way
// backupSchedule.test.mjs holds the backup clock: the block between the
// `shared core` markers is read off both files, the function's types are
// stripped with Node's own stripper, the whitespace is folded and the two
// are compared. Change one, change the other, in the same commit.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { emailIn } from "./emailIn.js";
import { emailIn as emailInTs } from "../../supabase/functions/_shared/emailIn.ts";
import { planChase, CHASE_RECENT_DAYS, CHASE_WORKERS, CHASE_INTERVAL_MS } from "./chasePlan.js";
import { planChase as planChaseTs, chaseWords, CHASE_LIST_LIMIT } from "../../supabase/functions/_shared/chasePlan.ts";

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

test("the address rule is the same code on the screens and in the function", () => {
  const js = coreOf("./emailIn.js");
  const ts = coreOf("../../supabase/functions/_shared/emailIn.ts");
  assert.ok(js.includes("export const emailIn"), "the core must hold emailIn itself");
  assert.ok(/\(s: string \| null \| undefined\): string/.test(ts), "the function's copy is the typed one");
  assert.equal(shapeOf(stripTypeScriptTypes(ts)), shapeOf(js));
  for (const f of [emailIn, emailInTs]) {
    assert.equal(f("Dana Reyes <dana@acme.ca>"), "dana@acme.ca");
    assert.equal(f("T. Beaudry · (780) 555-0142 · t.beaudry@pembina.com"), "t.beaudry@pembina.com");
    assert.equal(f("Site office, ask at the gate"), "");
    assert.equal(f(""), "");
    assert.equal(f(null), "");
  }
});

test("the chase plan is the same code on the tracker and in the function", () => {
  const js = coreOf("./chasePlan.js");
  const ts = coreOf("../../supabase/functions/_shared/chasePlan.ts");
  assert.ok(js.includes("export function planChase"), "the core must hold planChase itself");
  assert.ok(/list: ChaseRow\[\] \| null \| undefined/.test(ts), "the function's copy is the typed one");
  assert.equal(shapeOf(stripTypeScriptTypes(ts)), shapeOf(js));
  // The pool's numbers stay with the panel's copy alone (the function
  // never sends); the core has no clock of its own.
  assert.equal(CHASE_WORKERS, 3);
  assert.equal(CHASE_INTERVAL_MS, 500);
  assert.ok(!ts.includes("CHASE_WORKERS"));
  const now = Date.UTC(2026, 8, 10, 20, 0);
  const rows = [
    { id: "T-1", contactLabel: "Dana <dana@acme.ca>", chasedAt: null, queriedAt: null },
    { id: "T-2", contactLabel: "dana@acme.ca", chasedAt: new Date(now - (CHASE_RECENT_DAYS - 1) * 86400000).toISOString(), queriedAt: null },
    { id: "T-3", contactLabel: "no address", chasedAt: null, queriedAt: null }
  ];
  const want = { due: [{ id: "T-1", to: "dana@acme.ca" }], queried: [], recent: ["T-2"], noEmail: ["T-3"] };
  assert.deepEqual(planChase(rows, { emailIn, nowMs: now }), want);
  assert.deepEqual(planChaseTs(rows, { emailIn: emailInTs, nowMs: now }), want);
});

test("the card's words name the due tickets and who is left alone and why; nothing due is a refusal", () => {
  const w = chaseWords({ due: [{ id: "T-1", to: "a@b.c" }, { id: "T-4", to: "d@e.f" }], queried: ["T-2"], recent: ["T-5", "T-6"], noEmail: ["T-3"] }, " for Pembina");
  assert.equal(w.summary, "Chase 2 unsigned tickets for Pembina — resend the approval link for T-1, T-4? 1 left alone — the client has a question open (T-2); 2 left alone — sent or chased in the last 3 days; 1 skipped — no client email on file (T-3).");
  assert.match(w.done, /^Chasing 2 tickets for Pembina\. Progress shows in the toast, with Stop/);
  assert.equal(w.skipped, "1 left alone — the client has a question open (T-2); 2 left alone — sent or chased in the last 3 days; 1 skipped — no client email on file (T-3)");
  const one = chaseWords({ due: [{ id: "T-1", to: "a@b.c" }], queried: [], recent: [], noEmail: [] }, "");
  assert.equal(one.summary, "Chase 1 unsigned ticket — resend the approval link for T-1?");
  assert.equal(one.skipped, "");
  assert.throws(() => chaseWords({ due: [], queried: [], recent: ["T-9"], noEmail: [] }, ""), /Nothing to chase: 1 left alone — sent or chased in the last 3 days\./);
  assert.throws(() => chaseWords({ due: [], queried: [], recent: [], noEmail: [] }, " older than 14 days"), /Nothing to chase older than 14 days: no ticket is awaiting approval\./);
  const many = Array.from({ length: CHASE_LIST_LIMIT + 3 }, (_, i) => ({ id: `T-${i}`, to: "a@b.c" }));
  assert.match(chaseWords({ due: many, queried: [], recent: [], noEmail: [] }, "").summary, / and 3 more\?$/);
});
