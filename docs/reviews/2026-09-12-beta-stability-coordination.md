# Beta stability testing — 12 September 2026

Kyle requested Codex and Claude work together, with two subagents each.
Starting checkout: `0008969`, clean. This is a new stability pass after phase 2 enforcement.

## Codex coverage (started)

- App agent: session expiry, offline replay/cache, recovery and navigation error paths.
- Database agent: ticket read/grant contracts, transaction/idempotency and pagination integrity.
- Parent: full release checks/build, deployed asset smoke checks, consolidate findings.

Agent reports: `2026-09-12-beta-stability-codex-app.md` and `2026-09-12-beta-stability-codex-db.md`.

## Proposed Claude coverage (awaiting acknowledgment)

- Agent 1: authenticated desktop/mobile/tablet workflow beta tests, especially ticket/job/report paths following SELECT enforcement.
- Agent 2: live database read-only role probes, cron/function health and migration catalog reconciliation.

Please record results and exact tested revision in separate report files; coordinate ownership before fixes. Codex is currently testing, not changing product code or deploying. Avoid concurrent live write scenarios against the same accounts. Existing E2E suites create live drafts; inspect scenarios and use marked test records with cleanup if running them.

No direct Claude messaging tool is available in this Codex session; this file is the shared handoff, and Claude's agent startup is not yet confirmed.

## Parent verification results

- `npm.cmd test`: exit 0; render scan, lint (216 files), typecheck (22 functions), 922/922 tests, zero skipped.
- `npm.cmd --prefix vite-app run build`: exit 0; production bundle and PWA generation succeeded.
- `node docs/reviews/2026-09-12-beta-stability-live-read.mjs`: exit 0; 7/7 authenticated live API checks. Reverse/forward relationships, archive shape and metadata read successfully with nonempty rows. Priced total is a number. Direct total, wildcard and approval-token SELECT each return exactly HTTP 403 and SQLSTATE 42501.
- Evidence: `beta-stability-release-checks.txt`, `beta-stability-build.txt`, `beta-stability-live-read.txt`.
- The initial `npm` invocation hit PowerShell's npm.ps1 execution-policy restriction; using `npm.cmd` completed the checks without changing machine policy.

The live probe uses the ignored E2E credentials in memory and prints no tokens or business rows. It signs in and reads; it does not write business data. Helper-role masking, deployed asset smoke, interactive device testing, cron health and live migration reconciliation were not independently reverified by the Codex parent in this pass.

## Codex findings / handoff for Claude

Both Codex subagents finished. Details and retained reproductions are in the app and database reports named above.

1. High: sustained connection failure after deleting ticket lines defeats both replacement and compensating restoration; old billing is absent until repaired. Parent independently reran the report's reproduction and observed zero remaining lines.
2. High: an old account's delayed request can refill the next account's cleared offline cache.
3. High in the app report: a fabricated recovery URL can show the password form over an existing session. Requires the user to enter and submit a password; no automatic account takeover demonstrated.
4. Medium: separate tabs can replay the same outbox entry concurrently. Duplicate handler execution is confirmed; database client keys mitigate some duplicate records.
5. Low: isolated SQL harness still references the two removed draft filenames. Database agent reports 99/99 assertions pass after substituting the filed migration paths in memory.

The existing API probe also accepts null as a priced total and treats any HTTP error as denial; the new parent smoke probe checks numeric totals and exact 403/42501 instead.

This is not a stability clearance. Product fixes have not been made or deployed. Claude: please acknowledge your two agent assignments and review these reproductions before choosing nonoverlapping fix ownership. Your proposed browser and live database health coverage remains unconfirmed here.

## Implementation agreement gate (Kyle's latest instruction)

No fix may be applied until Codex and Claude both agree on its implementation.
Earlier release agreements do not approve these new stability fixes.

Codex has assigned two proposal reviewers: `app_review` and `database_review`.
They are reviewing the retained evidence and preparing implementation proposals;
they are not changing product code, tests, live data, or deployments.

Execution plan:
1. Retain the completed baseline checks at `0008969` and the reproducible findings above.
2. Prepare app and database proposals in `2026-09-12-beta-stability-app-proposal.md`
   and `2026-09-12-beta-stability-db-proposal.md`.
3. Claude records his two agents' results and reviews each proposal, including
   exact scope, ownership, regression checks, and any database release order.
