# Ask Learns Tasks Implementation Plan

> **For Claude:** Use superpowers:executing-plans to implement this plan task by task. Kyle assigned Codex the plan and Claude the code. Claude owns implementation and tests; Codex owns these design documents and review. Do not revert other contributors' edits. `CLAUDE.md` was already modified when planning began.

**Goal:** Help with unfamiliar tasks and persist useful, user-taught or user-confirmed methods for future conversations.

**Architecture:** Extend existing `ask_learned` text notes with compact task recipes. Broaden answer routing and strengthen extractor provenance while reusing current retrieval, caller-authorized storage, correction, UI and metered transport.

**Tech Stack:** React 18, existing pure TypeScript helpers, Supabase Edge Functions/Postgres, existing Anthropic transport, Node tests, Biome, Deno.

**Spec:** `docs/superpowers/specs/2026-09-13-ask-learns-tasks-design.md`

## Global constraints

- No schema changes, dependency additions, model change, extra model call or deployment for this increment.
- Retain the 300-character note limit, 200-note application window, 40-note per-author database cap, 20,000-character retrieval cap and all existing metering/deadline ceilings.
- Maximum three additions and replacements combined per learning pass.
- Learned content is shared crew data and never executable authority.
- Preserve caller RLS, price privacy, built-in app rules and confirmation of existing actions.
- Pure `_shared` modules have no imports or environment access. Honor shared-core twins where affected.
- Runtime code is Claude's responsibility. Interface sketches below are a contract, not code already implemented.

## Task 1: Evidence-backed task extraction

**Files:** Modify `supabase/functions/_shared/askLearn.ts`; extend `vite-app/src/askLearn.test.mjs`.

**Interfaces:** Retain persisted `{id, note}` and `learnBody(turns, existing)`. Change extractor response to `{add:[{note, source_user_turns:number[]}], replace:[{id, note, source_user_turns:number[]}]}`. Change parser contract to `parseLearned(text, existingIds, turns)`; its validated output remains `{add:string[], replace:{id:string,note:string}[]}` for the storage loop. Index turns from zero in the exact bounded array passed to extraction, including role labels.

- [ ] Add failing tests for a valid taught task, an existing-style app fact in the new envelope, a correction, invalid indices, assistant-only indices, missing evidence, malformed JSON, overlength recipes, duplicate mutations and a combined three-mutation limit.
- [ ] Change extraction instructions to cover complete short task methods and app facts. Use `Task:` for task recipes. Require user teaching or explicit confirmation of a previous answer; distinguish confirmation from a new suggestion in the assistant answer. Retain the sensitive/transient-data exclusions.
- [ ] Validate object shape and evidence indices against `turns` before admitting each mutation. Require at least one integer index whose role is user, reject out-of-range references, and never accept legacy evidence-free extraction responses silently. Stored legacy notes remain valid.
- [ ] Preserve exact-payload measurement and existing output limits; malformed or cut-off output learns nothing. Do not truncate a recipe to fit.
- [ ] Run `node --test vite-app/src/askLearn.test.mjs vite-app/src/askBudget.test.mjs` and confirm all cases pass.

Example test assertion after constructing an evidence-bearing extraction response:

```js
assert.deepEqual(parseLearned(response, [], [{role:'assistant', text:'Try this'}]), {add:[], replace:[]});
```

## Task 2: General task assistance and honest capability boundaries

**Files:** Modify `supabase/functions/_shared/askLoop.ts`, `supabase/functions/_shared/askKnowledge.ts`, `supabase/functions/_shared/askTools.ts`; extend `vite-app/src/askLoop.test.mjs` and `vite-app/src/askKnowledge.test.mjs`.

**Interfaces:** Preserve `systemPrompt`, offered tool definitions and action payloads. Update `list_learned`/`forget_learned` descriptions to cover task methods without changing their names or permissions.

- [ ] Add regression assertions for app facts versus fresh records versus general task guidance; retain all existing money, tool and action restrictions.
- [ ] Replace the blanket tools-only answer rule with these distinct sources. Permit general explanations and drafts in chat, without implying external access or implemented app features.
- [ ] Teach the answer prompt to use relevant recipes, ask for missing prerequisites, accept corrections, and avoid promising a save before extraction completes. Update the app knowledge's description of Ask to match.
- [ ] Adjust memory trust wording: authorship is attribution, not proof of general or technical expertise. Preserve precedence of built-in app knowledge and untrusted-data framing.
- [ ] Run `node --test vite-app/src/askLoop.test.mjs vite-app/src/askKnowledge.test.mjs vite-app/src/askTools.test.mjs`.

