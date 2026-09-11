// The one answer to "is the account asking still an Admin", and every door
// that must ask it.
//
// The defect this pins: a role-only check against a profile read through
// RLS. A locked account reads its own row by design (migration
// 20260908063429), delete-user locks the profile before it bans the Auth
// user and says so when the ban fails, and stripping every tab is a
// revocation the Edge doors did not know about. Each of those left an
// Admin who had been removed holding every privileged route — unlock-user
// among them, which would have undone the removal for good.
//
// Half of it is a pure function, so it is imported and called. The other
// half is which columns each door selects and which helper it calls, and no
// pure function can hold that, so the sources are read back — the shape
// constantTime.test.mjs uses for the same reason.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  LOCKED_WORDS, UNCHECKED_WORDS, adminRefusal
} from "../../supabase/functions/_shared/activeAdmin.ts";

const read = p => readFileSync(new URL("../../" + p, import.meta.url), "utf8");

// Every door that switches to service authority on the strength of the
// caller being an Admin.
const DOORS = [
  ["create-user", "Only an Admin can create an account"],
  ["delete-user", "Only an Admin can remove an account"],
  ["unlock-user", "Only an Admin can unlock an account"],
  ["password-reset", "Only an Admin can send a set-password link"],
  ["mail-test", "Only an Admin can send a test email"]
];

const ACTIVE = { role: "Admin", tab_access: ["board", "mail"], deactivated_at: null };

test("an active Admin passes, and nobody else does", () => {
  assert.equal(adminRefusal(ACTIVE, false, "no"), null);
  assert.equal(adminRefusal({ ...ACTIVE, tab_access: ["mail"] }, false, "no"), null,
    "one tab is enough — is_staff() asks for one");

  // The rank, for an account that is otherwise in good standing.
  for (const role of ["Coordinator", "Technician", "Helper", "", null, undefined]) {
    const said = adminRefusal({ ...ACTIVE, role }, false, "only an Admin");
    assert.equal(said?.status, 403, `${role} is refused`);
    assert.equal(said?.error, "only an Admin", "and hears the door's own words");
  }
});

test("a locked account is refused however good its rank and its token", () => {
  // The state delete-user leaves behind when the Auth ban fails: the
  // profile says locked, Auth still accepts the session, the rank is
  // untouched. This is the whole finding.
  const banFailed = { role: "Admin", tab_access: [], deactivated_at: "2026-09-11T22:00:00Z" };
  const said = adminRefusal(banFailed, false, "only an Admin");
  assert.equal(said?.status, 403);
  assert.equal(said?.error, LOCKED_WORDS);

  // deactivated_at alone, tabs intact — the race between the lock and the ban.
  assert.equal(adminRefusal({ ...ACTIVE, deactivated_at: "2026-09-11T22:00:00Z" }, false, "x")?.error,
    LOCKED_WORDS);

  // Tabs alone, no lock stamp and no ban anywhere: stripping every tab is a
  // revocation in its own right, and this one needs nothing to have failed.
  for (const tabs of [[], null, undefined, "mail"]) {
    assert.equal(adminRefusal({ ...ACTIVE, tab_access: tabs }, false, "x")?.error, LOCKED_WORDS,
      `tab_access ${JSON.stringify(tabs)} is not at least one tab`);
  }

  // A locked Admin and a locked Helper hear the same thing: the refusal
  // must not tell a stranger which rank the account they have holds.
  assert.equal(adminRefusal({ role: "Helper", tab_access: [], deactivated_at: "2026-09-11T22:00:00Z" }, false, "x")?.error,
    LOCKED_WORDS);
});

test("a check that could not be made refuses, and says it is worth retrying", () => {
  // `const { data: profile }` discarded the error, so a database blink read
  // as "no such profile" and then as an ordinary refusal. Nothing was
  // learned in that moment, and a door that cannot check must not open.
  const failed = adminRefusal(ACTIVE, true, "only an Admin");
  assert.equal(failed?.status, 503, "not 403 — the caller is not being judged");
  assert.equal(failed?.error, UNCHECKED_WORDS);
  // Even a row that says Admin is not trusted when the read failed beside it.
  assert.equal(adminRefusal(null, true, "x")?.status, 503);
  assert.equal(adminRefusal(undefined, false, "x")?.status, 503, "no row is the database disagreeing with Auth");
  assert.equal(adminRefusal(null, false, "x")?.error, UNCHECKED_WORDS);
});