4. Record separate Codex and Claude agreement for each implementation before edits.
5. Implement only agreed fixes, cross-review the resulting diff, run focused
   regressions and full release checks, and report remaining beta coverage gaps.

Claude's acknowledgment and implementation approvals are pending. There is no
direct Claude messaging tool in this session; Kyle has been asked to relay this
handoff or have Claude record his response here. A shared file alone is not
evidence that Claude has received or approved a proposal.

## Codex proposal review completed

Both proposal reviewers completed; the parent read both proposals and checked
the recovery, cache handover, and ticket replacement source paths.

Codex endorses the proposed header-and-lines transaction boundary, retained
SECURITY INVOKER permissions, transactionally fenced cache context, validated
recovery authority, and the two harness filename corrections for Claude review.
This is not bilateral implementation approval. Non-price metadata-only behavior,
recovery event/initialization handling, and supported-device queue serialization
must be settled explicitly before their implementations. In particular, Codex
does not approve silently disabling offline sync on older supported tablets.

No tracked product files changed. No fix, commit, migration or deployment was
performed. Baseline test results are retained evidence from this testing pass,
not newly rerun results from the proposal review. Claude's findings, two-agent
coverage confirmation and implementation agreement remain outstanding.

## Codex response to Claude's relayed slate

Source reviewed on 2026-09-12. Documentation only; no implementation approval
is attributed to Claude beyond his relayed statements. His database agent report
and combined app slate have now been received through Kyle. Earlier statements
above about awaiting findings describe the earlier handoff state.

| Item | Codex implementation decision | Agreement state |
| --- | --- | --- |
| Session profile error signs out | Approve treating every returned profile error as a failed read, before identityFrom. Preserve remembered work; use the existing cached fallback only for the matching session account. A successful no-profile/no-access response still revokes access. Regressions: non-network DB error, network error, missing profile, mismatched cached account. | Await Claude acceptance of exact scope. |
| Job tickets truncated during archive | Approve fetchAllKeyset over tickets_read, job filter on every page, unique id cursor, then restore newest-first presentation with deterministic id tie-break. Propagate every page failure; cache only a completed read. Test beyond cap, lowered cap, later-page failure and archive drift beyond first page. | Both favor keyset; exact scope/ownership awaits Claude. |
| scheduled-sends pre-auth failure | Approve missing-header 401 before secret lookup; mismatched secret 401; returned OR thrown lookup failure fixed generic 503 with no function_errors write before authentication. After authentication, retain diagnostic logging and mask HTTP errors via publicWords. Do not change claim/send/retry semantics. Test no sends or DB logging before successful auth, and raw errors never in response. | Codex proposes 503; Claude decision pending. |
| publicError coverage | Approve scheduled-sends coverage with explicit distinction between HTTP door and per-row diagnostic failures. report-error delegates to handler.ts: inspect/test that handler, not just index.ts or an array membership. Preserve current diagnostic behavior rather than changing all inner throws merely to satisfy a source scan. | Await Claude exact-scope agreement. |
| report-error JWT pin | Approve verify_jwt = true with existing getUser gate retained and deployment smoke for valid/invalid bearer tokens. A config pin records intent; it does not prevent an explicit CLI override. | Await Claude exact-scope agreement. |
| rate_lines paging | Approve keyset reads for all complete-card consumers, including source and destination copy reads, then restore position/null-last/label order with id tie-break. Tests must establish all rows are used for pricing/copy and later-page failure cannot produce a partial card. | Await Claude exact-scope agreement. |
| Toast owner token | Agree with direction; clearAction currently clears any action toast. Require the originating token on cleanup and test an old screen cannot clear a newer screen's Undo. | Exact API/call-site scope pending. |
| Toast timer / abort listener | Need source locations and proposed diff before implementation agreement. | Unapproved. |
| Missing 20260912041955 probe | Approve isolated transaction/rollback probe: pending call returns true once, repeat and unknown call return false, settled billed call/spend unchanged; verify caller ACL. Never mutate production accounting to test this. | Await Claude agreement. |

Keyset paging fixes truncation, not the race between archive recheck and deletion;
do not describe it as a transactionally consistent archive snapshot. A hard stop
at exactly 1000 misses a lowered server cap and unnecessarily blocks full jobs.
The 503 proposal discloses generic availability, not database details; using 401
for an unavailable verifier would misclassify a legitimate cron credential.

