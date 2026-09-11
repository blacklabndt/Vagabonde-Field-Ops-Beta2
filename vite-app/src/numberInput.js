// What a number box is allowed to hold while it is being typed into. The
// box itself is NumField, in components/common.jsx.
//
// The rule used to be a filter: strip anything outside [\d.,] out of whatever
// arrived and keep the rest. That does not refuse a keystroke, it rewrites
// the figure — "1e6" landed in the box as 16 and billed as 16, and "1.2.3"
// stayed on screen exactly as typed while the line billed 1.2. A quantity you
// can read back off the screen and still get wrong is worse than one that
// declines a key, so this answers one question — may the box hold this text —
// and the box keeps what it had when the answer is no.
//
// `step` is the caller's own statement of what a whole one of this thing is.
// Crew hours pass 0.5 and take a decimal; welds and films pass 1 and do not.
// Both props were being destructured and thrown away, which is why a weld
// count could be 3.5.
//
// Partial text is accepted on the way to a number: an emptied box, and a
// trailing separator ("3." on the way to "3.5"), because refusing those makes
// the decimal point unpressable.
import { decimalString } from "./data.js";

// Whether this step counts in whole units. No step, or a step that isn't a
// usable number, means the caller has stated no rule and decimals stay
// allowed — which is how every box behaved before step was honoured.
export const isWholeStep = step => {
  const n = typeof step === "number" ? step : parseFloat(step);
  if (!Number.isFinite(n) || n <= 0) return false;
  return Number.isInteger(n);
};

export function acceptsNumberText(text, step, decimals = 3) {
  const s = String(text == null ? "" : text);
  if (s === "") return true;
  // A minus sign, a letter, an exponent, a space, an emoji: refused whole,
  // rather than dropped so the surviving keystrokes close over the gap. A
  // pasted "-5" therefore leaves the box as it was instead of reading 5.
  if (/[^\d.,]/.test(s)) return false;
  const whole = isWholeStep(step);
  // The decimal point is not a key this box has when the step is whole.
  if (whole && s.includes(".")) return false;
  // decimalString settles what a comma means here ("1,5" is one and a half,
  // "1,200" is twelve hundred) and leaves anything it cannot read alone, so
  // "1.2.3" comes back unchanged and fails the shape test below.
  const norm = decimalString(s);
  // A whole-unit box tolerates the trailing point a lone grouping comma
  // leaves behind ("1," on the way to "1,200") but never a fractional digit.
  return whole ? /^\d*\.?$/.test(norm)
    : /^\d*\.?\d*$/.test(norm) && (norm.split(".")[1] || "").length <= decimals;
}
