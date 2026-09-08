// The in-app help is only help if it is there for the screen somebody is
// standing on. A new screen added to TABS with no entry beside it would
// simply open with no tip at all — no error, no blank popup, nothing to
// notice — so the check is here rather than left to somebody spotting it.
//
// Run with: node --test src/help.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { TABS } from "./data.js";
import { HELP, helpFor } from "./help.js";

test("every screen in TABS has a help entry", () => {
  const missing = TABS.filter(t => !HELP[t.key]).map(t => t.key);
  assert.deepEqual(missing, [], `screens with no help: ${missing.join(", ")}`);
});

test("no help entry names a screen that no longer exists", () => {
  const keys = TABS.map(t => t.key);
  const strays = Object.keys(HELP).filter(k => !keys.includes(k));
  assert.deepEqual(strays, [], `help for screens not in TABS: ${strays.join(", ")}`);
});

// Each entry is what the dialog renders directly: a name for the screen and
// paragraphs to print. An empty body would open a dialog with nothing in it.
// One paragraph is enough: the owner writes these, and some screens are
// said in a sentence.
test("every entry carries a heading and at least one paragraph", () => {
  for (const [key, entry] of Object.entries(HELP)) {
    assert.equal(typeof entry.heading, "string", `${key} has no heading`);
    assert.ok(entry.heading.trim().length > 0, `${key} has an empty heading`);
    assert.ok(Array.isArray(entry.body), `${key} has no body array`);
    assert.ok(entry.body.length >= 1, `${key} has no paragraphs`);
    for (const p of entry.body) {
      assert.equal(typeof p, "string", `${key} has a non-string paragraph`);
      assert.ok(p.trim().length > 0, `${key} has an empty paragraph`);
    }
  }
});

// Short enough to be read standing up. The brief for this screen was three
// to six paragraphs under 200 words; past that nobody reads it and the
// answer might as well have stayed in the repository.
test("no entry runs past six paragraphs or two hundred words", () => {
  for (const [key, entry] of Object.entries(HELP)) {
    assert.ok(entry.body.length <= 6, `${key} has ${entry.body.length} paragraphs`);
    const words = entry.body.join(" ").split(/\s+/).filter(Boolean).length;
    assert.ok(words <= 200, `${key} runs to ${words} words`);
  }
});

test("helpFor answers null for a screen with no entry, so a screen can open with no tip", () => {
  assert.equal(helpFor("board"), HELP.board);
  assert.equal(helpFor("nothing-like-this"), null);
  assert.equal(helpFor(undefined), null);
  assert.equal(helpFor(""), null);
});
