// The one way a secret is compared, and every door that must use it.
//
// A `===` on a secret returns at the first character that differs, and the
// time it takes says how many leading characters the caller guessed right.
// secretsMatch walks every presented byte whatever matches. The helper is
// read straight out of supabase/functions/_shared (erasable TypeScript, no
// imports), and each door is read back as text, because the defect is the
// operator used and no pure function can hold that.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { secretsMatch } from "../../supabase/functions/_shared/constantTime.ts";

const read = p => readFileSync(new URL("../../" + p, import.meta.url), "utf8");

test("secretsMatch answers equality, and an unminted secret matches nothing", () => {
  const secret = "3f9c2d7e-1b4a-4c8e-9f0d-2a6b7c8d9e0f-1a2b3c4d";
  assert.equal(secretsMatch(secret, secret), true);
  assert.equal(secretsMatch("café — ·", "café — ·"), true, "multi-byte characters compare as bytes");
  assert.equal(secretsMatch(secret.slice(0, -1) + "0", secret), false, "the last character counts");
  assert.equal(secretsMatch("0" + secret.slice(1), secret), false, "so does the first");
  assert.equal(secretsMatch(secret.slice(0, -1), secret), false, "a shorter presentation is not a prefix match");
  assert.equal(secretsMatch(secret + "x", secret), false, "nor is a longer one");
  assert.equal(secretsMatch(secret + secret, secret), false, "nor the secret twice, though every presented byte lines up modulo the length");
  assert.equal(secretsMatch("", secret), false);
  assert.equal(secretsMatch(null, secret), false);
  assert.equal(secretsMatch(undefined, secret), false);
  // A door whose secret was never minted stays shut: nothing presented
  // equals nothing expected is still a refusal.
  assert.equal(secretsMatch("", ""), false);
  assert.equal(secretsMatch(null, null), false);
  assert.equal(secretsMatch("anything", ""), false);
  assert.equal(secretsMatch("anything", undefined), false);
});

test("secretsMatch walks every presented byte and never returns from inside the walk", () => {
  const source = read("supabase/functions/_shared/constantTime.ts");
  const body = source.slice(source.indexOf("export function secretsMatch("));
  assert.match(body, /for \(let i = 0; i < a\.length; i\+\+\) diff \|= a\[i\] \^ b\[i % b\.length\];/, "the walk is over the presented bytes, folded without a branch");
  assert.match(body, /return diff === 0;/);
  // The only early return is the empty-expected refusal, before the walk.
  const walkAt = body.indexOf("for (let i = 0;");
  assert.ok(walkAt > 0);
  assert.doesNotMatch(body.slice(walkAt), /return(?! diff === 0;)/, "nothing after the walk returns early");
  assert.doesNotMatch(body, /presented\s*(===|!==)\s*expected|expected\s*(===|!==)\s*presented|a\s*(===|!==)\s*b\b/, "no string equality on the pair");
  assert.doesNotMatch(source, /^import\b/m, "erasable and import-free, like the modules beside it");
});

test("every door compares its secret through secretsMatch, never with an operator", () => {
  // The four doors the database signs its calls through.
  const common = read("supabase/functions/_shared/backupCommon.ts");
  assert.match(common, /import \{ secretsMatch \} from "\.\/constantTime\.ts";/);
  assert.match(common, /if \(!secretsMatch\(presented, expected\)\) return json\(\{ error: "Not authorized" \}, 401\);/);
  assert.doesNotMatch(common, /presented (!==|===) expected/);
  for (const fn of ["chat-push", "chat-retention", "admin-digest"]) {
    const source = read(`supabase/functions/${fn}/index.ts`);
    assert.match(source, /import \{ secretsMatch \} from "\.\.\/_shared\/constantTime\.ts";/, `${fn} imports the helper`);
    assert.match(source, /if \(!secretsMatch\(req\.headers\.get\("x-internal-secret"\), expected\)\)/, `${fn} compares through it`);
  }
  // No function anywhere compares that header with an operator — a door
  // added later has to come through here too.
  for (const dir of readdirSync(new URL("../../supabase/functions", import.meta.url), { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name.startsWith("_")) continue;
    let source = "";
    try { source = read(`supabase/functions/${dir.name}/index.ts`); } catch { continue; }
    assert.doesNotMatch(source, /get\("x-internal-secret"\)\s*(!==|===|!=|==)/, `${dir.name} compares the internal secret with an operator`);
    assert.doesNotMatch(source, /(!==|===)\s*expected\b/, `${dir.name} compares an expected secret with an operator`);
  }
  // The OAuth callback's nonce, decided in the erasable module the node
  // suite reads, and the approval page's fingerprint.
  const oauth = read("supabase/functions/_shared/backupOauth.ts");
  assert.match(oauth, /import \{ secretsMatch \} from "\.\/constantTime\.ts";/);
  assert.match(oauth, /if \(!secretsMatch\(got, want\)\) \{/);
  assert.doesNotMatch(oauth, /want (!==|===) got|got (!==|===) want/);
  const approve = read("supabase/functions/approve-ticket/index.ts");
  assert.match(approve, /import \{ secretsMatch \} from "\.\.\/_shared\/constantTime\.ts";/);
  assert.match(approve, /if \(!secretsMatch\(String\(form\.get\("fp"\) \?\? ""\), fingerprint\)\) \{/);
  assert.doesNotMatch(approve, /(!==|===) fingerprint\b/);
});