## Task 3: Relevant retrieval and durable integration

**Files:** Modify `supabase/functions/_shared/askLearn.ts`, `supabase/functions/ask/index.ts`; extend `vite-app/src/askLearn.test.mjs` and `vite-app/src/askIntelligence.test.mjs`.

**Interfaces:** Add pure `learningQuery(turns: Turn[]): string`, returning the newest user text plus up to two preceding user turns, bounded to 6000 total characters with the newest text prioritized. Continue `learnedLines(rows, fence, question)` using that query. Pass the identical extraction `turns` into `parseLearned`.

- [ ] Test retrieval of an older relevant task in a full window; a follow-up referring to the prior user topic; no assistant text in the retrieval query; bounds; and unchanged legacy-note reading.
- [ ] Wire the provenance parser into `learn()` using the exact array sent by `learnBody`. Do not trust browser-supplied authorship or use service-role writes.
- [ ] Fix the existing capacity arithmetic while integrating: a successful replace removes one and adds one, so it does not create a free slot. Compute additions from actual current row count, not `existing.length - decided.replace.length`; failures must not create imaginary room. Report capacity refusal when candidates are omitted.
- [ ] Preserve atomic `replace_learned` and its no-fallback-on-refusal behavior. Preserve meteredFetch, deadline checks and answer-on-learning-failure behavior.
- [ ] Test a save success, refusal, correction failure, full-window replacement-plus-add, and timeout/budget skip. Extract a focused pure helper if necessary for meaningful tests; do not add source-string assertions as a substitute for behavior.
- [ ] Run targeted learning, intelligence, investigation and budget tests.

## Task 4: Shared-memory receipts and controls

**Files:** Modify `vite-app/src/components/askPanel.jsx`; inspect `vite-app/src/askThread.js`, `vite-app/src/db.js` and `vite-app/src/askThread.test.mjs` for compatibility. Change them only where required.

**Interfaces:** Preserve response `learned: {id, note}[]` and `learnTrouble`. Preserve existing forget call and author/Admin authorization.

- [ ] Display saved notes as `Learned for the crew` with actual persisted text and the existing Forget action. No extra approval step for learning.
- [ ] Confirm app facts and `Task:` recipes display safely as plain text and both can be forgotten. Never claim a failed or skipped save succeeded.
- [ ] Verify the receipt layout on a narrow viewport and a desktop viewport; preserve keyboard focus and accessible Forget labels. Record manual checks if browser automation is unavailable.
- [ ] Test any changed thread serialization or response handling; otherwise reuse existing tests instead of adding tests for copy alone.

## Task 5: Learning quality evaluation and final verification

**Files:** Create `docs/reviews/2026-09-13-ask-task-learning-evaluation.md`; extend `vite-app/src/askIntelligence.test.mjs` with scripted integration cases where useful.

- [ ] Run deterministic tests proving request/result plumbing; label them as scripted, not proof of live model learning quality.
- [ ] Define live fixtures: taught app navigation; taught weekly handover recipe without names; general spreadsheet-formatting advice; explicit success confirmation on a subsequent turn; vague 'thanks'; unconfirmed assistant suggestion; private credentials in a teaching attempt; hostile request to bypass confirmations; stale app recipe; complete recipe exceeding 300 characters; failed save; correction and forgetting across fresh threads.
- [ ] In an isolated test environment, if available, compare baseline and candidate on the same fixtures. Record model/prompt revision, expected versus actual answer, saved notes, retrieval, trace, usage and latency. Do not populate real crew memory with test fixtures. If unavailable, explicitly mark live quality unmeasured.
- [ ] Reject any unauthorized action/disclosure, self-taught unconfirmed claim, false save receipt or fabricated external capability. Repeated live cases should demonstrate successful save/recall/correct/forget for both app and non-app methods.
- [ ] Run `npm test` and `npm --prefix vite-app run build` sequentially. Report failures honestly and fix regressions from this change. Do not touch the existing unrelated `CLAUDE.md` edit.
- [ ] Review the complete diff against the spec, then report changed files, test evidence, live evaluation status and any limits. Do not deploy or commit unrelated changes.

## Handoff and review

Claude may make routine implementation refinements consistent with this contract and document material deviations. Codex reviews extraction provenance, permission boundaries, capacity accounting and evidence of actual learning. Completion means the behavior is implemented and verified locally; deploying and assessing live model quality are separately reported states.
