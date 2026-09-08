# VagaboNDE Field Ops — Beta 2

RT weld-inspection field app for a crew in Grande Prairie, AB. Beta 2 opened
on 7 Sept 2026 from Beta 1's last commit (7cb2b93, repo
`Vagabonde-Field-Ops-Beta1`, now the frozen release); it deploys to the SAME
Supabase project and Worker, so Beta 1's repo must not be deployed from again
or it will put the old build back over this one. React PWA
(`vite-app/`) over Supabase (project `eielmvxzdwwprmmfamlq`), deployed as
Cloudflare Worker `solitary-snowflake-ee22` (assets + the `/approve` and
`/backup/oauth/*` proxies in `worker/index.js`).

## Commands

- Test: `npm --prefix vite-app test` (render-name scan + node --test). The
  scan also refuses a hook below a component's first early return — the
  mistake that crashed the ticket screen and, once, the lapsed-session
  sign-out; `appShape.test.mjs` pins App.jsx's own ordering. Both count
  any `useSomething(` (a named list once approved the hook nobody had added
  to it), the scan sees the brace-and-newline return shape and components
  wrapped in memo or forwardRef, which it did not until 8 Sept.
- Build: `npm --prefix vite-app run build`
- Deploy: `npm run build && npx wrangler deploy` (from repo root)
- Dev server: use the `.claude/launch.json` `beta2-dev` config, not Bash

## Rules that are not in the code

