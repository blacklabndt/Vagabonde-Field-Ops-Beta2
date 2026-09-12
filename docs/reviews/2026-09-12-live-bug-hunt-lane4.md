# Live bug hunt lane 4 - 12 September 2026

Baseline: main 403fb38, local Vite http://localhost:5176, real Supabase backend, Chromium desktop 1440x1000 and phone 390x844. Account authenticated through the real login form and its own banked session: Aaron Toews, Technician (confirmed from authenticated profile read). No product files changed.

## Result

11 live browser cases passed in the final run; zero unexpected page errors. No confirmed product defects in this lane. Runner exits nonzero for a failed case or unexpected page error. Biome passes for the retained script.

| Case | Steps and expected result | Actual |
|---|---|---|
| Session and role gate | Reopen with saved session; read own role; open Sections and confirm Admin absent | Technician session restored; Admin absent |
| Files | Sections > Files; wait for existing Gate-Codes.txt row | Existing file row visible |
| Contact lookup | Contacts > Find a person; search Sam Vandenberg; choose matching result | Existing person's organisation/contact displayed |
| Missing contact | Search unique nonexistent person | Explicit Nobody on file matches state |
| Contractor scope | Contacts > Contractors | Selected scope reports aria-pressed true; contact action remains available |
| Current timesheet | Timesheets; wait for loading indicator to disappear | Period content settles; export summary action visible |
| Approved records | Approved timesheets; wait for loading to finish | View active and settled |
| Dose ledger | Dose ledger > Year | Year selected; dose period chooser available |
| Chat read | Team chat; wait for retention note and existing message | Existing messages render; no sends or reactions performed |
| Phone contacts | Resize to 390x844; navigate Contacts | Document fits viewport horizontally |
| Controlled crash | Intercept Files lazy module in this browser only with a component throwing TypeError; navigate Files, then Home | Real screen ErrorBoundary displays fallback; real report-error returns HTTP 200 and ok:true; Home navigation recovers |

The crash request contained only error_category=type-error, route_id=files, component_id=screen, and app_version=0.93-beta 2 - 403fb38 - 2026-09-12. The injected message was not transmitted. This is an actual React render crash passing through the app boundary and sender, not a standalone HTTP function probe. It writes the expected categorized synthetic monitoring event. No existing monitoring records were removed.

## Still unverified

Admin/backup panels, Equipment and Users are unavailable to this account. Their absence is a role/access limitation, not a bug. The Home Recent failures strip is Admin-only, so signed-in crash -> Recent failures remains partially verified: boundary, outbound report, server acknowledgement and recovery passed; the Admin display remains open. No claims about backup restore/deployment/send workflows are made.

## Evidence and reproduction

Retained runner: vite-app/e2e/hunt/lane4-live.mjs. Start Vite on port 5176 and run `node e2e/hunt/lane4-live.mjs` from vite-app with its existing banked e2e/.auth/lane4.json session. Credentials and session are ignored, never committed. Evidence is ignored at vite-app/e2e/.auth/lane4-evidence/: results.json, identity.json, case-1 through case-10 text/screenshots, crash.json and crash.png. Evidence moved outside test-results because concurrent Playwright runs clear that shared directory.

Exploratory harness failures were corrected before final results: unread-count text requires a prefix selector for Team chat; seeded contact names are not unique; a filename shares a text element with its type badge; profile tabs is not a selectable column; PowerShell text encoding damaged Unicode selectors. None were product findings. The final run uses actual settled loading assertions and passed all 11 cases.
