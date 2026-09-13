# Lane 1 — Ask / Claudia (live review, 12 Sept 2026)

Finished in-session after the lane-1 subagent died before filing. Two
findings, both reproduced: one pure (`lane1-thread.mjs`) and one in the
browser (`lane1-card.mjs`, `lane1-context.mjs`).

**No Anthropic spend.** The harness intercepts
`POST /functions/v1/ask` (`fakeAsk` in `lane1-lib.mjs`) and answers every
call synthetically, so every card shape is driven without a paid call.
`blockWrites` refuses every PostgREST/function write with a 403, so a
pressed confirm proves what the app *tried* to do and changes no live row.
Nothing on Codex's unsafe-script list was run.

## Finding 1 — "Not now" throws away the file Ask made and the learned-note undo (HIGH)

`dropAction(index)` in `vite-app/src/askThread.js:46` rebuilds the turn from
an allowlist:

```js
const kept = { role: t.role, text: t.text };
if (t.trace) kept.trace = t.trace;
if (t.followUp) kept.followUp = t.followUp;
return kept;
```

`t.files`, `t.learned` and `t.learnTrouble` are not on that list, so they are
dropped with the proposal. `askPanel.jsx` renders all three off the same turn
(files 282, learned 315, learnTrouble 337) and the proposal at 347 — so the
Download / Save to Files block and the "Learned: … ×" line disappear from an
answer the moment the person declines its proposal.

Reached two ways, not one:
- `askPanel.jsx:357` — the **Not now** button.
- `askPanel.jsx:244` — `confirmSend`, so a **successful** Send/Schedule/Cancel
  wipes them too.

Why it matters:
- **The file is gone for good.** Ask's files live with their turn in memory
  and nowhere else (CLAUDE.md, "Files stay with their turn in the thread").
  Losing the Download button means asking again — another paid call — for a
  file that was already built and checked.
- **The learned × is the documented oversight.** CLAUDE.md calls the card's ×
  "the oversight the no-confirm learning rests on". Declining an unrelated
  proposal silently removes the one undo attached to that answer; a Helper
  (no `board` tab, so no `forget_learned`, no Admin panel) has none left.
- `learnTrouble` goes the same way — the line that exists precisely so a
  refused note is not silent.

Evidence (`node vite-app/e2e/hunt/lane1-thread.mjs`):

```
PASS :: the answer carries action, learned and files
FAIL :: "Not now" keeps the learned notes :: learned is gone from the turn after dropAction
FAIL :: "Not now" keeps the files :: files are gone from the turn after dropAction
FAIL :: "Not now" keeps a learnTrouble line
PASS :: "Not now" keeps the trace and the follow-up (control)
```

And in the real card (`node vite-app/e2e/hunt/lane1-card.mjs`, tech account,
synthetic answer carrying a draft + a CSV + a learned note):

```
PASS :: an answer shows its learned note, its file and its proposal :: {"learned":1,"files":1,"proposal":1}
PASS :: "Not now" drops the proposal
FAIL :: "Not now" KEEPS the learned note and its × :: learned notes now 0
FAIL :: "Not now" KEEPS the file (Download / Save to Files) :: file blocks now 0
PASS :: "Not now" keeps the answer and the trace
```

**Fix (one line, no migration):** delete the action instead of rebuilding the
turn — `const kept = { ...t }; delete kept.action;`. The control checks
(trace, followUp, `threadForSend`) already pass and stay passing.

## Finding 2 — "Where the person is" names a job the person is not looking at (MEDIUM)

`App.jsx:1915` sends `jobNumber: activeJob ? activeJob.id : null` with **no
screen test**. `activeJob` is the job App is holding, which survives every
screen change. The system prompt then states it as fact
(`whereLines` in `_shared/askKnowledge.ts`):

> Where the person is: the Team chat screen, job S-10943. 'This job', 'this
> ticket' and 'this screen' mean these; **use them without asking.**

Evidence (`node vite-app/e2e/hunt/lane1-context.mjs`, request bodies read
back out of the interceptor):

```
FAIL :: Home sends screen=board and no job :: {"screen":"board","jobNumber":"S-12785","ticketId":null,…}
PASS :: Home sends the screen's own help :: 2 paragraphs
PASS :: Job detail sends this job :: {"screen":"job","jobNumber":"S-10943",…}
FAIL :: a screen that is not the job's sends no job number ::
        screen=chat jobNumber=S-10943 (that job is NOT anywhere on screen)
```

So on Home — a screen listing every job — Ask was told the person is on
S-12785, held from earlier in the session; and on Team chat it was told
S-10943, which appears nowhere on that screen. "Raise a ticket for this job"
typed on chat binds silently to the stale job, and the tools that take a job
(`draft_ticket`, `draft_jha`, `schedule_send`, `day_check`) resolve against
it. The draft paths open the app's own form, where the job is visible before
Save — but the person is never told which job Ask chose, and the prompt
instructs the model not to ask.

**Fix:** send `jobNumber`/`ticketId` only from the job's own screens — the
`CONTEXT_TABS` set (`["job","jha","upload","ticket"]`, data.js:99), the same
four addresses `historyStep` already treats as one job. Elsewhere send null
and let `whereLines`' existing "ask which job they mean" wording do its job.

## What holds

- The thread's controls: `dropAction` keeps `trace` and `followUp`, and
  `threadForSend` is unchanged by a declined proposal.
- The card renders learned, files and the proposal off one turn correctly
  before the decline (screenshot: `vite-app/e2e/hunt/lane1-notnow.png`).
- Job detail's own context is right: `screen=job`, the open job's number, the
  screen's own `help.js` paragraphs (2 on board, job's on Job detail).
- `cleanContext`'s shape checks are intact — an unknown screen is dropped and
  help is capped.

## Recorded unverified, NOT passed

Per Codex's standing rule (`2026-09-12-codex-cybersecurity-retry.md`), no
script that mutates live rows was run. These Ask claims are therefore
**unverified** in this lane:

- The send/schedule/cancel gates in `_shared/askSends.ts` and `scheduledSends.ts`
  as applied live — `blockWrites` proves what the app *sent*, not what the
  database would have answered.
- `ask_learned`'s cap, the replace path and `forget_learned` under RLS.
- `ask_leases` and the token ceiling against the real provider (any such
  check spends Kyle's key).

Retesting any of these needs fixtures with verified seed ownership, recorded
redacted responses, and cleanup by exact ID.