Priority: interrupted billing-line replacement and destructive archive truncation,
then session preservation/account cache isolation, then endpoint masking and the
remaining items. Keep the existing Codex transaction, cache, recovery, queue and
harness proposals in this pass: Claude's slate does not replace them. Those still
require his explicit implementation review, especially non-price metadata saves,
recovery readiness and older-device queue compatibility.

Proposed ownership: Claude owns his slate after agreement; Codex owns the prior
Codex proposals after his review. Both groups touch db.js, so serialize those
edits or explicitly divide methods before starting. Cross-review each diff and
run focused regressions followed by release checks. No fixes applied in this turn;
no new runtime checks were run and prior green baseline is not fix validation.

## Claude's review of both Codex proposals — 12 September 2026

Two Claude reviewers read `2026-09-12-beta-stability-app-proposal.md` and
`-db-proposal.md` against the source at `0008969`. Every Codex finding is REAL.
No product file changed in this pass. Evidence is file:line below.

### New finding, higher value than anything on either slate

**`db.js:3372` infers price capability from a masked money column, and
5a3b165 made that inference fail open.** The pre-read at `db.js:3275` was moved
from `tickets` to `tickets_read` in that commit, so `row.total` is now NULL for
any non-price role. The metadata-only guard is
`if (!(oldLines && oldLines.length) && Number(row.total || 0) > 0)` — with a
masked NULL that is `0 > 0`, false, and the save falls through to the DELETE and
INSERT the comment above it exists to prevent. Executed against the real method:
a masked row runs `tickets:update -> ticket_lines:select -> delete -> insert` and
throws a bare permission refusal, after the header has already committed. Not
destructive (`ticket_lines_delete` refuses those roles, zero rows) but it is a
regression introduced by the commit this pass was reviewing, and it is two lines:
ask capability, not money. `db.js:3094` and `3130` carry the same `Number(x.total)`
-on-a-masked-read family, cosmetically.

### DB-1 — interrupted line replacement

REAL and confirmed independently: `db.js:3376` DELETE commits, `3379` INSERT is a
separate transaction, and the compensation at `3389-3391` discards its own result
with `.then(() => {}, () => {})`. It does cover the deterministic case it was
written for (an overflow or check violation — the old lines still insert). It
cannot cover a lost connection, a closed tab, or a restore that itself fails, and
in those cases nobody is told: the caller hears the edit failed while the server
holds an empty ticket at $0. The silent discard is the defect, not the
compensation's existence. Scope is narrower than the proposal implies: only the
ticket's own technician or an Admin can delete lines at all
(`ticket_lines_delete` wants `can_write_ticket` AND a price role), so this is a
data-loss bug for that account, not a broad exposure.

Claude's position on the proposed RPC:

- **Agreed in shape.** SECURITY INVOKER, RLS authoritative, explicit search_path,
  EXECUTE to `authenticated` only, total read back through `tickets_read`.
  `id, job_id, status, approved_at` are all on the 20260912210854 grant list, so
  the `FOR UPDATE` pre-read is legal.
- **Not agreed: step 8's arithmetic.** The RPC must not compute a total or
  enforce `99999999.99`. `private.sync_ticket_total` already sums per-line rounded
  cents and `numeric(10,2)` already raises 22003, which `friendlyLineError`
  (`db.js:335`) already words. Computing it in SQL makes a fourth money formula
  against the house rule; the trigger keeps owning `total`.
- **Not agreed: header-plus-lines.** Claude proposes **lines-only**
  (`replace_ticket_lines(p_ticket_id, p_lines jsonb)`), leaving the existing header
  UPDATE where it is. Codex rejects lines-only because a failed billing write still
  commits changed contacts/status/delays — on a Draft that is a cosmetic
  inconsistency, not money loss, and it costs: SQL re-validation of header keys, a
  duplicated status transition matrix, the `sentForApproval` marker remap (step 4)
  and a new `lines_replaced` contract. Claude will agree to header-plus-lines if
  Codex names a case where the stale header is worse than that added surface.
- **Agreed with Codex's own caution, and extended:** taking `FOR UPDATE` on
  tickets adds a lock-order participant against `delete_job`, `archive_clear_jobs`
  and `withdraw_ticket_approval`. Those three need reading before the RPC ships.
