# Ask, fourth slice: a send can wait for its time

Date: 10 September 2026. Follows `2026-09-10-ask-sending-design.md`
(sending), `2026-09-10-ask-drafts-design.md` and
`2026-09-10-ask-assistant-design.md`.

## What it is

The person can say "send the JHA on S-10113 to Dave at seven tomorrow
morning", "email the report from today to the contractor rep on Friday
at 8", or "send T-10231 for approval at 6 tonight", and the card answers
with a confirm block naming the record, every address and the time in
Grande Prairie's clock, with **Schedule** and **Not now**. Pressing
Schedule inserts one row in a new `scheduled_sends` table, as the person,
through RLS. Nothing else happens then.

Every five minutes a cron job in the database calls a new
`scheduled-sends` Edge Function with the internal secret — the daily
digest's shape — and the function sends whatever is due through the same
code the live buttons send through. The person's device, session and
signal do not matter after the row is in the table: the email goes out
within five minutes of the time, phone off or on.

The person sees what is queued and what happened on Job detail (a
"Scheduled sends" strip with Cancel and Dismiss) and by asking Ask; a
failure also goes to the error log, where the digest and Home's strip
read it.

## Authority: two halves

The rule from the first spec holds: nothing scheduled carries more
authority than the person who scheduled it, and a timer must not become
a way round a gate. A live send is authorised once, by the person's
session. A scheduled one is authorised in two halves, because there is
no session at fire time:

1. **At scheduling time**, the row is inserted through RLS as the person.
   The insert policy accepts a row only when `set_by` is the caller and
   the record it names can be read by the caller — the policy looks the
   JHA, report or ticket up under the caller's own read policies, inside
   the policy. A record the person cannot see cannot be scheduled. Ask's
   runner has already applied the send gate before proposing (below), so
   a Helper who may not email someone else's assessment is refused in the
   card, not at 7 a.m.
