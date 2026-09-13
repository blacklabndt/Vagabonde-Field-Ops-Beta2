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
  Repo files and applied migrations must reconcile 1:1. The history starts
  at `20260817040000_beta1_baseline.sql` — the whole schema squashed into
  one file, generated from the live catalogs; the 77 evolutionary
  migrations it replaced live in the prototype archive. It opens with
  `set check_function_bodies = off` and closes with a `reset`, because it is
  in catalog order and §2’s sql-language helpers name tables §3 creates —
  without that it dies on its first statement in the fresh environment it
  exists for. Never apply the baseline to the live project; it is for fresh
  environments. Replaying the repo into a fresh project also stands up cron
  jobs and a chat push trigger pointed at THIS project’s functions (seven
  migrations bake the URL and publishable key in, `scheduled-sends-tick`
  the latest), so unschedule them and
  re-point the trigger before anything else — HANDOVER.md’s Path B says how. An unshipped
  DB fix waits as a draft under `supabase/handover/` (probes beside it) —
  a draft, not history, until it is applied and filed under migrations.
  Replacing a ticket’s charges is applied as
  `20260913013801_a_ticket_saves_its_charges_atomically.sql`: the definer
  `replace_ticket_lines(ticket_id, lines jsonb)` does the editor’s DELETE and
  INSERT in one transaction, locks the parent ticket FOR UPDATE and asks every
  authorization question AFTER that wait (a role, a deactivation or an approval
  landing while a save queues must refuse, not be honoured), validates the whole
  payload before a row is touched, and leaves `tickets.total` to the sync
  trigger. Its probes are beside it under `supabase/handover/`, part 1 in one
  rolled-back transaction and part 2 as real concurrent sessions — all run live
  on 13 Sept and recorded in the migration’s header. `Db.updateTicket` — the editor’s save and the
  outbox replay both — now calls it instead of deleting and re-inserting the
  lines from the browser, and takes the total the function returns; the
  hold-and-restore of the old lines is gone with the gap it covered.
  `ticketLineSave.test.mjs` reads the method back and fails on a
  `ticket_lines` write from the client. Its four refusals are marked as
  refusals: `lineRpcRefusal` in db.js turns the errcodes the function raises
  (`P0002` the row gone, `42501` role or state, `22023` the payload, `28000`
  signed out) into `plainError` — `P0002` with `ticketGone` — because
  oqFlushOnce and the editor both ask `.plain` first, and an unmarked refusal
  met in a dead spot reads as "offline" and is retried for ever. A lost
  connection, a gateway page and PGRST202 stay as they came; a missing EXECUTE
  grant does too (its words name the function); and 22003 gets one fixed
  sentence, since Postgres’s own names the column’s precision. `createTicket` still writes a new
  ticket’s lines directly: an insert has no old billing to lose.
  Browser crash reporting is applied as
  `20260912160845_browser_crashes.sql`: `browser_crashes` records the
  account/minute rate limit, and service-only `file_browser_crash` writes
  it and the Recent failures entry in one transaction. Live release probes
  cover permissions, validation, atomic rollback and duplicate reporting.
  `report-error` and app/Worker release `b3c15b8` were deployed on 12 Sept
  (CI run 34704562986, 911 tests passed). The signed-in browser crash →
  Recent failures end-to-end check remains unperformed; it is a verification
  gap, not a held deployment.
  Ask’s reservation ceiling is applied as
  `20260912034222_the_ceiling_is_charged_before_the_call.sql`, followed by
  `20260912041955_a_refusal_that_settles_nothing_answers_false.sql` and
  `20260912045301_a_busy_lease_answers_false.sql`. These are live migrations,
  not pending drafts. Before them,
  `20260911233656_ask_learned_is_bounded_and_cannot_be_backdated.sql` —
  `ask_learned` gains a column-list INSERT grant (`note`, `said_by` only, so
  `created_at` is not the caller’s to backdate — backdating was what turned
  crowding into eviction under the old oldest-first read), a BEFORE INSERT
  trigger capping one author at 40 behind a per-author advisory xact lock, and
  `replace_learned(_old, _note)`, SECURITY INVOKER, which takes the same lock,
  refuses a zero-row delete rather than turning a correction into an addition,
  and is one transaction. Nine probes beside it, run live under role
  simulation. A BEFORE INSERT trigger fires AHEAD of the RLS check, so an
  author already at the cap meets the cap’s words when attempting a forged
  `said_by` — right refusal, wrong reason, and the probe asks that question
  while the author still has room. Before it,
  `20260911010317_a_reminder_is_a_timer_with_no_mail.sql` —
  `scheduled_sends.kind` gains `reminder`, `job_id` becomes nullable, and
  the insert policy’s reminder arm (record_id and to_list pinned empty; a
  named job must be one the caller reads under jobs_select; the send arms
  now say `job_id is not null` themselves). Five probes beside it. Before
  it, `20260910225905_ask_learns_the_app.sql` — `ask_learned`, Ask’s one
  crew memory of how the app works (staff read; insert own; delete own
  or Admin; no update; note 3–300 chars). Seven probes beside it. Before
  it, `20260910213858_a_send_can_wait_for_its_time.sql` — the
  `scheduled_sends` table (Ask’s timers), its policies and the
  `scheduled-sends-tick` cron job (every five minutes, x-internal-secret,
  admin-digest’s shape; DEPLOY THE FUNCTION FIRST). Probes beside it, run
  under role simulation. Before it, `20260910195523_ask_has_a_key.sql` —
  `app_settings.anthropic_api_key`. Before it,
  `20260910130301_a_jha_is_open_or_closed.sql` — `jhas.status` gains the
  check list (`Open`, `Closed`) the other four status columns had from the
  start; it was NOT NULL with a default since the baseline, but nothing
  refused a third word, and an assessment filed under one would have been
  neither open nor closed on any screen. Probe beside it. Before it,
  `20260910023039_the_file_checks_clock_starts_on_its_own.sql` —
  `app_settings.backup_verify_next_at` defaults to 01:00 Grande Prairie
  tomorrow: 20260908151245 seeded it with an UPDATE of the one row, and a
  fresh replay has no row (the panel’s first Save or a restore’s upsert
  makes it, and neither names the column), so a rebuilt project never
  queued a file check and the panel hid the line that would have said so.
  Probe beside it, on a temp clone of the table. Before it,
  `20260908152626_a_run_may_be_a_file_check.sql` — `backup_runs.kind`’s
  check list gains `verify`; the first file check moved the clock and then
  met the constraint, because 20260908151245 taught the tick a fifth kind
  and not the table. Before it,
  `20260908151245_the_backup_checks_every_file_a_fortnight.sql` —
  `app_settings.backup_verify_every_days` (14) and `backup_verify_next_at`,
  and `backup_state()` answering both; probes beside it. Before it,
  `20260908141656_a_backup_knows_the_hash_of_every_file.sql` —
  `backup_run_files` (service role only, one row per file per run, cascades
  with the run); probes beside it, run live twice. Before it,
  `20260908101639_the_equipment_pages_in_a_total_order.sql` —
  `search_equipment` orders by type, serial_number, id: two items of one
  type with no serial were a tie, and an OFFSET page boundary inside a tie
  doubled one and dropped the other. Probe beside it. Before it,
  `20260908063429_a_locked_account_reads_only_its_own_row.sql` —
  `profiles_select` is `is_staff()` or the caller’s own row, where it was
  "anybody signed in": a locked account’s token stays good for an hour, and
  it read the crew’s serials and id codes until then. Probes beside it
  (locked 1 row, own; staff all). Before it,
  `20260908053815_the_token_hook_reads_profiles.sql` — `grant select` on
  profiles (and USAGE on public) to `supabase_auth_admin`, the role Auth
  calls the SECURITY INVOKER `custom_access_token_hook` as; live had it all
  along, the baseline dropped it, and a fresh replay issued every token
  with no tab_access claim while the hook swallowed the denial. Probe
  beside it. Before it,
  `20260908044141_withdrawing_an_approval_is_the_offices_too.sql` —
  `withdraw_ticket_approval` states its own gate (the ticket’s technician,
  an Admin, or a Coordinator) instead of borrowing `private.can_write_ticket`,
  which 20260907044223 narrowed to own-or-Admin for the lines and crew
  writes and, unnamed, took the Coordinator’s Cancel approval with it.
  Probes beside it (Coordinator 1, other technician 0, own 1). Before it,
  `20260907175805_the_error_log_clear_says_where.sql` — the Clear button’s
  `clear_function_errors()` deletes `where true`, because the authenticator
  role preloads pg-safeupdate, which refuses an unfiltered DELETE or UPDATE
  in every API session, definer functions included ("DELETE requires a
  WHERE clause"). Any new bulk door needs a WHERE, even a `where true`;
  the probe beside it cannot load the library (refused outside the API’s
  sessions), so the button is the end-to-end check. Before it,
  `20260907044223_a_ticket_is_edited_by_its_technician_or_an_admin.sql` —
  `private.can_write_ticket`, the gate behind every ticket_lines and
  ticket_crew write, is the technician’s own or an Admin’s; the Coordinator
  arm it carried since the baseline is gone (the tickets UPDATE policy keeps
  its Coordinator arm for the tracker’s chase and query columns, which are
  the office’s and not the bill). Probes beside it. Before it,
  `20260906181829_the_shared_drive_is_deleted_by_the_office.sql` — the
  `shared delete` storage policy needs Admin or Coordinator as well as the
  files tab (the Files screen’s × was a courtesy with no gate behind it);
  storage.objects refuses a direct DELETE from SQL, so its probes evaluate
  the predicate under role simulation. Before it,
  `20260906154840_an_invoice_has_a_number.sql` — `tickets.invoice_number`
  from `invoice_number_seq` (starts at 1000, `authenticated` has no USAGE),
  stamped only by `mark_tickets_invoiced` and kept across an un-invoice; the
  tickets insert policy pins it null; `app_settings.invoice_terms`,
  `invoice_remit_to`, `business_number`; and the merged `search_tickets`
  carrying `client_gst_rate`, `invoice_number` and `client_id` — and
  `20260906154650_a_client_may_be_gst_exempt.sql` — `clients.gst_rate`
  (percent, default 5, not null, 0–100), guarded per column by the
  `clients_guard_update` trigger so only an Admin changes it (the clients
  update policy is a tab test a Helper passes). `gstOn(subtotal, rate)` in
  data.js and `invoiceTotals` in invoice.ts both take the client’s rate; a
  missing rate reads as 5, never as exempt. Before them,
  `20260906143757_the_office_hears_about_failures.sql` — the pg_cron job
  `admin-digest-daily` (13:00 UTC) calling the `admin-digest` function,
  which mails every active Admin only when something needs attention — and
  `20260906143715_the_tracker_knows_how_old_the_money_is.sql` —
  `ticket_aging()`, invoker rights, counts for everyone and money for the
  price roles, behind the tracker’s aging tiles and By client view (probes
  beside each under `supabase/handover/`). Before them,
  `20260906135356_a_worker_keeps_their_own_serials.sql` (probes in
  `supabase/handover/probes-20260906135356-a-worker-keeps-their-own-serials.sql`):
  `set_own_dosimetry(tld, drd, alarm)`, a definer RPC any signed-in, unlocked
  account may call to write the three serial columns on its OWN profile row
  and nothing else — the "Keep these on my profile" button, offered by the
  JHA builder (a profile with no serial at load, or a serial typed that the
  kit on file does not hold, after a pause) and by Job detail’s close-out
  dialog for the closer’s own row; `dosimetryPrompt.js` holds the pure
  questions (`newSerials`, `mergedSerials` — keeping never blanks a serial
  the profile has) and the once-a-session mark both screens share. The
  screens fall back (PGRST202 or a message naming the function) to keeping
  the serials on the assessment alone. Before it,
  `20260906033223_the_error_log_can_be_cleared.sql` (probes in
  `supabase/handover/probes-20260906033223-the-error-log-can-be-cleared.sql`):
  `clear_function_errors()`, an Admin-only definer RPC behind the Admin
  screen’s Clear button, empties the whole log — signed-in accounts hold no
  delete grant on the table. Before it,
  `20260905222931_the_wipe_deletes_a_batch_at_a_time.sql` (probes in
  `supabase/handover/probes-20260905222931-the-wipe-deletes-a-batch-at-a-time.sql`):
  `restore_wipe_batch(table, limit, keep_id)`, the service role’s alone,
  empties at most `limit` rows of one of the tables a restore wipes and says
  how many went, raising on any other table name and keeping a row back from
  profiles alone. The wipe calls it until a short answer says the table is
  empty; see the restore rules below for why one unbounded DELETE could not.
  Before it,
  `20260905105635_a_patch_is_an_update_not_an_upsert.sql` (probes in
  `supabase/handover/probes-20260905105635-a-patch-is-an-update-not-an-upsert.sql`):
  `restore_patch_rows(table, rows)`, the service role’s alone, writes back
  the three columns a restore has to set a second time
  (chat_messages.reply_to, tickets.total, jobs.last_activity_at) and raises
  on any other table. It is an UPDATE and not a partial upsert because Postgres builds
  the proposed tuple and checks NOT NULL on it before it ever looks for the
  conflict, so `{id, total}` fails on tickets.job_id however certainly the
  id is already there. The automatic backup’s own columns, `backup_runs`,
  `backup_state()`, `backup_schema_version()`, `restore_chat_messages()`
  and the five-minute cron job arrived one migration earlier in
  `20260905080604_the_project_backs_itself_up.sql` (probes in
  `supabase/handover/probes-20260905080604-the-project-backs-itself-up.sql`).
  Before those, `20260904135107_the_token_is_not_the_record.sql`: tab_access()
  /user_role() read profiles instead of the token claim and answer
  empty/null for a `deactivated_at` account, profiles insert is Admin-only
  above Technician/Helper and delete is an Admin’s alone, delete_job returns
  its PDF keys behind an is_staff() door with a coalesced admin test,
  guard_job_update’s client gate is null-safe (a null rank read as
  Coordinator), the equipment functions count Edmonton days rather than UTC,
  public.dose_totals sums the ledger in the database, and filing a report
  needs the upload tab alone.
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

## Access rules the database enforces (probe with role simulation)

- `is_staff()` means at least one tab. Stripping every tab locks an
  account out of the API, not only the menu. delete-user locks (Auth ban +
  `profiles.deactivated_at` + no tabs) an account with work on file instead
  of deleting it, because the foreign keys keep history's names.
- An Edge Function that switches to service authority asks
  `requireActiveAdmin` in `_shared/adminGate.ts`, never the rank alone. The
  decision is `adminRefusal` in `_shared/activeAdmin.ts` (pure, import-free,
  in the guard list) and its order is the point: the read's own error first
  (fail closed, 503 and words that say to try again — `const { data }` used
  to discard it, so a database blink read as "no profile" and then as an
  ordinary refusal), then `deactivated_at`, then at least one tab, then
  Admin last so a locked Admin and a locked Helper hear the same sentence.
  Every door selects `ADMIN_SELECT`, because a `select("role")` that forgot
  the other two columns is how this was written the first time. Six doors
  come through it: `requireAdmin` in backupCommon (and so `backupDoor` and
  the three backup functions), create-user, delete-user, unlock-user,
  password-reset, mail-test. Two states made it reachable — delete-user
  locks the profile BEFORE it bans the Auth user and returns
  `banFailed: true` when the ban does not land, and stripping every tab is a
  revocation that needs nothing to fail at all. **unlock-user also refuses
  its own caller** (`userId === callerId`, before the ban is lifted): an
  unlock is the one act that undoes a removal permanently, so it does not
  rest on a single check. delete-user has always refused its own caller;
  that asymmetry is what hid it. `activeAdmin.test.mjs` holds all of it.
- Filing a report needs the `upload` tab, never the `job` tab
  (20260904135107 §7): reports_insert and the storage `reports write`
  policy name upload alone, so a Helper — who holds job — cannot file a
  radiographic report; both READ policies keep their job arm. Job detail's
  "+ Upload report" asks tabList the same question; the button is the
  courtesy, the policy is the gate.
- A role change is an Admin's (`profiles_update` WITH CHECK); the users tab
  alone grants tabs, never rank.
- Signed-in accounts may update only a JHA's close-out columns (column
  grant); the functions write the rest with the service role.
