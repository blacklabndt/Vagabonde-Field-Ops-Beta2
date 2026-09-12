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
