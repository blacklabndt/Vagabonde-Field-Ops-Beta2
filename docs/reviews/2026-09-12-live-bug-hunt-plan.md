> Historical lane allocation, retained from review branch cf44e0d. Current Codex environment, credential availability, and live-data rules are in 2026-09-12-live-bug-hunt-codex.md. Do not rely on the old missing-credentials or disabled-email assumptions below.

# Live bug hunt — environment and plan (12 Sept 2026)

Two agents (Claude, Codex), two subagents each, four lanes, one shared
harness. Findings land in this folder as `2026-09-12-live-bug-hunt-<lane>.md`
and are reviewed jointly before any fix is written.

## The environment

There is no new stack to stand up — the app already has a live harness and
it is the one to use:

- `vite-app/playwright.config.js` drives the REAL app (Vite dev server on
  5173, started and torn down by Playwright) against the LIVE Supabase
  project, signed in as a seed technician. `workers: 1`, `retries: 1`,
  screenshots and traces on failure.
- `vite-app/e2e/auth.setup.js` banks one session per account into
  `e2e/.auth/state.json` (and `state2.json` for the cross-account races), so
  the suite spends one password grant per run instead of tripping Supabase's
  sign-in throttle.
- `vite-app/e2e/helpers.js` holds the shared moves: find a seed job, walk to
  it from the board, open a ticket row, sweep the drafts a run minted.
- Playwright's Chromium is already installed on this machine.

### The one blocker

`vite-app/e2e/.env` is gitignored and absent. Without it every lane skips.
It needs, from Kyle:

    E2E_EMAIL=aaron.toews@seed.vagabonde.ca
    E2E_PASSWORD=<seed account password>
    E2E_EMAIL2=ben.sawatzky@seed.vagabonde.ca
    E2E_PASSWORD2=<second seed account password>

Seed accounts only (`@seed.vagabonde.ca`), never Kyle's own sign-in. An
Admin-tabbed seed account would widen lanes 2 and 4; without one those lanes
test the refusals instead, which is worth doing either way.

### Rules for every lane

- Seed data only: jobs `S-1%`, `@seed.vagabonde.ca` accounts, the generated
  orgs and contacts. Never touch a real record.
- Every draft a run mints is cancelled in `afterEach`, as the existing specs
  already do.
- No email actually leaves the building: Resend is in testing mode, so a send
  to anyone but the Resend account's own inbox is refused — that refusal is a
  legitimate assertion, not a failure to chase.
- Nothing is deployed, no migration is applied, no `main` is touched. The
  branch is `room/37dbe6165f-beta-2-review` and commits are per finding.
- A finding is a REPRODUCTION or it is not a finding: a spec file, or exact
  steps, plus the expected and actual behaviour.

## The lanes

Lanes 1 and 2 are Claude's subagents; 3 and 4 are Codex's. Each lane writes
its own spec files under `vite-app/e2e/hunt/` so nothing collides.

**Lane 1 — Ask (Claudia).** The newest and largest surface, with almost no
e2e coverage: the panel on every screen, context ("what is this screen for",
"this job"), the read tools, the draft proposals (job / ticket / JHA) opening
the app's own forms with a seed, the send and schedule confirms, reminders,
`make_file` downloads, the learning notes and their ×, dictation's absence
where the browser has none. Watch the card's action precedence, `dropAction`,
and a proposal whose record changed underneath it.

**Lane 2 — Money and the office.** Ticket editor arithmetic against the rate
card (orphan lines, `CATALOG_STEP`, `NumField` refusals, the sane-quantity
questions), the GST snapshot across approve → withdraw → re-rate → invoice,
the tracker (aging tiles, By client, chase planning, invoiced ↔ approved),
the accounting CSVs, and the archive dialog's build → verify → drift refusal.
`seesPrices` and the own-or-Admin ticket rule are the gates to push on.

**Lane 3 — Field and offline.** JHA builder, report upload, the offline
outbox and its replay, the shared-tablet cache owner, recovery copies,
`overwroteNewer` banners, the refusal-under-approval park, push and the
service worker, route/back behaviour within one job.

**Lane 4 — Admin, backup and chat.** The Admin screen's panels (app settings,
error log paging and Clear, what Ask has learned, users and tabs), the backup
panel's reading of `backup_state()` (never a write — no restore is run
against the live project), Files, Contacts, Equipment, Timesheets and the
dose export, and team chat (replies, pins, media, job-number linkifying by
membership).

## How a finding becomes a fix

1. The subagent files its lane report with reproductions.
2. Claude and Codex read both of their own lanes' reports, then each other's,
   and agree a severity and a cause before a line is written.
3. Anything touching RLS is probed live with role simulation first.
4. `npm --prefix vite-app test` and the build stay green BEFORE the commit.

