# Round 5 verification — scheduled sends and reminders

Answers all three P2s in `docs/reviews/2026-09-11-round5-codex-review.md`.

## F1 — the record's write is not the send

The tick awaited the final `update` and dropped its error, then counted the
row fired and pushed "Sent" to the scheduler's phone. The row stayed
`sending`; the job strip and Ask's `list_scheduled` read only queued and
failed rows, so it was invisible until the stale sweep failed it fifteen
minutes later with words that ask whether to send again — about an email
that had definitely gone.

`markStatus` in `scheduled-sends/index.ts` now writes the final status with
one second chance and **never throws** (a throw from the success path would
land in the catch that marks a row failed, which is the one lie this
function must not tell), and its answer is read:

- the send went, the row would not write → `sentUnrecorded` to
  function_errors: "… WAS SENT … Do not send it again."
- the send failed and the row would not write → `failureUnrecorded`, naming
  both.
- either way `unrecorded` is counted and the tick answers
  `{ ok: unrecorded === 0, fired, failed, unrecorded, stuck }`. `fired` and
  `failed` describe the SEND and are unchanged; `unrecorded` describes the
  ROW. A tick that abandoned a row no longer reports a clean run.

The row is still left for the stale sweep rather than retried — twice is
worse than once too few — and function_errors now says which of the two it
was.

## F2 — the clock

`localToUtc` checked only month 1–12 and day 1–31, then let `Date.UTC`
normalise; and its two offset passes never checked that the instant reads
back as the time asked for.

- `2026-11-31 07:00` silently became 1 December (inside ninety days, so no
  other guard caught it). The date parts are now read back off `Date.UTC`
  and a day the month has not got is refused.
- `2026-03-08 02:30` — an hour the clock skips — silently became 01:30. The
  final instant is now converted back through the zone and must equal the
  wall-clock time requested.
- The autumn hour that happens TWICE now has a stated, tested policy: the
  passes converge on the FIRST occurrence (daylight time), which is what a
  person means by "before the clocks go back".

## F3 — what may be proposed must still be insertable

Three separate halves of one contract:

- `MAX_PAST_MS` 5 min → **30 s**, deliberately inside the insert policy's
  `run_at > now() - interval '1 minute'`. Both test files read that
  migration back, so the two cannot drift.
- `reschedule_send` checks the **effective** time, new or kept. Moving
  yesterday's failed send to another address keeps yesterday's time and
  skipped the check entirely.
- App asks `tooLateToSchedule` (new, in `scheduledSends.js`) **before** the
  cancel. A move is a cancel and then an insert; a refusal after the cancel
  destroys the only copy of the send. The plain schedule asks it too, so a
  stale card gets words a person can act on instead of an RLS refusal.

The database remains the authority; these only stop us offering what it
will refuse.

## Tests

`vite-app/src/scheduledSends.test.mjs` and `scheduledSends.client.test.mjs`
— eleven new cases: the impossible date, the skipped hour, the repeated
hour's policy, the floor read back off the migration (twice), `markStatus`
first-time / retry / given-up / never-throws, the tick's answer shape, the
two words, the guard's own answers, and the ORDER of guard-before-cancel
read out of App.jsx.

One test of mine was wrong first time round and Codex caught it: the
App.jsx slice searched `indexOf` from zero, found an earlier
`getJobByNumber`, and sliced backwards to an empty string that asserted
nothing. Both slices now search from the branch AND assert the slice is
non-empty, so an empty slice can never pass quietly again.

## What ran

- node suite — **783 passed, 0 failed** (Codex)
- render-name scan, Biome lint — passed (Codex)
- `npm --prefix vite-app run build` — passed (Claude, this worktree)
- **`npm run typecheck` — PASSED.** "21 functions type-check under
  deno@2.9.6", zero errors, run from this worktree at commit `c46ae41`.
  It works here now because Kyle's own round-4 run left Deno in the npx
  cache — the `EACCES` was always the DOWNLOAD, never the checker. Anyone
  meeting that refusal again should have Deno fetched once from a shell
  with network, after which the gate runs in the sandbox in ten seconds.
- No migration, no RLS change, no live probe needed: the SQL is only read
  back by tests.

## Deployed — 11 Sept, on Kyle's authorisation

All four steps done in this order, from this worktree at `c46ae41`:

1. `npm run typecheck` — 21 functions, zero errors.
2. `scheduled-sends` — deployed.
3. `ask` — deployed.
4. `backup-run` — deployed (ROUND 4's fix, `cdadf5e`, which had been
   committed and never shipped; its own gate was met by Kyle's typecheck
   and again by this one).
5. `npm run build && npx wrangler deploy` — Worker version
   `d5c1212c-9ef4-43fb-9344-286e9de0f27b`.

The functions and the app went together on purpose: the 30-second floor is
in both, and the app's guard is the friendlier of the two refusals.

Nothing about the database changed in round 4 or 5 — no migration, no
policy, no probe to run.