- The build must be green **before** the commit, never beside it.
- Migrations: apply live first (timestamps come from the applier), then
  write the matching file under `supabase/migrations/` with that version.
  Repo files and applied migrations must reconcile 1:1. The history starts
  at `20260817040000_beta1_baseline.sql` — the whole schema squashed into
  one file, generated from the live catalogs; the 77 evolutionary
  migrations it replaced live in the prototype archive. It opens with
  `set check_function_bodies = off` and closes with a `reset`, because it is
  in catalog order and §2's sql-language helpers name tables §3 creates —
  without that it dies on its first statement in the fresh environment it
  exists for. Never apply the baseline to the live project; it is for fresh
  environments. Replaying the repo into a fresh project also stands up cron
  jobs and a chat push trigger pointed at THIS project's functions (six
  migrations bake the URL and publishable key in, `admin-digest-daily`
  the latest), so unschedule them and
  re-point the trigger before anything else — HANDOVER.md's Path B says how. An unshipped
  DB fix waits as a draft under `supabase/handover/` (probes beside it) —
  a draft, not history, until it is applied and filed under migrations.
  Nothing is waiting there now. The latest is
  `20260908101639_the_equipment_pages_in_a_total_order.sql` —
  `search_equipment` orders by type, serial_number, id: two items of one
  type with no serial were a tie, and an OFFSET page boundary inside a tie
  doubled one and dropped the other. Probe beside it. Before it,
  `20260908063429_a_locked_account_reads_only_its_own_row.sql` —
  `profiles_select` is `is_staff()` or the caller's own row, where it was
  "anybody signed in": a locked account's token stays good for an hour, and
  it read the crew's serials and id codes until then. Probes beside it
  (locked 1 row, own; staff all). Before it,
  `20260908053815_the_token_hook_reads_profiles.sql` — `grant select` on
  profiles (and USAGE on public) to `supabase_auth_admin`, the role Auth
  calls the SECURITY INVOKER `custom_access_token_hook` as; live had it all
  along, the baseline dropped it, and a fresh replay issued every token
  with no tab_access claim while the hook swallowed the denial. Probe
  beside it. Before it,
  `20260908044141_withdrawing_an_approval_is_the_offices_too.sql` —
  `withdraw_ticket_approval` states its own gate (the ticket's technician,
  an Admin, or a Coordinator) instead of borrowing `private.can_write_ticket`,
  which 20260907044223 narrowed to own-or-Admin for the lines and crew
  writes and, unnamed, took the Coordinator's Cancel approval with it.
  Probes beside it (Coordinator 1, other technician 0, own 1). Before it,
  `20260907175805_the_error_log_clear_says_where.sql` — the Clear button's
  `clear_function_errors()` deletes `where true`, because the authenticator
  role preloads pg-safeupdate, which refuses an unfiltered DELETE or UPDATE
  in every API session, definer functions included ("DELETE requires a
  WHERE clause"). Any new bulk door needs a WHERE, even a `where true`;
  the probe beside it cannot load the library (refused outside the API's
  sessions), so the button is the end-to-end check. Before it,
  `20260907044223_a_ticket_is_edited_by_its_technician_or_an_admin.sql` —
  `private.can_write_ticket`, the gate behind every ticket_lines and
  ticket_crew write, is the technician's own or an Admin's; the Coordinator
  arm it carried since the baseline is gone (the tickets UPDATE policy keeps
  its Coordinator arm for the tracker's chase and query columns, which are
  the office's and not the bill). Probes beside it. Before it,
  `20260906181829_the_shared_drive_is_deleted_by_the_office.sql` — the
  `shared delete` storage policy needs Admin or Coordinator as well as the
  files tab (the Files screen's × was a courtesy with no gate behind it);
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
  data.js and `invoiceTotals` in invoice.ts both take the client's rate; a
  missing rate reads as 5, never as exempt. Before them,
  `20260906143757_the_office_hears_about_failures.sql` — the pg_cron job
  `admin-digest-daily` (13:00 UTC) calling the `admin-digest` function,
  which mails every active Admin only when something needs attention — and
  `20260906143715_the_tracker_knows_how_old_the_money_is.sql` —
  `ticket_aging()`, invoker rights, counts for everyone and money for the
  price roles, behind the tracker's aging tiles and By client view (probes
  beside each under `supabase/handover/`). Before them,
  `20260906135356_a_worker_keeps_their_own_serials.sql` (probes in
  `supabase/handover/probes-20260906135356-a-worker-keeps-their-own-serials.sql`):
  `set_own_dosimetry(tld, drd, alarm)`, a definer RPC any signed-in, unlocked
  account may call to write the three serial columns on its OWN profile row
  and nothing else — the "Keep these on my profile" button, offered by the
  JHA builder (a profile with no serial at load, or a serial typed that the
  kit on file does not hold, after a pause) and by Job detail's close-out
  dialog for the closer's own row; `dosimetryPrompt.js` holds the pure
  questions (`newSerials`, `mergedSerials` — keeping never blanks a serial
  the profile has) and the once-a-session mark both screens share. The
  screens fall back (PGRST202 or a message naming the function) to keeping
  the serials on the assessment alone. Before it,
  `20260906033223_the_error_log_can_be_cleared.sql` (probes in
  `supabase/handover/probes-20260906033223-the-error-log-can-be-cleared.sql`):
  `clear_function_errors()`, an Admin-only definer RPC behind the Admin
  screen's Clear button, empties the whole log — signed-in accounts hold no
  delete grant on the table. Before it,
  `20260905222931_the_wipe_deletes_a_batch_at_a_time.sql` (probes in
  `supabase/handover/probes-20260905222931-the-wipe-deletes-a-batch-at-a-time.sql`):
  `restore_wipe_batch(table, limit, keep_id)`, the service role's alone,
  empties at most `limit` rows of one of the tables a restore wipes and says
  how many went, raising on any other table name and keeping a row back from
  profiles alone. The wipe calls it until a short answer says the table is
  empty; see the restore rules below for why one unbounded DELETE could not.
  Before it,
  `20260905105635_a_patch_is_an_update_not_an_upsert.sql` (probes in
  `supabase/handover/probes-20260905105635-a-patch-is-an-update-not-an-upsert.sql`):
  `restore_patch_rows(table, rows)`, the service role's alone, writes back
  the three columns a restore has to set a second time
  (chat_messages.reply_to, tickets.total, jobs.last_activity_at) and raises
  on any other table. It is an UPDATE and not a partial upsert because Postgres builds
  the proposed tuple and checks NOT NULL on it before it ever looks for the
  conflict, so `{id, total}` fails on tickets.job_id however certainly the
  id is already there. The automatic backup's own columns, `backup_runs`,
  `backup_state()`, `backup_schema_version()`, `restore_chat_messages()`
  and the five-minute cron job arrived one migration earlier in
  `20260905080604_the_project_backs_itself_up.sql` (probes in
  `supabase/handover/probes-20260905080604-the-project-backs-itself-up.sql`).
  Before those, `20260904135107_the_token_is_not_the_record.sql`: tab_access()
  /user_role() read profiles instead of the token claim and answer
  empty/null for a `deactivated_at` account, profiles insert is Admin-only
  above Technician/Helper and delete is an Admin's alone, delete_job returns
  its PDF keys behind an is_staff() door with a coalesced admin test,
  guard_job_update's client gate is null-safe (a null rank read as
  Coordinator), the equipment functions count Edmonton days rather than UTC,
  public.dose_totals sums the ledger in the database, and filing a report
  needs the upload tab alone.
- RLS changes get probed live with `set_config('request.jwt.claims', …)`
  role simulation before they ship. Permissive policies OR together — a
  new `FOR ALL` policy can silently void an older condition.
- Money: integer-cents rounding (`gstOn(subtotal, ratePercent)` in `data.js`,
  the rate from the client's row via `gstRateOf`); never float-sum. A line's
  own charge is `lineTotal` in data.js and `lineCents` in invoice.ts (both
  exported, both whole cents times thousandths of a unit) and no third
  formula: a float product put the foot bar, the emailed invoice, the CSV
  and the archive a cent under the trigger's `round(quantity * unit_rate, 2)`.
- Rates come from the Rate admin screen, never hardcoded. Billing is per
  truck, not per technician. PO = AFE. Hotel = subsistence. solo/soloOt
  are timesheet-only and never billed.
- The rate card IS the billing menu: the ticket screen's dropdowns, their
  order, and the invoice's line order all come from the client's published
  schedule (`getPublishedRatesForClient` → catalog). A client whose
  schedule has `follows_default` on prices from the house card, live.
  Publishing matters exactly once per card — after that, edits go live as
  they save — which is why the Publish button hides once pressed.
- A saved ticket can hold lines the card no longer offers. linesToForm
  returns them as `orphans`; the ticket screen lists them read-only under
  "No longer on the rate card" (× to drop one), buildLines writes them back
  verbatim — label, unit and the rate they were filed at — and their cents
  are in the total. Silently dropping them would rewrite somebody's bill.
- Crew hours are private: the ticket_crew read policy is own rows, Admin/
  Coordinator, or crewmates on a shared ticket (private.shares_ticket).
  Never widen it back to a tab check.
- The Timesheets dose ledger sums in the database: `dose_totals(start, end)`
  — SECURITY INVOKER on purpose, narrowed again to own rows or Admin — so a
  year is forty-odd numbers, not 30k crew rows over the wire. It is live
  (20260904135107); the screen keeps a fallback to the old row walk for a
  database that has not had that migration — a fresh environment — on
  PGRST202, or on an error whose message names dose_totals and says it
  could not be found, because older gateways only say it in words. Both
  halves of that test matter: no other code falls back, and no message
  falls back unless it names the function, so a permission refusal or a
  timeout still reaches the screen as itself.
- PostgREST silently caps responses at 1,000 rows. Anything that means
  "all of them" pages, and `paging.js` has two shapes: fetchAllPages
  (concurrent, by OFFSET) for the reference lists, where a row deleted
  mid-walk only costs a reappearance next load; fetchAllKeyset
  (sequential, "the next thousand after this id") for anything people are
  paid or billed from, where an OFFSET walk can skip a row silently.
  listTicketsForExport is the exception: search_tickets is an RPC with no
  cursor, so it pages by page_num and keeps that caveat.
- `Db.listJobs` is gone. A job picker is `SearchSelect` over `Db.searchJobs`
  (server-side, paged) — the delete-job transfer target and Rate admin's job
  override are the two. Never read every job to fill a dropdown; the
  archive's `listJobsCreatedBetween` is bounded by its date range.
  `SearchSelect` also fronts in-memory lists when a dropdown got long: the
  ticket editor's crew picker (`searchCrew`, over the cached crew by name,
  initials or id code, technicians before helpers, a pick adds the person in
  the role `crewRoleFor` decides and never twice) — its `search(text, max)`
  returns `{ rows, total }` either way. The JHA's helper field stays a
  native select because it holds one value with a "working alone" option.
  Contacts filters an organisation's people client-side (name, title, email,
  phone) and the pager counts the filtered set; the list was already
  fetched per organisation, so nothing new is read.