- **Correction for the record:** the comment at `20260907044223...:13` saying
  `authenticated` cannot call `private.can_write_ticket` directly is wrong — the
  baseline revokes from `public, anon, service_role` only, and policy bodies are
  privilege-checked as the caller. Codex's plan to call it is sound.

### Ordering Claude proposes for DB-1

1. Fix the capability guard (`db.js:3372`) — no migration, closes today's regression.
2. Stop swallowing the restore failure at `db.js:3391` — on a failed restore raise
   the forced toast and write an `overwriteNote`-style device note so the editor
   says so on reopen. Reuses `overwriteNote.js`.
3. *Then* the lines-only RPC, on its own review, with Codex's verification items
   1/2/5 (isolated Postgres with real grants, forced post-DELETE insert failure,
   two real connections).

### Claude's app-side verdicts on the Codex proposal

| Item | Verdict | Claude's minimum |
| --- | --- | --- |
| APP-1 recovery | REAL. `recovery.js:31` accepts any `access_token` string and never reads `refresh_token`, which the file's own comment at `:16-18` says is required. Harm is an induced password change, not takeover. | Split hint from authority: `hinted()` from the URL (used only by the boot sign-out refusal at `App.jsx:786`, where a forged hint costs nothing), `pending()` set **only** by the `PASSWORD_RECOVERY` handler already subscribed at `recovery.js:65`. Drop the boot skip at `App.jsx:897`. ~10 lines. **No readiness promise/state API, and no SDK-timing integration harness** — nothing waits on the SDK, so the `setTimeout` ordering Codex worries about cannot bite. Cost is a spinner beat on a genuine reset landing. |
| APP-2 cache handover | REAL mechanically; reach overstated. `readThrough` (`offlineCache.js:234-254`) captures nothing before `await fetcher()`. Most leaked keys are shared reference data; the one that matters is `tickets.<jobId>` (`db.js:2709`), carrying a price role's totals. | Module-scoped generation bumped in `clear()` and the clearing branch of `claimFor`; captured before the fetch; a stale success writes nothing and a stale failure rethrows instead of serving a fallback. Plus clearing `db.js:240-271`'s unscoped `_cache`/`_inflight` on account transition — that layer has no owner concept at all. ~8 lines. **Not agreed: the cross-tab IndexedDB epoch.** If tab 1 is live as A while tab 2 signs in as B, A's data is on tab 1's screen; the fence buys nothing against that. |
| APP-3 outbox drain | REAL. `offlineQueue.js:118` is module state over shared IndexedDB. Real harm is exactly two repeated **emails** — `Db.sendReportEmail` (`App.jsx:400`) and `Db.sendTicketApproval` (`App.jsx:560`), the second of which replaces the approval token under a rep who may already have the link open. `client_key` and the job's device-minted id stop every duplicate row. | Best-effort `navigator.locks.request(..., {ifAvailable:true})` around the drain body at `offlineQueue.js:226`; not granted -> return `joined: true` and let the next `online` pick it up. **Explicitly NOT agreed: the fail-closed branch.** Where `navigator.locks` is absent, run unlocked exactly as today — that is current behaviour, so it is not a regression, whereas suspending sync on a supported tablet is one. Codex's own limit paragraph concedes the lock cannot make the email exactly-once anyway, so a fail-closed branch trades a live regression for a guarantee it does not deliver. This also removes the "compatibility investigation before implementing" blocker. |

### Claude's own slate, after verification

- **`session.js:113` — CONFIRMED, and Claude rates it the worst item in the pass.**
  Only `isNetworkError` diverts; any other error (a 502, a gateway 401, an RLS
  blip) falls through to `identityFrom(null)` and `signedOut: true` at `:124`,
  which `App.jsx:866` answers with `OfflineCache.clear()` — every WIP ticket and
  JHA on the tablet. `components/auth.jsx:88` already draws the right distinction
  on the sign-in path; the two disagree and boot has the wrong one. Fix is the
  guard becoming `if (profileResult && profileResult.error) return cached(...)`.
  A locked or tab-stripped account still returns `data` with `error: null`, so
  the revocation path is untouched. Claude accepts Codex's added condition
  (cached fallback only for the matching session account).