2. **At fire time**, `scheduled-sends` reads the person's profile row and
   the record with the service role and applies the same gate the live
   function applies to a press — `fireGate` in `_shared/scheduledSends.ts`
   (pure): the account still active and holding a tab the record's read
   policy names; the role or ownership rule (`jhaSendGate` /
   `ticketSendGate` from askSends.ts, the report's role list); a PDF still
   on file; a ticket still unsigned. Anything changed since scheduling
   fails the row with the reason, and nothing is sent. The approval email
   records `approval_sent_by` as the person who scheduled it.

One code path sends. The bodies of `send-jha`, `send-report` and
`send-ticket-approval` — storage read, email, transport, the sent stamp
or the token write — move into three shared modules (`_shared/mailJha.ts`,
`mailReport.ts`, `mailApproval.ts`), each taking the service-role client,
the record row the caller has already read and gated, the recipient
strings mail.ts has already validated, and for the approval the id of the
sender. The live functions keep their doors, their reads as the caller
and their gates unchanged, and call the module; `scheduled-sends` reads
with the service role, applies `fireGate`, and calls the same module.

## The table

```
scheduled_sends
  id          uuid pk
  kind        text   check in ('jha', 'report', 'ticket_approval')
  record_id   text   the JHA or report uuid, or the ticket number
  job_id      uuid   references jobs on delete cascade
  label       text   what the strip says: "JHA RT-Shop.pdf (2026-09-08)",
                     "Report 12-inch-tie-in.pdf", "Ticket T-10231"
  to_list     text   comma-separated addresses, mail.ts's shape
  message     text   default ''
  run_at      timestamptz
  set_by      uuid   references profiles
  status      text   queued | sending | sent | failed | cancelled
  created_at  timestamptz default now()
  fired_at    timestamptz
  error       text
```

RLS: SELECT own rows, or every row for Admin and Coordinator. INSERT as
above (`set_by = auth.uid()`, `status = 'queued'`, `fired_at` and
`error` null, `run_at` not more than a minute past, the record visible
under the caller's policies and on the row's `job_id`). UPDATE only from
`queued` or `failed` to `cancelled`, own rows or the office, and the
column grant lets signed-in accounts write `status` alone — a Dismiss on
a failed row is a cancel. No DELETE for signed-in accounts; the service
role writes everything else. Probed with role simulation before it
ships: a Helper cannot schedule a report they cannot read, a technician
cannot cancel another's row, nobody can insert as somebody else or with
`status = 'sent'`.

The cron job `scheduled-sends-tick` (`*/5 * * * *`) posts to the function
with the internal secret, the seventh migration to bake this project's URL
and publishable key in (HANDOVER.md's Path B list grows by one).

## The tick

`scheduled-sends` (`verify_jwt = false`, guards itself on
`x-internal-secret` through `secretsMatch`; `constantTime.test.mjs` will
read it back):

1. Rows `sending` whose `fired_at` is older than fifteen minutes are
   marked `failed` with "The send did not report back — check whether it
   arrived before sending again." No retry: sending twice is worse than
   once too few, and the person can schedule again.
2. Due rows (`queued`, `run_at <= now()`, oldest first, twenty a tick)
   are each claimed with a conditional UPDATE (`status = 'queued'` →
   `sending`, `fired_at = now()`, returning the id); a claim that returns
   nothing was taken by another tick and is skipped.
3. For a claimed row: the person's profile (`role, tab_access,
   deactivated_at`), the record, `fireGate`, `recipients()` over
   `to_list` again, then `mailJha` / `mailReport` / `mailApproval`. On
   success `sent`; on any throw `failed` with the message, and a
   `function_errors` row naming the kind, the record and the job so the
   digest and Home's strip say so.

The tick runs the rows one after another. A tick meeting a gateway blip
throws to the log like the digest does, and the next tick tries the rows
still queued.

## Tools (`_shared/askTools.ts`)

- `list_reports(job_number)` — tab `job`: the job's reports, newest
  first: id, file, welds, result, uploaded, sent stamps.
- `schedule_send(kind, record_id, recipients[], run_at)` — tab `job`. The
  runner reads the record as the caller and applies the kind's gate
  before proposing: a JHA as `send_jha` does; a report needs a PDF and the
  role Admin, Coordinator or Technician (send-report's gate); a ticket
  approval needs a price role (the viewer's) and `ticketSendGate`.
  Recipients: a JHA's or a report's through `resolveRecipients`
  (contacts on file by name, or an address the person typed); a ticket
  approval's is the ticket's own rule and `recipients` is ignored.
  `run_at` is "YYYY-MM-DD HH:MM" in Grande Prairie's clock; `localToUtc`
  (pure, DST-correct through Intl) turns it into an instant; a time more
  than five minutes past or more than ninety days ahead is refused with
  words the model passes on. The action:
  `{ kind: "schedule_send", summary, done, to, send_kind, record_id,
  label, message, run_at (ISO, UTC), job: { id, job_number } }`.
- `list_scheduled(job_number?)` — tab `job`: queued and failed rows this
  person may read (RLS), newest first, with the label, addresses, time,
  status and error.
- `cancel_scheduled(id)` — tab `job`: the row read as the caller; queued
  or failed only; the action `{ kind: "cancel_scheduled", summary, done,
  id }`.

The prompt gains a line: a time the person gives is Grande Prairie's
clock; "tomorrow morning" without an hour is a question back; a schedule
tool schedules nothing until the card's Schedule is pressed.

## The card and App

The proposal block's confirm shape (slice 3) now covers four kinds:
`isConfirmAction` in askThread.js names them, and `confirmLabel` gives
the button its word — Send, Schedule, or Cancel it. `runAskAction` for
`schedule_send` calls `Db.scheduleSend(row)` (an insert, RLS deciding)
and answers `done`; for `cancel_scheduled`, `Db.cancelScheduledSend(id)`
(the conditional update; zero rows means "it already went or was
cancelled", said in words).

## Job detail

A "Scheduled sends" strip above the assessments, shown only when the job
has queued or failed rows: one line each — the label, the addresses, the
time in Grande Prairie's clock (`describeScheduled` in
`vite-app/src/scheduledSends.js`, pure), Cancel on a queued row, the
error and Dismiss on a failed one. Read fresh on each open
(`Db.listScheduledSendsForJob`, never the device cache: a stale "queued"
is a lie). Cancel goes through the same `Db.cancelScheduledSend` Ask
uses.

## Tests

- `scheduledSends.test.mjs`: `localToUtc` (a September time is MDT,
  a January time MST, a nonsense string refused, past and far-future
  refused); `fireGate` per kind (locked account, tab lost, PDF gone, ticket
  approved meanwhile, the signer/owner rules through askSends' gates);
  the stuck rule; the words.
- `askTools.test.mjs`: the four tools sit behind `job`; trace lines.
- `askThread.test.mjs`: `isConfirmAction`, `confirmLabel`.
- `backupShared.test.mjs`: `scheduledSends.ts` in the guard list, allowed
  to import `./askSends.ts` and nothing else.
- `constantTime.test.mjs`: reads `scheduled-sends` back (automatic).
- Live probes for the policies, filed under `supabase/handover/`.

## Not in this slice

Recurring schedules; editing a scheduled row (cancel and schedule again);
a device notification when a scheduled send goes; scheduling anything
other than the three sends; retrying a failed send.
