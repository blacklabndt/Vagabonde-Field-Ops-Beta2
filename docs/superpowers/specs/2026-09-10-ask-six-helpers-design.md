# Ask, six helpers: chase, new contact, done for the day, reminders, hours and dose, lookups

Date: 10 September 2026. Follows the files slice
(`2026-09-10-ask-makes-files-design.md`). Kyle picked six of the
suggestions; this spec is all six as one slice. The rules are the
earlier slices': every read runs as the person, a write goes through
the app's own form or a confirm on the card, the `ask` function writes
nothing of its own (bar `ask_learned`).

## 1. Chase from Ask

Tool `chase_unsigned(client?, older_than_days?)` — tab tracker, price
roles (the tracker's own gate: a chase from an account that cannot see
prices would mail a $0.00 approval). The runner reads the unsigned
tickets as the caller through the same read the tracker uses
(`listUnsignedTicketContacts`'s select, re-implemented against
`search_tickets`'s rows: id, client contact label, chased_at,
queried_at, job number, client name, work date), narrows by client
name and age, and applies `planChase` — the tracker's own three skips,
moved into `_shared/chasePlan.ts` with `vite-app/src/chasePlan.js`
keeping a twin core between `shared core` markers and a test comparing
the two, the way `backupSchedule` is held. `emailIn` (common.jsx) comes
along the same way, as `emailIn.ts`'s twin.

The card shows the plan as words: "Chase N tickets (T-1, T-2, …)? Left
alone: a with a question open, b sent or chased in the last three
days, c with no email on file." The action is
`{ kind: "chase", tickets: [{ id, to }], summary, done }`. On Chase,
App runs `runSendPool` with the tracker's workers and interval,
`Db.sendTicketApproval` then `markTicketChased` per ticket, toasts
muted around it, progress in a forced toast whose action is Stop, and a
summary toast at the end naming failures by ticket number. The done
sentence says the chase has started and where progress shows.

## 2. New contact or client

Tools `draft_contact(organisation, name, title?, email?, phone?, notes?)`
and `draft_organisation(name, type: client|contractor)` — tab contacts.
The runner resolves the organisation as the caller (exact name, else the
one hit of `search_org_directory`, else the model is told what to ask)
and proposes; nothing is written. Actions `draft_contact { org: { type,
id, name }, seed }` and `draft_organisation { seed: { type, name } }`
open the Contacts screen (App switches to it if held) with
`contactSeed`: the screen selects the organisation and opens the New
contact form filled from the seed, or opens the New organisation dialog
with the name and type. The form's own Save writes, as today.

## 3. Am I done for the day?

Tool `day_check(date?)` — tab job. `date` is a Grande Prairie calendar
day, today by default. As the caller: JHAs with `signed_by` = me and
`work_date` = date; tickets with `technician_id` = me and `work_date` =
date; `ticket_crew` rows of mine whose ticket's `work_date` = date;
reports with `profile_id` = me uploaded that day. The union of their
jobs is "the jobs I worked". Per job the runner reads that job's JHAs,
tickets (with crew count) and reports of the date and
`_shared/dayCheck.ts` (pure) answers `{ job_number, jha: { signed,
sent }, report: { uploaded, sent }, ticket: { exists, status, sent,
helper } , missing: [...] }`, `missing` being plain phrases ("JHA not
sent", "no ticket yet", "ticket not sent for approval", "no helper on
the ticket", "report not sent"). Ask answers with what is missing and
names the jobs.

## 4. Reminders

Migration: `scheduled_sends.kind` gains `reminder`; `job_id` becomes
nullable; the insert policy gains `(kind = 'reminder' and (job_id is
null or exists (select 1 from public.jobs j where j.id =
scheduled_sends.job_id)))`; `to_list` is `''` for a reminder. Probes
beside it. Tool `set_reminder(text, run_at, job_number?)` — tab any.
The runner converts the time with `localToUtc` and `checkRunAt`,
resolves the job when named, and proposes `{ kind: "set_reminder",
label: text, run_at, job, summary, done }`; the card's confirm reads
"Set it"; App inserts through `Db.scheduleSend` with kind `reminder`,
record_id `''`, to `''`. `list_scheduled` and `cancel_scheduled` cover
reminders as they are; `whenWords`/`describeScheduled` word a reminder
row as "Reminder: <text> — <time>".

At fire time the tick's reminder branch skips the mail and pushes
`resultPushWords` (title "Reminder", body the text, url the job's
address or "/") to the person's own subscribed devices through
`sendPush`. No device subscribed is a failure with the reason ("No
device of yours is set up for notifications — turn them on in the
drawer"), so the strip shows it. `fireGate` for a reminder checks the
account is active and nothing else.

## 5. Hours and dose

Tools `my_hours(start?, end?, person?)` and `my_dose(start?, end?,
person?)` — tab any; own rows by RLS. Defaults: hours to the current
pay period (1st–15th, 16th–end, Grande Prairie's calendar); dose to
the current calendar quarter. `person` is an Admin's only — anyone
else naming a person is refused in words — and matches a profile by
name. Hours: `ticket_crew` rows joined to tickets in the range, summed
per job and in total (straight, overtime, solo, solo overtime,
mileage, days) by `_shared/hoursDose.ts` (pure): integer-hundredths
sums, never float. Dose: `dose_totals(start, end)` as the caller (the
RPC is invoker-rights, own rows or Admin), rows filtered to the person.
The answer names the period.

## 6. Equipment and contacts lookups

`find_equipment(search?, filter?)` — tab equipment — over
`search_equipment` (filters as the screen's: All, the types, Due soon,
Overdue), first two pages, with type, serial, calibration due and who
holds it. `find_contact(name, organisation?)` — tab contacts — over
`contacts` (RLS: staff) matched by name, title, email or phone,
narrowed to an organisation when named, with the organisation's name
and type. Both read-only.

## Testing

- `chasePlan.test.mjs` gains the twin comparison; `emailIn` the same.
- `dayCheck.test.mjs`, `hoursDose.test.mjs` (client tests over the
  shared modules): missing phrases, period defaults at month edges, the
  sums.
- `scheduledSends.test.mjs`: reminder words, `fireGate("reminder")`,
  `resultPushWords` for a reminder; `scheduledSends.client.test.mjs`:
  the strip's reminder line.
- `askTools.test.mjs`: the eight tools, tabs, roles, trace lines;
  `askThread.test.mjs`: the new confirm kinds (chase "Chase",
  set_reminder "Set it").
- Probes: a reminder with no job, one on a visible job, one on a job the
  caller cannot read (refused), a `to_list` of `''`.
