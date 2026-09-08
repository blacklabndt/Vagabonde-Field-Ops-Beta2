# VagaboNDE Field Ops — Beta 2

The field operations app for VagaboNDE Full Service NDE, Grande Prairie:
jobs, JHAs, report uploads, billing tickets rendered as the client-facing
field invoice, timesheets with approval PDFs, equipment, rates, and an
offline-first field path — a React PWA over Supabase, deployed on a
Cloudflare Worker.

This folder is Beta 2, opened on 7 September 2026 from the last commit of
Beta 1 (`Vagabonde-Field-Ops-Beta1`, which stays as the frozen Beta 1
release). It deploys to the same Supabase project and the same Cloudflare
Worker as Beta 1 did, so a deploy from the Beta 1 repo would now put an
older build back over this one — deploy from here only.

Beta 1 itself was the same code that had been running live,
promoted to its own standalone repository. Nothing was rewritten for the
promotion — the source had already been through five lead-developer review
passes, and its correctness lives in details a rewrite would only re-risk.
What changed is the packaging: the Worker and its `wrangler.jsonc` moved
inside the project (they sat above it in the prototype workspace), and the
repo root is the project root. The version the app reports is
`vite-app/package.json`'s — `0.92-beta 2` today — stamped into the bundle at
build time with the commit and the date, and shown at the bottom of the
drawer on every device.

Screens: the nine from the original design handoff — dialogs, ticket
numbering, rate calculation, light/dark theme — plus eight that grew out of
running it: Files, Contacts, Equipment, Timesheets, Open tickets, the admin
billing tracker, Team chat, and the Admin screen the app is configured from.
And two easter eggs nobody should document further. The first time an account opens a
screen it gets a popup explaining it in under two hundred words, with **Ok**
and **No more tips**, which is final (`src/help.js`, one entry per screen,
tested to stay short; `src/helpTips.js` remembers which screens a person has
met), and the drawer's
**Feature request** button mails the owner whatever the crew wishes the app
did, under their own name.

## Run it

```
cd vite-app
npm install
cp .env.example .env      # already has the public URL + publishable key
npm run dev
```

Opens at `http://localhost:5173`. `npm run build` produces `dist/`, a folder
of hashed, minified static files to host anywhere (Netlify, Vercel,
Cloudflare Pages) — React, ReactDOM and Supabase-js are bundled in. Four
libraries are not: SheetJS (the Excel export), jsPDF and its autotable
plugin (the timesheet approval PDF) and pdf.js with its worker (the report
preview) lazy-load from `cdn.jsdelivr.net` the first time a button needs
them, pinned to an exact version and checked against an SRI hash. The one
exception is pdf.js's worker: pdf.js fetches it itself, as a Worker, so no
`integrity` attribute can be put on it — and a worker runs in its own scope
with no DOM and no cookies, which is why the main script is the one that has
to be pinned. The service worker caches them from there (`cdn-libraries`,
CacheFirst), so each device needs a connection for them once and they work
offline after that.

## Deploying

Cloudflare Workers Builds runs `npm run build` from the repository root —
the root `package.json` reaches down into `vite-app`, because Workers Builds
has no root-directory setting the way Pages does. In Beta 1 the repo root is
the project root, so the reach-down is one level. `wrangler.jsonc` names the
output directory (`vite-app/dist`), routes `/approve`, `/approve-ticket` and
`/backup/oauth/*` through `worker/index.js` before the asset server (without
that last one the asset cache answers the drive's redirect first and a backup
drive can never finish connecting), and sets
`not_found_handling` so a hard refresh on any path serves the app rather
than a 404. A manual deploy is:

```
npm run build
npx wrangler deploy
```

`wrangler.jsonc`'s `name` has to match the existing Worker. Change it and the
next deploy quietly creates a second Worker on a new URL, leaving the old
address serving whatever was last published to it.

There's no seeded login — see "You need to create the sign-in accounts" below
before the sign-in screen will accept anything.

## Backend: Supabase project `nde-field-ops`

A real Supabase project is provisioned and wired in (region `ca-central-1`,
free tier — see `VITE_SUPABASE_URL` / publishable key in `.env.example`, both
safe to be public). What's live there:

- **Full schema** for every table in the handoff's Suggested Data Model —
  `profiles`, `clients`, `contractors`, `contacts`, `jobs`, `jhas`,
  `reports`, `tickets`, `ticket_lines`, `ticket_crew`, `timesheet_approvals`,
  `equipment`, `rate_schedules`, `rate_lines`, `rate_line_history`,
  `rate_overrides`, `function_errors`, `audit_log`.
