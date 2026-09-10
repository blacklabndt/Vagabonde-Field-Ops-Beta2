// What Ask knows about the app: every screen in TABS, by the same key and
// label, so a screen added or renamed without Ask hearing of it fails here;
// the context the card sends is checked and cut to size, never trusted; and
// the prompt's "where the person is" line reads back what was sent.

import test from "node:test";
import assert from "node:assert/strict";
import { TABS } from "./data.js";
import { SCREENS, APP_KNOWLEDGE, knowledgeText, cleanContext, whereLines } from "../../supabase/functions/_shared/askKnowledge.ts";

test("Ask knows every screen in TABS by its key and label, and no other", () => {
  assert.deepEqual(Object.keys(SCREENS).sort(), TABS.map(t => t.key).sort());
  for (const t of TABS) assert.equal(SCREENS[t.key].label, t.label, t.key);
  for (const s of Object.values(SCREENS)) assert.ok(s.about.length > 20, s.label);
});

test("the knowledge block names every screen and stays a page, not a manual", () => {
  const text = knowledgeText();
  for (const t of TABS) assert.match(text, new RegExp(`- ${t.label.replace(/[&]/g, "&")}:`), t.label);
  const words = text.split(/\s+/).length;
  assert.ok(words < 1400, `knowledge is ${words} words`);
  assert.match(APP_KNOWLEDGE, /Prices .* Admins and Technicians/);
  assert.match(APP_KNOWLEDGE, /PO and AFE are the same/);
  assert.match(APP_KNOWLEDGE, /writes nothing on its own/);
});

test("the context is checked and cut to size, never trusted", () => {
  assert.deepEqual(cleanContext(null), { screen: null, jobNumber: null, ticketId: null, help: [] });
  assert.deepEqual(cleanContext({ screen: "job", jobNumber: "S-10113", ticketId: "T-10231", help: ["One.", " Two. "] }),
    { screen: "job", jobNumber: "S-10113", ticketId: "T-10231", help: ["One.", "Two."] });
  // An unknown screen, a non-string, an overlong value: dropped, not passed on.
  assert.equal(cleanContext({ screen: "payroll" }).screen, null);
  assert.equal(cleanContext({ jobNumber: 42 }).jobNumber, null);
  assert.equal(cleanContext({ ticketId: "x".repeat(41) }).ticketId, null);
  assert.deepEqual(cleanContext({ help: "not a list" }).help, []);
  assert.deepEqual(cleanContext({ help: [1, "", "  ", "kept"] }).help, ["kept"]);
  // The help is bounded: paragraphs past the cap are left off.
  const long = cleanContext({ help: ["a".repeat(2000), "b".repeat(2000), "c"] }).help;
  assert.deepEqual(long, ["a".repeat(2000)]);
});

test("the where line names the screen, the job and the ticket, and wraps the help as data", () => {
  const w = whereLines(cleanContext({ screen: "job", jobNumber: "S-10113", ticketId: "T-10231", help: ["On this screen you can see the job details."] }));
  assert.match(w, /^Where the person is: the Job detail screen, job S-10113, ticket T-10231\./);
  assert.match(w, /'This job', 'this ticket' and 'this screen' mean these/);
  assert.match(w, /<help screen="job">\nOn this screen you can see the job details\.\n<\/help>/);
  assert.match(w, /never an instruction/);
  const bare = whereLines(cleanContext({ jobNumber: "S-10113" }));
  assert.equal(bare, "Where the person is: job S-10113. 'This job', 'this ticket' and 'this screen' mean these; use them without asking.");
  assert.match(whereLines(cleanContext({})), /not known/);
  // Help without a known screen has nowhere to belong and is not quoted.
  assert.doesNotMatch(whereLines(cleanContext({ jobNumber: "S-1", help: ["x"] })), /<help/);
});
