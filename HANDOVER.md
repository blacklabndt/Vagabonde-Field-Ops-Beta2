# VagaboNDE Field Ops: handover guide

This guide explains how to take over the app, set up the office, and handle
common problems. If the app already works, start with **Day one**. You do
not need to install it again.

**Click** also means **tap** on a phone. The **drawer** is the side menu.
An **Admin** is someone allowed to change the app's settings. A **backup**
is a saved copy of business records and files. **Restore** means putting
that information back into the app.

## Find your task

- [Day one](#day-one)
- [Connect a backup drive](#connect-a-backup-drive)
- [Recover a deleted job](#recover-a-deleted-job)
- [Backup and restore problems](#backup-and-restore-problems)
- [Everyday problems](#everyday-problems)
- [Transfer ownership](#transfer-ownership)
- [Developer instructions](#developer-instructions)
- [Release status](#release-status)

## Day one

Have your Admin sign-in, the app's web address, the business's sending email
addresses, invoice details, prices, and staff list ready.

### 1. Set up email and invoices

1. Sign in to the app as an Admin.
2. Open the side menu. Click **Admin**.
3. Enter the business's Resend key and its two sending addresses. A key is
   a private code that lets the app use the email service. Verify the sending
   domain in Resend first; see the [setup document](Things%20to%20do%20to%20get%20set%20up.md).
4. Find **App address**. Enter the full address people use to open the app,
   starting with `https://`. Use the app address, not the Supabase address.
5. Find **Invoices**. Enter the payment terms, GST number, and the name and
   address clients should send payment to.
6. Click **Save settings**.
7. Under **Send a test email**, enter an inbox you can check. Click
   **Send test email**.
8. Open that inbox. Check that the message arrived, including in junk mail.

**Finished when:** the settings are saved and the test email arrives.
If it does not arrive, use the email steps under **Everyday problems**.

### 2. Check password settings

Do this with the person handing over. Supabase is the service that handles
sign-in and stores the app's records.

1. Sign in to the Supabase dashboard. Open the correct project.
2. Open **Authentication**, then **URL Configuration**.
3. Check that **Site URL** is the app's current address. Save any change.
4. Find the password security settings under **Authentication**. Check
   **leaked-password protection**. If the project's plan does not offer it,
   record that with the person handing over.
5. Send a password-reset link to an account you control. Check that the
   link opens the correct app.

**Finished when:** password-reset links reach the right app and the password
protection setting has been checked.

### 3. Add the crew

1. Open the app's side menu. Click **Users & access**.
2. Create an account for each crew member.
3. Choose their role. This sets the sections they can use.
4. Check their section permissions and adjust them if needed.
5. Tick **Subcontractor** for anyone who invoices the business instead of
   being paid through payroll.
6. Have one crew member sign in and check their access.

**Finished when:** the crew can sign in and see the sections they need.

### 4. Add contacts and prices

1. Open **Contacts**. Add the real clients, contractors, and contact people.
2. Choose each business's primary contact. The app uses this person to fill
   in contacts on jobs and emails.
3. Open **Rate admin**. Replace the house card's example prices with real prices.
4. Set up each client's card. It can follow the house card, use its own
   prices, or start as a copy of another client's card.
5. Check each client's **GST rate**. The default is 5; enter the correct
   rate for an exempt client.
6. Click **Publish schedule** for each new card. Once a card is published,
   later edits take effect when saved.

**Finished when:** each client has the right contact, prices, and GST rate.
Existing tickets keep their saved prices. A ticket's GST rate is saved on
its first approval attempt, or when first invoiced if it has no saved rate.
Older tickets without a saved GST rate still use the client's current rate.

### 5. Start backups

1. Follow **Connect a backup drive** below.
2. Choose the schedule and how many backups to keep.
3. Run a backup yourself and wait for it to finish.

**Finished when:** the panel shows a completed backup and the next scheduled
run. A connected drive alone does not prove a backup worked.

### 6. Check the app together

1. Open a job and check its details.
2. Open a ticket and check its prices and tax.
3. Open a report or invoice PDF and check that it is readable.
4. Open **Timesheets** and check the expected people are listed.
5. Write down who the office should contact for help.

Use agreed test records. Sending an approval sends a real email, so use
a test recipient if checking that step.

## Connect a backup drive

Use a Google Drive, OneDrive, or Dropbox account owned by the business.
Backups contain private information, including hours, dose readings, and
client prices. Only one drive can be connected at a time.

The backup contains the records and files supported by the app's backup
system. It does not replace ownership of the code or hosting accounts.
The error log, audit trail, and private service keys are left out. A restore
does not replace the live Resend, KLIPY, or drive credentials with backup values.

### Start here for all providers

1. Open **Admin**. Check **App address** and click **Save settings**.
2. Find **Automatic backup**, then **App registration**.
3. Choose the drive provider.
4. Copy its **redirect URI**. This is the return address the drive uses to
   send you back to the app after signing in.
5. Leave the app open. Follow just one provider section below in another tab.

An **app registration** gives the backup system permission to use your drive
without knowing your drive password. Copy its ID and secret into the app;
do not put secrets in this guide or send them in chat.

### Google Drive

1. Open [Google Cloud](https://console.cloud.google.com/projectcreate).
   Create a project for the business's backup connection.
2. Select that project. Open the
   [Google Drive API page](https://console.cloud.google.com/apis/library/drive.googleapis.com)
   and click **Enable**.
3. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview).
   Enter the app name and the business's contact email.
4. Set the audience to **External** for a connection using an ordinary Google
   account. Set the publishing status to **In production** when ready.
   Testing mode normally limits access to listed test users and expires
   this connection after seven days.
5. Open [Credentials](https://console.cloud.google.com/apis/credentials).
   Choose **Create credentials**, **OAuth client ID**, then **Web application**.
6. Under **Authorised redirect URIs**, paste the address copied from the app.
   Save the registration.
7. Copy the **Client ID** and **Client secret** into the app's Google boxes.
8. Click **Save backup settings**, then **Connect Google Drive**.
9. Sign in with the business's Google account, review the permission request,
   and complete the connection.

The app requests `drive.file`, a limited file permission, to manage its backup
files. If Google blocks sign-in, check the audience, publishing status, and
the business's Google Workspace restrictions. See
[Google's publishing guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)
and [Drive permissions](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

### OneDrive

1. Open [Microsoft Entra](https://entra.microsoft.com).
2. Open **App registrations** and click **New registration**.
3. Enter a name for the business's backup connection.
4. Choose **Accounts in any organizational directory and personal Microsoft
   accounts** as the account type.
5. For **Redirect URI**, choose **Web**. Paste the address copied from the
   app. Create the registration.
6. On **Overview**, copy the **Application (client) ID** into the app's
   OneDrive ID box.
7. Open **Certificates & secrets**, then **New client secret**. Create one.
8. Copy the secret's **Value**, not its Secret ID, into the app's secret box.
   Copy it now; it is only shown once. Record its expiry date in the
   business's reminder system so it can be replaced in time.
9. Click **Save backup settings**, then **Connect OneDrive**.
10. Sign in with the business's Microsoft account and complete the connection.

The app asks for file access and permission to stay connected between runs.
If the menus differ, use [Microsoft's registration guide](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app).

### Dropbox

1. Open [Dropbox's app console](https://www.dropbox.com/developers/apps).
2. Click **Create app**. Choose **Scoped access**, then **Full Dropbox**.
3. Give the registration a name and create it.
4. Open **Permissions**. Tick `files.content.write`, `files.content.read`,
   and `files.metadata.read`. Click **Submit**.
5. Open **Settings**. Under **OAuth 2**, add the return address copied from
   the app to **Redirect URIs**.
6. Copy the **App key** and **App secret** into the app's Dropbox boxes.
7. Click **Save backup settings**, then **Connect Dropbox**.
8. Sign in with the business's Dropbox account and complete the connection.

See [Dropbox's connection guide](https://developers.dropbox.com/oauth-guide)
for an explanation of its permission choices.

### Set the schedule and check the first backup

1. Return to **Admin**, then **Automatic backup**.
2. Check that the drive is connected.
3. Choose how often to back up: daily, weekdays, weekly, or monthly.
4. Choose the hour. The app uses **Grande Prairie time**, even if you are
   setting it up somewhere else.
5. Choose how many backups to keep. Save the backup settings.
6. Read the schedule shown in words. Check that it matches your choice.
7. Click **Back up now**.
8. Wait for completion. A large first backup can take an hour. You may close
   the screen; the server keeps working.
9. Reopen the panel if needed. Read the result and click **Show backups**
   to find the completed copy.

**Finished when:** the backup completed and the next run is shown.
After a successful run, older backups beyond the keep count are removed.
Safety copies taken before a restore are not removed by that count.
To switch providers, disconnect the old drive first.

## Recover a deleted job

Use this when a completed backup still contains the missing job.

1. Ask anyone working on that job to pause while you recover it.
2. Open **Admin**, then **Automatic backup**.
3. Click **Show backups**.
4. Find a completed backup from before the job was deleted.
5. Click **Restore jobs** on that backup.
6. Select the missing job and start the restore.
7. Wait for completion. Read any notes about items that could not be restored.
8. Open the job. Check its tickets, reports, and crew records.

**Finished when:** the missing records are back and checked.
This option adds missing records. It does not overwrite existing records,
so it is not a way to undo an edit to a job that is still there.

## Backup and restore problems

Open **Admin**, then **Automatic backup**, and read the run's message.
A failed backup does not turn off the schedule. A failed restore needs
attention because it may have changed data.

### The drive needs reconnecting

1. Click **Disconnect**.
2. Check whether the provider's client secret expired or changed.
3. Save a replacement secret if needed.
4. Connect again and run **Back up now**.

### A folder or file could not be saved

1. Check the drive has space.
2. Check the drive provider is working.
3. Click **Back up now** to retry.

An unfinished backup cannot be used for a restore. Choose a completed copy.

### Progress has stopped, or nothing has run

1. For a stuck run, wait ten minutes. The automatic five-minute check may
   resume it.
2. Refresh the panel.
3. Check that a drive is connected and the schedule is saved.
4. If still stuck, ask support to check `function_errors` for `backup-run`
   or `backup-restore`. If scheduled backups never start, the developer
   should also check the `backup-tick` scheduled job.

### A restore failed

1. Read whether the app was emptied before the failure.
2. If it says **before the app was emptied**, fix the reported problem
   and retry. The existing records were not emptied.
3. If it says **the app was emptied before this failed**, ask the crew to
   stop entering data and contact support. Retry the same backup to continue,
   or restore the named `before-restore` safety copy to recover the previous data.
4. If **Restore jobs** failed, read which records failed, fix the cause,
   and retry those jobs. Other jobs were not emptied.

Read the final notes even when a restore says complete. They may name
individual records or accounts that could not be put back.

## Everyday problems

### A screen crashes

1. Note the screen and time. If possible, note the version at the bottom
   of the side menu.
2. Use **Reload** on the problem screen. Tell the office if it happens again.
3. In the office, sign in as an Admin and open **Admin**.
4. Find **Recent background errors** and click **Refresh**. This is the panel
   called "Recent failures" in earlier handover discussions.
5. Look for an entry marked `browser`. If a task filter is shown, choose
   `browser` or **All tasks**. Use **Load 20 more** for older entries.
6. Give support the entry and the steps taken before the crash.

The report records the screen, error category, app version, and whether
the whole app or one screen caught the error. It does not send raw error
text, screen contents, or screenshots. Reporting needs a signed-in session
and a working connection. Reports are limited to prevent flooding the log.
A missing report does not prove nothing crashed.

Reporting is deployed. A deliberate signed-in screen crash followed through
to this panel has **not yet been checked end to end**.

### Email did not arrive

1. Check the recipient address and junk folder.
2. Open **Admin**, then **Recent background errors**. Click **Refresh**.
3. Read any entry for the failed send.
4. Open the business's Resend dashboard. Check **Emails** for the attempt.
5. Correct the reported problem, then retry the intended send.

**Clear** only removes log entries. It does not fix the cause or resend mail.

### Work is waiting to upload

1. **N queued** in the top bar means work is saved on this device and waiting
   to reach the database. Restore the connection and give it time to send.
2. If it says **N won't sync**, click it, read the reason, fix it, and retry.
3. Finish saving before handing a shared device to another person. A
   different person's sign-in clears the previous person's local app data.

Losing signal or having a session expire does not itself empty the device.
Sign back in as the same person to continue. Older devices may need a
one-time reload when the app cannot identify who owned their old local data;
finish and sync work before changing accounts or updating a shared device.

### An approval was sent by mistake

1. Open the ticket from the job or **Billing tracker**.
2. If it is unsigned, click **Cancel approval**. This stops the client's
   link working and returns the ticket to a draft.
3. Use **Cancel and edit** if you also want to open it for changes.
4. Check figures and recipient before sending again.

A signed ticket cannot be pulled back this way. If an approval link displays
page code, check **App address** and ask support to check the Worker route.

### A ticket's figures changed or its tax is wrong

1. Open the ticket. Check its lines, charges, and crew details.
2. Ask an Admin to check the client's card in **Rate admin**.
3. Remember that rate-card edits do not replace saved ticket prices.
4. For tax, ask support whether the ticket has a saved GST rate. A client
   rate change does not replace a saved ticket tax rate.

When two devices save the same draft, the later save wins. An offline save
that later replaces another edit can show a warning on the device that
sent it. Reopen and check the whole ticket before sending it.

### Someone needs an account unlocked

1. An Admin opens **Users & access**.
2. Find the person's account marked **Locked out**.
3. Click **Unlock account**. Check their role and permissions.
4. Have them sign in with their existing password.
5. If they forgot it, use **Email a set-password link** after unlocking.

Accounts linked to business records are locked instead of erased so old
records still show who did the work.

### Other quick answers

| Task or question | What to do |
|---|---|
| Check someone's version | Read the version, build, and date at the bottom of the side menu. Use **Restart now** when the update banner appears. |
| Read another technician's ticket | Open the job and click its ticket or **View**. Helpers do not see prices. Only its technician or an Admin can edit it. |
| Find unsigned money | Open **Billing tracker**. Check the aging tiles and **By client**. Use its exports for the accountant. |
| Find work needing attention | Check **Needs attention** above the board and the Admin morning email. No email alone does not prove all is well; email can fail. |
| Enable chat notifications | Open Team chat and allow notifications on each device. |
| Find old chat messages | Unpinned messages expire after 30 days and are removed nightly. |
| Suggest a feature | Use **Feature request** in the side menu. It emails the owner. |
| Understand the current screen | Click **?** in the top bar. |

## What runs the app

| Part | What it does | Where it lives |
|---|---|---|
| App | The screens the crew and office use | Code in `vite-app/` |
| Cloudflare Worker | Delivers the app, approval pages, and backup sign-in returns | `worker/index.js` and `wrangler.jsonc` |
| Supabase | Stores records and files; handles sign-in | Current project `eielmvxzdwwprmmfamlq` |
| Server functions | Carry out email, backups, crash reporting, Ask, and other tasks | `supabase/functions/` |
| Resend | Sends email | Business account; settings in **Admin** |
| KLIPY | Finds chat GIFs; optional | Key in **Admin** |
| Backup drive | Stores copies for recovery | Business's Google Drive, OneDrive, or Dropbox |
| GitHub | Holds code and runs release checks | `blacklabndt/Vagabonde-Field-Ops-Beta2` |

## Transfer ownership

The business owner and developer should do this together. Choose whether
to keep the existing database (Path A) or build a new one (Path B).

### Path A: keep the existing database

1. Confirm the business can access its GitHub, Supabase, Cloudflare, email,
   and backup accounts. Record who controls billing and account recovery.
2. Make a backup and check it completed.
3. Have the new owner create a Supabase organization. Give the person
   transferring the project the required access to that organization.
4. In the existing project's **General settings**, use **Transfer project**.
   Check the destination and plan. Plan changes can affect features or
   briefly interrupt service. Follow
   [Supabase's transfer checklist](https://supabase.com/docs/guides/platform/project-transfer).
5. Have the developer deploy the Worker in the business's Cloudflare
   account. Update GitHub's deployment credentials and account setting too;
   the current workflow explicitly names the original Cloudflare account.
6. Decide the final app address before the crew installs it.
7. If it changes, update **Admin / App address**, Supabase's **Site URL** and
   allowed redirects, and the backup provider's return address. Reconnect
   the backup drive.
8. Test sign-in, password reset, a test email, an approval link to a test
   recipient, and a backup from the final address.
9. Have the crew install from that address and allow notifications.
10. Decide whether test records need removing. A transfer does not require
    erasing data. Use the developer cleanup steps if needed.

**Finished when:** the business controls the accounts and the app works
from the final address.

### Choose the web address

1. Decide whether to use a `workers.dev` address or a business address
   such as `app.vagabonde.ca`.
2. Have the developer check the current DNS arrangement, configure the
   domain in Cloudflare, and verify it opens the right app.
3. Complete Path A's address changes and checks.
4. Give the final address to the crew.

Installed apps and notification permissions belong to an address. A later
change means reinstalling and allowing notifications again. Keep the old
address available for existing approval links until the developer has
checked how those links will continue to work.

## Developer instructions

These tasks change hosting, database structure, or stored records. The
office can use the earlier sections without running these commands.

Run terminal commands from the repository root, the folder containing this
file. Run each separately and check its result before continuing.
The [setup document](Things%20to%20do%20to%20get%20set%20up.md) covers initial
service setup. Use [README: Deploying](README.md#deploying) for releases;
older setup examples are not a complete list of today's functions.

### Path B: fresh install

This needs developer preparation. The repository contains the original
project's addresses; a new `.env` file alone does not redirect everything.

1. Create a new, empty Supabase project. Record its reference, URL, and
   public key. Label it clearly so it cannot be confused with live.
2. Inspect `supabase/handover/`. Read headers: `draft-*` may mean pending
   work or a historical copy; `probes-*` are checks, not migrations.
   Compare these with migrations and release notes.
3. Prepare reviewed installation SQL for the new project. Preserve the
   original project's applied migration files. The baseline
   `20260817040000_beta1_baseline.sql` is for an empty project only.
   Never apply it to the existing live database.
4. Before running the installation SQL, replace the old URLs and public
   keys in its scheduled jobs and chat push function. Otherwise timers
   start calling the old project as soon as the database is created.
   Check all four jobs: `chat-retention-nightly`, `backup-tick`,
   `admin-digest-daily`, and `scheduled-sends-tick`. Also check the
   chat-message trigger calling `chat-push`.
5. If unmodified migrations already ran on the new project, immediately
   stop its schedules with the SQL below. Correct its chat push function
   before inserting chat messages. Run this only in the **new** project:

   ```sql
   select cron.unschedule(jobid) from cron.job;
   ```

6. Apply the reviewed schema to the new project. Once its functions are
   ready, recreate its four schedules using its own URLs and credentials.
   Inspect the resulting schedules and chat push function.
7. Copy `vite-app/.env.example` to `vite-app/.env`. Set
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for the new project.
8. Update `FUNCTIONS_ORIGIN` in `worker/index.js` to its function address.
   This controls approval pages and backup sign-in returns.
9. Generate a push key pair with `npx web-push generate-vapid-keys`.
   Put the public key in `vite-app/src/config.js`. Set matching
   `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT`
   function secrets in the new project. Keep private keys out of Git.
10. Configure the remaining function secrets and authentication settings.
    Review `supabase/config.toml`, authentication hooks, and the project's
    internal shared secret. Deploy every actual function directory,
    including `report-error`; `_shared` is library code, not a function.
11. Create the first Admin and verify its profile and permissions.
12. Build the app for the new project. Prepare a separately named Worker
    in the intended account. Configure its release workflow for the new
    account and project too; a local `.env` file is not automatically
    available in GitHub Actions. Do not deploy until the next check passes.
13. Search `vite-app/dist/` for `eielmvxzdwwprmmfamlq` and investigate
    any match. Missing build settings silently fall back to the old live
    project. Rebuild after correcting them. Once this check passes, deploy
    the new app and Worker.
14. Complete **Day one**. Test sign-in, permissions, password reset, email,
    approval links, chat push, backup connections, and scheduled tasks.
    Confirm the records and requests belong to the new project.
15. If restoring old tickets, set the invoice sequence below before any
    new invoices are created.

**Finished when:** the deployment works independently and no app request,
Worker route, or scheduled task still points at the original project.

### Remove test records or empty the app

Do not assume all current records are test data. The owner must decide what
to keep. These are one-off deletion scripts, not migrations.

1. Make a backup and verify it completed.
2. Confirm the project and deletion scope with the owner.
3. Choose the script:

   | Goal | Script |
   |---|---|
   | Remove generated test records; keep real work | `supabase/handover/wipe-seed-only.sql` |
   | Empty business records and remove accounts except the original owner | `supabase/handover/wipe-seed-data.sql` |

4. Read the full header and SQL. Seed-only cleanup uses markers such as
   `S-1` jobs and `@seed.vagabonde.ca` accounts. Review its organization
   preview before running deletion statements.
5. For a full wipe, check the preserved owner address
   `blacklabndt@gmail.com`. The house rate card and database structure
   survive. Review the optional settings-clear block separately.
   The required confirmation is `set app.confirm_total_wipe = 'yes';`
   in the same SQL session as the wipe.
6. Run the agreed script in the confirmed project's SQL editor.
7. After a full wipe, follow its storage cleanup instructions. Removing
   file records does not remove stored file bytes. Do not empty buckets
   after seed-only cleanup that must retain real files.
8. Check the surviving account and records. Replace the seed test accounts
   if automated browser tests must continue; the tests use seed technicians.

**Finished when:** the agreed records are gone, intended records remain,
and the owner can still sign in.

### Set the next invoice number

An Admin assigns an invoice number by clicking **Mark invoiced** on an
approved ticket in **Billing tracker**. The default series starts at 1000.
Returning a ticket to Approved keeps its number.

Use this when continuing an existing numbering series or restoring into
a fresh project. Pause invoicing while doing it.

1. In the correct project's SQL editor, check the highest ticket number:

   ```sql
   select max(invoice_number) from public.tickets;
   ```

2. Check the accounting records for higher numbers issued outside the app.
   Check the current sequence too. Never move an existing series backwards.
3. Choose the next unused number above those values. For example, after
   4000, choose 4001.
4. Replace the example `4001` with the agreed number and run:

   ```sql
   alter sequence public.invoice_number_seq restart with 4001;
   ```

5. Record the change. Check the next legitimate invoice gets the expected
   number. Do not issue a real invoice just for a test.

A backup carries ticket numbers but not the sequence's position.

### Rehearse a full restore

Use a separate test project, never live. Full restore empties the
destination's business records before putting the backup back.

1. Make a completed backup of the source app.
2. Prepare a separate project using Path B, including correcting timers
   and chat push. Keep automated sends disabled during the rehearsal.
3. Deploy a separate Worker pointing only to that project.
4. Add its backup return address to the drive registration. Set the test
   app's **App address** and connect the drive.
5. Disable real email sending in the test project, including fallback
   Resend secrets. Restored active accounts may otherwise receive password
   emails. Use a controlled mail setup if testing those emails.
6. Open **Show backups**. Choose **Restore everything** on the agreed
   backup. Type the folder name when asked.
7. Wait for completion and read the notes. The stages include taking a
   safety copy, emptying the destination, and restoring accounts, records,
   files, and activity totals.
8. Compare record and file counts, PDFs, job details, ticket totals, dates,
   account access, and timesheets with the source. Set the invoice sequence
   before testing new invoicing.
9. Test **Restore jobs** twice for the same missing jobs. Check the second
   run does not duplicate them.
10. Record the results. Remove the test project, Worker, and extra return
    address when finished.

The `before-restore` safety copy is not removed by normal retention.
Error logs and the audit trail are not restored. Re-created accounts need
a set-password process; old passwords are not recovered. Read account
failures in the final notes.

**Past verification:** on 5 September 2026, a backup of 23 tables, 203,838
rows, and 26 files was restored into empty and populated test projects.
The recorded checks passed, including repeated selected-job restores.
That result does not verify later changes. Repeat after restore-code changes.

### Release an update

1. Review the changes and run the required tests and build.
2. Commit the reviewed changes.
3. When release is authorized, push to `room/37dbe6165f-beta-2-review`.
4. Open the repository's **Actions** page. Open the **CI** run for that
   commit and wait for tests, build, and deployment to succeed.
5. Check the live app serves the intended build.

A push to that branch automatically deploys the app and Worker after checks
pass, including a documentation-only push. To rerun manually, choose
**Actions**, **CI**, **Run workflow**, and that branch.

Supabase functions and database changes are released manually. Pushing
does not deploy them. Follow [README: Deploying](README.md#deploying) and
[CLAUDE.md](CLAUDE.md). Never deploy the old Beta 1 repository; it shares
the live services and would replace this app.

## Release status

Recorded status as of 12 September 2026:

| Item | Status |
|---|---|
| Browser crash reporting | Released: `20260912160845_browser_crashes.sql`, live probes, `report-error`, and app/Worker `b3c15b8`. |
| Signed-in screen crash appearing in the office panel | Not checked end to end. Database probes and unit tests do not complete this check. |
| Ask spending ceiling | Filed as `20260912034222_the_ceiling_is_charged_before_the_call.sql`, with follow-up fixes. Under the apply-live-first convention it is shipped; this doc review did not independently query live. |
| Saved GST rate per ticket | Applied as `20260911204844_a_ticket_remembers_its_gst_rate.sql`. The old handover draft was deleted; no further SQL needs applying for this change. |

For the crash check, use an agreed test account and controlled screen-render
failure. Confirm a `browser` entry in **Admin / Recent background errors**,
remove the test fault, and record the result. Throwing an error in the
browser console alone does not prove the screen error handler sent a report.

## Support access

1. Agree who supports the app and how the office contacts them.
2. Decide whether to keep `blacklabndt@gmail.com` as an Admin during handover.
3. Remove that access through **Users & access** when no longer needed.
4. Check the business still has a working Admin and controls its hosting,
   code, email, and backup accounts.

App access follows roles and permissions. The developer's email address
does not grant special access by itself.