- **Row-level security on every table**, enforced in Postgres — not just
  hidden in the UI, per the handoff's own warning. Access is keyed off a
  `has_tab()` check against each signed-in user's `tab_access[]`. Tickets
  and rate overrides also lock at the database level once a ticket is
  client-approved (the handoff's "billing immutability" rule).
  > That last guarantee was briefly untrue and is worth understanding before
  > adding a policy. Permissive policies **OR** together, so a later
  > `FOR ALL` policy added to relax *tab* gating silently ORed away the
  > `approved_at is null` condition that made approved tickets immutable —
  > the app still refused to edit them, but the database no longer did. The
  > repair — one policy per command, each carrying its own conditions — is
  > baked into the baseline migration this repo starts from. When widening
  > access to a table, add a policy for the command you mean, never
  > `FOR ALL`.

#### Who owns what

Tab access answers "which screens", not "whose record". Three places now ask
the second question as well:

- **Tickets** are readable by everyone — crews are meant to see each other's —
  but writable only by the technician who raised one, plus Admins and
  Coordinators, who finish other people's drafts from the billing tracker.
- **Contacts** can be added and corrected by any staff account, because
  creating a job files its rep into the directory. Deleting one is an Admin's.
- **Certification numbers** (`id_code` — CEDO/CGSB) stay on the profile row and
  readable by any staff account, because the JHA prefills both nuclear energy
  workers from them and the printed form has a column for each. Only admins can
  change one: `profiles_update` requires the `users` tab, so a technician
  cannot alter anyone's certification record, including their own.
  > This field was briefly moved into a private table on the strength of its
  > own placeholder text, which said "NRCAN # or driver's licence #". It holds
  > a professional credential, not personal identification, and hiding it left
  > the helper's column blank on a regulatory document. The placeholder now
  > says what the field is for.

`profiles` itself stays readable by every signed-in account, and that is
deliberate rather than an oversight: PostgREST embeds `profiles(name)` into
tickets, JHAs, equipment, crew rows, timesheets and rate history, and the crew
pickers list every technician. Restricting the row blanks names across the app
and empties every crew dropdown. If it ever has to be locked down, the work is
a name-only view or an RPC for the pickers plus denormalised names on the six
join sites — not a policy change.

#### Writing a policy

Four rules, all learned the hard way, all costing more than they look:

0. **Replace a policy, never layer on top of one.** Permissive policies OR
   together, so the loosest one on a command decides — a new, careful policy
   sitting beside an old, broad one changes nothing at all. The storage
   buckets carried two generations of policy for months: `jhas_bucket_read`
   checked for the jha or job tab, while a first-generation `jhas read` said
   only `bucket_id = 'jhas'` and ORed that check away. Every signed-in
   account could list and download every JHA — crew names, signatures, cert
   numbers — whatever their tabs. `20260815202002` dropped the old set.
   When you add a policy, go and look at what is already on that command.

1. **Never `FOR ALL`.** The same trap by another route: a `FOR ALL` policy
   takes part in every command including `SELECT` — it quietly sets the floor
   for the whole table. This is not hypothetical here: a `FOR ALL` policy added
   to relax tab gating ORed away the `approved_at is null` condition that made
   approved tickets immutable. `20260814010000` fixed that table;
   `20260815191345` split the last six, one of which had let anyone with the
   timesheets tab rewrite crew hours on an already-approved ticket. Write a
   policy per command, even when the expression is identical.

2. **Wrap the helper in a subquery**: `(select private.has_any_tab('a','b'))`,
   never a bare `private.has_any_tab('a','b')`. A bare call becomes a per-row
   `Filter`; the subquery form becomes an `InitPlan` evaluated once per
   statement. The policies used to read `profiles` three times *per row* —
   which is why it was the busiest table in the database by tenfold — and
   fixing that took one `rate_lines` count from 4.9 ms to 1.6 ms on 152 rows,
   with the gap growing linearly. Same reason Supabase says to write
   `(select auth.uid())`.
3. **Ask once for several tabs**: `has_any_tab('a','b','c')` (one array
   overlap) rather than `has_tab('a') or has_tab('b') or has_tab('c')` (three
   separate lookups).

`private.tab_access()` is the single source: it reads the tab list from the
JWT when the access-token hook has put it there, and falls back to querying
`profiles` when it hasn't. That fallback is what makes the hook optional and
safe to toggle — see "The token hook" below.
- **Storage buckets** `reports`, `jhas`, `shared`, `timesheets` and
  `chat-media`, all private. Most are gated by the same tab policies as the
  tables; `timesheets` is the Admin's own (plus each person's own folder,
  which is how a technician gets their approval PDF), and `chat-media` — the
  chat's pictures and voice notes, capped at 8 MB — answers to the `chat`
  tab, with uploads confined to a folder named for the sender. PDFs get
  signed URLs, never public ones.
- **A trigger that provisions a profile automatically** when a new Supabase
  Auth user is created, seeding `tab_access` from `public.tabs_for_role()` —
  the database-side twin of `ROLE_PRESETS` in `data.js`. Keep the two in
  step: they drifted once, and a new Admin came out unable to write
  equipment because the preset had never granted them that tab.
- **Seed reference data**: the five clients, three contractors, their
  contacts, the seven sample jobs, and a published rate schedule per client
  (RT film/CR/DR × 5 size bands, the other test methods, time & expense).

> **On the migration history.** `supabase/migrations/` starts at
> `20260817040000_beta1_baseline.sql` — the whole schema as it stood at the
> Beta 1 cut, squashed into one file generated from the live catalogs. The
> 77 evolutionary migrations that built up to it stayed with the prototype
> archive and are deliberately not in this repository. Everything after the
> baseline is applied history: each file has already run against the live
> project, and the folder reconciles 1:1 with the project's migrations
> table. Two cautions follow: never apply the baseline to the live project
> (it is for fresh environments only), and treat a from-scratch rebuild as
> untested rather than guaranteed — the baseline has never been replayed
> against an empty project.

Every screen reads and writes Supabase. What's left is filling in real
behaviour behind a couple of buttons (see "Known gaps"), not wiring more
tables.

