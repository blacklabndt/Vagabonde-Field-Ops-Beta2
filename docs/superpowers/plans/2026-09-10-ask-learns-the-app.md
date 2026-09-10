# Ask learns the app Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ask keeps what the crew tells it about how the app works — one shared memory, written as the speaker, graded by the speaker's role, visible and deletable — and uses it in later answers.

**Architecture:** `ask_learned` table (RLS: staff read, own insert, own-or-Admin delete). `_shared/askLearn.ts` (pure) builds the extractor prompt, parses its JSON, words the prompt block. The `ask` function reads the notes as the caller into the prompt, runs the extractor after the answer, writes as the caller, and returns `learned`. Card, tools and an Admin panel show and forget.

**Tech Stack:** as the earlier slices; Haiku 4.5 for the extractor.

**Spec:** `docs/superpowers/specs/2026-09-10-ask-learns-the-app-design.md`

## Global Constraints

- The `ask` function writes only `ask_learned`, as the caller, in the caller's name.
- Notes inform, never instruct: wrapped as data in the prompt.
- Migration applied live first, filed with the applier's version, probes beside it.
- `askLearn.ts` imports nothing; the guard test says so.
- Every commit passes `npm --prefix vite-app test`.

---

### Task 1: The table

**Files:** apply live; create `supabase/migrations/<version>_ask_learns_the_app.sql`, `supabase/handover/probes-<version>-ask-learns-the-app.sql`.

- [ ] `public.ask_learned(id, note check length 3..300, said_by fk profiles cascade, created_at)`; RLS select `is_staff()`, insert `said_by = auth.uid() and is_staff()`, delete `said_by = auth.uid() or user_role() = 'Admin'`; grants select/insert/delete to authenticated, all to service_role; index on created_at.
- [ ] Probes run live under role simulation, each ending on its answer.

### Task 2: The pure module

**Files:** create `supabase/functions/_shared/askLearn.ts`, `vite-app/src/askLearn.test.mjs`; modify `backupShared.test.mjs`.

- [ ] `LEARN_MODEL`, `MAX_LEARNED = 200`, `NOTE_CHARS = 300`, `MAX_ADD = 3`.
- [ ] `learnPrompt(turns, existing)` → `{ system, user }`; `parseLearned(text, existingIds)` → `{ add: string[], replace: { id, note }[] }`; `learnedLines(rows)` → the prompt block.
- [ ] Tests; guard list gains `askLearn.ts`.

### Task 3: The function

**Files:** modify `supabase/functions/ask/index.ts`, `_shared/askLoop.ts` (prompt takes `learned`), `_shared/askTools.ts`.

- [ ] Read `ask_learned` as the caller (note, said_by, created_at, profiles(name, role)); `learnedLines` into `systemPrompt`'s extra.
- [ ] After `askLoop`: `learn()` — one fetch to the API with `learnPrompt`, parse, count cap, delete replaced (as caller), insert adds (as caller) returning ids; `learned: [{ id, note }]` on the response; every failure swallowed.
- [ ] Tools `list_learned` (board), `forget_learned` (board, proposes `{ kind: "forget_learned", id, summary, done }`); trace lines; prompt line.

### Task 4: The app

**Files:** modify `vite-app/src/db.js`, `askThread.js` + test, `components/askPanel.jsx`, `App.jsx`, `components/adminSetup.jsx`, `askTools.test.mjs`.

- [ ] `Db.listLearned()`, `Db.forgetLearned(id)` (conditional delete; zero rows → "already forgotten, or not yours to forget").
- [ ] `pushTurn(role, text, trace, action, learned)`; `dropLearned(index, id)`; `CONFIRM_KINDS` gains `forget_learned` ("Forget it").
- [ ] Card: "Learned: …" lines with ×; App `runAskAction` handles `forget_learned`.
- [ ] Admin screen panel "What Ask has learned" with Delete.
- [ ] Deploy `ask`, Worker; docs; memory.