- `jobs_guard_update` trigger: job_number/created_by/created_at are fixed,
  status changes are Admin-only, client changes Admin/Coordinator. There is
  no direct DELETE on jobs — `delete_job` is the only door, and a non-admin
  transfer may target only a job they raised.
- Prices are for Admins and Technicians (per Kyle): rate_lines,
  rate_overrides, rate_line_history and ticket_lines SELECT require the
  role as well as the tab — and so do the WRITES (ticket_lines insert/
  delete, every rate_lines/rate_overrides/rate_schedules write), because a
  role that cannot read a ticket's lines must never replace them (a
  Coordinator's save once read zero lines and deleted the real ones).
  `search_tickets` and `ticket_tracker_stats` hand other roles null money.
  `seesPrices(user)` in data.js is the one client-side answer; Job detail,
  Open tickets and the tracker all ask it. A Coordinator cannot price a
  ticket until the role is added to those policies.
- Money that leaves the building is read with the service role, not taken
  from the caller: send-ticket-approval builds the emailed summary from its
  own `loadInvoice` read, because the database hands a non-price role null
  totals and the browser's figures are whatever that role could see. Same
  reason the tracker's money buttons ("Chase all unsigned") sit behind
  `seesPrices` — one tap would otherwise mail every client a $0.00 approval.