- The offline queue is for work only — scores, telemetry and other
  nice-to-haves call the API directly and fail soft. `savingWords.js` holds
  the two decisions the three field screens share: `deviceOffline()` sends a
  save straight to the outbox when the device already knows there is no
  signal (the token refresh in front of a failed save cost eight frozen
  seconds otherwise), and `savingLabel(elapsed, base)` names the outbox
  while a long wait is happening. Keep new field saves going through both.
- A queued report whose upload synced but whose email failed raises one
  forced toast naming the job and the recipient and where to resend it
  from (App.jsx's report replay) — a console line was the whole record of
  that before, and the report sat Pending until somebody wondered.
- The device cache has an owner (`cache.owner`, `OfflineCache.claimFor`):
  signing in — and a session restored at boot — empties the store first
  unless this same account already owns it, so a shared tablet never hands
  over the last crew's jobs, rates and half-entered tickets. Boot clears
  outright only on the server's `signedOut`; offline-with-no-identity and a
  merely lapsed session forget the identity and nothing else, so the same
  person's recovery copies survive going out of range or signing back in —
  `cache.owner` and `claimFor` are the gate that keeps a stranger from them,
  not a boot-time wipe. Sign-out clears everything, and
  still asks first when drafts or queued work would go with it. The outbox
  has the same owner: `oqFlushOnce` asks who is signed in again before every
  item, never once for the list, because a slow upload can span a change of
  hands and the last person's work replayed under the next session is
  refused by RLS and stamped "won't sync", one tap from being discarded.
- auth-js does not remove the stored session when `signOut` fails — offline
  it refreshes an expired token first and returns the failure, leaving the
  session on disk for the next reload to sign straight back in. Every
  sign-out path therefore checks the error and calls `forgetStoredSession()`
  (config.js; `AUTH_STORAGE_KEY` names the key supabase-js derives, so the
  two cannot drift). Keep new ones doing it.
- Tabs are PERMISSION; drawer visibility is code. The contextual screens
  (`CONTEXT_TABS`: job, jha, upload, ticket) never appear in anyone's
  menu — they open from a job's own page, per Kyle. Never "hide" a screen
  by removing its tab from a profile: that revokes RLS/storage access too,
  which is exactly the invisible breakage that rule replaced.
- Client-facing HTML: the invoice body is
  `supabase/functions/_shared/invoice.ts`; the approval page's own chrome
  (`page`, `signForm`, `queryForm`) is approve-ticket's. Both escape every
  interpolated value with `esc()`, which lives in `_shared/mail.ts`. The
  in-app viewer iframe stays sandboxed.
- Accounts are created by the create-user Edge Function (Admin-gated,
  service key, arrives email-confirmed), never by client signUp: the
  signup endpoint answers to anyone with the publishable key, so the
  provisioning trigger caps metadata roles to Technician/Helper and the
  function writes the real rank itself. Never widen the trigger's role
  allowlist back.
- The chat composer is held whole across a screen change — words, the
  message being answered, an unsent picture, an unlistened voice note — in
  `chatDrafts.js`, keyed by profile id and cleared at sign-out. Files are
  held as Files and the screen mints a fresh object URL on remount, because
  it revokes its own on unmount; the room's first load drops a held reply
  whose parent has gone. Nothing in the shell may import the chat chunk for
  this — the module exists so sign-out can reach it without doing so.
- Team chat forgets: unpinned messages expire after 30 days, deleted by
  the chat-retention Edge Function (it also removes their chat-media
  pictures), fired nightly by the pg_cron job `chat-retention-nightly`.
  Media goes before rows, so a storage failure strands no object nobody
  sweeps, and the delete itself carries `.is("pinned_at", null)` again — a
  message pinned during the seconds the media took went too. A row pinned in
  that window has already lost its picture, so the run heals it: the dead
  image_key/audio_key come off and a row left with nothing gets words naming
  which one went, because `chat_messages_says_or_shows` refuses an empty row
  and would fail the whole nightly pass.
  Message bodies are immutable by column grant — only pin columns are
  updatable, Admin-only. GIF search is KLIPY (Tenor's API is dead);
  the key lives in app_settings (see below), handed out by gif-search.
- App configuration lives in the app_settings table (one enforced row,
  Admin-only RLS), edited from the Admin screen (tab key "mail", label
  "Admin"): Resend key + sending addresses, the approval-link base URL,
  the KLIPY key. Email rides Resend (shared module
  supabase/functions/_shared/mail.ts). The old env secrets
  (RESEND_API_KEY, MAIL_FROM_*, KLIPY_API_KEY, APPROVAL_BASE_URL) are
  FALLBACKS only — a table value wins, so rotating a secret does nothing
  while a table value exists. With a key but no verified sending address
  the transport is in testing mode: every send goes out under Resend's
  onboarding sender, which delivers only to the inbox the Resend account
  was created with — a send to anyone else is refused by Resend and
  mail.ts translates that refusal into a plain message naming the fix.
- The drawer's "Feature request" button (beside the Animations switch, for every account)
  mails the owner through the `feature-request` Edge Function: the
  recipient is the function's own constant (`FEATURE_REQUEST_TO`), never
  taken from the request, the reply-to is the sender's address, and the
  body carries the sender's name and role above their words. A direct
  call, not the offline queue — it fails soft and keeps the text in the
  dialog. Dialogs render after `<main>` in App.jsx and `.dialog-backdrop`
  carries z-index 100 (above the bar, banner and drawer; below the egg
  overlay at 200 and the toast at 300) — one rendered ahead of main once
  sat under the jobs table and took no clicks.
- The screen is in the address bar: `vite-app/src/route.js` (pure, node-
  tested) spells `#/board`, `#/chat`, `#/job/S-10113` and
  `#/job/S-10113/ticket`; App.jsx pushes one history entry per screen
  change and answers popstate, so Back steps back a screen and a reload stays
  put — except within one job: `historyStep(prev, next)` answers "replace"
  when both addresses are the same job's screens (its page, its ticket, its
  JHA, its upload), so a technician who went job → ticket → job → JHA
  reaches the board with one Back instead of four. A ticket/JHA/upload
  address degrades to its job (`landingRoute`) —
  the address never said which draft. Our hashes always start with `/`;
  Auth's recovery hash never does, and `recovery.js` now also demands an
  access_token before showing the set-password screen. Anything that
  rewrites the URL (the `?goto=` and `?backup=` strips) must keep the hash.
- `NumField` refuses a keystroke that would leave an invalid number instead
  of dropping it (`numberInput.js`, tested) and honours `step`: a whole step
  takes no decimal point, so `CATALOG_STEP` in db.js names the units billed
  in fractions (h and days by the half, km by the tenth). A minus sign is
  refused, never silently made positive.
- `saveCrewForTicket` upserts on (ticket_id, profile_id) then deletes the
  rest — two devices saving one draft used to collide on the unique key and
  drop one side's hours. Keep it upsert-first: a failure leaves a person
  too many, never an empty crew.
- A queued ticket replay is last-write-wins, and says so when it mattered:
  the payload carries `baseFingerprint` (`ticketFingerprint.js`, what the
  edit started from — db.js remembers the last loaded/written lines and crew
  per ticket in `lastKnownTicketFingerprint`), the replay fingerprints the
  row before writing, and when the row differs from both the base and the
  payload somebody else saved in between: it still writes, then raises one
  forced toast, checkpoints `overwroteNewer` and leaves a note in the device
  cache (`overwriteNote.js`, `ticket.overwrote.<id>`) that the editor shows
  as a banner when that ticket is reopened, until "I've checked" removes
  it; `deleteTicket` forgets it with the recovery copy. No base, no
  comparison.
- The ticket editor and the JHA builder end in a fixed `.screen-foot` bar
  (z-index 50, under the banner, drawer and dialogs) carrying the running
  total or "N required left" and the primary button; the pages pad their
  bottom for it. The dose export on Timesheets is every role's, scoped to
  the signed-in person for a non-admin.
- Open tickets cancels drafts in bulk through the same `Db.deleteTicket` the
  editor's Cancel uses, one after another (`runInOrder`), naming failures
  and leaving them ticked; App passes `onReload` so the drawer badge moves
  with the list. Rate admin counts the house card's followers
  (`listScheduleFollowers`, newest schedule per client) and a following
  client's Rate history shows the house card's changes under its own. Its
  New client dialog can copy another client's card (`copyDefaultInto(id,
  fromScheduleId)` — the house card when null): a copy, never a follow, and
  the copy lands BEFORE `follows_default` goes off, so a failed copy leaves
  the client priced from the house card rather than on an empty card; a
  source that itself follows the house card copies the house card. Once the
  insert has landed the dialog holds the client (`made`) so a failed copy is
  retried alone, never a second insert of the same name.
- The tracker's pure parts are modules: `chasePlan.js` (who a chase would
  mail, shown before it sends), `ticketAging.js` (the aging tiles and By
  client view over `ticket_aging()`), `accountingExport.js` (the two CSVs,
  GST per ticket from the client's rate). Open tickets' half-entered strip
  reads the device's recovery copies through `wipDrafts.js`, and its bulk
  cancel runs through `approvalRun.js`. Home's Needs attention strip asks
  `attention.js`'s four questions. Keep logic out of the screens and in
  those files, where `npm test` reaches it.
- The backup panel's list of earlier runs is `EARLIER_RUNS` (12) deep, each
  row showing records, files and size from `runRows/runFiles/runBytes` in
  `backupPanelLogic.js` — the same helpers the last-run sentence uses, so
  the two cannot drift — with `sizeTrend` drawing complete backup and
  before_restore runs scaled from zero and flagging `halved` when the latest
  is under half the one before. Five points on a daily schedule was too
  short to read as a trend.
- In-app help is `vite-app/src/help.js`, pure data keyed by screen key with
  a test that every TABS key has an entry under 200 words; the top bar's "?"
  opens it for the active screen. Keep it true when a screen changes. The
  button is for the first two days: `helpWindow.js` (pure, tested) keeps the
  account's first sight of it on this device as a `Store` preference
  (`help.firstSeen.<id>`, localStorage — sign-out clears the device cache,
  not Store, so signing back in does not restart the clock) and
  `helpOffered` nulls `helpEntry` in App.jsx after `HELP_WINDOW_MS`, on
  every screen at once. A record that is not a time keeps the button. The
  error log pages by keyset (`listFunctionErrors(limit, { before,
  functionName })`, the timestamp double-quoted inside the or()) and filters
  by function name.
- The JHA opens with nothing ticked (`SEED_HAZARDS` all `on: false`); the
  ticket editor asks once (`SANE_QUANTITY_*`, `SANE_CREW_HOURS` in data.js)
  before saving a figure that looks like a typo, and remembers the answer for
  that ticket session.
- Bulk sends go through `sendPool.js`, never a loop — "Chase all unsigned"
  is the caller, with thousands of emails to get out: 3 workers, a floor
  between starts, and a wait-and-retry for the two refusals mail.ts marks as
  transient (429 → "Resend is rate-limiting…", 5xx → "is unavailable…",
  carrying Resend's Retry-After, since only the message crosses the function
  boundary). It has a Stop button, and failures are named by ticket number
  rather than counted. What counts as an earlier nudge is
  `later(chased_at, approval_sent_at)`: only the tracker's own chase paths
  write `chased_at`, so reading it alone chased an approval the editor had
  sent that morning and put a fresh token over the one the rep was signing
  with.
- Approval tokens are stored hashed (`sha256:` + hex, see
  `_shared/approvalToken.ts` and migration 20260902211209); the raw token
  exists only in the emailed link. The token is NOT single-use — signing
  does not null it, so the link stays the rep's way back to the read-only
  signed page until the 30-day expiry (a resend refuses an Approved
  ticket, so burning it left them with no copy). Re-signing is refused
  three ways over: the already-approved branch returns before the POST
  handler, the sign UPDATE carries `.is("approved_at", null)`, and
  `authenticated` has no grant on the column. Only a resend replaces a
  token, and `withdraw_ticket_approval` nulls one on purpose. Approving is
  the service role's act alone: the tickets UPDATE policy's WITH CHECK
  pins the approval columns, so no signed-in account can set Approved.
  Probe it with role simulation if you touch that policy.
  Withdrawing is offered three places — Job detail's ticket row, the
  field-invoice viewer and the tracker row — each with a plain "Cancel
  approval" and a "Cancel and edit" that opens the ticket (the job record
  is read first, from the tracker, then the editor) once the list has
  re-read it as a draft; the RPC's own-or-office rule is the gate, not the
  button. The tracker's "Cancel and edit" is an Admin's alone: its row
  carries no technician_id, and loadDraft refuses another technician's
  ticket for anyone else, so a Coordinator's press killed the link and
  then met "another technician's ticket".
- The role→tabs defaults live in TWO places that must move together:
  ROLE_PRESETS in vite-app/src/data.js and tabs_for_role() in the
  database (create-user provisions from the latter). data.test.mjs reads
  the migration back and fails on drift.
- Chat push: an insert trigger fires the chat-push function via pg_net;
  it sends Web Push (VAPID_* secrets) to push_subscriptions minus the
  sender and prunes endpoints answering 404/410. The handlers live in
  public/push-sw.js, importScripts'd by the generated sw.js. A push
  endpoint belongs to the DEVICE: claim_push_subscription (definer RPC)
  is how the next tech on a shared tablet takes it over.
- Chat extras: chat_reads + the chat_unread_count RPC power the drawer
  badge and the "new messages" line; replies are reply_to (quote goes
  null if the quoted message dies — the reply stands on its own words);
  voice notes are audio_key in chat-media, cleaned up by delete and
  retention like pictures; job numbers in message text linkify by
  MEMBERSHIP against listJobNumbers, never by pattern — they're freeform.
- Automatic backup lives in two places and no others: the connection, the
  schedule and the three app registrations are columns on the one
  `app_settings` row (Admin-only RLS), and every run is a row in
  `backup_runs` (Admin may read, nobody may write — the writes are the
  service role's, from inside the functions). `backup_state()` is the
  panel's whole read and answers `has_secret_google`, never a secret: the
  refresh token and the client secrets are never selected by the client, and
  no new code may select them. A backup is
  a dated folder in the drive — `2026-09-05 02-00`, Grande Prairie's clock,
  no colon because Windows has no colon in a filename — holding
  `manifest.json`, `tables/` (one gzipped JSON part per table,
  `<table>.01.json.gz` and up) and `files/` (every stored object, its
  bucket and key percent-encoded into one flat name, because all three
  providers read a `/` as a folder). `app_settings` goes in with its
  credentials blanked (`APP_SETTINGS_SECRETS`); `profiles` carries an extra
  `auth_email` field that is not a column, because Auth holds the addresses
  and a restore has nowhere to send a set-password link without them.
- The files phase carries unchanged files over ON the drive
  (`docs/superpowers/specs/2026-09-07-backup-carries-unchanged-files-over-design.md`):
  once per run it picks a base — the newest stamped folder other than its
  own (`chooseBaseFolder`, pure), the run's own set aside by folder ID and
  never by the row's `folder_name`: the first slice reads its row before it
  makes the folder, and on a small database the tables phase finishes
  inside that slice, so the name was "" and the run took its own empty
  folder as the base (found live, 7 Sept) — and for an object in a write-once bucket
  (`WRITE_ONCE_BUCKETS`: reports, chat-media; keys never reused) whose name
  and size the base's `files/` already holds, `DriveClient.copy` makes the
  night's copy server-side (`carryOverId`). jhas, timesheets and shared are
  rewritten at the same key and are read through every night. Every folder
  stays complete on its own; restore and retention are untouched; a copy
  that fails falls back to download-and-upload, so the backup can never do
  worse than before. The cursor carries `baseLooked`, `baseFilesFolderId`
  and `reused`; `counts.reused` and the manifest's `files.reused` say how
  many, and the panel says "N carried over". Nightly Supabase egress is
  what is new, not the whole store times thirty.
- The tick is the only scheduler. pg_cron fires `backup-run` every five
  minutes with `x-internal-secret` (chat-retention's shape, read from
  `private.internal_config` when the job fires); `backup-run` drives kinds
  `backup` and `before_restore` and forwards `restore_all` and
  `restore_jobs` to `backup-restore`. The safety copy is NOT left to the
  tick: `stepSafety` queues the `before_restore` run and then kicks
  `backup-run` by name for it — deliberately unchained, so that a cron
  picking up the same row in the same second loses to backup-run's
  conditional claim instead of taking the copy twice. Before that kick a
  restore sat in `safety` until the next tick, and for ever on a project
  whose cron was missing or aimed elsewhere. The cron is still the backstop,
  which is why its own kinds come first, always: taking the restore ahead of
  them would leave a queued safety backup unstarted and the restore waiting
  on it. A `before_restore` run goes manifest → done and never
  reaches `retention` (`nextPhaseAfterManifest`): retention prunes the drive
  to `backup_keep` folders and cannot see which folder the restore behind it
  is reading from, so at `keep = 1` the safety copy's own retention step
  would delete the backup being restored, after the wipe. Retention also
  spares by name the folder of every queued or running restore. Work is done in slices of about 100 seconds (`BUDGET_MS`)
  with the position in `backup_runs.cursor`, and a slice that got something
  done kicks the next one itself — `{action:"advance", runId, chain:true}`,
  never a tick, because a tick reads the heartbeat that same slice has just
  written and calls the run busy. There is no separate kick secret; the
  chain signs itself with the same `x-internal-secret` the cron sends. The
  cron is the safety net, not the engine. A run whose `heartbeat_at` has
  been quiet for `SLICE_ALIVE_MS` — three minutes — died mid-slice and is
  reclaimed; every write a slice makes is conditional on the status it
  believes it holds, so a superseded slice writes nothing, not even its own
  failure — and the folder write on `folder_id` still being null, because a
  reclaim leaves both slices believing "running": the one reclaimed while
  making the folder gets zero rows back and stops. It removes that folder
  only after reading the folder the run recorded and finding it is another
  one; `ensureFolder` hands two slices inside a minute the same id, and an
  error or no row leaves the folder alone, because the delete once took the
  winner's backup — or the safety copy — with it,
  instead of splitting one backup across two folders. `backup_next_run_at` moves when a run STARTS, so a long night
  does not make tomorrow late and a failure does not stop tomorrow; the move
  is conditional on the due time the tick read, so two ticks that saw the
  same due time queue one run, not two into one folder.
- Restoring everything is gated four times — the caller's own Admin profile,
  a backup from a newer schema refused outright (`backup_schema_version()`),
  the Admin typing the backup's folder name (held against the name the drive gives preflight, never the request's own copy), and a complete safety backup of
  what is about to be replaced as the restore's own first phase — and the
  order of its phases is not the obvious one: safety → wipe → **accounts** →
  tables → files → activity. Accounts come before the records because
  `profiles.id` is a foreign key to `auth.users(id)` — a profile whose Auth
  user is gone cannot be inserted at all; an account that cannot be
  re-created is dropped from the load, counted, and named on the run rather
  than failing it. A retry does NOT take a second safety copy: `safetyToReuse`
  looks for the last failed `restore_all` on the same folder whose cursor
  carries a completed `safetyFolderName`, and under 24 hours old it is
  reused and named in the run's notes ("the safety copy from … is the way
  back"). Taking a fresh one would copy a database the failed attempt had
  already part-emptied — and it would be the newest folder in the drive, the
  one an Admin reaches for. The wipe follows
  `supabase/handover/wipe-seed-data.sql`'s
  own order (a test reads that file back), deletes in bounded batches through
  `restore_wipe_batch(table, limit, keep_id)` — the service role's alone, its
  table names a whitelist — because the role these functions reach the
  database through carries an eight-second statement cap it cannot raise, and
  one unbounded DELETE over 111,777 ticket_lines was cancelled and rolled
  back whole every time, so restore-everything could never finish on real
  data and left the app half wiped when it failed. A batch is 2,000 rows
  (`WIPE_BATCH`), halved down to `MIN_WIPE_BATCH` on a 57014 and no other
  error, with the size and the per-table `counts.wiped` on the cursor; the
  load's own `rate_line_history` clear goes the same way. It keeps the Admin
  running the
  restore so their session does not lose its permissions halfway, deletes
  `rate_lines` BEFORE `rate_line_history` (the delete trigger refills
  history), and clears `audit_log` and `function_errors` although neither is
  backed up, because their foreign keys to profiles would abort the delete —
  so a restored database starts with an empty error log, deliberately.
  Triggers stay on through the load, so the three values a trigger writes
  over go back afterwards through `restore_patch_rows`: chat quotes (a reply
  can sit in an earlier part than the message it quotes), the totals of
  tickets a client has signed or been billed for (every ticket loads at
  `total: 0`, because tickets_total_balances is a deferred constraint
  trigger and ticket_lines cannot load first; the lines' sync trigger then
  writes the figure, and only for a signed or Approved/Invoiced ticket is the
  backup's own figure put back over it), and `jobs.last_activity_at`, in the
  `activity` phase. Chat history itself loads through
  `restore_chat_messages`, which disables the push trigger around the insert
  and re-enables it in the same call — otherwise a restore buzzes every phone
  in the crew once per historical message. `app_settings` is
  never wiped and is restored by a narrow UPSERT of the one enforced row
  (`id = true`) that skips every `backup_*` column
  (`APP_SETTINGS_NEVER_RESTORED`), or the restore would replace the
  drive connection it is running through; and a secret column that is null
  in the backup is skipped rather than written, so a restore never takes the
  live Resend or KLIPY key out of the building. It is an upsert and not an
  update because the table ships with no row — on the fresh project a
  disaster recovery starts from, an UPDATE matches nothing and every setting
  in the backup is dropped in silence.
- Restoring chosen jobs deletes nothing and overwrites nothing: a row
  already present is left alone, so the same job restored twice is a no-op —
  and a job already here still keeps its id on `jobsHere`, so a retry after a
  half-finished restore fills in the tickets, assessments and reports that
  never landed. A ticket's id IS its number, so an id already in use — or
  one retired in `burned_ticket_numbers` — is a collision, and that ticket
  goes back unrestored with its lines and crew and is named in the report;
  the one exception is a ticket already here **on the job it came back
  under**, which is the second press of the button and is left alone
  unrepriced. `client_key` is checked the same way before the insert, since
  a duplicate key is a refusal that would fail the whole batch. An
  organisation is matched by id, then by name, then reported and left empty;
  a contact the same way but only inside the organisation the job ended up
  pointing at; a technician or signer that has gone is nulled; a
  `ticket_crew` row whose person has gone is skipped and counted, because
  `profile_id` is `not null` and those are somebody's hours.
- `nextRunAt` lives twice — `vite-app/src/backupSchedule.js` and
  `supabase/functions/_shared/backupSchedule.ts` — with a byte-identical
  block between the `shared core` markers, and `backupSchedule.test.mjs`
  reads both files off disk and compares them. Change one, change the other,
  in the same commit. Seven shared modules — `backupSchedule.ts`,
  `backupTables.ts`, `backupManifest.ts`, `backupRun.ts`, `backupOauth.ts`,
  `drive.ts` and `gzip.ts` — are erasable TypeScript with no imports of
  their own (`backupManifest.ts` may name `backupSchedule.ts`, and nothing
  else), because the node suite imports them straight out of
  `supabase/functions/` — an `enum`, a constructor parameter property, a
  `Deno.env` read or a control character in any of them breaks `npm test`,
  and `backupShared.test.mjs` asserts each of those. `backupRestore.ts` is
  import-free and node-tested too but is outside that guard;
  `backupCommon.ts` is deliberately outside it — it talks to supabase-js.
- The three backup functions deploy through the CLI like every other one
  (`npx supabase functions deploy <name> --project-ref eielmvxzdwwprmmfamlq`)
  and all three are pinned `verify_jwt = false` in `supabase/config.toml`,
  because a true pin would 401 the scheduler. Each guards itself before it
  parses anything: `backup-oauth` because the provider redirects a browser
  with no token (its callback is gated by a single-use nonce minted in
  `app_settings`, ten minutes old at most, and spent by an UPDATE filtered
  on the nonce actually presented — nulling it on the row's id alone let any
  stranger's GET clear the nonce Connect had just minted); `backup-run` and
  `backup-restore` on `x-internal-secret` OR an Admin JWT (`backupDoor` in
  `backupCommon.ts`).

## Rules the 0.92 optimization pass added (Sept 2026)

- `cached()` in db.js shares one in-flight read between callers in the
  same tick (`_inflight`), and `invalidate()` drops that entry too; a
  field save starts its idempotency-key lookup (`startKeyLookup`, resolves
  with its error rather than rejecting) and createTicket its first mint
  beside `assertJobOpen`, awaited in the old order so the job's refusal
  still wins. A pre-started lookup is consumed ONCE — createJha's 23505
  branch reads again, because re-awaiting the settled promise returned
  the same null that led to the insert.
- `OfflineQueue.flush` answers `joined: true` to a caller that joined a
  flush already running; `attachAutoFlush(handlers, onSynced)` and App's
  retryQueue act only on their own drain, so the outbox reload runs once
  however many `online`s a truck fires (tested). `oqNotify` coalesces its
  re-reads and never projects the list in memory.
- `Db.signedUrl(bucket, key, { fresh })` remembers chat-media links in
  memory (never OfflineCache, never another bucket — chat-media objects
  are never rewritten in place) for eight of their ten minutes; a caller
  whose load failed, and the lightbox by its own promise, pass `fresh`.
  `forgetChatMediaUrls()` runs at sign-out beside forgetHeldDrafts.
- `contactsForOrg` in data.js is the one definition of "an organisation's
  people, primary first", memoized where a dialog re-renders per keystroke;
  the ticket editor's rep box reads the cached directory. A ChatRow is a
  memoized message with its handlers behind one ref (`rowHandlers`);
  `pinKey` decides whether the pinned strip's array is replaced, and it
  carries the quote because that is the one field that moves.
- `mapLimit` lives in paging.js (archive.js re-exports it). The archive
  downloads and renders through ONE pool of four; the line export walks
  four disjoint batches at once, each a sequential keyset walk.
- `appSettings()` also carries the invoice's three settings as `invoice`;
  `sendMail({ settings })` and `loadInvoice(client, id, fallback,
  settings)` take a row the caller already read. One read per request,
  started early with a no-op `.catch` sink where an early return could
  otherwise leave a rejection nobody awaited — fatal in the Edge runtime.
  Never memoized across requests.

## Verification habits that caught real bugs

- "curl works" ≠ "a browser renders it": Supabase rewrites HTML to
  text/plain on the functions domain; the Worker exists because of this.
- The dev server hands out `?t=` module instances after edits — patching
  `import('/src/db.js')` reaches a different copy than the app holds.
  Spy-count before trusting a negative result.
- The browser pane suspends rAF when hidden: game/animation testing needs
  the preview panel visibly open.
- Verifying a deploy by fetching `/` can HIT Cloudflare's edge cache and
  show the previous index.html (query-string cache-busters don't help).
  Confirm instead that the newly hashed chunk files answer 200.
- Never round-trip a source file through PowerShell 5.1 Get-Content/
  Set-Content: BOM-less UTF-8 reads as ANSI and every em-dash, `·`, `…`
  and emoji ships as mojibake (it cost teamChat.jsx 71 characters once).
  Edit tool or a node script only.
- Never leave a literal control character in source (a `"\u0000"` join
  separator written as the byte itself): git then treats the file as
  binary — no diff, no blame, wholesale merge conflicts — and the review
  that should have read the tracker's changes couldn't. Write the escape
  text; the Write/Edit tools can turn an escape into the byte, so check
  with `grep -P '[\x00-\x08\x0e-\x1f]'` after writing one.

## Live data

The live project carries deliberate load-test seed data alongside Kyle's
real records: jobs `S-1%`, staff accounts `@seed.vagabonde.ca` (id_code
24400+), and generated orgs/contacts/tickets from 2026-08-18. It is all
identifiable by those markers when a cleanup is wanted:
`supabase/handover/wipe-seed-only.sql` removes exactly that, by marker.
`wipe-seed-data.sql` beside it is the handover reset — despite its name it
empties EVERYTHING except the owner account, and refuses to run until the
session has set `app.confirm_total_wipe = 'yes'`.

## Access rules the database enforces (probe with role simulation)

- `is_staff()` means at least one tab. Stripping every tab locks an
  account out of the API, not only the menu. delete-user locks (Auth ban +
  `profiles.deactivated_at` + no tabs) an account with work on file instead
  of deleting it, because the foreign keys keep history's names.
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

## People

Kyle Keith (blacklabndt@gmail.com) is the admin and owner. Technicians and
helpers see their own hours only; approval is Admin-role-gated in RLS, not
just in the UI.
