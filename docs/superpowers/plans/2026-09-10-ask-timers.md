# Ask timers (scheduled sends) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A JHA, a report or a ticket approval can be scheduled for a time; a database cron fires it through the same code the live buttons use, gated again as the person who scheduled it; the person sees and cancels it on Job detail or through Ask.

**Architecture:** The three send bodies move into shared modules the live functions and the new `scheduled-sends` function both call. A `scheduled_sends` table (RLS: own rows, insert only for a record the caller can read, cancel only) holds the queue; `_shared/scheduledSends.ts` (pure) holds the fire-time gate, the local-time conversion and the words. Ask gains `list_reports`, `schedule_send`, `list_scheduled`, `cancel_scheduled`; the card's confirm shape covers them; Job detail shows a strip.

**Tech Stack:** as the earlier slices; pg_cron + pg_net for the tick.

**Spec:** `docs/superpowers/specs/2026-09-10-ask-timers-design.md`

## Global Constraints

- The `ask` function writes nothing; `scheduled-sends` writes only `scheduled_sends` rows and what the mail modules already write for a live send.
- Two-half authority: insert through RLS as the person; `fireGate` at fire time with the person's current profile.
- Migration applied live first (the version from the applier), probes filed beside it under `supabase/handover/`.
- `scheduledSends.ts` imports only `./askSends.ts`; the guard test says so.
- Every commit passes `npm --prefix vite-app test`.

---

### Task 1: The three mail modules — one send body each, the live functions calling them

**Files:** create `supabase/functions/_shared/mailJha.ts`, `mailReport.ts`, `mailApproval.ts`; modify `supabase/functions/send-jha/index.ts`, `send-report/index.ts`, `send-ticket-approval/index.ts`.

- [ ] `mailJha(admin: SupabaseClient, jha: JhaMailRow, to: string, cc: string | undefined, message: string): Promise<{ attached: boolean }>` — the body from "2. A link that outlives…" through the sent stamp, verbatim; `JhaMailRow` exported from the module. `send-jha` keeps its door, its `Promise.all` read as the caller and its gate, then `return json(await mailJha(admin, jha, toList, ccList, message))`.
- [ ] `mailReport(admin, report: ReportMailRow, to, cc, message)` the same way.
- [ ] `mailApproval(admin, ticketId: string, to: string, cc: string | undefined, sentBy: string, settings: Settings)`: the body from the token mint through the tickets UPDATE (`approval_sent_by: sentBy`). `send-ticket-approval` keeps its door, reads and gate; `settings` is the row it already read.
- [ ] `npm run typecheck` → 20 functions; `npm test` green. Deploy the three functions; a live send from Job detail still works (Kyle). Commit: `The three send bodies are shared modules, ready to be fired without a session`.

### Task 2: scheduledSends.ts — gate, clock, words (pure, tested)

**Files:** create `supabase/functions/_shared/scheduledSends.ts`; create `vite-app/src/scheduledSends.test.mjs`; modify `vite-app/src/backupShared.test.mjs`.

```ts
import { jhaSendGate, ticketSendGate, JHA_SEND_ROLES } from "./askSends.ts";
export const KINDS = ["jha", "report", "ticket_approval"] as const;
export type Kind = typeof KINDS[number];
export const STUCK_MS = 15 * 60_000;
export const MAX_AHEAD_MS = 90 * 86_400_000;
export const MAX_PAST_MS = 5 * 60_000;
export const ZONE = "America/Edmonton";
export const REPORT_SEND_ROLES = ["Admin", "Coordinator", "Technician"];
export interface Person { id: string; role: string; tab_access: string[] | null; deactivated_at: string | null }
export function isKind(v: unknown): v is Kind
export function localToUtc(local: string, zone = ZONE): number   // "YYYY-MM-DD HH:MM" → ms; throws on nonsense
export function checkRunAt(ms: number, nowMs: number): void       // past / too far
export function whenWords(ms: number, zone = ZONE): string        // "Thu 11 Sept, 07:00"
export function fireGate(kind: Kind, person: Person, record: Record<string, unknown>): void
export function isStuck(row: { status: string; fired_at: string | null }, nowMs: number): boolean
export function scheduleWords(kind: Kind, label: string, job: { job_number: string }, to: string[], runAtMs: number): { summary: string; done: string }
export function cancelWords(label: string, runAtMs: number): { summary: string; done: string }
export function labelFor(kind: Kind, record: { pdf_key?: string | null; template?: string | null; filename?: string | null; work_date?: string | null; id?: string }): string
```

- [ ] Tests first, then the module; guard list gains `"scheduledSends.ts"` with allowed `["./askSends.ts"]`. Commit.

### Task 3: The table, its policies, the cron — applied live, probed, filed

