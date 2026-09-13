# VagaboNDE Field Ops — Beta 2 (slim rules for Claudex agents)

React PWA (`vite-app/`) over Supabase (project `eielmvxzdwwprmmfamlq`),
deployed as Cloudflare Worker `solitary-snowflake-ee22`.

## Commands

- Test: `npm --prefix vite-app test`
- Lint: `npm run lint` (Biome — warnings fail)
- Typecheck: `npm run typecheck` (Deno 2.9.6 over Edge Functions)
- Build: `npm --prefix vite-app run build`
- Deploy: `npm run build && npx wrangler deploy` (from repo root)
- Deploy a function: `npx supabase functions deploy <name> --project-ref eielmvxzdwwprmmfamlq`

## Build and commit

- The build must be green **before** the commit, never beside it.
- Biome ignores go on the line above: `// biome-ignore lint/<group>/<rule>: <reason>`.
- Edge Function types: bytes into Blob/Request/digest are `Uint8Array<ArrayBuffer>`.

## Migrations

- Apply live first (timestamps come from the applier), then write the
  matching file under `supabase/migrations/` with that version.
- Never apply the baseline to the live project.
- An unshipped DB fix waits as a draft under `supabase/handover/` with
  probes beside it — a draft, not history, until applied and filed.
- RLS changes get probed live with `set_config('request.jwt.claims', …)`
  role simulation before they ship.
- Permissive policies OR together — a new `FOR ALL` policy can silently
  void an older condition.
- Probe every new invoker-rights function as a non-owner before shipping.

## Money

- Integer-cents rounding: `gstOn(subtotal, ratePercent)` in data.js;
  never float-sum. A line's charge is `lineTotal` (data.js) and
  `lineCents` (invoice.ts) — no third formula.
- GST rate comes from `clients.gst_rate` via `gstRateOf`; missing = 5.
- Rates come from the Rate admin screen, never hardcoded. Billing is
  per truck, not per technician. PO = AFE. Hotel = subsistence.

## RLS and security (rules that prevent real bugs)

- `is_staff()` = at least one tab. Stripping tabs locks an account.
- Tabs are PERMISSION; drawer visibility is code. Never hide a screen
  by removing its tab — that revokes RLS access.
- Prices are for Admins and Technicians: rate_lines, ticket_lines
  SELECT/WRITE require the role AND the tab. `seesPrices(user)` in
  data.js is the client-side answer.
- Crew hours are private: `ticket_crew` read policy is own rows,
  Admin/Coordinator, or crewmates. Never widen it.
- One technician never edits another's ticket; an Admin edits anyone's.
  Three gates enforce this: Job detail, `loadDraft`, `can_write_ticket`.
- tickets has column-level UPDATE grants — signed-in accounts write
  only status, client_contact, contractor_contact, delays, chased_at.
  Approval columns are the service role's alone.
- Accounts are created by the `create-user` Edge Function (Admin-gated),
  never by client signUp. The provisioning trigger caps metadata roles
  to Technician/Helper — never widen this.
- Approval tokens are stored hashed (`sha256:` + hex). The raw token
  exists only in the emailed link.
- No secret is ever compared with `===`: use `secretsMatch` in
  `_shared/constantTime.ts` (constant time).
- `authenticated` has USAGE on schema `private` (migration 20260903).

## Architecture patterns

- Shared modules (22 `.ts` files in `supabase/functions/_shared/`) are
  erasable TypeScript with no imports of their own. No `enum`, no
  constructor parameter property, no `Deno.env` — `npm test` imports
  them directly and breaks on any of those.
- Twin rule: code shared between browser and Edge Function lives between
  `shared core` markers; `askTwins.test.mjs` / `backupSchedule.test.mjs`
  compare them and fail on drift. Change one, change the other, same commit.
- `ROLE_PRESETS` (data.js) and `tabs_for_role()` (database) must agree;
  `data.test.mjs` reads the migration back and fails on drift.
- PostgREST caps responses at 1,000 rows. Anything meaning "all" pages:
  `fetchAllPages` for reference lists, `fetchAllKeyset` for pay/billing.
- `Db.listJobs` is gone. Job pickers use `SearchSelect` over `Db.searchJobs`.
- Idempotent saves: tickets/reports/jhas use `client_key` (unique). The
  create functions return the existing row for a repeated key.
- The offline queue is for work only — nice-to-haves call the API direct.
- `saveCrewForTicket` upserts then deletes the rest. Keep it upsert-first.

## CSP

Every HTML document carries a Content-Security-Policy set by the Worker
from `worker/csp.mjs`. A new external script or API host must be added
to `csp.mjs` or it will not load. Scripts: this origin, `cdn.jsdelivr.net`
(SRI), inline blocks the Worker hashes. No inline event handlers.

## Client-facing HTML

The invoice body is `supabase/functions/_shared/invoice.ts`; the approval
page is `approve-ticket`'s. Both escape values with `esc()` from
`_shared/mail.ts`.

## Fonts

Barlow and Barlow Condensed are local in `vite-app/public/fonts`. The
design system's `@import` of fonts.googleapis.com is gone. Never put it
back or add a webfont by URL.

## Verification habits

- `npm test` before committing.
- Never round-trip source through PowerShell Get-Content/Set-Content (BOM
  issues). Use Edit tool or a node script.
- Never leave literal control characters in source — write the escape text.

## People

Kyle Keith (blacklabndt@gmail.com) is the admin and owner.