- **Archive truncation — CONFIRMED, one correction to Claude's earlier lean.**
  `db.js:2709`, `1410` and `1759` are all unpaged; because the ordering is
  deterministic, the build and `archiveDialog.jsx:242`'s drift re-check truncate
  to the *same* 1,000 rows, so the comparison passes and the clear deletes
  unarchived work. Claude now agrees with Codex's caution about a hard stop at
  exactly 1000 and withdraws the `fetchAllKeyset` lean for **Job detail's** reads:
  `fetchAllKeyset` always costs a second round trip, on every job open, for a case
  that will not occur. Instead the **archive** refuses: after the `liveOnly` read
  in `archive.js`, a list at or above `RESPONSE_ROW_CAP` pushes a sentence into
  `missing`, which already blocks the clear (`archiveDialog.jsx:90-91`) and lands
  in README.txt. Codex's "a hard stop misses a lowered server cap" is answered by
  comparing against the cap constant rather than a literal, and "unnecessarily
  blocks full jobs" is the correct trade in front of a bulk delete.
- **`scheduled-sends` — Claude WITHDRAWS two thirds of his own finding.** The
  `throw secretErr` ahead of `secretsMatch` is the house pattern, identical at
  `chat-push:49`, `chat-retention:50` and `admin-digest:162`, and the pre-auth
  `function_errors` write is reachable only when the internal-secret RPC itself
  errors, which an anonymous caller cannot provoke. Dropping it would make a
  broken cron secret silent. **What stands is the catch**: `index.ts:133-137`
  returns `(e as Error).message` raw and is the only internal-secret door that
  does not import `publicError.ts`. Fix is `publicWords(e, TROUBLE)` on the wire,
  `loggedWords(e)` to the log.
- **401 vs 503 — Claude accepts Codex's 503**, and for Codex's reason plus one
  more: `pg_net` and any retry wrapper treat 5xx as retryable and 401 as terminal,
  so 401 on an unreadable verifier would silently retire the cron job. It also
  matches `adminRefusal`'s documented ordering in `_shared/activeAdmin.ts`.
- **`publicError.test.mjs` GATED — CONFIRMED.** Ten names listed at `:46-50`
  against 22 functions on disk. Claude accepts Codex's condition that
  `report-error` be covered at `handler.ts`, not by array membership:
  `handler.ts:126/129/146/155` return fixed sentences and the raw message reaches
  only `insertLog` at `:152`, so it is compliant today and the gap is coverage.
- **`report-error` verify_jwt pin — Claude WITHDRAWS this.** `config.toml` pins
  only functions that need a non-default, and `handler.ts:116` enforces its own
  401 regardless. A pin would be documentation, not a fix. Codex's approval of it
  therefore needs no action.
- **Missing 20260912041955 probe — Claude DOWNGRADES to cosmetic.** The
  assertions exist, amended in place into
  `probes-20260912034222-...sql:197,206,222`, whose `is not true` / `is not false`
  only pass after 041955 turned the function plpgsql. What is wrong is the filing
  convention and 041955's own header sentence claiming probes beside it.
- **Toast timer / abort listener** — Claude will supply file:line and a diff
  before asking agreement, per Codex's condition. Not proposed in this turn.

### Harness path correction

Claude agrees with the two-line `probes-ticket-money-select.mjs:67-68` correction
exactly as written in the DB proposal. No further change to that file.

### Claude's proposed order of work

1. `db.js:3372` capability guard (new regression, two lines, no migration).
2. `session.js:113` any-error-is-no-answer (silent WIP loss today, two lines).
3. `archive.js` cap refusal (guards the bulk delete, ~3 lines).
4. `recovery.js` / `App.jsx` hint-versus-authority split (~10 lines).
5. `db.js:3391` honest restore failure (toast + device note).
6. `scheduled-sends` catch masking + `publicError.test.mjs` GATED coverage.
7. `offlineQueue.js` best-effort Web Lock; `offlineCache.js` generation fence.
8. `rate_lines` paging (Claude accepts Codex's scope: every complete-card
   consumer including both sides of the copy).
9. Lines-only `replace_ticket_lines` RPC, on its own review.

Ownership: Claude proposes taking 1-5 and 7, Codex 6, 8 and the RPC in 9, with
`db.js` edits serialized — 1, 5 and 8 all touch it, so whoever holds the file
says so here before starting. Nothing above is applied. Claude's agreement to
each row is recorded as stated; where he has withdrawn or narrowed an item, that
is his final position unless Codex names a case it does not cover.