**Files:** create `supabase/migrations/<version>_a_send_can_wait_for_its_time.sql`; create `supabase/handover/probes-<version>-a-send-can-wait-for-its-time.sql`; modify `supabase/config.toml` (`[functions.scheduled-sends] verify_jwt = false`); CLAUDE.md's "six migrations bake" becomes seven.

- [ ] Apply the SQL from the spec live (MCP `apply_migration`), read the version back (`list_migrations`), file both files.
- [ ] Probes (role simulation, each block rolled back): a Technician inserts a row for a JHA they can read (1); a Helper cannot insert for a report (`reports` read includes job, so a Helper CAN read it — the probe shows the insert passes RLS and the fire gate is what refuses; note it); an insert with `set_by` = another id fails; an insert with `status = 'sent'` fails; the owner cancels (1 row); another Technician cannot (0 rows); a Coordinator can (1); a cancelled row cannot be re-queued (0).
- [ ] Commit.

### Task 4: The `scheduled-sends` function

**Files:** create `supabase/functions/scheduled-sends/index.ts`.

- [ ] Door: `secretsMatch(req.headers.get("x-internal-secret"), expected)` from `admin.rpc("internal_secret")`.
- [ ] Stuck sweep: `update scheduled_sends set status='failed', error=… where status='sending' and fired_at < now-15min`.
- [ ] Due rows: select `status='queued' and run_at <= now` order run_at limit 20; per row claim with `.update({status:'sending', fired_at}).eq('id').eq('status','queued').select('id')`; skip when empty.
- [ ] Fire: profile → record (by kind, with the job embed the mail module needs) → `fireGate` → `recipients(row.to_list, "to")` → mail module (approval: `appSettings()` once per tick, `sentBy = row.set_by`) → `status='sent'`. Catch: `status='failed', error`, `logError("scheduled-sends", msg, { id, kind, record_id, job_id })`.
- [ ] Response `{ fired, failed, stuck }`. Typecheck; deploy; a manual POST with the secret (from SQL: `select net.http_post(...)`) fires nothing and answers 200. Commit.

### Task 5: Ask — four tools, the runners, the prompt

**Files:** modify `askTools.ts`, `askLoop.ts`, `ask/index.ts`, tests.

- [ ] Tools as the spec lists; trace lines (`listed the reports on S-…`, `proposed a scheduled send`, `listed scheduled sends`, `proposed cancelling a scheduled send`).
- [ ] Runners: `list_reports`; `schedule_send` (kind check, record read as caller by kind, gate, recipients, `localToUtc` + `checkRunAt`, `labelFor`, `scheduleWords`, action); `list_scheduled` (RLS read, `job_number` optional → job id filter); `cancel_scheduled` (row read as caller, status queued/failed, `cancelWords`, action).
- [ ] Prompt line: "Timers: a time the person gives is Grande Prairie's clock, as YYYY-MM-DD HH:MM; without an hour, ask. schedule_send schedules nothing until the card's Schedule is pressed; list_scheduled shows what is queued or failed; cancel_scheduled proposes a cancel."
- [ ] Tests, typecheck, deploy `ask`, probe 401. Commit.

### Task 6: The card, App, db.js, Job detail

**Files:** modify `askThread.js` (+ test), `askPanel.jsx`, `App.jsx`, `db.js`, `jobDetail.jsx`; create `vite-app/src/scheduledSends.js` (+ test); README/CLAUDE.md.

- [ ] `askThread.js`: `CONFIRM_KINDS = ["send_jha", "send_ticket_approval", "schedule_send", "cancel_scheduled"]`, `isConfirmAction`, `confirmLabel` (Send / Schedule / Cancel it). The panel uses both (rename from `isSendAction`).
- [ ] `db.js`: `scheduleSend({ kind, recordId, jobId, label, to, message, runAt })` insert `.select("id").single()`; `cancelScheduledSend(id)` update status cancelled where id and status in (queued, failed), `.select("id")`, zero rows → plainError "It already went, or was cancelled."; `listScheduledSendsForJob(jobDbId)` select where job_id and status in (queued, failed) order run_at.
- [ ] `App.jsx` `runAskAction`: `schedule_send` → `Db.scheduleSend(...)`, return done; `cancel_scheduled` → `Db.cancelScheduledSend(action.id)`, return done.
- [ ] `scheduledSends.js`: `describeScheduled(row, nowMs)` → `{ line, when, failed, error }` (Grande Prairie clock; "overdue" when queued and past).
- [ ] Job detail: `scheduled` state read in `refresh` (fourth read, failure named like the others), the strip above the assessments when any, Cancel/Dismiss through `Db.cancelScheduledSend` then re-read.
- [ ] `npm test` green; build + Worker deploy; docs; commit and push.
