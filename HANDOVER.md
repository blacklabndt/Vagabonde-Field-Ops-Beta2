# Handing VagaboNDE Field Ops over

The setup document ("Things to do to get set up") is the installation
manual. This is the owner's manual: what the system is made of, how it
changes hands, and what the new owner's admin does on day one.

---

## What the system is made of

| Piece | What it does | Where it lives |
|---|---|---|
| The app | React PWA the crew installs on phones | Built from `vite-app/`, served by the Cloudflare Worker |
| The Worker | Serves the app + renders client approval pages at `/approve` | `worker/index.js`, deployed with `npx wrangler deploy` |
| Database, sign-in, files | Everything the app stores | Supabase project `eielmvxzdwwprmmfamlq` (Postgres + Auth + Storage) |
| Server functions | Email sending, approvals, user provisioning and unlocking, chat push, nightly cleanup, the automatic backup, the morning digest, feature requests | `supabase/functions/`, deployed with the Supabase CLI |
| Email | Reports and billing approval links | Resend (key entered on the in-app **Admin** screen) |
| Chat GIFs | Team chat's GIF search | KLIPY (key on the **Admin** screen, optional) |
| The backup drive | Where the app copies itself on a schedule, and restores from | One Google Drive / OneDrive / Dropbox account of the business's own, connected on the **Admin** screen |

Everything an admin configures day-to-day lives **inside the app**:
drawer → **Admin** (Resend key and addresses, the app's public address for
approval links, the KLIPY key, the archive and the automatic backup) and
**Users & access**, **Rate admin**,
**Contacts**. Only two settings live in the Supabase dashboard because
they guard sign-in itself: the **Site URL** (Authentication → URL
Configuration — where password-reset links land) and **leaked-password
protection** (Authentication → Policies).

## Changing hands — two paths

**Path A — transfer (recommended): keep everything, move the accounts.**
1. The client makes free accounts at supabase.com and cloudflare.com.
2. Supabase: their account creates an organization, and the current owner
   transfers the project into it (Project Settings → General → Transfer
   project). Data, functions, secrets and URLs all move unchanged;
   nothing redeploys, nothing breaks, the app doesn't notice.
3. Cloudflare: the Worker is stateless, so it isn't "moved" — it's just
   deployed again from this repo while logged into their account
   (`npx wrangler login`, then `npm run build && npx wrangler deploy`).
   Their copy gets its own URL; update the **Site URL**, the Admin
   screen's **App address**, and have the crew reinstall the PWA from the
   new address. Doing this at the same time as a custom domain (below)
   means the crew only ever installs once.
4. Run the seed wipe (below) somewhere between transfer and go-live.

**Path B — fresh install: new project, empty history.**
The migration history is built for this — `supabase/migrations/` starts
with a baseline that recreates the whole schema in a fresh project (and
must never run against an existing one). The extra steps beyond the setup
doc: point the app at the new project (copy `vite-app/.env.example` to
`.env` with the new URL and publishable key), generate a fresh push
keypair (`npx web-push generate-vapid-keys` — public key into
`vite-app/src/config.js`, private key + subject into the function
secrets), then `supabase db push`, deploy all functions, set secrets, and
deploy the Worker. Path A avoids all of this.

