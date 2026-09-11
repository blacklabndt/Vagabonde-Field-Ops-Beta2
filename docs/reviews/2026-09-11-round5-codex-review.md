# Round 5 — scheduled sends and reminders

Reviewed `cdadf5e`. Kyle requested an audit of a different part of the code. This pass follows scheduled-send/reminder creation, time conversion, rescheduling, cancellation, tick claiming, delivery routing, result persistence, notification, and stale-send handling. It does not certify every function in the repository.

## F1 — P2: failed final-status writes are ignored after delivery

**Location:** `supabase/functions/scheduled-sends/index.ts:98–110`.

The tick awaits the update to `sent` but never checks the returned Supabase `error`. It then increments `fired` and notifies the scheduler of success. The failure path likewise ignores an error writing `failed`.

**Reproduced:** extracting and executing the actual HTTP handler with a successful delivery and a failed final update returns `{ ok: true, fired: 1, failed: 0, stuck: 0 }`, sends a success notification, logs no error, and leaves the row `sending`. A rejected delivery combined with a failed failure-status update also returns `ok: true` with the row still `sending`.

The next stale sweep eventually changes that delivered row to `failed` with an ambiguous check-before-resending message. In the interim it is absent from the job strip and Ask's list, both of which request only queued/failed rows. The send itself must not be blindly retried, because it already happened.

**Correction:** inspect terminal-update errors and distinguish a delivery failure from a failure recording a completed delivery. Report/log the persistence failure without asserting that the email was not sent; retry only the status write if appropriate. Add handler tests for both resolved error results and transport exceptions, ensuring no second delivery occurs.

## F2 — P2: invalid local dates and nonexistent DST times silently move the timer

**Location:** `supabase/functions/_shared/scheduledSends.ts:53–63` (`localToUtc`). Used by schedule_send, reschedule_send, set_reminder, and the day-check boundary.

The parser checks only month 1–12 and day 1–31 before `Date.UTC`, which normalizes impossible dates. Its two timezone-adjustment passes do not check that the result converts back to the requested wall-clock date and time.

**Reproduced with the real helper:**

- `2026-11-31 07:00` equals `2026-12-01 07:00`; the normalized result also passes the ninety-day guard when requested on September 11.
- Edmonton `2026-03-08 02:30`, a nonexistent spring-forward time, equals `2026-03-08 01:30`.

The confirmation card shows the normalized result, but Ask does not receive a validation error or ask the person to choose a real time. A malformed tool argument can therefore schedule a different date/hour.

**Correction:** validate the calendar components and round-trip the final instant through the target timezone. Reject nonexistent wall-clock times. State and test a policy for the duplicated fall-back hour as well; this report does not classify choosing either occurrence as a bug without an agreed policy.

## F3 — P2: scheduling-time validation disagrees with insertion policy

**Locations:** `_shared/scheduledSends.ts:39,74–77`, `ask/index.ts:528–529`, `App.jsx:1553–1565`, and `20260911010317_a_reminder_is_a_timer_with_no_mail.sql`.

The application permits a time up to five minutes in the past, but the current insertion policy requires `run_at > now() - interval '1 minute'`. A time two minutes ago passes `checkRunAt` and can produce a confirmation card whose insert is guaranteed to be refused at the same clock time.

There is a related deterministic reschedule path: changing only recipients retains the old `run_at` and skips `checkRunAt` entirely. For a failed send from yesterday, Ask prepares the action, App cancels the old row, and insertion of the replacement is refused for its past timestamp. App truthfully reports the partial failure, but the workflow should reject that proposal before cancelling anything and ask for a new time.

**Evidence:** the reproduction executes the real time guard for two minutes ago and checks the exact latest SQL predicate; the recipient-only path and cancellation order were traced in source. No live policy execution or production cancellation was performed.

**Correction:** align the application and SQL time windows, validate the effective time on every reschedule, and revalidate before cancellation when the confirmation card has aged. The database must remain the final authority. Preserve the existing race protection that refuses cancellation once the tick has claimed a row.

## Function and workflow coverage

| Area | Evidence / outcome |
| --- | --- |
| `localToUtc`, `checkRunAt` | Ordinary summer/winter times pass; F2/F3 reproduce boundary defects. |
| `isKind`, `fireGate`, `isStuck` | Existing tests cover kinds, roles, tab loss, locked accounts, approved tickets, missing PDF keys, and stale threshold. |
| Labels, recipient splitting, schedule/reschedule/cancel/reminder/result wording | Existing helper tests pass, including exemption of reminders from recipient wording and job/no-job notification links. |
| HTTP tick authorization and conditional claim | Actual-handler tests show unauthorized requests and lost claims do not deliver. |
| `fire` JHA/report/ticket/reminder branches | Actual function extracted; all four route once to their intended transport. All four reject locked schedulers. Deleted send records are refused. |
| Reminder delivery | No devices and zero accepted pushes raise explicit failures. |
| Ticket resend | Approved ticket refused; awaiting-approval resend preserves scheduler identity and records chase after delivery. |
| Final state | Normal success/failure controls pass; database update error cases reproduce F1. |
| `devicesOf`, `tellScheduler`, `logError` | Source reviewed: active-profile filter; notification/logging best effort. Real push service, subscription pruning, and database failures not exercised end-to-end. |
| Db scheduling/list/cancel and App confirmation | Source traced through RLS insertion, no offline queue, conditional cancellation, cancel-before-replace ordering and explicit partial-failure message. |
| SQL permissions | Latest insert/cancel/select policy and column grants reviewed in source; live role probes not rerun. |

## Verification

Command:

```text
node --test docs/reviews/round5-scheduled-repro.test.mjs vite-app/src/scheduledSends.test.mjs vite-app/src/scheduledSends.client.test.mjs
```

**38 tests passed, 0 failed.** Five tests deliberately assert the current defective behavior; their pass confirms reproduction, not correctness. The other tests are positive/negative controls. The harness executes the actual handler and delivery router with injected database/transport dependencies; it does not send mail or push notifications. Output: `round5-scheduled-tests.txt`.

No application code, SQL, production state, or permission settings changed. Only audit artifacts added. No build or typecheck rerun for these review-only artifacts. This audit does not depend on resolving the earlier discussion of Kyle's local round-4 typecheck.

Recommended fix order: F1 (truthful send state), F2 (clock validation), F3 (proposal/persistence contract), each with regression tests at the affected boundary. No broad rewrite is needed.