- A ticket's money is read through a view. `tickets_read` (definer,
  security_barrier, its own explicit `is_staff()` predicate mirroring the
  tickets SELECT policy) masks `total` to null for anything but Admin and
  Technician, and `search_tickets`, `ticket_tracker_stats` and
  `ticket_aging()` are built over it (20260912205211). Since
  20260912210854 the base table carries NO table-level SELECT grant for
  `authenticated` and no `total` column grant: a signed-in account reads
  the named metadata columns only, and `approval_token`,
  `approval_expires_at` and `approved_ip` are off that list on purpose —
  the token is a stored credential, the IP is a client rep's, and only the
  service role (approve-ticket, mailApproval, the backups) reads them. So a
  NEW COLUMN on tickets is invisible to the app until it is added to BOTH
  the grant list in that migration and to `tickets_read`, and a
  `select("*")` on tickets from the client is now a 42501. Row scope
  changing in the tickets SELECT policy must change the view's predicate in
  the same commit. The deployed-API probe
  `supabase/handover/probes-ticket-money-select-api.mjs` is what proves
  PostgREST still resolves the reverse `ticket_lines` embed through the
  view (getTicket and the archive both depend on it); it reads only.
- tickets has a column-level UPDATE grant: signed-in accounts write
  status, client_contact, contractor_contact, delays and chased_at, nothing
  else. The approval plumbing (approval_token/sent_at/expires_at/sent_to/
  sent_by) is the service role's alone — a policy can't pin a column it
  doesn't name, and an unpinned token column let a technician plant a hash
  and sign their own ticket from the link. Withdrawing an approval is the
  `withdraw_ticket_approval(id)` definer RPC. `total` is the trigger's.