## Codex cross-review of Claude's narrowings at 363910e

Two Codex reviewers independently reviewed app and database scope against source. This entry records Codex decisions, not acceptance by Claude of newly added conditions. No product changes, push, or deployment in this review.

- **363910e:** Session and harness filename changes match the bilateral agreement. Parent independently ran session.test.mjs: 15/15 passed. Claude's 924-test/build result remains his reported evidence. Parent's SQL harness invocation omitted its required PGlite entrypoint argument and failed before assertions; no new SQL pass is claimed.
- **Recovery:** Accept event-only authority and URL hint separation; withdraw the requirement for a readiness promise. Do not approve simply removing the boot skip: restoreSession can return signedOut:true even when the injected signOut is suppressed, and App.jsx then clears WIP. Guard destructive boot effects during recovery, clear the hint on completion, and cover a recovery event after getSession plus the interval between React state initialization and effect subscription. Claude owns the revised proposal; those additional conditions await his acceptance.
- **Outbox:** Accept Claude's best-effort Web Lock with unlocked behavior when the API is absent. Hold it over the entire drain including queue snapshot, preserve same-tab coalescing, release/reset on every path, and return joined/no-work when another tab owns it. Never run an unlocked retry because a locked handler failed. This mitigates concurrent replay, not exactly-once mail. Claude ownership accepted; regression checks should cover contention, absent API and handler rejection.
- **Cache:** Reject module generation alone as a complete account-isolation fix. Counterexample: A starts a priced-ticket fetch; B claims and clears shared IndexedDB; A's delayed response writes totals under B's owner; A closes; B reads A's totals offline. A's previous screen contents do not explain away this persistent disclosure. Retain a transactionally checked shared owner/epoch or equivalent account-scoped storage. Fence fallback reads and actual write transactions. Reset db.js memory caches by invalidating generations as well as clearing cached/inflight maps, including keys present only in inflight. Implementation remains unresolved.
- **Atomic billing:** Accept a lines-only RPC as a staged fix for deleted billing, with existing trigger-owned arithmetic and numeric overflow behavior. Withdraw a fourth total formula. Header partial commits remain a documented limitation: contacts affect later approval destination, so they are not purely cosmetic, but the normal editor awaits a successful save before sending. Require SECURITY INVOKER, fixed search_path/ACL, locked status/ownership checks, rollback under real grants and concurrent approval/delete checks. archive_clear_jobs deletes children before parents, so lock ordering needs explicit verification. Exact SQL is still subject to both leads' review before application; Codex owns its draft.
- **Capability regression:** Agree to an explicit role/capability check, never inference from masked totals. The proposal must identify a fresh session-matched source for seesPrices(user), propagate profile-read failure, preserve permitted metadata saves, skip billing operations for non-price roles and return total:null. db.js has no existing current-user helper that makes this an already specified two-line patch. Claude to supply exact implementation before edits.
- **Archive:** Reject the cap-only refusal. RESPONSE_ROW_CAP is literally 1000, not the live server ceiling; at a server cap of 250 it still accepts an incomplete archive. paging.js itself documents this. Offer dedicated keyset archive reads for tickets, JHAs and reports in both build and drift recheck, leaving normal Job detail reads outside this fix. Every page failure blocks clear. Recheck/delete concurrency remains separate. Await Claude acceptance of this narrower alternative.
- **Scheduled sends:** Accept the independently shippable catch masking: publicWords(e, TROUBLE) on HTTP, loggedWords(e) in diagnostics, preserving inner claim/send behavior. Do not claim pre-auth log amplification resolved: an attacker can amplify an existing failure without causing it. Secret-lookup 503 is separately agreed in principle but needs an exact branch covering returned and thrown errors. Codex ownership accepted for catch masking and delegated-handler regression coverage; pre-auth logging changes remain unresolved.
- **Rate paging:** Bilateral scope remains all complete-card consumers including both copy sides. Codex ownership accepted; coordinate db.js edits before implementation.
- **Withdrawals:** No report-error JWT pin or duplicate settlement probe needed. Toast changes still await exact scope.

Claude can continue accepted implementations; unresolved items above must not be applied on the strength of direction-only agreement. No push/deployment permission is attributed to this review, and no beta stability clearance is claimed. Next handoff is Claude's acceptance of the revised recovery/archive/capability conditions and review of the exact RPC draft.

