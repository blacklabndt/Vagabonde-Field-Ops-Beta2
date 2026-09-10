# Ask timers, follow-ups: the phone hears the result, and a send can be moved

Date: 10 September 2026. Follows `2026-09-10-ask-timers-design.md`.
Kyle's decisions on the four items that spec left out: a notification
when a scheduled send goes, on success **and** failure (yes); moving a
scheduled send to another time or other addresses (yes); a cc field
(dropped); recurring schedules (not a feature — each send is scheduled
on its own).

## 1. The scheduler's own devices hear the result

When the `scheduled-sends` tick finishes a row — sent or failed — it
sends one Web Push to every device subscribed under the account that
scheduled it (`push_subscriptions.profile_id = set_by`, the profile
still active). Nobody else's phone: the office reads failures in the
error log and the digest as before, and the crew's chat push is
untouched.

**Words** (pure, `resultPushWords` in `_shared/scheduledSends.ts`,
node-tested): a sent row reads

    Sent: JHA jha.pdf on S-10113
    To dave@example.com · Fri, Sep 11, 07:00

and a failed row

    Not sent: JHA jha.pdf on S-10113
    <the row's error, the same words Job detail's strip shows>

The payload is `{ kind: "scheduled_send", id, ok, title, body,
job_number, url: "/#/job/S-10113", tag }` — the job's own address,
which the app already honours at boot (`route.js`).

**The service worker** (`public/push-sw.js`) tells the two payloads
apart by `kind`. A chat push behaves exactly as it does now. A
scheduled-send push with the app on screen is handed to the page
(`postMessage({ type: "scheduled-send", ... })`) and shows nothing;
out of sight it is a notification of its own — tag
`scheduled-send-<id>`, so two results never collapse into one, and
never the chat's tag — and it does not touch the app badge, which is
the chat's unread count. Tapping it navigates to the job's address,
through the same click handler the chat uses.

**The app** listens beside the chat hand-off: a scheduled-send message
raises one forced toast (`ok` tone on success, `error` on failure)
with an **Open** action that opens the job, and bumps `filedNonce`, so
a Job detail page already showing that job re-reads its strip and the
sent row leaves it.

**Best effort, both ways.** The push is sent after the row's final
status is written, inside its own try/catch: a push that cannot go
(no subscription, VAPID missing, the push service down) never turns a
delivered email into a failed row, and a failed push is not logged as
an error — a row's failure already is. Endpoints answering 404/410 are
pruned, as chat-push prunes them.

**One send loop.** The VAPID setup, the send and the prune move from
chat-push into `_shared/webPush.ts` (`sendPush(admin, subs, payload)`),
which talks to supabase-js and web-push and so stays outside the
import-free guard list, like `backupCommon.ts`. chat-push keeps its own
recipient query (minus the sender, chat tab, active) and calls it;
scheduled-sends queries the scheduler's own devices and calls it.

## 2. Moving a scheduled send

A new Ask tool, `reschedule_send(id, run_at?, recipients?)` (tab job):
at least one of the two. The runner reads the row as the caller (RLS:
own, or the office), refuses one that is not queued or failed, reads
the record again through the same helper `schedule_send` uses — so the
screen's gate is applied again and the job is known — resolves new
recipients under askSends' rule when given (a ticket approval's
address is the rep's and cannot be given), keeps the row's addresses
when not, converts a new time with `localToUtc` and `checkRunAt` when
given and keeps the row's when not, and refuses a call that changes
nothing. It proposes:

    { kind: "reschedule_send", id, send_kind, record_id, job, label,
      message, to, run_at, summary, done }

`rescheduleWords` (pure, tested) says what moves: "Move the send of
JHA jha.pdf on S-10113 to Fri, Sep 11, 09:00 (was Fri, Sep 11,
07:00)?", or "Send JHA jha.pdf on S-10113 to a@x, b@y instead, at
Fri, Sep 11, 07:00?", or both.

The card's confirm button reads **Reschedule** (`CONFIRM_KINDS` gains
the kind). App's `runAskAction` does it as one confirm in two writes,
in this order: `Db.cancelScheduledSend(id)` first — zero rows back is
"it already went" and stops everything — then `Db.scheduleSend` with
the new row, through RLS as the person, gated again at fire time like
any other. Cancel first because twice is worse than once too few: an
insert that then fails leaves nothing queued and the card says so in
words that name the fix ("The old send was cancelled but the new one
was not scheduled: … Schedule it again."), where the other order
could leave two rows and two emails.

Job detail's strip keeps Cancel and Dismiss only; moving a send is
Ask's.

## Not built

- cc on a scheduled send.
- Recurring schedules.
- A notification to anyone other than the person who scheduled it.

## Testing

- `scheduledSends.test.mjs`: `resultPushWords` (sent, failed, the url,
  the tag), `rescheduleWords` (time only, addresses only, both).
- `askThread.test.mjs`: the fifth confirm kind and its label.
- `askTools.test.mjs`: the tool behind the job tab, its trace line.
- Typecheck over 21 functions; the constant-time guard still reads
  scheduled-sends and chat-push back.
- Live: schedule a send a few minutes out from the phone, background
  the app, receive the notification, tap it, land on the job; move one
  through Ask and see the strip show the new time.