- `updateTicket` refuses a Draft write over an Awaiting-approval ticket
  (plainError, flagged `sentForApproval`). "Draft" is the word every save
  sends — the editor hardcodes it and a queued replay carries it hours
  later — so letting it through replaces the lines and moves the money under
  a live approval link. A live save shows the refusal and stops. A queued
  replay saves what it still can and then parks: App.jsx catches the flag,
  writes the crew hours (they stay writable until the client signs, and they
  are the day's pay), skips the approval resend so the rep's token is not
  reset mid-signature, raises the forced toast once (checkpoint
  `refusalTold`), and re-throws the refusal so the item stays in the outbox
  with it as `lastError` — badge lit, the queue panel saying the hours are on
  the ticket and only the welds and charges were not. Retrying is safe (a
  refused update and a crew delete-then-insert, the same refusal again);
  discarding is how it ends. The one exception is this item's own send:
  `checkpoint({ sendAttempted: true })` is written in sendTicketApproval's
  CATCH, and only when `isNetworkError` — a reply the radio lost is the
  ambiguous case, because the send may well have moved the row. A send the
  server refused (a 403, a bad address) never moved it, so marking that one
  would dress a later send by the office up as this item's own. The ticket
  editor sets the same flag on its own enqueue (`sendAttempted: stage ===
  "email"`) when the reply it lost was its own send's. A refusal met
  with `sendAttempted` set is therefore the row this same item moved to
  Awaiting approval — its lines are already there, and the replay completes
  quietly. `withdraw_ticket_approval` is the only way to re-price the ticket.
  A refusal the server actually gave (`.plain`) is a reason whatever the
  radio says: oqFlushOnce checks `.plain` BEFORE isNetworkError, which calls
  any error "offline" while navigator.onLine is false — a refusal rethrown
  into a dead spot would otherwise stop the flush with no reason written.
  The three field screens keep that same order (ticketMobile, jhaMobile,
  uploadMobile): tested the other way round, a refusal met in a dead spot
  was queued as work to retry and the recovery copy dropped.
- Invoicing is `mark_tickets_invoiced(ids, invoiced)` (Admin, definer) —
  Approved ↔ Invoiced with `invoiced_at`; the approved-ticket immutability
  policies are untouched and this RPC is the only door. The tracker's
  "Mark invoiced" and "Back to approved" are an Admin's to match: the row
  buttons, the bulk button, the tick column's header, its cells and the
  empty row's colSpan all read one `picking` flag, so the five cannot drift
  and a Coordinator holding the tab is not offered a 42501.
- Idempotent saves: tickets.client_key / reports.client_key /
  jhas.client_key (unique). The ticket editor and the JHA builder mint a
  key per unsaved record (kept in the recovery copy and the outbox
  payload); createTicket/uploadReport/createJha return the existing row
  for a repeated key instead of inserting again — and a failed key lookup
  is the save's failure, never a green light. The queue's ticket replay
  passes the key too (it once didn't, on the one path that mattered).
- contacts, equipment, timesheet_approvals and arcade_scores reads need
  `is_staff()` too, so a locked account's unexpired token reads nothing.
- A client rep's "Query this ticket" (approval page) writes tickets.
  queried_at/query_text/query_by with the service role; the tracker shows
  it; send-ticket-approval clears it on resend. It is two updates, in this
  order. First the words: `query_text`/`query_by`, unconditional bar
  `approved_at` and touching no timestamp (a filter on `queried_at` once
  dropped a second — different — query inside the window while the page still
  told the rep it had been sent). Then the mail gate: a conditional UPDATE of
  `queried_at` alone, `.is("approved_at", null)` plus `.or(queried_at.is.null,
  queried_at.lt.<15 min ago>)`, with `.select("id")` — a row back means this
  request won the window and may mail, zero rows means another one just took
  it. That order is the point: the gate spends the window, so nothing is spent
  before the rep's words are on the record. `queried_at` means "when we last
  told the office", not when the rep last spoke, and the gate is its only
  writer — writing it beside the words slid the window forward on every post,
  so the throttle lifted only after 15 minutes of total silence. notifyQuery
  runs only for the winner, so a burst mails once. The ticket read at the top
  of handle() deliberately does NOT select `queried_at`: deciding the gate
  from that copy is no gate at all — every racing request reads the same
  stale null and every one of them mails, which is the flood arriving by the
  one door the limit was watching. A send that throws still spends the
  window. The page gives the same receipt either way, because the link is
  the whole credential and it gets forwarded.
  jobs.last_activity_at is kept by definer triggers on tickets/jhas/reports
  (private.touch_job_activity) and orders the board (search_jobs).
  search_tickets also returns filtered_total (null for non-price roles).
- Accounts: create-user with `invite: true` mints a password nobody knows
  and mails Auth's recovery link through Resend (_shared/setPassword.ts);
  password-reset (Admin-gated) mails the same link to an existing account.
  Both land on the app's own set-password screen. The link's redirect is
  the approval base URL's origin, else the Auth Site URL.
- Archive (the Admin screen's dropdown, deliberately not Home): every job
  raised in a year or date range, zipped in the browser
  (vite-app/src/archive.js), filed client → month raised → job, each job
  folder holding Job details.txt, JHAs/, Reports/, Invoices/ (HTML), plus
  Index.csv and README.txt at the top. A finished build is kept on the
  device for a day (`archive.built` in the OfflineCache: zip name, manifest,
  summary, the jobs' ids and dbIds, written after the download and read
  straight back before the dialog believes it), so the Admin can check the
  zip and clear the next morning: reopening offers "Check that zip", and a
  resumed clear acts on the HELD job ids — never the range picker's current
  count, which may be sitting on another year. Building again, or a
  completed clear, forgets it. The build keeps a manifest (name,
  size, CRC per entry); the dialog then makes the Admin pick the downloaded
  zip and verifyZip reads its central directory back against the manifest
  AND checksums each entry's stored bytes (`payloadIntact`), because a zip
  with a bad sector kept a good directory and checked out "each intact".
  Only a zip that checks out, from a build with nothing unretrieved,
  unlocks the clear — behind a typed CLEAR — which is
  `archive_clear_jobs(ids)` (Admin, definer): it deletes those jobs and
  everything under them, approved tickets included (delete_job refuses
  them), and the client removes the PDFs from the two buckets. Jobs are
  chosen by created_at on local days. It is one of the app's two bulk
  deletes — restore-all's wipe phase is the other, and it has its own four
  gates; keep every one of those gates. The screen threads `onArchiveCleared`
  through to the dialog, so a clear also makes App let go of the job and
  ticket it was holding open and reload the drafts badge — the cleared job
  may be the one the drawer was pointing at.
- The clear re-checks before it deletes: immediately before
  `archive_clear_jobs`, inside `liveOnly`, every job's ticket/JHA/report
  counts AND the ids of what each one held (`archiveIds`, one sorted string
  per job) are read again and compared with the build's (`archiveDrift`). Any
  drift — or a read that failed, or a build from before the ids were
  recorded — refuses, because the build and the button can be hours apart,
  counts alone let a report deleted and another filed pass, and checking the
  zip cannot see work filed since.
- The build batches its per-ticket reads (`listTicketsForArchive`,
  `listCrewForTickets`, one call each per job) and renders the field
  invoices at concurrency 4 through `mapLimit` — each is an Edge Function
  call. A busy year is still thousands of files and can run to an hour;
  keep that expectation in the dialog's wording. The zip has no zip64:
  makeZip refuses past 65,535 entries or 4 GB (66,000 files were masked into
  a 16-bit field and read back as 464), and buildArchive refuses as the entry
  that would break the trailer is added, not after the downloads.
- The archive build reads inside `OfflineCache.liveOnly(fn)`: a remembered
  copy must never stand in for the server's answer when the clear behind it
  is a real delete. Inside it readThrough rethrows instead of falling back,
  and the failed read becomes a missing entry, which blocks the clear. The
  flag is module-wide and depth-counted, so nothing else may read from the
  cache while a build runs — keep the build's reads inside it.
- `authenticated` has USAGE on schema `private` (migration 20260903055300).
  A policy expression is stored resolved and never needed it; a SQL or
  plpgsql function that runs as the caller and names `private.user_role()`
  is parsed at call time and did — the tracker's stats and search failed
  for every account for three minutes after round three's migration until
  the live probe caught it. Probe every new invoker function as a
  non-owner before calling it done.
- One technician never edits another's ticket; an Admin edits anyone's
  (per Kyle). Three gates say so and must agree: Job detail opens another
  technician's draft read-only (`editable` wants `isAdmin || mine`, the row
  title says why, the button says View), the editor refuses to load a
  ticket whose `technician_id` is not the signed-in account's unless it is
  an Admin (`loadDraft`, for the tracker and anything else that reaches it
  by id), and `private.can_write_ticket` is own-or-Admin in the database.
  Reading is not editing: any account that sees prices reads any ticket's
  invoice, which is how a technician taking over a job sees how the last
  one billed it.
- Job detail's Create ticket dialog inserts nothing: it hands a seed (work
  date, this ticket's reps) to the editor, which saves — and queues — like
  a ticket started from Home.
- The new-work buttons carry the same gates as the screens behind them:
  Home's "+ Ticket" wants the ticket tab and `seesPrices`, exactly as Job
  detail's does, and "+ New JHA" waits on the job record the way Create
  ticket and Edit do — a JHA raised before the reps have been read is a form
  filled in with the client's usual contacts rather than this job's.

## Verification habits

- `npm test` before committing.
- Never round-trip source through PowerShell Get-Content/Set-Content (BOM
  issues). Use Edit tool or a node script.
- Never leave literal control characters in source — write the escape text.

## People

Kyle Keith (blacklabndt@gmail.com) is the admin and owner.