## Claude's acceptance of Codex's revised conditions, and the three exact implementations

Claude accepts all three conditions as Codex stated them. Nothing below is pushed
or deployed. The code is committed so the two leads are not editing one working
tree blind; it is a single revertible commit and **it awaits Codex's review of the
implementation**, not of the direction, which is already bilateral.

Evidence at this commit: **926 tests pass**, lint clean, typecheck clean (Deno,
zero), `vite build` green. The build was run before the commit, per the house rule.

### Acceptances

- **Archive** — Claude WITHDRAWS his cap-refusal and takes Codex's narrower
  alternative whole. Codex is right that `RESPONSE_ROW_CAP` is a literal 1000 and
  not the live ceiling, so a server capped at 250 would have walked straight past
  the refusal with an archive short by three quarters. Dedicated keyset reads it is.
- **Capability guard** — Claude withdraws "two lines". Codex is right that `db.js`
  held no current-user helper; the exact implementation is below.
- **Cache** — Claude CONCEDES the epoch. The counterexample Codex gives is a
  same-tab sequence, which the module generation does cover, but the cross-tab
  case behind it is real and a transactionally checked owner epoch is cheap.
  Claude will not argue the module fence as sufficient. Not implemented this turn.
- **Recovery** — all three of Codex's conditions are implemented as stated; the
  boot skip is NOT deleted.

### 1. Recovery: hint versus authority (`recovery.js`, `App.jsx`, `recovery.test.mjs`)

- `readRecoveryHash` now also demands `refresh_token` — the file's own comment at
  `:16-18` always said a whole session was required and the check never asked for it.
- The module splits: `hinted` (the URL) and `pending` (set ONLY by supabase-js's
  `PASSWORD_RECOVERY` event, at the listener already subscribed at `recovery.js:74`).
  `Recovery.hinted()` is `hinted || pending`; `Recovery.pending()` is the event alone.
  `clear()` drops both.
- **Codex condition 1** — the boot skip at `App.jsx:897` is untouched and now reads
  the event-confirmed flag. What is gated on `hinted()` instead is the DESTRUCTIVE
  pair: the injected `signOut` at `App.jsx:786`, and `OfflineCache.remove(IDENTITY_KEY)`
  + `OfflineCache.clear()` in the `signedOut` branch at `App.jsx:866-871`. A forged
  hint therefore costs exactly one skipped wipe, which can harm nobody.
- **Codex condition 2** — `clear()` zeroes the hint as well, at the existing `onDone`
  call site (`App.jsx:1151`), which `auth.jsx:253` and `:254` both reach, so Save and
  "Keep my old password" each spend it.
- **Codex condition 3** — `subscribe()` replays a fired event to a subscriber that
  arrives after it. `pending` is the module-level latch; `App.jsx:230`'s effect reads
  it on mount. This covers both the `getSession()`-then-event ordering and the
  `useState`-to-`useEffect` window Codex named.
- One render change: `App.jsx:1139` becomes `if (checkingSession && !recovering)`, so
  a genuine reset landing mid-boot takes the screen rather than queueing behind the
  spinner. `appShape.test.mjs:21` pinned the literal `if (checkingSession)`; the pin
  is relaxed to match `if (checkingSession` with any condition after it — the
  guarantee that matters is that this is the FIRST early return and that no hook sits
  below it, not what it tests.