| Screen | What it does |
| --- | --- |
| Sign in | Real Supabase Auth (`signInWithPassword`); the session persists across reloads |
| Home / dispatch board | Paged, server-side job search (`search_jobs`) with a status filter and a per-column search An Admin also gets a **Needs attention** strip above the board when a backup failed, a drive needs reconnecting or the functions logged errors overnight (see "Automatic backup"). **+ Ticket** and **+ New JHA** here carry the same gates as the buttons on Job detail. |
| Job detail | JHAs, reports and tickets for the open job, each card reloading only itself after a mutation The address bar follows the screen (`#/job/S-10113`, `#/job/S-10113/ticket`), so Back steps back a screen and a reload stays put — and a job with its own ticket, JHA and upload is one history entry, so one Back leaves it. Daily billing lists five tickets at a time, newest first, with a pager; every sent ticket — and every draft that is somebody else's — carries a **View** button that opens the field invoice read-only for any account that sees prices. Only the technician who raised a draft, or an Admin, can edit it; the database's `can_write_ticket` says the same. A ticket sent for approval by mistake has **Cancel approval** and **Cancel and edit** on its row and in the viewer: the client's link stops working and the ticket is a draft again. |
| JHA builder (mobile) | The FLHA as the crew fills it: site info, rated hazards, equipment record, both nuclear energy workers and their dosimetry. Files a real `jhas` row and renders a PDF. Carries an editable **date of the assessment**, so one missed on site can be written up afterwards for the day it actually covers. Hazard ratings start from what this person last gave each hazard, read back out of their own filed assessments — no preferences table to drift from what was actually filed Nothing is ticked when it opens. The builder offers **Keep these on my profile** for the dosimeter serials — when the profile holds none, or when one typed differs from what is on file — so the same three numbers stop being typed on every job. |
| JHA close-out | End readings off each DRD at the end of the day; the dose is computed here, not trusted from the screen, and the PDF is redrawn Makes the same serials offer for the closer's own row, since the person closing a JHA is often not the one who raised it. |
| Report upload (mobile + dialog) | The PDF uploads to the private `reports` bucket, plus a `reports` row; emailing it is a separate, recoverable step |
| Billing ticket (mobile) | Prices every weld and charge line against the client's *published* rate schedule, and records the crew's hours, solo hours and dose Number boxes refuse a keystroke that would leave a bad number rather than rewriting it, and honour the unit's step (hours and days by the half, km by the tenth). A figure that looks like a typo — 400 welds, a 30-hour day — is queried once before it saves. The crew is added through a type-ahead over name, initials or id code. Lines the rate card no longer offers are kept read-only under "No longer on the rate card", billed at the rate they were filed at. A queued save that replayed over somebody else's edit says so in a toast at the time and in a banner on the reopened draft until it is dismissed. |
| Open tickets | A technician's own unbilled tickets — drafts to finish, signatures to chase Filtered and paged, with a strip of work half-entered on this device and never saved, and a tick-and-cancel for drafts that will never be finished, one after another, naming any that refuse. |
| Team chat | One crew-wide room: pictures, voice notes, GIFs, replies, pins, unread badge and Web Push. Unpinned messages expire after 30 days; job numbers in a message linkify to the job Leaving the screen keeps the whole composer — the words, the reply target, an unsent picture or voice note — per account, until sign-out. |
| Billing tracker | Every ticket across every job, paged server-side, with the four totals as one RPC rather than a full table scan in the browser. **Chase all unsigned** re-sends the approval link to every ticket still waiting: it leaves alone anything chased in the last three days or carrying an open client query, then sends through a paced pool (three at a time, spaced, `sendPool.js`) that waits out a rate-limited or unavailable transport instead of writing it off. It reports "sending *n* of *N*" as it goes, has a **Stop** that lets the sends in flight land and leaves the rest for another day, and names the tickets that failed by number, because a count of 37 is not something anyone can act on. Both that button and **Export to accounting** are behind the price gate: the database hands a role that can't see prices null totals, so a Coordinator would otherwise have mailed every client a $0.00 approval or built accounting a spreadsheet of zeroes **Resend link** on a single row; the chase dialog shows who each chase would mail before it sends. Aging tiles and a **By client** view answer how old the unsigned money is (`ticket_aging()`, counts for everyone and money for the price roles). Two exports for accounting carry the GST per ticket, and an Invoiced row shows its invoice number. |
| Rate admin | Rate lines write straight to `rate_lines` (debounced); **"Restore removed lines"** re-adds any standard line missing from the schedule, at zero, ready to be priced, and the follow switch copies the house card into a client's own card; rate history is logged by a trigger The house card lists the clients following it, and a following client's Rate history shows the house card's changes under its own. Each client carries its own **GST rate** (5 by default, 0 for an exempt one; Admin-only), and the field invoice, the approval email and the receipt all charge that rate. **New client** can copy another client's card as figures of its own, unconnected afterwards. |
| Files | A private `shared` bucket browsed directly; folders are path prefixes, not a table, so the listing can't drift from what's stored |
| Contacts | The directory of people at each client and contractor, one primary each — what every other screen pre-fills a rep from Ten to a page with a per-page dropdown, and a find box over name, title, email and phone inside one organisation. |
| Equipment | Exposure devices, survey meters, dosimeters and tools with calibration dates; the JHA pre-fills each worker's kit from what's assigned here |
| Timesheets | Hours, solo hours, dose and mileage per person per pay period, derived from ticket crew rows; admin approves a period, and "Export to Excel" builds a two-sheet workbook. The dose ledger beside it — milliroentgens per person per calendar quarter and year, the figures a nuclear energy worker's record needs — is added up by the database (`dose_totals`), not the browser: a "Year" view used to pull every crew row of the year, tens of thousands of them, to print one line each. It runs with the caller's own rights, so row-level security is still what keeps one technician's dose out of another's screen, and it falls back to the old row-by-row read on a database that hasn't had the function yet A technician's own view is headed "Your hours"; an Admin approves several periods at once; the dose export is every role's, scoped to the signed-in person for a non-admin. |
| Users & access | Accounts, tab permissions and role presets; an account that was locked rather than deleted (its name is on tickets or JHAs) comes back with **Unlock account**, which lifts the Auth ban, clears `deactivated_at` and restores the role preset's tabs without touching the role The background-error log lives on the Admin screen now: filtered by function, twenty at a time with **Load 20 more**, and **Clear** behind an Admin-only door. |
| Admin | The settings that used to be function secrets — Resend key and sending addresses, the approval-link base URL, the KLIPY key — in one Admin-only row, plus an **Invoices** section holding the terms, GST number and remit-to block the field invoice prints (the invoice number itself comes from the app's own series, stamped when a ticket is marked invoiced and starting at 1000), a test email, a panel of recent background errors from the Edge Functions (with Refresh and Clear), and the year/date-range archive. Building the archive reads every PDF and renders every ticket's invoice over the connection — minutes for a quiet month, an hour or more for a busy year, so it is a job to start at a desk. Clearing is gated three times over: the downloaded zip is checked back against the manifest the build kept; immediately before the delete, every job's tickets, assessments and reports are counted again live; and the word CLEAR has to be typed. A job that has gained or lost anything since the build stops the clear and says so — the zip on disk cannot know about a ticket filed at 16:20 against a job archived at 16:00. Below the archive sits **Automatic backup**: connect one drive account of the business's own (Google Drive, OneDrive or Dropbox), pick a frequency, an hour in Grande Prairie time and how many copies to keep, and the app writes every record and every PDF to a dated folder there on a schedule — on its own server, so nothing passes through the browser. The same panel lists what is in the drive and restores from it two ways: chosen jobs, which deletes nothing and overwrites nothing, or everything, which empties the database first and is gated four times over The list of earlier backup runs shows records, files and size for each, twelve deep, with a size line under them and a plain word when the latest backup is under half the one before. An archive build is kept on the device for a day, so the zip can be checked and the clear pressed after the dialog was closed — on the jobs the build covered, never the picker's current count. |

### What the field test changed

Beta 1 went through a field test on the seed data — four testers trying
to break every screen, then three review rounds over the code — and the
list they came back with was worked through in one day (commits 1cfef40
through c168a22). Most of it is in the rows above; the rest cuts across
screens:

- **The screen is in the address bar** (`src/route.js`, pure and tested):
  `#/board`, `#/chat`, `#/job/S-10113`, `#/job/S-10113/ticket`. Back steps
  back a screen, a reload stays put, a ticket or JHA address degrades to
  its job, and a job's own screens share one history entry so one Back
  leaves the job (`historyStep`).
- **An invoice has a number.** Marking a ticket invoiced stamps the next
  number in the app's own series (from 1000), kept across an un-invoice;
  the terms, GST number and remit-to block on the Admin screen print on
  the client's copy. HANDOVER.md says how to carry on a series started
  elsewhere.
- **GST is the client's.** `clients.gst_rate` (percent, Admin-only,
  guarded per column by a trigger); a missing rate reads as 5, never as
  exempt. `gstOn(subtotal, rate)` in data.js and `invoiceTotals` in
  `_shared/invoice.ts` both take it, so the screen, the invoice, the
  approval email and the receipt agree.
