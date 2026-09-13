# Codex Admin follow-up - 12 September 2026

Resumed existing lane 4 verification; no product files changed. Real Chromium, local existing Vite at localhost:5176, live Supabase. Fresh real UI sign-in as qa1@seed.vagabonde.ca; authenticated profile confirmed Admin.

## Passed

- Home Needs attention displayed background failure summary including browser (5).
- Admin Recent background errors loaded and displayed five `ErrorBoundary (screen) on files: type-error` rows.
- Read-only Admin query correlated three rows to every field in the earlier actual React crash request: route files, component screen, category type-error, app version `0.93-beta 2 - 403fb38 - 2026-09-12`. Latest matching row `b7105314-a69f-4df0-9f6d-e3a41a79d58f`, 2026-09-12T17:28:13.279055Z, matches the final lane4 run timing. The response had no event id, so this is matching payload/time correlation, not a returned-id join.
- Automatic backup loaded connected status, completed last run, next backup/file-check schedules, and enabled Show backups action. No backup operation was started.
- No unexpected browser page errors.

This closes the prior Admin-display verification gap when combined with retained lane4 actual React-boundary/report-error evidence. Precise UI names: Home shows the Needs attention summary; individual records appear in Admin > Recent background errors. There is no card literally named Recent failures.

## Limits and evidence

No fresh crash injected, sends, error clearing, settings saves, backup runs, drive listing, restore, archive, deployments or migrations. Backup coverage is read-only initial panel loading only. The panel had no active run and no nudge was exercised. No confirmed product defect found.

Runner: `vite-app/e2e/hunt/codex-admin-followup.mjs`. Run from vite-app with `QA_PASSWORD` provided via environment. Private evidence under ignored `vite-app/e2e/.auth/codex-admin-followup/`: identity, results, correlation, browser rows, Home/Admin text and screenshots. No credentials are stored in the runner.

Exploratory harness corrections: old banked session had different origin; fresh login succeeded. First-use help modal blocked drawer until acknowledged. Neither is a product bug. Final runner waits for loaded UI, not fixed delay.