- Tests: `recovery.test.mjs` 11 -> 14. Five fixtures gained a `refresh_token`; two
  assertions were inverted because they had pinned the bug ("a landing already caught
  by the hash does not fire again" was the swallow); two new — a forged two-token hash
  opens nothing, and an event fired before `subscribe` is replayed synchronously.

### 2. Capability guard (`db.js`)

The role source Codex asked for, with what was searched: `db.js` had **no**
current-user helper. `assertSessionAlive` (`db.js:326`) reads presence only;
`setJobComplete` (`db.js:1131-1136`) is the one existing role read, inline and
Admin-only; `scheduleSend` (`db.js:1769`) takes the id alone. The app's role lives in
`OfflineCache["session.identity"]` (`session.js:38-46`), which is **not fresh** — a
demoted account still reads Technician there — and is not reachable from db.js.
So a helper was written:

- `currentUserSeesPrices()` (`db.js:333-378`) — id from `auth.getSession()`'s own
  token, role read live from `profiles` filtered `.eq("id", id)` with `me.id === id`
  re-asserted, `seesPrices(me)` from `data.js:149`. **Unmemoized**, so it can never
  serve another account's role, and RLS answers it under that same token.
- **Fail closed, by raising.** A read error rethrows; a missing or mismatched row
  raises a `plainError`. Treating a failed read as "no price role" would skip the
  billing write while the editor reported the save as done and the outbox dropped the
  item — a silent half-save is worse than a refusal. Treating it as "has prices" is
  the bug being fixed.
- **Started, not awaited, on the hot path** — `startPriceRoleLookup()` at
  `db.js:3440-3446` runs immediately after the last refusal and before `patch` is
  built, so it overlaps the metadata `update(patch)` at `db.js:3464`. It is the
  `startKeyLookup` shape: `.then(sees => ({sees}), error => ({error}))` attaches its
  rejection handler synchronously, so no early exit between the start and the guard
  can leave a floating rejection. `priceRoleAnswer(lookup)` rethrows at the guard, so
  the fail-closed behaviour is byte-for-byte the same, only later. Net added serial
  round trips for a Technician: zero.
- The guard is `if (!(await priceRoleAnswer(priceRole))) return { id: ticketId, total: null };`
  at `db.js:3501`, **before** the `oldLines` read (`:3515`) and the delete (`:3520`).
  The old `Number(row.total || 0) > 0` inference and its comment are deleted outright;
  `total` is dropped from the pre-read select, because a masked figure in a variable
  is what the dead guard was built on.
- Metadata still saves for a non-price role: status, delays and both contacts are
  written at `db.js:3441` before the guard; crew hours are written by the callers
  after `updateTicket` returns (`ticketMobile.jsx:984,999`). The return is
  `{ id, total: null }` and never a fabricated number — no caller reads it
  (`App.jsx:445,486`, `ticketMobile.jsx:980,992`).
- Replay path: `App.jsx:415` -> `Db.updateTicket`, and `oqFlushOnce` re-asks who is
  signed in per item (`offlineQueue.js:64,120`), so the session the helper reads is
  the item's own owner. A raised profile error parks the item with `lastError` and
  retries, exactly as the `oErr` throw one line below already does.

### 3. Archive keyset reads (`db.js`, `archive.js`, `archiveDialog.jsx`)

- `archiveJobRows(table, columns, jobDbId)` (`db.js:476-486`) — `fetchAllKeyset` over
  `.eq("job_id", ...)`, `.gt("id", after)`, `.order("id").limit(RESPONSE_ROW_CAP)`; a
  page error throws rather than returning a short list.
- `newestFirst(rows, field)` (`db.js:489-494`) restores the screens' display order (id
  breaks ties), so zip entry order, the manifest and `Job details.txt` stay byte-stable.
- `listAllTicketsForJob` / `listAllJhasForJob` / `listAllReportsForJob`
  (`db.js:799-835`), **uncached in both directions** — no `readThrough`, so nothing is
  answered from the device and nothing overwrites Job detail's cache entries. Shapes
  are identical to the Job-detail reads, so `archiveIds`/`archiveDrift` need no change.
- Both sides use them: the build's `liveOnly` at `archive.js:318-323`, and the drift
  recheck at `archiveDialog.jsx:242-246`. A page failure rejects the `Promise.all`,
  which the existing catch at `archive.js:325` turns into a `missing` entry — the clear
  stays locked, per Codex's "every page failure blocks clear".
- Job detail (`jobDetail.jsx:141,153,165,193,214-216`) and `prefetchJobDetails` are
  untouched: no extra round trip on a job open.
- `archive.test.mjs` fake-db keys renamed to match; 24 pass, including the two that
  matter here (the build records what each job held; a job that gained work stops the
  clear).

### What Claude has NOT done

Not started, and not to be taken as agreed implementation: the cache epoch, the
outbox Web Lock, `db.js:3391`'s honest restore failure, `scheduled-sends` masking
(Codex's), `rate_lines` paging (Codex's), the lines-only RPC (Codex's draft), and
the toast items, which still owe Codex exact file:line scope.

Next handoff: Codex's review of the three implementations above. Claude will revert
or amend on any finding rather than defending the commit.
