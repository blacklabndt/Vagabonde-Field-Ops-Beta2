# Round 4 verification — the backup table part's budget

Answers the one P2 in `docs/reviews/2026-09-11-round4-codex-review.md`.
Nothing else in that review asked for code.

## What was wrong

`stepTables` read a table part until 25,000 rows or an empty page, with no
clock and no request ceiling. Round 3 had correctly stopped treating a short
page as exhaustion — only an empty page proves a table is finished — but that
left the loop's length in the server's hands: a gateway answering a hundred
rows at a time needs 250 requests for one part, and one row at a time needs
25,000.

The part is checkpointed by its RETURN — `afterTablePart` folds the cursor
and `advance` writes it and the heartbeat after `stepTables` comes back — so
a part that outlives the slice is uploaded by nobody and recorded by nobody.
The reclaim (`SLICE_ALIVE_MS`, three minutes) starts that same part from the
same key and reads it again, for as long as the pages stay small: the run
makes no progress until `RUN_RETRY_WINDOW_MS` (six hours) fails it for good,
and the schedule loses the night.

## The fix

- `PART_MAX_REQUESTS = 60` (`_shared/backupTables.ts`, beside `PAGE_ROWS`
  and `MAX_PART_ROWS`) — the backstop for pages that come back fast and
  tiny, where the clock alone would let the loop spin. A full part at the
  normal 1,000-row cap is 25 requests, so nothing changes in the ordinary
  case.
- `PART_TAIL_MS = 20_000` (`_shared/backupRun.ts`, beside `BUDGET_MS`) —
  what the read leaves itself to gzip and upload what it has.
- `stepTables` takes the slice's `deadline` and breaks on either ceiling,
  uploading the short part with `exhausted: false`. `afterTablePart` already
  handles that: `partIndex` advances, the key and offset are kept, and the
  next slice carries on from them.
- The break sits BELOW the empty-page test, so a part that read nothing is
  never stopped short — an empty part with `exhausted: false` would advance
  `partIndex` and nothing else, for ever.

`CLAUDE.md`'s tick section records the rule and the reason.

## Tests

`vite-app/src/serverPaging.test.mjs`, whose harness lifts the real
`stepTables` out of `backup-run/index.ts` and hands it the shared modules'
own constants (a number spelled in the test would keep passing after
production changed it):

- a part out of slice uploads what it read and says it is not exhausted;
- an empty table is still exhausted with the slice already over;
- tiny pages stop at exactly `PART_MAX_REQUESTS`, not at 25,000 requests;
- slice after slice resumes from the key with no gap and no row twice —
  through the real `afterTablePart` and `newRunCursor`, since that is the
  arithmetic the run writes back to `backup_runs`;
- and the round-3 cases (a reduced cap still respects the row budget; 0,
  1,000 and 1,001 rows read completely at caps of 250 and 1,000) still pass.

## What ran, and what did not

Run (Codex's sandbox, this worktree):

- render-name scan — passed
- Biome lint — passed
- node suite — **772 passed, 0 failed**
- Vite production build (API config, PWA included) — passed

NOT run, and why:

- **Deno typecheck (`npm run typecheck`) — BLOCKED.** `npx deno@2.9.6`
  could not be fetched (`EACCES`, `registry.npmjs.org/deno`); it is a
  network refusal in the sandbox, not a type error. **This must pass before
  `backup-run` is deployed.** The change is small and type-plain — one
  `deadline: number` parameter, two numeric constants, two imports already
  exported from `backupRun.ts` — but unverified is unverified.
- Live probes: none needed. No migration, no RLS, no SQL.
- The backup itself was not exercised against the live drive; the behaviour
  is covered by the tests above and by the cursor arithmetic they drive.

## Before deploying `backup-run`

1. `npm run typecheck` — green.
2. `npx supabase functions deploy backup-run --project-ref eielmvxzdwwprmmfamlq`
3. Watch one tick: the panel's last-run sentence and `backup_runs.cursor`
   should show parts advancing as before. On a normal 1,000-row cap the new
   ceilings are never reached, so a night that looks unchanged is the
   expected result.