- **The office hears about failures**: the Needs attention strip on the
  board and the `admin-digest` email at 13:00 UTC, only when something
  needs doing.
- **A locked account comes back**: **Unlock account** on Users & access
  (`unlock-user`), and **Email a set-password link** if they have
  forgotten it.
- **No signal is said at once**: a save on a device that knows it is
  offline goes straight to the outbox and says "Saved on this device"
  rather than trying the network first.
- **A queued save is last-write-wins, and says so**: the queued ticket
  carries a fingerprint of what the edit started from; the replay
  compares before it writes, toasts once if it replaced somebody else's
  save, and leaves a banner on the reopened draft (`overwriteNote.js`).
  A queued report whose email failed says so in a forced toast.
- **Numbers are typed, not corrected** (`numberInput.js`): a keystroke
  that would leave an invalid figure is refused, a minus sign is never
  silently made positive, and the ticket editor queries a figure that
  looks like a typo once (`SANE_QUANTITY_*`, `SANE_CREW_HOURS`).
- **Two devices saving one draft** no longer drop a side's hours:
  `saveCrewForTicket` upserts on (ticket, person) and deletes the rest.
- **The tests grew teeth**: the render scan refuses a hook below a
  component's first early return (the mistake behind two of the day's
  crashes), `appShape.test.mjs` pins App.jsx's ordering, and the
  Playwright suite has a two-device test for the overwrite banner and a
  check of the crew type-ahead.

The full list, with what was fixed, built, removed and declined, is the
"Beta 1 Field Test Findings" artifact the round produced.

### Offline

The app is a PWA: a service worker precaches the whole shell, including the
lazily-loaded office screens, so it starts with no connection at all and can
be installed to a phone's home screen.

