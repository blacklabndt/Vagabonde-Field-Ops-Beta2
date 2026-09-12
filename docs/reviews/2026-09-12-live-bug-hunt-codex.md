# Codex live bug hunt — 12 September 2026

## Environment and ownership

- Baseline: original main, commit `403fb38`.
- Isolated checkout: `claudex-work/37dbe6165f`, branch `codex/live-bug-hunt-20260912`.
- Two live testers: lane 3 (field/offline, port 5175), lane 4 (admin/support, port 5176).
- Separate browser contexts, auth storage, and evidence per lane. Existing ignored test credentials are available; never include them in reports.
- Claude's existing plan assigns lanes 1 (Ask) and 2 (money/office) to Claude. Codex cannot start or claim completion of Claude's separate session.

## Execution plan

1. Run baseline suite and production build against main's current code.
2. Each tester verifies its signed-in identity and role, then exercises 8–12 live cases with real backend responses.
3. Lane 3 covers JHA/report forms, navigation, offline/reconnect, draft recovery, and ownership boundaries.
4. Lane 4 covers available support screens, role refusals, read-only backup/admin panels, session handling, and the browser-crash reporting follow-up where feasible.
5. Record expected/actual behavior, exact reproduction, account role (no credentials), and evidence. Separate live checks from static observations and blockers.
6. Parent reproduces findings, reviews root cause, and shares findings with Claude through review artifacts before fixes. Add focused regression checks for confirmed defects, then rerun relevant tests and build.

## Live data boundaries

Only use identifiable seed records or uniquely labeled records created by this run. Clean up exact owned IDs; do not use the existing broad same-day/initials draft sweeps. No email or chat sends to people, restores, bulk clears, deployments, or migrations are part of this test run. Do not assume external email delivery is disabled.

## Status

Both Codex testers dispatched and signed in as the seed technician. Baseline `npm.cmd test`: 911 passed, no failures or skips; lint and function typecheck passed. Production build passed.

Parent built-app smoke (`node vite-app/e2e/hunt/parent-shell.mjs`, preview port 4175): six checks passed — shell loads, service worker controls the page, offline reload renders, mobile sign-in fits the viewport, offline navigation fallback renders, and no uncaught browser errors. This validates the locally built production shell, not the deployed Worker's headers.

Lane 3: 11 field/navigation/offline-read/JHA-recovery cases passed with no uncaught browser errors. Additional live lifecycle passed: offline ticket save, second seed account sees no first-account queue, original account reconnects, exact client-key and test marker prove the draft landed, and cancellation removes only that ticket with an exact-ID absence check.

Lane 4: 11 support-screen/session cases passed with no unexpected browser errors. A browser-only injected render failure exercised the real ErrorBoundary and live report-error endpoint (HTTP 200, ok:true), with only the four permitted identifiers sent; Home navigation recovered. Parent reviewed result JSON, the crash payload/response, screenshot, and retained runner.

No confirmed product defects in the two Codex lanes. No application source changes. Harness issues were corrected: selectors for open dropdowns and unread counts, waits for loaded data, isolated evidence directories, and rejected duplicate dialog acknowledgements. A concurrent lane-2 probe's unused local variable was removed to keep lint green; no test behavior changed.

Seed role lacks Admin/backup access; those positive-path checks need a suitable test account. Browser crash -> Recent failures is partially verified, with the Admin display still open. Report upload/submission, JHA submission, approved-ticket conflict replay, and deployed Worker behavior were not exhaustively tested by these lanes.

## Review handoff to Claude

Read `2026-09-12-live-bug-hunt-lane3.md` and `2026-09-12-live-bug-hunt-lane4.md` alongside this summary. Codex found no reproducible product defect requiring a fix. Please supply lane 1/2 findings for cross-review; joint review is not yet recorded. The ignored test environment file is present in this checkout and the original checkout, superseding the historical missing-credentials note. Keep each runner's output separate from default Playwright test-results.
