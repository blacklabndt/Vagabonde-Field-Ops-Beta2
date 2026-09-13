import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CONTEXT_TABS, TABS } from "./data.js";

// Exercise the actual context expression handed to AskLauncher, with a
// retained job/ticket as happens after navigating away from the editor.
const app = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
const expression = app.slice(app.indexOf("<AskLauncher")).match(/context=\{(\{[\s\S]*?\})\} \/>/)?.[1];
assert.ok(expression, "AskLauncher supplies context");
const readContext = new Function("screen", "activeJob", "activeTicket", "helpFor", "CONTEXT_TABS", `return (${expression});`);
const help = ["Screen help"];
const contextAt = (screen, job = { id: "J-1" }, ticket = "ticket-1") => readContext(screen, job, ticket, () => ({ body: help }), CONTEXT_TABS);

test("Ask forgets retained record context on every screen outside the job", () => {
  for (const screen of TABS.map(t => t.key).filter(key => !CONTEXT_TABS.includes(key))) {
    assert.deepEqual(contextAt(screen), { screen, jobNumber: null, ticketId: null, help }, screen);
  }
});

test("Ask keeps visible job context and ignores unsaved ticket seeds", () => {
  for (const screen of CONTEXT_TABS) {
    assert.deepEqual(contextAt(screen), { screen, jobNumber: "J-1", ticketId: screen === "ticket" ? "ticket-1" : null, help });
    assert.equal(contextAt(screen, null, { workDate: "2026-09-12" }).ticketId, null);
    assert.equal(contextAt(screen, null, null).jobNumber, null);
  }
});