Loading is only half of it — an app that opens to an empty jobs table is no
more use on a lease than one that doesn't open. `offlineCache.js` keeps the
last good copy of what the field path reads, in IndexedDB: the ten most recent
jobs, each of those jobs, the record and history of any job that has been
opened, the client's published rates, profiles, contacts, clients,
contractors and equipment. Every read still goes to Supabase first and only
falls back on a genuine connectivity failure — a permission error or a bad
request is a real answer and surfaces as one. Anything served from the cache
puts an **Offline** tag in the top bar and, on the board, a line saying what
was saved and when, because data that quietly looks live is worse than no
data. Writes are never cached; they queue (below).

These are shared tablets, so the cache records whose it is. Signing out
clears it — after warning, if there are half-entered tickets or queued work
that would go with it — and signing in clears it again if the last owner was
anybody but the account now signing in, so the next person cannot page
through the last crew's jobs, rates and drafts. Signing back in as the *same*
person keeps all of it, which is the point: a token that expired while the
truck was out of range forgets who the device belonged to but leaves the
morning's work where it is. Starting up with no signal and no remembered
identity does the same: the identity is gone, the data stays, and whoever
signs in next settles it. Exactly one case clears the store at boot — an
account the server says has nothing behind it any more, deactivated or
stripped of every tab, which nobody is coming back for. Sign-out also
removes the stored session by hand when the server can't be reached, because
`signOut` reports the failure without removing it, and a tablet handed over
"signed out" that signs itself back in on the next reload is the whole
problem this is here to prevent.

Starting up with no signal is its own problem, handled in `session.js`.
Restoring a session touches the network twice — refreshing the access token
and reading the profile — and neither call was bounded, so with the radio off
the app sat on "Loading…" indefinitely. Worse, supabase-js reports a failed
request as `{ data: null, error }` rather than throwing, which made a network
failure indistinguishable from "this account has no profile" — the one case
the code answered by signing the user out. Going out of range logged people
out. Both steps are now bounded, a failed request is never read as an answer,
and the last signed-in identity is kept on the device so the app opens signed
in. `npm test` covers those paths, including promises that never settle.

The board doesn't just cache the ten jobs, it caches what's *on* them: after
the board loads, three batched queries pull every JHA, report and ticket for
all ten and file them per job, so any of them opens offline with its history
intact rather than three empty cards. Batched rather than per-job — thirty
requests to fill a cache would be a poor trade — and throttled to at most
once a minute, since the board refetches on every filter tap.

One thing still needs a connection the first time: a client's rate card is
cached when their ticket screen is first opened, so a client never billed
from this device can't have a ticket built offline. The screen says so rather
than failing blankly.

Jobs can be started on site. A job created with no signal mints its own uuid
on the device rather than waiting for Postgres to assign one — that is the
whole trick, because the JHA filed ten minutes later and the ticket raised
that evening both need a real `job_id` to point at, and letting the database
choose it at sync time would mean rewriting every queued item that referenced
the temporary one. The job appears on the board and opens immediately, and
the queue replays it ahead of anything raised against it. The one thing that
can't be settled in a truck is the job number: it is `UNIQUE` and nothing on
the device knows what the office has issued, so it is typed rather than
suggested, and a collision surfaces in the queue panel as a refusal to sync.

The three field screens (JHA builder, report upload, billing ticket) keep
working with no signal. A save that fails on connectivity — and only on
connectivity; a completed job or a missing rate schedule still surfaces
immediately — is written to IndexedDB with its attachments and replays
automatically when the browser comes back online.

The top bar shows what is still waiting, and distinguishes two states that
used to look identical: *queued* (waiting for signal, will go on its own) and
*won't sync* (the database refused it — a job completed while the crew was
out of range, say). Tapping either opens the reason, a retry, and the option
to discard an item that is never going to land. Ticket numbers are minted by
the database at save time rather than in the browser, so a ticket built
offline at 07:00 can't collide with one raised while it was waiting.

### Three things that need the Edge Functions deployed

- **Creating a user** (Users & access → "+ New user") goes through the
  `create-user` Edge Function, which holds the service-role key. It checks
  that the caller is a signed-in Admin, creates a *real* Supabase Auth
  account already email-confirmed (so there is no confirmation step to
  chase), and then writes the rank and its tabs itself. The browser's
  `signUp()` is deliberately not used and signups are disabled: that
  endpoint answers to anyone holding the publishable key, so the
  provisioning trigger caps a metadata role to Technician or Helper and the
  real rank is only ever set by the function, Admin-to-Admin. Tick
  **Invite** and the account gets a password nobody knows plus a
  set-password link by email.
- **Removing a user** goes through the `delete-user` Edge Function, also
  service-role. An account with no work on file is deleted outright, auth
  row and all. An account with tickets, JHAs or jobs against it is *locked*
  instead — banned in Auth, every tab removed, `deactivated_at` stamped —
  because the foreign keys are what keep a name on the history it signed.
  The screen says which of the two happened. Deploy both functions or the
  buttons report an error; nothing in a client app should ever hold that key.
- **Automatic backup** needs `backup-oauth`, `backup-run` and
  `backup-restore` deployed, and needs the `backup-tick` pg_cron job — the
  cron job arrives with its migration, the functions do not. All three are
  pinned `verify_jwt = false` in `supabase/config.toml`, because the caller
  is a browser coming back from a consent screen or the database's own
  scheduler, neither of which carries a JWT; each checks its own caller
  before it parses anything. Until an Admin connects a drive on the Admin
  screen the tick finds nothing due and returns, five minutes at a time,
  costing nothing.

