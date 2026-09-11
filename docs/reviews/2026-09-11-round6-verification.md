# Round 6 verification — a revoked Admin is revoked at every door

Answers S1 from `2026-09-11-security-codex-review.md`, under the scope
Codex and I agreed in `2026-09-11-security-claude-verdict.md` and his
reconciliation: **S1 only, no migration.**

## What was wrong

Six doors switched to service authority on the strength of one question —
`profile.role !== "Admin"` — against a row the caller reads through RLS:

- `_shared/backupCommon.ts` `requireAdmin`, behind `backupDoor` and so
  behind `backup-run`, `backup-restore` and `backup-oauth`
- `create-user`, `delete-user`, `unlock-user`, `password-reset`, `mail-test`

Three things that revoke an account were not asked about.

**The lock stamp.** `delete-user` writes `tab_access: []` and
`deactivated_at` FIRST and then bans the Auth user, and when the ban does
not land it says so and returns `ok: true, banFailed: true`. In that state
Auth still accepts the session and the rank still reads Admin.

**The tabs.** Stripping every tab is a revocation in its own right —
`is_staff()` means at least one tab, and CLAUDE.md has said since the
baseline that it locks an account out of the API, not only the menu. The
Edge doors were the one place that did not know. **This one needs nothing
to have failed anywhere**, which is what makes S1 more than a partial-failure
story.

**The read's own error.** `const { data: profile }` discarded it. A database
blink answered "no profile", which the door then read as an ordinary
refusal — and `.single()` makes a missing row an error, so no row and a
failed read were the same silence.

### Why it was a P1 and not a nuisance

`unlock-user` had no self-target check. A just-revoked Admin, inside the
window where Auth still accepted the session, called it with their **own**
id: `!target.deactivated_at` passes (they are locked), the ban is lifted,
`deactivated_at` is nulled and `tab_access` is written back from
`tabs_for_role`. The removal was undone, permanently, by the person who had
just been removed. `delete-user` has refused its own caller from the start;
that asymmetry is what hid it.

## What was corrected during review

Codex was right and I was wrong on the reach of the defect, and the record
should say so. I claimed the window was open on the **success** path because
"a locked account's token stays good for an hour". That sentence is about
the **PostgREST/RLS** path, where the JWT is verified locally against the
secret with no call to Auth. `requireAdmin` calls `auth.getUser()`, which
asks Auth itself and does refuse a banned account. So the ban-failure state
and the zero-tab state are the reachable ones; a *successful* ban is not
bypassed, and this note does not claim it is.

## The fix

- `_shared/activeAdmin.ts` — new, pure, import-free, in the guard list
  (twenty-three now). `adminRefusal(profile, readFailed, refusal)` answers
  null or a refusal. The ORDER is the design:
  1. the read failed → 503 and "try again in a moment" — fail closed, and
     the caller is not being judged, so it is not a 403;
  2. no row → the same, because the database disagreeing with Auth is not
     "not an Admin";
  3. `deactivated_at` → locked;
  4. fewer than one tab → locked;
  5. rank **last**, so a locked Admin and a locked Helper hear the same
     sentence and a refusal never says which rank the stolen account holds.
  `ADMIN_SELECT` is exported beside it so no door can be judged on a column
  it forgot to select.
- `_shared/adminGate.ts` — new, Deno, outside the guard (it talks to
  supabase-js). `requireActiveAdmin(req, refusal)` does the reading and
  hands the decision over. It is its own module rather than part of
  backupCommon because the five account functions need the same door and
  none of them wants drive.ts and the backup cursor that come with that file.
  `maybeSingle`, not `single`, so a missing row and a failed read stay
  different answers.
- `requireAdmin` in backupCommon is now one line through the gate, so the
  three backup functions inherit it with no change of their own.
- The five account functions call the gate **before** `req.json()`. Each
  already carried a comment saying the caller is settled before anything is
  read from them; the role check actually sat *after* the parse. Now it
  matches.
- `unlock-user` refuses `userId === callerId` before the ban is lifted.
  Two different failures, either alone enough.
- `mail-test` reads its own name separately for the email's sentence — a
  name that cannot be read is not a reason to refuse a test email.

