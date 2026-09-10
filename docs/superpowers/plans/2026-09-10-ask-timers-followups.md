# Ask timers follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The person who scheduled a send is told on their own devices when it went or failed, and can move a scheduled send to another time or other addresses through Ask with one confirm.

**Architecture:** The tick pushes a result payload to the scheduler's own subscriptions through a shared `webPush.ts` (chat-push's loop, moved); the service worker routes it by `kind`; App toasts it when on screen. A `reschedule_send` tool proposes; App cancels the old row and inserts the new one.

**Tech Stack:** as the timers slice; `npm:web-push@3.6.7` in two functions now.

**Spec:** `docs/superpowers/specs/2026-09-10-ask-timers-followups-design.md`

## Global Constraints

- The `ask` function writes nothing; the push is best effort and never fails a row.
- No migration: the tables already carry everything needed.
- `scheduledSends.ts` still imports only `./askSends.ts`.
- Every commit passes `npm --prefix vite-app test`.

---

### Task 1: The words, tested

**Files:** modify `supabase/functions/_shared/scheduledSends.ts`, `vite-app/src/scheduledSends.test.mjs`.

- [ ] `resultPushWords(row: { id, kind, label, to_list, run_at }, jobNumber: string, error: string | null)` → `{ kind: "scheduled_send", id, ok, title, body, job_number, url, tag }`.
- [ ] `rescheduleWords(kind, label, job, to, oldRunAtMs, newRunAtMs, toChanged)` → `{ summary, done }`.
- [ ] Tests for both; `npm --prefix vite-app test` green.

### Task 2: The push

**Files:** create `supabase/functions/_shared/webPush.ts`; modify `chat-push/index.ts`, `scheduled-sends/index.ts`, `vite-app/public/push-sw.js`, `vite-app/src/App.jsx`.

- [ ] `sendPush(admin, subs: PushSub[], payload: unknown): Promise<{ sent, pruned }>` — VAPID from env, the loop, the prune. chat-push calls it.
- [ ] scheduled-sends: the due select embeds `jobs(job_number)`; after sent/failed, `notifyScheduler(admin, row, error)` in its own try/catch.
- [ ] push-sw.js: `data.kind === "scheduled_send"` branch.
- [ ] App.jsx: the `scheduled-send` message listener; toast with Open; `filedNonce` bump.
- [ ] Typecheck 21; deploy `scheduled-sends`, `chat-push`; build and deploy the Worker.

### Task 3: Reschedule

**Files:** modify `_shared/askTools.ts`, `_shared/askLoop.ts`, `ask/index.ts`, `vite-app/src/askThread.js`, `askThread.test.mjs`, `askTools.test.mjs`, `App.jsx`.

- [ ] Tool `reschedule_send` (tab job), trace line, prompt line.
- [ ] The send helpers take `recipients: unknown` where `null` means keep (no resolution).
- [ ] Runner: read the row as the caller, re-gate through the kind's helper, new time / new addresses / refuse nothing-changed, propose.
- [ ] `CONFIRM_KINDS` + label; App cancel-then-insert with the named failure.
- [ ] Deploy `ask`; Worker.

### Task 4: Docs

- [ ] CLAUDE.md, README.md, HANDOVER.md, memory.