### Automatic backup

The Admin screen can point the whole app at one drive account — Google
Drive, OneDrive or Dropbox — and copy itself there on a schedule: every row
of the twenty-three tables that hold the work, and every file in all five
storage buckets. The error log and the audit trail are the two deliberate
omissions — operational noise, not records.

The drive belongs to the business, not to the app: the drive's refresh token
and the three client secrets are columns on the Admin-only `app_settings`
row, read by the functions with the service role and never selected by the
browser — the panel's one read, `backup_state()`, answers `has_secret_google`
rather than the secret, and the same read is what tells it whether a drive is
connected at all.

A backup is a folder named for the moment it started (`2026-09-05 02-00`,
the crew's own clock) holding `manifest.json`, a `tables/` folder of gzipped
JSON parts, and a `files/` folder with one flat entry per stored object. The
work runs in slices of about a hundred seconds, driven by a pg_cron job that
pokes `backup-run` every five minutes and by each slice kicking the next, so
a first backup of a busy database — which can take an hour — needs nobody to
keep a browser open. Older folders beyond the keep count are removed after
each successful run; the copies taken automatically just before a restore
never are.

Neither the panel nor the error log says anything until somebody opens the
Admin screen, so two things carry the bad news out. An Admin who opens the
board gets a **Needs attention** strip above it, and only when there is
something on it: a run that failed and why, a drive whose consent has lapsed
and needs reconnecting, a backup that was due more than six hours ago and has
not started, and how many background errors the Edge Functions logged since
yesterday, grouped by which function. Each line names where to look, because
the board cannot switch tabs for anybody. The **admin-digest** function says
the same four things by email to every active Admin, once a morning at 13:00
UTC — 07:00 in Grande Prairie in summer, 06:00 in winter, since pg_cron has no
time zone — and sends nothing at all on a morning when nothing is wrong, so a
message in the inbox always means something needs doing.

Restoring comes two ways. **Restore jobs** is the everyday one: pick jobs off
the backup's own index and they come back with their tickets, assessments,
reports and PDFs. It deletes nothing and overwrites nothing, so restoring
the same job twice is a no-op and anything it could not put back — a ticket
number since reused, a crew member's account since removed — is named in a
written report rather than counted. **Restore everything** is the other one,
and it is the only thing in the app that empties tables it did not fill: it
is gated on the caller being an Admin, on the backup not coming from a newer
schema than this database, on the Admin typing the backup's folder name, and
on a complete safety backup of what is about to be replaced succeeding
first. If that copy fails, nothing is deleted.

Three details are worth knowing before trusting it. Each provider needs a
free app registration under the owner's own account — `HANDOVER.md` walks
all three consoles. The **App address** on the Admin screen has to be filled
in before Connect will do anything, because that is what the redirect URI in
the registration is built from. And a restored database deliberately starts
with an empty error log and audit trail: neither is backed up, and their
foreign keys to `profiles` mean they have to be cleared before the wipe can
finish.

### The token hook

`public.custom_access_token_hook` puts each account's `tab_access` and role
into their JWT. The function, its grants and the auth-admin read policy are
deployed; whether the hook itself is switched on is a dashboard setting
(**Authentication → Hooks → Customize Access Token (JWT) Claims**) that
nothing in this repository can read back — and deliberately nothing has to.

It is optional in both directions, and since migration `20260904135107` it
decides nothing at all. `private.tab_access()` and `private.user_role()` read
`profiles` and only `profiles`, and answer as though a deactivated account
did not exist. The app's own menu never asked the token either — the drawer
is drawn from the `profiles` row read at sign-in, so a tab granted or revoked
shows up on the next sign-in whatever the hook is doing. Nothing in
`vite-app/`, the Worker or the Edge Functions reads `app_metadata`, so the
claim has no reader left on either side of the wire.

What it cost while the functions did read it is worth remembering: a token is
a *copy* of the row, an hour stale at the outside, so a demoted or locked
account kept whatever the claim said until it refreshed — that is the hole
that migration closes. The hook is left deployed only because removing an
auth hook is its own change with its own blast radius; a follow-up, once this
has been live long enough to be sure nothing was leaning on it.

`config.toml` carries the setting under `[auth.hook.custom_access_token]`, but
**do not run `supabase config push` to apply it** — that file was generated by
`supabase init` with local defaults and would overwrite the project's live
auth settings (site URL, redirect URLs, email confirmation, JWT expiry) with
them. Either use the dashboard, or reconcile the whole file against the live
project first.

### One low-priority item left as-is

**Leaked-password protection** is off by default on a new project — a
one-click toggle in Authentication → Policies, not something a migration can
set. Worth turning on before this goes further than a demo.

### You need to create the sign-in accounts

Seeding `auth.users` by hand with raw SQL is unreliable on a hosted project
(Supabase's own docs warn against it — the auth service owns that table). So,
in the [Supabase dashboard](https://supabase.com/dashboard/project/eielmvxzdwwprmmfamlq/auth/users):

1. **Authentication → Users → Add user**, for each person.
2. Check **Auto Confirm User** (so they can sign in immediately, no email step).
3. Under **User Metadata**, add JSON like:
   ```json
   { "name": "R. Vandenberg", "role": "Technician", "cert": "Lvl III · CGSB 48.9712" }
   ```

The provisioning trigger reads that `name` and `cert`, but it will only
honour a `role` of `Technician` or `Helper`, and files anything else — an
absent role included — as `Technician`. That is deliberate: the metadata on
this route is attacker-controlled on the signup endpoint, so rank is never
taken from it. Which means the *first* admin cannot be made this way. Promote
one by hand, once, with `supabase/RESTORE-ADMIN.sql` (put the address in and
run it in the SQL editor) — after that every account is created from the
app's own **Users & access → + New user**, where an Admin's own session is
what authorises the rank.

## Structure

```
vite-app/
  index.html                shell; the design system's CSS is linked from public/
  vite.config.js            React plugin, the PWA/service worker config, vendor chunk
  playwright.config.js      the end-to-end run: projects, the stored sign-ins, retries
  .env.example              VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
  public/_ds/industry-.../  the Industry design system (unmodified)
  public/icons/             app icons (192, 512, 512-maskable, 180 apple-touch)
  public/brand/wordmark.svg the logo, masked by .topbar-brand so it takes the theme colour
  src/
    main.jsx                ReactDOM mount, wrapped in the error boundary
    App.jsx                 auth, nav drawer, theme, screen switch, offline-queue replay
    app.css                 page layout, top bar, phone frame, tables etc.
    config.js               Supabase client (public URL + publishable key)
    data.js                 shared constants + pure helpers (money, dates, ticket #s, rate lines)
    db.js                   the whole data-access layer over Supabase — every screen goes through it
    offlineQueue.js         IndexedDB queue + auto-replay for the three field screens
    offlineCache.js         IndexedDB read-through cache — the jobs board and the
                            field path, kept usable with no signal
    paging.js               reading past PostgREST's silent 1,000-row cap: by offset
                            for reference lists, by key for anything billed or paid
    sendPool.js             the paced worker pool behind "Chase all unsigned" — a few
                            sends at a time, a floor between them, and a wait-and-retry
                            for a rate-limited refusal (pure, so it tests on a fake clock)
    session.js              sign-in restore: whose session it is, and what to do when
                            the network can't answer (unit-tested, no React)
    recovery.js             catches a password-reset landing at import, before
                            supabase-js consumes the hash and the one-shot event
    swUpdates.js            asks for a new version on a timer, on foreground and on
                            reconnect; drives the Restart now / Postpone banner
    toastBus.js             the data layer announces its own writes; App's one Toast
                            listens, so no screen has to remember to confirm a save
    chatMerge.js            the chat's merge — every path a message arrives by goes
                            through it, so nothing doubles and a fuller copy wins
    archive.js              builds the year-end archive: client → month → job, with
                            a manifest the downloaded zip is checked back against
    zip.js                  a minimal ZIP writer, so the archive needs no CDN library
    backupSchedule.js       when the automatic backup is next due — Grande Prairie's
                            clock, DST and all; a byte-identical twin lives in
                            supabase/functions/_shared/ and a test compares them
    backupPanelLogic.js     the backup panel's pure parts — the provider list and
                            labels, the redirect URI each registration needs,
                            reading the outcome the drive's redirect came back with,
                            and the per-run figures and size line
    route.js                the hash routes: what the address bar says, what the app
                            does with it, and when a screen change replaces the
                            entry rather than pushing one
    help.js                 the screen-tip text for every screen, under 200 words each
    helpTips.js             which screens an account has been introduced to, and the
                            one-way "No more tips" switch
    numberInput.js          which keystrokes a number box accepts (step, no minus)
    ticketFingerprint.js    what a queued ticket edit started from, so the replay
                            can tell it wrote over somebody else's save
    overwriteNote.js        the note that replay leaves for the editor's banner
    savingWords.js          "Saving…" against "Saved on this device" — what the
                            button says while a save is on its way
    chatDrafts.js           the chat composer held across screen changes, per account
    dosimetryPrompt.js      the serials offer's pure questions: which typed serial is
                            news, what keeping writes, and the once-a-session mark
    wipDrafts.js            the half-entered work Open tickets lists off the device
    approvalRun.js          running the bulk cancel one draft after another, naming
                            what failed
    chasePlan.js            who a chase would mail, before it does
    ticketAging.js          the tracker's aging tiles and By client view
    accountingExport.js     the two CSVs for accounting, GST per ticket
    attention.js            the Needs attention strip's four questions
    *.test.mjs              `npm test` — node --test plus the render-name scan, no
                            browser needed (archive, chat merge, dates, numbers,
                            offline cache and queue, paging, periods, session, zip,
                            routes, help, number input, the fingerprint, the chat
                            draft, the serials offer, and four for the backup —
                            schedule, shared modules, restore, panel — which import
                            the Edge Functions' TypeScript straight out of
                            supabase/functions/)
    components/
      common.jsx            Blueprint frame, Btn, TagX, Field, Dialog, Switch, ErrorBoundary…
      auth.jsx              Sign in
      home.jsx              Dispatch board + New job dialog
      jobDetail.jsx         Job detail (JHA/reports/billing cards, job record)
                            + Upload report / Create ticket / JHA close-out dialogs
      jhaMobile.jsx         JHA builder (phone)
      uploadMobile.jsx      Report upload (phone)
      ticketMobile.jsx      Billing ticket (phone) — typed weld/charge quantities, crew & dose
      openTickets.jsx       A technician's own unbilled tickets
      teamChat.jsx          Team chat — pictures, voice notes, GIFs, replies, pins
      files.jsx             Shared files browser over the `shared` bucket
      contacts.jsx          Client/contractor directory, primary contact per org
      equipment.jsx         Equipment register + calibration due dates
      timesheets.jsx        Hours per person per pay period, + Excel export
      rateAdmin.jsx         Rate schedules, rate history + job-level overrides
      billingTracker.jsx    Unsigned-money tracker
      usersAccess.jsx       Accounts, tab permissions, background-error log
      adminSetup.jsx        Admin screen: Resend + KLIPY keys, app address, archive,
                            automatic backup
      backupPanel.jsx       Connect a drive, the schedule, the backups in it, and the
                            two restores (everything, or chosen jobs)
      archiveDialog.jsx     Build the archive zip, check it, then unlock the clear
      queuePanel.jsx        The offline-queue badge and its what's-waiting panel
      helpTip.jsx           The first-visit popup, one screen's entry from help.js
      featureRequest.jsx    The drawer's Feature request form
      flappy880.jsx         One of the two easter eggs
  e2e/                      Playwright against the live project — auth.setup.js signs
                            the accounts in once, then fieldOps, networkSync and
                            multiUser drive real screens; helpers.js sweeps the drafts
                            a run leaves behind
  scripts/check-render.cjs  the render-name scan `npm test` runs first: every capitalised
                            tag in a JSX file must resolve to something that file imports,
                            and no hook may sit below a component's first early return
supabase/
  migrations/               schema, applied in filename order
  functions/                nineteen Edge Functions — the three that send mail
                            (send-report, send-jha, send-ticket-approval), the two
                            that render PDFs (render-invoice, render-jha), the client
                            approval page (approve-ticket), account handling
                            (create-user, delete-user, password-reset, unlock-user),
                            the chat's push and nightly cleanup (chat-push,
                            chat-retention), the automatic backup (backup-oauth,
                            backup-run, backup-restore), the morning digest to the
                            Admins (admin-digest), the drawer's feature-request
                            mail, gif-search and mail-test; plus
                            `_shared/`, which is library code, not a function —
                            invoice/JHA rendering, mail, the approval token, and the
                            nine modules the backup is built from (drive.ts and its
                            three vendors, backupTables/Manifest/Schedule/Run/
                            Restore/Oauth/Common, gzip), most of them erasable
                            TypeScript the node suite imports directly
  handover/                 the handover runbooks — the two wipes, the probes a
                            migration was checked with, and any DB fix written but
                            not yet applied (nothing is waiting there now)
  *.sql                     one-off operator scripts (seed jobs, restore an admin),
                            each idempotent — paste into the SQL editor
worker/index.js             the Cloudflare Worker: serves the built assets, proxies
                            /approve to the approve-ticket function (Supabase hands
                            that domain's HTML back as text/plain) and
                            /backup/oauth/* to backup-oauth, whose answer is a
                            redirect rather than a page
wrangler.jsonc              the Worker's name, its assets binding and its routes —
                            /approve, /approve-ticket and /backup/oauth/* run the
                            Worker before the asset server
```

The office-facing screens (Files, Contacts, Equipment, Timesheets, Rate
admin, Billing tracker, Users & access, Admin) are `React.lazy` chunks, and
so are Team chat and the arcade — a technician who never opens Rate admin
doesn't download it.

## Known gaps against the handoff (flagged, not hidden)

- Weld-level detail from radiographic reports (`W-041 → 044` style ranges)
  isn't cross-linked into the billing ticket's per-weld tally yet — the
  ticket screen bills by size/method quantity, as specced, but doesn't yet
  pull those quantities from uploaded report data.
- "Flag as chased" next to each ticket in the billing tracker sends nothing —
  it is the record of a phone call, written to `tickets.chased_at`, so it
  survives a reload and every admin sees the same answer. "Chase all
  unsigned" beside it is the one that really re-sends, and it skips anything
  chased in the last three days.
- The mobile JHA builder collects no signature. The account filing the
  assessment is the record of who filed it, which is why the screen says so
  rather than drawing a signature box that means less than it looks like.
  It carries two dates for the same reason: `work_date` is the day the
  assessment covers and is editable, so a JHA missed on site can be written up
  later for the right day; `signed_at` is when the record was actually
  created and is not. The PDF prints them as **Date** and **Filed**. Back-
  dating the document is a real need; back-dating the claim about when it was
  written up would not be.
- Four libraries lazy-load from `cdn.jsdelivr.net` on first use rather than
  riding in every page load: SheetJS for the Excel export (~900 KB behind one
  button), jsPDF and its autotable plugin for the timesheet approval PDF, and
  pdf.js with its worker for the report preview. Each script tag is pinned to
  an exact version and checked against an SRI hash — except pdf.js's worker,
  which pdf.js fetches itself as a Worker and so can carry no `integrity`
  attribute; a worker has its own scope, no DOM and no cookies, so pinning
  the main script is what matters. The service worker caches them
  (`cdn-libraries`, CacheFirst) — so a device needs a connection the first
  time it opens one of those, and never again.
- Every signed-in account can read every row of `profiles`, including the
  `id_code` certification number. That is deliberate — the JHA prefills both
  workers from it and the printed form has a column for each — and only admins
  can change one. See the access-control notes above; narrowing the read
  further wants either column privileges or a view the crew pickers read from
  instead.
