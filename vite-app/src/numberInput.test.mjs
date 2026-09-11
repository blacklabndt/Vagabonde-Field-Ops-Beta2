// The keystroke rule for every box that feeds a bill. Beta testing typed
// each of these into a quantity box at $8.00 a weld and read the total back:
// "1e6" showed 16 and billed 16, "1.2.3" showed 1.2.3 and billed 1.2, and
// "-5" showed 5 and billed 5. The point of these tests is that none of those
// three can ever be a figure the box holds.
//
// Run with: node --test src/numberInput.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { acceptsNumberText, isWholeStep } from "./numberInput.js";

test("fractional quantities stop at thousandths without treating step as an increment", () => {
  assert.equal(acceptsNumberText("1.2345", 0.1), false);
  assert.equal(acceptsNumberText("1.234", 0.1), true);
  assert.equal(acceptsNumberText("2.25", 0.5), true);
});

test("money has an explicit two-place limit, including decimal commas", () => {
  assert.equal(acceptsNumberText("1.234", 0.01, 2), false);
  assert.equal(acceptsNumberText("0,125", 0.01, 2), false);
  assert.equal(acceptsNumberText("1.23", 0.01, 2), true);
  assert.equal(acceptsNumberText("1,200.25", 0.01, 2), true);
  assert.equal(acceptsNumberText("1.", 0.01, 2), true);
});

test("an exponent is refused, not swallowed", () => {
  // The old filter dropped the "e" and left 16 behind, which is a different
  // number that looks like a plausible one.
  assert.equal(acceptsNumberText("1e6", 0.5), false);
  assert.equal(acceptsNumberText("1e6", 1), false);
  assert.equal(acceptsNumberText("1E6", 1), false);
});

test("a second decimal point is refused rather than shown", () => {
  assert.equal(acceptsNumberText("1.2.3", 0.5), false);
  assert.equal(acceptsNumberText("1.2.3", 1), false);
  // The first point on its own is still on the way to a number.
  assert.equal(acceptsNumberText("1.", 0.5), true);
  assert.equal(acceptsNumberText("1.2", 0.5), true);
});

test("a minus sign is refused and never becomes a positive", () => {
  assert.equal(acceptsNumberText("-5", 0.5), false);
  assert.equal(acceptsNumberText("-5", 1), false);
  assert.equal(acceptsNumberText("-", 1), false);
  // 5 typed on its own is 5; only the sign is turned away.
  assert.equal(acceptsNumberText("5", 1), true);
});

test("a comma decimal is a decimal", () => {
  assert.equal(acceptsNumberText("1,5", 0.5), true);
  // One and a half is not a whole number of welds.
  assert.equal(acceptsNumberText("1,5", 1), false);
});

test("a grouping comma survives a whole-unit step", () => {
  assert.equal(acceptsNumberText("1,200", 0.5), true);
  assert.equal(acceptsNumberText("1,200", 1), true);
  // The trailing point a lone comma leaves behind is on the way there.
  assert.equal(acceptsNumberText("1,", 1), true);
});

test("step decides whether a decimal point is a key at all", () => {
  assert.equal(acceptsNumberText("3.5", 0.5), true);
  assert.equal(acceptsNumberText("3.5", 1), false);
  assert.equal(acceptsNumberText("3.", 1), false);
  assert.equal(acceptsNumberText("3", 1), true);
  // No step is no rule: decimals stay allowed, as they were before step
  // was read at all.
  assert.equal(acceptsNumberText("3.5", undefined), true);
  assert.equal(acceptsNumberText("3.5", "0.5"), true);
});

test("an emptied box stays empty", () => {
  assert.equal(acceptsNumberText("", 1), true);
  assert.equal(acceptsNumberText(null, 1), true);
});

test("letters and emoji are refused whole", () => {
  assert.equal(acceptsNumberText("abc", 1), false);
  assert.equal(acceptsNumberText("2 welds", 1), false);
  assert.equal(acceptsNumberText("🛠", 1), false);
});

test("isWholeStep reads the props the callers actually pass", () => {
  assert.equal(isWholeStep(1), true);
  assert.equal(isWholeStep("0.5"), false);
  assert.equal(isWholeStep(0.5), false);
  assert.equal(isWholeStep(undefined), false);
  assert.equal(isWholeStep(0), false);
  assert.equal(isWholeStep("nonsense"), false);
});