> **Check the `.env` actually took.** `vite-app/src/config.js` falls back
> to this beta project's URL and publishable key when
> `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are missing — which is
> what keeps a fresh `npm run dev` working, and also means a `.env` that
> is absent, misnamed, or added after the build silently produces an app
> pointed at the original live project rather than one that refuses to
> start. It is a build-time substitution, so it is settled when
> `npm run build` runs, not when the Worker serves. Verify before handing
> the address out: sign in on the new deployment and confirm the data is
> the new project's, or grep the built bundle in `vite-app/dist/` for the
> old project ref (`eielmvxzdwwprmmfamlq`) and expect no hits.
>
> **The moment `supabase db push` finishes, the new project starts calling
> this one.** Six migrations bake the live project's function URL and
> publishable key into the text of three cron jobs and the chat push
> trigger: `20260818155616_chat_messages_expire.sql`,
> `20260818190952_chat_push_subscriptions.sql`,
> `20260826041947_the_database_signs_its_own_calls.sql` (both the push and
> the retention job), `20260905080604_the_project_backs_itself_up.sql`,
> `20260906143757_the_office_hears_about_failures.sql` and
> `20260910213858_a_send_can_wait_for_its_time.sql`.
> So a fresh project stands up a `backup-tick` job posting at *this*
> project's `backup-run` every five minutes, a `chat-retention-nightly`
> job posting at its `chat-retention`, an `admin-digest-daily` job posting
> at its `admin-digest` every morning, a `scheduled-sends-tick` job posting
> at its `scheduled-sends` every five minutes, and a trigger on `chat_messages`
> posting every insert at its `chat-push`. They are rejected — the
> `x-internal-secret` is minted per project — but the requests are real
> and the protection is one shared secret deep. Before anything else, run
> `select cron.unschedule(jobid) from cron.job;` on the new project and
> re-point the chat push trigger at the new project's own function URL,
> then re-create the three jobs against it. (Reading the URL from a setting
> the way `edge_shared_secret` already is would end this; it has not been
> written yet.)
>
> Before `supabase db push`, look in `supabase/handover/` for a draft
> schema fix — that is where one lives once it is written and before it
> has been applied anywhere. Anything still sitting there is not in
> `migrations/` and will not be in the fresh project. Nothing is waiting
> there today: the last one went live as
> `20260905105635_a_patch_is_an_update_not_an_upsert.sql`, and the probes
> it was checked with stayed behind as
> `probes-20260905105635-a-patch-is-an-update-not-an-upsert.sql`.

## The custom domain

Client-facing links currently use the Worker's `workers.dev` address. A
custom domain (say `app.vagabonde.ca`) needs its DNS zone on Cloudflare —
vagabonde.ca is on GoDaddy today, so that's either moving nameservers or
living with workers.dev. **Decide before the crew installs the PWA
widely**: the old URL keeps working alongside a new domain (nothing sent
breaks), but installed PWAs and push subscriptions are bound to their
address — change it later and every device reinstalls and re-allows
notifications. Changing it early costs nothing.

## Connecting a backup drive

The app can copy itself — every record, every PDF — to one drive account on
a schedule, and restore from it. The drive account is the business's own and
stays the business's own: the app holds nothing but the access it was
granted, which the provider's own security page can withdraw at any moment.
The copying happens on the app's server, so nothing passes through anybody's
browser and the machine that pressed the button can be shut afterwards.

Two things follow from what is in it. A backup carries the crew's hours and
dose readings and every client's pricing, so the drive account should belong
to the business rather than to a person. And it deliberately does **not**
carry the Resend key, the KLIPY key or the drive's own credentials — those
are blanked on the way in, so a restore never overwrites the live ones and a
backup on somebody's laptop is not a set of keys.

Each provider needs a free app registration under your own account. That is
what lets the app write to your drive without anybody holding your password.
Do the one you intend to use and ignore the other two — only one drive is
ever connected, and switching later means Disconnect first.

**Before you start**, open the app, sign in as an Admin, go to **Admin →
Automatic backup → App registration**, and copy the redirect URI shown
beneath the provider you have chosen. It reads
`https://<your app address>/backup/oauth/google` (or `/microsoft`, or
`/dropbox`) and it has to be pasted into the registration character for
character. Those boxes fall back to whatever address this window happens to
be on when the **App address** field further up the Admin screen is blank —
and Connect refuses outright until that field is filled in ("The App address
isn't set on the Admin screen"), so fill it in first.

### Google Drive

1. <https://console.cloud.google.com/projectcreate> — make a project.
2. <https://console.cloud.google.com/apis/library/drive.googleapis.com> —
   **Enable** the Google Drive API in that project.
3. <https://console.cloud.google.com/auth/overview> — fill in the OAuth
   consent screen. **External**, your own email as the support and developer
   contact. Then, on the same **Audience** page, set the publishing status
   to **In production**. An app left in Testing refuses every account not
   listed under Test users with "Access blocked: … has not completed the
   Google verification process", and even a listed one is signed out after
   seven days, because Google expires a Testing app's refresh tokens. The
   only permission asked for, `drive.file`, is one Google does not review,
   so publishing needs no verification; the first sign-in may show an
   "unverified app" page — Advanced → continue. The app name on that page
   is whatever you typed as the consent screen's name.
4. <https://console.cloud.google.com/apis/credentials> — **Create
   credentials → OAuth client ID → Web application**. Under *Authorised
   redirect URIs* paste `https://<your app address>/backup/oauth/google`.
5. Copy the **Client ID** (the string ending `.apps.googleusercontent.com`
   — the console's copy sometimes brings its helper text along; the app
   keeps only the id) and **Client secret** into the app's Google boxes,
   press **Save backup settings**, then **Connect Google Drive**.

The app asks for one permission, `drive.file`. That scope only lets it see
files it created itself: it cannot read anything else in your Drive.

### OneDrive

1. <https://entra.microsoft.com> → **Applications → App registrations → New
   registration**.
2. Supported account types: *Accounts in any organizational directory and
   personal Microsoft accounts*.
3. **Redirect URI**: platform **Web**, value
   `https://<your app address>/backup/oauth/microsoft`.
4. After it is created, **Certificates & secrets → New client secret**. Copy
   the *Value* (not the Secret ID) immediately — it is shown once.
5. The **Application (client) ID** is on the Overview page. Put both into the
   app's OneDrive boxes, save, then **Connect OneDrive**.

The app asks for `Files.ReadWrite` and `offline_access` — permission to work
with your files, and permission to keep working without you signing in again.

### Dropbox

1. <https://www.dropbox.com/developers/apps> → **Create app** → **Scoped
   access** → **Full Dropbox** → give it a name.
2. On the app's **Permissions** tab tick `files.content.write`,
   `files.content.read` and `files.metadata.read`, then **Submit**.
3. On the **Settings** tab, under *OAuth 2 → Redirect URIs*, add
   `https://<your app address>/backup/oauth/dropbox`.
4. Copy the **App key** and **App secret** into the app's Dropbox boxes,
   save, then **Connect Dropbox**.

### Setting the schedule

Pick how often (every day, weekdays only, once a week, once a month), at
what hour — Grande Prairie time, always, whatever clock the person setting
it is on — and how many backups to keep. The panel prints the schedule back
in words and, once a drive is connected, when the next one is due. Older
folders beyond the keep count are removed after each *successful* run;
copies taken automatically just before a restore are never tidied away.

Then press **Back up now** once and watch it through. The first backup is
the slow one and can take an hour on a busy database; it keeps going on the
server whether the screen is open or not, so the panel can be closed and
reopened. A run that is going shows its phase and a running count of records
and files.

### Rehearsing a restore

**Done once, on 5 September 2026**, against the first real backup
(`2026-09-05 08-47`: 23 tables, 203,838 rows, 26 files) — a full restore
over an empty project, a full restore over a populated one (the wipe path),
and a restore of two chosen jobs run twice (the second a no-op). Every row,
file, total and timestamp came back identical to live; it took four to six
minutes each. It found four defects before they reached live, all fixed:
the safety copy pruning the drive, a one-statement wipe that the database's
eight-second limit refused, a retry reusing the most damaged safety copy,
and a restore that waited on the cron instead of starting itself. Do it
again after any change to the restore code, and never on the live project.

Branching needs the Pro plan, which this project is not on. What worked
instead — and is simpler than the second-Worker route below — was a
throwaway free project in the same organisation: apply every migration to
it, unschedule its cron jobs, deploy the three backup functions, copy the
drive connection's `backup_*` columns from live's `app_settings` into
its own row with one SQL `format()` statement run in each project's SQL
editor (leave the Resend key out so it cannot mail), bootstrap one Admin by
inserting an `auth.users` row with every token column set to `''`, sign
that Admin in with the token endpoint, and call `backup-restore` directly.
The scripted version of that is in the session notes; the shape is what
matters. Delete the project afterwards. The original route, for a plan that
has branches:

1. Connect the drive on the live app and let one backup complete.
2. In the Supabase dashboard, create a branch off the project (Branches →
   Create branch). A branch gets the schema and its own empty data.
3. Stand the app up against that branch and connect the drive from it. This
   is the fiddly step and it is worth knowing why before starting: the
   drive's callback arrives at `/backup/oauth/<provider>`, which is a
   *Worker* route, so a plain `npm run dev` cannot receive it. Deploy a
   second Worker instead — a copy of `wrangler.jsonc` with a different
   `name`, built with the branch's URL and publishable key in
   `vite-app/.env` — deploy the three backup functions to the branch, put
   that Worker's address into the branch app's **App address**, and add its
   `/backup/oauth/<provider>` to the registration's redirect URIs. All three
   providers accept several.
4. **Restore everything** from the folder the live app wrote. Type the
   folder name when it asks. Watch the phases go past: safety, wipe,
   accounts, tables, files, activity.
5. Then check the branch the way an admin would: sign in, open the board, a
   job, one of its tickets, its invoice PDF, and the timesheet ledger.
6. Delete the branch and the second Worker, and take the extra redirect URI
   back out of the registration.

What to expect, so none of it reads as a fault: the restore's own first
phase writes a `before-restore …` folder into the same drive, and that one
is kept for ever rather than tidied away by the retention count; the error
log and the audit trail come back empty (they are not backed up, and their
links to the staff list mean they have to be cleared before the wipe can
finish); accounts are re-created in Auth with passwords nobody knows, and
each active one is mailed a set-password link — so do this on a branch whose
Resend key you are content to have send, or take the key out of the branch's
Admin screen first; and any account that could not be re-created is named on
the run rather than stopping it.

### When a run fails

The panel says so in place of the last-run line, with the reason the run
recorded, and — this is the important half — **the next scheduled backup
still runs**. A failure does not stop the schedule and does not have to be
cleared by hand. Read it in this order:

- **"The drive needs reconnecting."** The provider has withdrawn the app's
  access, or the client secret has been rotated or has expired. Press
  **Disconnect**, check the client secret in the registration, and connect
  again. Nothing backs up while that message is showing.
- **A run that says it could not open a folder or upload a file.** The drive
  is full, or the provider was having a bad hour. The next run will try
  again; **Back up now** tries immediately.
- **A folder in the list tagged "didn't finish".** It has no index, so it is
  not offered for restoring. A run that died partway leaves one; it is
  harmless and retention will clear it in time.
- **A run that stays "in progress" with nothing moving.** The five-minute
  tick picks up a run whose slice died and carries on with it, so give it
  ten minutes before doing anything. If it is still stuck, the reason will
  be in `function_errors` (Supabase → Table Editor) under `backup-run` or
  `backup-restore`.
- **A restore that failed.** This is the one failure where the next
  scheduled backup is not the answer, because the app itself may be
  half-way through being replaced — so the panel says which it is, in the
  failed-run line, and it is worth reading before anything else is pressed.
  - *"It stopped before the app was emptied."* Nothing has been changed;
    everything is as it was. Deal with the reason it gives — nearly always
    the drive — and press **Restore** again.
  - *"The app was emptied before this failed."* What is in the app now is a
    part-restored copy, and there are two ways out. Either press **Restore**
    on the same backup again, which carries on from where it stopped; or
    restore the `before-restore …` folder the panel names, which is the copy
    taken automatically just before this started and puts back exactly what
    was here before. Both are ordinary restores from the list. The safety
    copy is never tidied away by the retention count, so it is still there
    however long it takes to decide.
  - **Restoring jobs** never empties anything — it only adds — so a per-job
    restore that fails has left the rest of the app alone. Press Restore on
    those jobs again. Its notes are printed under the failed line too, and
    they name each job, ticket or crew row that did not come back.
- **Nothing has run at all and no failure is shown.** Either no drive is
  connected, or the `backup-tick` cron job is not there — it arrives with
  the migration, so a project restored from `supabase db push` has it and an
  older one may not. Check `select * from cron.job` in the SQL editor.

A restore's own report is worth reading even when the run says complete: the
panel prints the notes underneath, naming each job, ticket or crew row it
could not put back and why.

## Wiping the seed data

Every job, ticket, client, contractor, contact and account in the system
today (except blacklabndt@gmail.com) is generated test data. The wipe is
staged, reviewed, and run by hand exactly once:

    supabase/handover/wipe-seed-data.sql

Read its header before running — it says what survives (the owner
account, the house rate card, the schema itself) and what to do about the
storage buckets afterwards. Despite its name it empties everything, not
only the seed rows, so it refuses to run until the session has said so:
`set app.confirm_total_wipe = 'yes';` first, in the same SQL session.
**It also retires the Playwright e2e suite**, which signs in as two of the
seed technicians; keep a pair of test accounts if the suite should outlive
handover.

To remove only the generated rows and keep real records, run
`supabase/handover/wipe-seed-only.sql` instead — it works by the seed
markers (S-1… jobs, @seed.vagabonde.ca accounts, organisations that only
ever appeared on seed jobs) and prints a preview of the organisations it
will remove before the deletes.

## Invoice numbers

An approved ticket becomes an invoice the moment an Admin presses **Mark
invoiced** on the billing tracker: the app stamps it with the next number in
its own series — starting at **1000** — and the client's copy prints as
INVOICE, with that number, the date it was raised, and the terms, GST number
and remit-to block set on the Admin screen. Nothing else in the app writes
that number.

A number is never reused. Pulling a ticket back to Approved to correct
something leaves the number on it, so the corrected bill goes out under the
number the client already has in their system rather than appearing as a
second invoice for one day's work.

To carry on a series that started somewhere else — an accounting package, a
pad of paper invoices — run this once in the Supabase SQL editor **before**
the first ticket is marked invoiced, never after, or the next invoice takes a
number a client has already been given:

    alter sequence public.invoice_number_seq restart with 4001;

The same command is what to run after restoring into a fresh Supabase project
(Path B): a backup carries the tickets and the numbers on them, not the series
they came from, so set it past the highest number restored —
`select max(invoice_number) from public.tickets;`.

## Day one, for the new admin

1. **Admin screen** (drawer → Admin): Resend key, then the two sending
   addresses once the domain verifies; the app's public address; KLIPY
   key if the crew wants GIFs; the **Invoices** section — terms, GST
   number and remit-to block — so the first invoice prints complete. Send
   the test email.
2. **Supabase dashboard**, five minutes: Site URL, leaked-password
   protection.
3. **Users & access**: create the crew's accounts — role sets the tabs,
   tabs can be tuned per person afterwards. Tick Subcontractor for anyone
   who invoices rather than draws payroll.
4. **Rate admin**: replace the house card's placeholder prices with real
   ones, per client add their card (or let it follow the house card, or
   copy another client's card as a starting point), and **Publish
   schedule** once per card — after that, edits go live as they save.
   Tickets snapshot their rates when raised, so publishing never reprices
   anything already out. Set the **GST rate** on any client that is exempt
   (it is 5 unless changed) — the invoice, the approval email and the
   receipt all charge the client's own rate.
5. **Contacts**: the real clients, contractors, and the people at each —
   the primary contact is what jobs, report emails and approvals pre-fill.
6. **Automatic backup**, once the app address is set: register one drive
   app, connect it, set the schedule, and press Back up now — see
   "Connecting a backup drive" above. It is the only step here that needs an
   account outside Supabase and Cloudflare, and the only one that protects
   everything the other five set up.

## When something looks wrong

- **"What version is everyone on?"** — bottom of the drawer, on every
  device: version, build, date. Updates announce themselves with a
  banner (Restart now / Postpone) within half an hour of a deploy.
- **"N queued" in the top bar** — work saved on a device that hasn't
  reached the database yet; it syncs itself when signal returns. **"N
  won't sync"** is different: tap it, read the reason, fix and retry.
- **An email didn't arrive** — Resend's dashboard → Emails shows every
  attempt and why it failed. The app-side reasons are on the **Admin
  screen**, under **Recent background errors**: the newest twenty failures
  from the functions that send mail, render PDFs and remove accounts, with
  **Refresh** beside them and **Clear** to empty the log once they have been
  dealt with.
- **An approval link opens as a plain text-looking page** — the Admin
  screen's App address is blank or wrong.
- **A ticket went to the client by mistake, or with the wrong figures** —
  **Cancel approval** on its row (Job detail, the field-invoice viewer or
  the tracker) makes the client's link stop working and the ticket a draft
  again; **Cancel and edit** does that and opens it. A ticket the client
  has already signed cannot be pulled back this way.
- **A technician needs to see how the last person billed a job** — open
  the job, tap the other technician's ticket or its **View** button, and the
  field invoice opens to read. Only the technician who raised a ticket, or
  an Admin, can edit it; a Helper sees the list without prices, by design.
- **A client is GST exempt, or charged the wrong rate** — Rate admin, the
  client's card, **GST rate**. Admin only; it changes every ticket priced
  from then on and nothing already sent.
- **"How old is the unsigned money?"** — the tracker's aging tiles and
  **By client** view. The two export buttons beside them are for the
  accountant: one row per ticket, GST and invoice number included.
- **A technician says their ticket changed under them** — two devices
  saved the same draft and the later save won, whole. If the later one was
  a queued save replaying after signal came back, that device was told at
  the time and shows a banner on the draft until it is dismissed. Reopen
  the ticket and check the welds, charges and crew.
- **Somebody wants the app to do something it doesn't** — the drawer's
  **Feature request** button mails the owner with the sender's name and
  role on top. The **?** in the top bar explains the open screen.
- **"What happened overnight?"** — an Admin sees a **Needs attention**
  strip above the board when something needs doing, and gets the same
  by email each morning (admin-digest); silence means nothing is wrong.
- **Chat push isn't arriving on one device** — notifications are allowed
  per device from Team chat; on shared tablets the next tech's sign-in
  claims the device's subscription automatically.
- **Chat history fades** — by design: unpinned messages expire after 30
  days, swept nightly.
- **"The drive needs reconnecting"** on the Admin screen — the backup
  provider has withdrawn the app's access or the client secret has been
  rotated. Nothing backs up until it is reconnected; see "When a run fails"
  above.
- **Somebody who left is back** — an account with tickets, JHAs or jobs on
  file is locked rather than deleted when it is removed, so the records keep
  their name. Users & access shows "Locked out" on that account, and
  **Unlock account** on the same card is the way back: they sign in again
  with the password they had, at the role they left at, with that role's
  sections. If they have forgotten the password, **Email a set-password
  link** once the account is unlocked. Neither one needs the Supabase
  dashboard.
- **Somebody deleted a job that should not have gone** — Admin → Automatic
  backup → Show backups → **Restore jobs** on the last backup that still
  had it. It puts back only what is missing and leaves everything else
  exactly as it is.
- **"It reloaded everything the first time I signed in"** — possible once
  per device after this release, and only on some of them. The offline
  cache now records which account it belongs to, and no existing device
  has that on file yet. On that first sign-in the app looks at who the
  device last had signed in: if it is the same person, the device is
  simply marked as theirs and everything on it — including a half-entered
  ticket or assessment — is kept. If it last belonged to somebody else, or
  it doesn't remember anyone, it is emptied at the door and fetches the
  jobs, rates and contacts again, so a tablet that gets passed around
  should have anything in progress finished and saved before the update
  lands. A device that does reload needs signal that one time; afterwards
  it behaves as before, and only a *different* person signing in clears
  it. Going out of range, or the session timing out overnight, never
  empties a device — sign back in and the morning's work is still there.

## Support access

Keeping the developer's account (blacklabndt@gmail.com) as an Admin for
the first months means logs, settings and fixes stay one sign-in away.
Remove it any time from Users & access — the RLS rules make every screen
answer to roles, not to hard-coded names.