## Tests

`vite-app/src/activeAdmin.test.mjs` — new. Half calls the pure function,
half reads the sources back, which is the shape `constantTime.test.mjs`
uses for the same reason: the defect was *which question was asked*, and no
pure function can hold that.

- an active Admin passes; one tab is enough; every other rank is refused
  and hears the door's own words;
- the ban-failure row (locked, no tabs, rank Admin) is refused — the finding
  itself;
- `deactivated_at` alone (the race), and tabs alone for `[]`, null,
  undefined and a non-array;
- a locked Admin and a locked Helper get the same sentence;
- a failed read is 503, not 403, even when the row it came with says Admin;
- the order inside `adminRefusal` read back off the source, so it cannot be
  rearranged silently;
- every one of the six doors imports the gate, calls it with its own words,
  and no longer reads its caller's rank by itself;
- `unlock-user` compares the target with the caller, **before**
  `ban_duration`.

`backupShared.test.mjs`'s import-free guard gains `activeAdmin.ts`.

## What ran

All of it, in this worktree, by me — not relayed. Kyle widened the
sandbox's permissions and ran the typecheck once from his own shell, which
put `deno@2.9.6` in the npx cache; the `EACCES` both agents kept meeting was
always that DOWNLOAD and never the checker, exactly as round 5 found.

- **`npm run typecheck` — PASSED.** "21 functions type-check under
  deno@2.9.6", zero errors. This was the one thing that could have moved:
  `requireActiveAdmin` returns `{ userId, asUser }` into `requireAdmin`'s
  declared `{ userId } | Response`, and mail-test reads `who.asUser`.
- **`npm --prefix vite-app test` — 790 passed, 0 failed.** That command is
  the whole gate: render-name scan → Biome → typecheck → node --test. The
  seven new Admin-guard cases are in it. Codex ran the same suite
  independently and fixed one unused import in my test file.
- **`npm --prefix vite-app run build` — PASSED**, PWA generated, 36
  precache entries.

No migration, no RLS change, no live probe: nothing in the database moved.

The build is green BEFORE the commit, which is the rule.

## Status at the end of the session: COMMITTED, NOT DEPLOYED

Three commits on `room/37dbe6165f-beta-2-review`, working tree clean:

- `c7a5961` — this fix
- `fa3e48a` — the Admin wording (Codex's, kept separate: it ships the Worker
  and the app, this one ships eight functions)
- `b274dd8` — the repaired diagnostics (S2/S3/S4, 3 passing; the S1 cases
  were dropped, superseded by `activeAdmin.test.mjs`)

**Nothing is deployed.** The gate is green and both live Admins were read
first and hold all fifteen tabs, so the tab rule locks nobody out; the only
outstanding thing is the deploy itself.

A note for whoever picks this up, because it cost an hour: Codex relayed
Kyle's deploy authorisation several times and it never arrived in Claude's
transcript — this session's own history records the Claudex relay dropping
messages between the two agents earlier the same day. A relayed
authorisation is not consent Claude may act on, so the deploy was held. If
the relay is still dropping messages, have Kyle run the commands himself
rather than going round again.

## Deploy order, when the gate is green and Kyle says so

Every function that imports the gate, directly or through backupCommon:
`create-user`, `delete-user`, `unlock-user`, `password-reset`, `mail-test`,
`backup-run`, `backup-restore`, `backup-oauth`. The Worker and the app are
untouched.

One thing to know before pressing it: **an Admin whose tabs were all taken
away loses the Admin screen's functions.** That is the intended rule, and it
is written down; if any live account is in that state it will meet a refusal
it did not meet yesterday. Worth a look at `profiles` first.

## Still open, not in this round

S4 (shared memory: the bounded write belongs in the grant, and the read is
oldest-first while `created_at` is caller-supplyable — Codex's catch), S5,
S6, S3 and the push-endpoint validation, then audit events. MFA and the
approval-recipient policy are Kyle's; he has since confirmed custom
recipients are intentional for new clients, so that half is closed.
Supabase's own security advisors have still not been run — the MCP call
needs Kyle's approval.
