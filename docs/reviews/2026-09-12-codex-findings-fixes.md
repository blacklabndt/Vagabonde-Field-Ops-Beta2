# Claude findings: Codex review and fixes

All four reported defects are supported by the source. This change set fixes
the three application defects and prepares the database disclosure fix for a
staged release. Nothing in this change set has been deployed or applied live.
The live ticket-total disclosure remains open until enforcement is applied.

## Application fixes

- Approval fingerprints now use the frozen ticket GST rate, preserving zero
  and falling back to the client rate only for legacy tickets. Regression
  tests cover an unchanged frozen invoice after a client rate change and a
  changed invoice after a snapshot change.
- Resolving or declining an Ask proposal removes only `action`. Generated
  files, learned-note undo, learning errors, trace and follow-up remain.
- Ask receives job context only on job-related screens and ticket context
  only on the ticket screen. The narrower ticket rule also prevents a
  retained ticket from another job being sent on Job detail, JHA or Upload.

The original GST and Ask regressions failed before their respective fixes.

## Ticket totals

A column revoke alone would break Admin and Technician readers too: all
signed-in users connect as `authenticated`. A price-only row policy would
hide legitimate Helper ticket metadata, timesheet joins and Coordinator
workflow reads. Instead:

1. `ticket-money-select.sql` prepares `tickets_read`, an owner-rights,
   security-barrier view with an explicit `is_staff()` predicate and a
   role-dependent total. It grants SELECT only. Three existing invoker RPCs
   read this view while keeping their existing joins and response contracts.
2. Browser and Ask total readers use the view. Ticket writes remain on the
   base table. The invoice loader permits a view read for `render-invoice`,
   while service-role approval/mail callers keep their base-table reads.
3. `ticket-money-select-enforce.sql` removes table-level SELECT and any
   explicit total-column SELECT grants, then grants the explicit metadata
   column list. Service-role grants remain intact. Future columns do not
   automatically become readable.

Invoice numbers and dates remain accessible: existing RPCs deliberately
return them, and they are not prices. The finding's suggested additional
revokes would change that contract without closing another demonstrated leak.

The view must mirror any future ticket row-scope restriction. Owner-rights
views need this explicit gate because they do not use the caller's table
privileges. See [PostgreSQL view security](https://www.postgresql.org/docs/16/sql-createview.html).

## Verification and release

Final checks on the complete change set: `npm test` passed all **922 tests**,
including render checks, lint and Deno typechecking; the production Vite/PWA
build passed; `git diff --check` passed. The final SQL drafts passed **75
isolated PostgreSQL assertions**. Application regression coverage increased
from 911 to 922 tests. Two bounded agents implemented/reviewed the changes;
Codex inspected the combined diff and reran the complete checks.

The isolated harness `supabase/handover/probes-ticket-money-select.mjs` uses
PGlite 0.3.14 in memory, with synthetic records, minimal supporting tables,
and session-setting stand-ins for the application's identity helpers. It
does not connect to Supabase, read credentials, send mail or mutate live data.
This verifies PostgreSQL grants, masking and the actual draft RPC definitions;
it does not replace deployed PostgREST/browser testing or a full schema replay.

To rerun, install `@electric-sql/pglite@0.3.14` outside the repository and pass
the file URL of its `dist/index.js` to the harness. Add `--before` to exercise
the old grants: it fails because a Helper's total SELECT succeeds. Without
that flag it applies both draft files to the in-memory database.

Release order:

1. Apply the preparation SQL and file it under its actual migration version.
2. Verify `tickets_read` embeds `profiles`, `jobs` and `ticket_lines` through
   PostgREST as seed Admin, Technician and Helper, including null Helper
   totals. The SQL requests a schema-cache reload. View relationship
   inference requires the source FK columns and must be checked against the
   deployed API; see [PostgREST embedding](https://docs.postgrest.org/en/v13/references/api/resource_embedding.html).
3. Deploy the app and affected functions: Ask, render-invoice and
   approve-ticket (the fingerprint fix). Verify job lists, ticket reopening,
   invoice download and Ask's ticket list using seed records. Refresh older
   browser builds before enforcing the new grants.
4. Apply enforcement and file its actual migration version. Verify direct
   base total reads and predicates are refused, Helper metadata/counts remain
   available, and Admin/Technician prices still work through the view/RPCs.

Do not claim closure after preparation alone. Neither SQL file belongs in
applied migration history until it is applied and assigned its actual version.
Claude's review should focus on the staged SQL, reader coverage and deployed
embedding checks before release. No direct communication with Claude's
separate session was available; ownership and results are shared on disk.

One additional unverified observation from review: `openTicket()` changes
the selected job before its asynchronous load finishes. A transition invoked
from an already open ticket may briefly retain its old ticket ID. This has
not been reproduced as a user-visible failure and is not marked fixed.
