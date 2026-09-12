# Live bug hunt — lane 3, field and offline workflows

Date: 2026-09-12. Checkout: `codex/live-bug-hunt-20260912`, starting at `403fb38`.

## Environment and boundaries

Real headless Chromium at 1440 × 900, local Vite on `http://localhost:5175`, live Supabase backend. Own browser storage: `vite-app/e2e/.auth/lane3.json`. The real sign-in form authenticated Aaron Toews; the ownership case additionally authenticated Ben Sawatzky. Secrets came from ignored `e2e/.env` and were not copied into tracked files.

Only seeded job `S-12785` was used for writes. Ticket drafts carried a unique `lane3-<timestamp>` delay marker and an independently captured queue `clientKey`. Every landed draft was verified against that exact key, technician ID, job ID, marker and Draft status before UI cancellation. Cleanup never searched by initials/date and never swept other drafts. There were no sends, signatures, report uploads, deployments, restores or changes to existing JHAs.

## Plan and executed results

| Case | Expected | Actual |
| --- | --- | --- |
| 01 Sign-in and board | Authenticated identity and live rows load | PASS: Aaron Toews; 10 board rows |
| 02 Offline board | Warm board remains usable with offline disclosure | PASS: offline banner and 10 cached rows |
| 03 Reconnection | Returning online loads board without stale offline disclosure | PASS |
| 04 Directory precondition | Live New job picker includes seeded client | PASS: Athabasca Energy present |
| 05 Offline client search | Cached lookup works, creates no queued read, dialog can close | PASS: results present, no queue; Escape dismissed results and Cancel closed dialog |
| 06 Seeded job navigation | Search opens the intended seeded job | PASS: `#/job/S-12785` |
| 07 Job deep-link reload | Reload restores same job | PASS |
| 08 JHA initial state | New assessment does not pre-tick Driving | PASS: `aria-checked=false` |
| 09 JHA draft recovery | Checked hazard and typed muster survive reload | PASS: recovery notice, Driving checked, exact lane3 muster restored |
| 10 JHA draft reset | Start empty clears recovered fields | PASS: muster empty and Driving unticked |
| 11 Reports read state | Job's reports section settles and presents empty state | PASS: zero reports, “None on file yet”, upload action available |
| 12 Offline ticket and account handoff | Own marked draft queues offline, stays hidden from next account, replays for owner, appears once, and can be cancelled | PASS: one queue entry; Ben sees zero entries/badges; Aaron reconnect drains it; exact key resolves to owned marked Draft; UI cancellation followed by exact-ID absence |

The 11-case browser script completed with zero page errors. The full ownership/queue script completed with exit code 0, including final cleanup. All four lane scripts passed targeted Biome lint.

## Findings reviewed

No confirmed product defects in this lane.

Initial harness issues were corrected and rerun:

- The welcome tip appeared after the first immediate visibility probe; awaiting and dismissing “No more tips” removed the blocked navigation.
- Clicking Cancel while the client listbox was open hit the listbox overlay. The existing picker deliberately permits overflow; Escape dismissed it and Cancel worked. This was not classified as a product defect.
- Job detail's ticket dialog uses “Create ticket”, not the Home dialog's “Continue”.
- The ticket's primary ID is the displayed ticket number; there is no `ticket_number` column. The verification query now uses `id`.
- A sign-out confirmation handler survived a sign-out which did not prompt and tried to accept the later cancellation dialog twice. The ticket was already cancelled; an independent exact-client-key read confirmed absence. The harness handled repeated acceptance and the whole ownership cycle subsequently passed cleanly.

## Reproduction and evidence

From `vite-app`, with the isolated Vite server running on 5175:

```text
node e2e/hunt/lane3-probe.mjs
node e2e/hunt/lane3-cases.mjs
node e2e/hunt/lane3-queue.mjs --ownership
```

The queue script performs a real seeded-job draft write and deletes only its own verified draft. `--cleanup` resumes cleanup using its captured evidence. `lane3-verify-cleanup.mjs` independently checks that the captured client key no longer exists. Scripts return a nonzero exit code for failed assertions/authentication; dependent cases are marked blocked when the seeded job cannot open.

Ignored evidence is under `vite-app/e2e/.auth/lane3-evidence/`: `results.json`, `queue.json`, and initial failure screenshot `5.png`. `queue.json` contains the unique marker, client key, exact created ID, second identity, and completed cleanup result. Displayed draft number `AT-0912-26-01` was reused by sequential create/cancel cycles; cleanup identity therefore depended on the unique client key and marker, never the number alone.

## Coverage limits

JHA recovery was a device-local draft test, not a filed or signed assessment. Reports coverage is the real empty-state read/navigation only; no report upload, download, mail or last-number write was tested. This lane did not test billing amounts, failed queue conflict resolution, mobile layout, or the signed-in crash-to-Recent-failures flow. No broad claim that all offline or field workflows are bug-free is made.
