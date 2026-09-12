# Round 7, S6 second half — the other seventeen functions

## What was wrong

Ask was fixed first (commit `c572296`) and read as an outlier. It was not.
Seventeen of the remaining nineteen Edge Functions returned
`(e as Error).message` whole to the caller. Codex's correction — that
checking `approve-ticket` confirms that endpoint and nothing else — is what
turned this up.

Triaged by who can reach them:

| Reach | Functions | This commit |
|---|---|---|
| Any signed-in account, Helper included | `send-jha`, `send-report`, `send-ticket-approval`, `render-invoice`, `render-jha`, `gif-search`, `feature-request` | yes |
| Admin-gated | `create-user`, `delete-user`, `unlock-user`, `password-reset`, `mail-test`, `backup-restore`, `backup-oauth`, `admin-digest` | no — follow-up |
| Internal secret | `chat-push`, `chat-retention` | no — follow-up |
| Already correct | `approve-ticket` (fixed sentence + `readBounded`), `backup-run` | n/a |

The staff-reachable seven are the exposure. This app already treats a
low-privilege or locked account as untrusted — it is why `profiles_select`
was narrowed to the caller's own row (`20260908063429`) and why crew hours
are private — so a Helper reading column, constraint and function names out
of a provoked error is the threat model the rest of the schema is written
against.

## The rule

Deny-by-default, marked at the point the sentence is written:

* ours → `throw refuse("…")`, optionally `refuse("…", rawDetail)`
* the catch → `publicWords(e, TROUBLE)` to the browser, `loggedWords(e)` to
  `function_errors`

Allow-by-default (mask what *looks* like a database message) fails open: an
unforeseen message, or a later edit adding a throw, is disclosure.
Deny-by-default fails closed: forgetting costs silence.

`_shared/publicError.ts` is the one definition. `ask/index.ts` now imports
it rather than keeping its own copy. The guard-list modules still spell the
three lines out themselves — they may hold no imports at all — and
`askThread.test.mjs` accepts either.

## Two things the shape had to get right

**Nothing is lost by masking.** `detail` carries the raw reason to the log
and never to the browser. `gif-search` and `feature-request` wrote to no
error log at all, so masking alone would have *moved* the blindness rather
than removed it; both now log.

**Two kinds of sentence stay public on purpose.**

1. `mail.ts`'s `transient` refusals. "Slow down" and "that address is
   wrong" are different answers, the bulk chase tells them apart by reading
   the message, and only the message crosses the function boundary. Masked,
   every rate limit would reach the tracker as an unexplained failure and
   thousands of approvals it could have waited for would be counted as
   tickets the office must now chase by hand. `publicError.test.mjs` reads
   `sendPool.js` back for the phrases so the two cannot drift.
2. A send that WENT but could not be recorded (`mailJha`, `mailReport`,
   `mailApproval`). Telling the person "try again" would send it twice.
   The sentence is ours; the database's reason is `detail`'s.

## Verification

Run in this worktree, in this order, before the commit:

| | |
|---|---|
| render scan | pass |
| Biome | pass |
| `npm run typecheck` | 21 functions, 0 errors, deno@2.9.6 |
| `node --test` | **802 passed, 0 failed** |
| `npm --prefix vite-app run build` | pass, PWA generated |

New: `vite-app/src/publicError.test.mjs`. It holds no list of strings to
classify — a list could never keep up with the raise sites. It asks the two
questions that can: is any sentence of ours raised unmarked, and can any
catch answer with a message it has not first judged. It also exercises the
module's behaviour, not only its shape: the same sentence unmarked is still
masked, which is the whole difference between marking and recognising.

Changed: `invoiceSnapshot.test.mjs` asserted the raw database text reached
the caller (`/snapshot failed/`). That was the defect. It now asserts the
person gets our sentence, the error is marked, and `detail` carries the
reason.

## Deployed

Nine functions, 2026-09-11, verified through `supabase functions list`:

`send-jha` v20, `send-report` v22, `send-ticket-approval` v32,
`render-invoice` v19, `render-jha` v19, `gif-search` v13,
`feature-request` v3, `ask` v16, `scheduled-sends` v7.

`scheduled-sends` is in the list because it bundles the three changed mail
modules. Its `verify_jwt` is still **false** after the deploy — checked,
per Codex's point that the CLI honours `config.toml` and the MCP connector
would not. No client change in this commit, so the Worker was not
redeployed.

## Still open in round 7

1. **Rate and spend limits** (S5's second half) — Codex's design. Agreed:
   an expiring lease keyed to a request id, the concurrency slot released
   on expiry but **uncertain spend retained** against the budget, and the
   reservation covering every model call in the tool loop, not just the
   Opus answer plus the Haiku learn pass.
2. **The two-session concurrency probe** on the 40-note `ask_learned` cap.
   Neither agent can hold two transactions open; the procedure is written
   into `probes-20260911233656-*.sql`.
3. **The Admin-gated and internal-secret ten** — same helper, second commit.
4. **The Vite/PWA major** — `esbuild <= 0.24.2` has no targeted fix (vite
   5.4 pins `esbuild ^0.21`, the advisory clears in 0.25), so it is a
   migration onto the service worker and precache manifest and gets its own
   round with the e2e suite run.
5. **The CDN pins** — `xlsx@0.18.5`, `jspdf@2.5.2`, `jspdf-autotable@3.8.4`
   in `cdnLibs.js`. `npm audit` is structurally blind to them. Low: the app
   only ever *writes* with SheetJS (no `XLSX.read` anywhere), which is not
   where its advisories live, and SRI makes a compromised CDN fail closed.
