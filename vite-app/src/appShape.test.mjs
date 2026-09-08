// Shape tests over App.jsx's source, for the two mistakes a bundler cannot
// catch and a browser only shows in the field.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
const at = needle => { const i = src.indexOf(needle); assert.ok(i >= 0, `App.jsx no longer contains: ${needle}`); return i; };

test("clearSessionState is declared above the recheck effect that captures it", () => {
  // The recheck effect is registered on the first render, which returns
  // early while the session is being checked. A function declared below
  // that return is not initialised when the listener captures it, and the
  // lapsed-session path threw instead of signing out.
  assert.ok(at("const clearSessionState = ") < at("const recheck = async () =>"));
});

test("every early return in App comes after the last hook call", () => {
  // Hooks below an early return run on some renders and not others, which
  // React refuses with "Rendered more hooks than during the previous render".
  const firstReturn = src.search(/\n  if \(checkingSession\)/);
  assert.ok(firstReturn > 0, "the checkingSession early return should exist");
  const body = src.slice(firstReturn);
  // Any `useSomething(`, not a list: App calls useModalPanel, which a named
  // list did not hold, and the next custom hook would not be in it either.
  const stray = body.match(/\n  (const |let )?[^\n]*\buse[A-Z]\w*\s*\(/);
  assert.equal(stray, null, `a hook sits below the first early return: ${stray && stray[0].trim()}`);
});