test("the lock is asked before the rank, so the order cannot be rearranged silently", () => {
  const src = read("supabase/functions/_shared/activeAdmin.ts");
  const body = src.slice(src.indexOf("export function adminRefusal("));
  assert.ok(body.length > 0);
  const at = s => body.indexOf(s);
  assert.ok(at("readFailed") < at("deactivated_at"), "the read's own error comes first");
  assert.ok(at("deactivated_at") < at("tab_access"), "then the lock stamp");
  assert.ok(at("tab_access") < at('role !== "Admin"'), "then the tabs, and the rank last");
  assert.doesNotMatch(src, /^import\b/m, "erasable and import-free, like the modules beside it");
  assert.ok(!/Deno\.env|process\.env/.test(src), "and it reads nothing from around it");
});

test("every privileged door asks the shared question, and selects what it is judged on", () => {
  // The Deno half, which the three backup functions reach through
  // backupCommon's requireAdmin.
  const gate = read("supabase/functions/_shared/adminGate.ts");
  assert.match(gate, /import \{ ADMIN_SELECT, adminRefusal \} from "\.\/activeAdmin\.ts";/);
  assert.match(gate, /\.select\(ADMIN_SELECT\)/, "the gate selects all three columns by the shared name");
  assert.match(gate, /adminRefusal\(/);

  const common = read("supabase/functions/_shared/backupCommon.ts");
  assert.match(common, /import \{ requireActiveAdmin \} from "\.\/adminGate\.ts";/);
  assert.match(common, /return await requireActiveAdmin\(req, refusal\);/,
    "requireAdmin is the shared gate now, not a role-only read of its own");
  assert.doesNotMatch(common, /\.select\("role"\)/, "and it no longer reads the rank alone");

  for (const [fn, words] of DOORS) {
    const src = read(`supabase/functions/${fn}/index.ts`);
    assert.match(src, /import \{ requireActiveAdmin \} from "\.\.\/_shared\/adminGate\.ts";/, `${fn} imports the gate`);
    assert.match(src, new RegExp(`requireActiveAdmin\\(req, "${words}"\\)`), `${fn} asks it with its own words`);
    // The defect itself: nowhere may a caller still be judged on the rank
    // alone, however the row was read.
    assert.doesNotMatch(src, /callerProfile\.role !== "Admin"/, `${fn} must not judge the caller on the rank alone`);
    assert.doesNotMatch(src, /from\("profiles"\)\s*\.select\("role"\)/, `${fn} must not read the caller's rank by itself`);
  }
});

test("no door anywhere reads only the rank to decide a privileged call", () => {
  // A function added later has to come through the gate too. The pattern is
  // the caller's OWN row (`.eq("id", user.id)`) read for the rank alone;
  // reading a TARGET's role is a different thing and is left alone.
  for (const [fn] of DOORS) {
    const src = read(`supabase/functions/${fn}/index.ts`);
    assert.doesNotMatch(src, /select\("role"\)[\s\S]{0,80}\.eq\("id", user\.id\)/,
      `${fn} reads its caller's rank alone`);
  }
});

test("unlock-user refuses to unlock the account that is asking", () => {
  // The consequence that made this a P1 rather than a nuisance: inside the
  // window where Auth still accepts a just-locked Admin, unlock-user would
  // clear that account's OWN lock — ban lifted, deactivated_at nulled and
  // the tabs written back from the role preset — and the removal was undone
  // for good. The gate above shuts the window; this shuts the door behind
  // it, because the two failures are different and either alone is enough.
  const src = read("supabase/functions/unlock-user/index.ts");
  assert.match(src, /userId === callerId/, "it compares the target with the caller");
  const guardAt = src.indexOf("userId === callerId");
  const banAt = src.indexOf("ban_duration");
  assert.ok(guardAt > 0 && banAt > 0 && guardAt < banAt,
    "and refuses before the ban is lifted, not after");
  // delete-user has had this guard from the start; unlock-user is the one
  // that went without, and the asymmetry is what hid it.
  assert.match(read("supabase/functions/delete-user/index.ts"), /userId === callerId/);
});
