# Ask, five more: open the record, check my ticket, rate lookup, needs attention, cancel an approval

Date: 11 September 2026. Follows the six-helpers slice
(`2026-09-10-ask-six-helpers-design.md`). Kyle picked five of the
suggestions; this spec is all five as one slice. The rules are the
earlier slices': every read runs as the person, a write goes through the
app's own door after a confirm on the card, the `ask` function writes
nothing of its own (bar `ask_learned`). No migration.

## 1. Open the record

Tool `open_record(kind, id)` — `kind` job | ticket | jha | report — tab
job (the screens it lands on are Job detail's). The runner reads the
record as the caller to confirm it exists and to learn its job, and
proposes `{ kind: "open", record, id, status?, job: { id, job_number },
summary }`. It is not a confirm kind: the card's button reads "Open"
(`formLabel` in askThread.js: "Open" for this kind, "Open the form"
for a draft), the card closes and App navigates with what it already
has — a job through `openJobByNumber`; a ticket through `openTicket`
(the tracker's own path: the job first, then the editor for a Draft,
which `loadDraft` refuses for another technician's ticket unless Admin,
else Job detail); a JHA or a report through `openJobByNumber`, where
its row is. No new reads in App.

## 2. Check my ticket

Tool `check_ticket(ticket_id)` — tab ticket, price roles (the lines are
theirs to read). The runner reads as the caller: the ticket (status,
technician, work date, client contact, the job's number), its lines,
its crew with names, and whether a JHA exists on the job for that work
date. A ticket that is not a Draft is refused in words ("is Awaiting
approval — cancel the approval to change it"); another technician's is
refused unless Admin, the editor's own rule. `_shared/ticketCheck.ts`
(pure, in the guard list) answers `{ ticket_id, findings, ok }`,
findings being plain phrases: no client rep on the ticket; no charges
on the ticket; a line at quantity zero; a quantity above the editor's
own sane ceiling for its unit (`SANE_QUANTITY_PER_UNIT`,
`SANE_QUANTITY_DEFAULT`, twinned from data.js with a drift test); a
line priced at $0; a total of $0 (the client would be sent a $0.00
approval); no crew on the ticket; no hours entered for the crew; one
person above `SANE_CREW_HOURS` on the day; no JHA filed on the job for
that date; a work date in the future. Nothing is changed. A line the
client's card no longer offers is NOT checked here: the catalog's label
expansion lives in db.js and is the editor's, not twinned.

## 3. Rate lookup

Tool `rate_card(client, search?)` — tab rates, price roles. The runner
resolves the client (exact name, the one hit, else ask), picks the
schedule the way `_fetchPublishedRates` does — the newest schedule; the
house card when it follows the default; else the newest published one —
reads its `rate_lines` as the caller and answers `{ client, card:
"the house card" | "its own card", lines: [{ kind, label, unit, rate }]
}`, narrowed by `search` on the label, welds first then methods then
expenses. No card is "no published rate schedule — Rate admin". Read
only; nothing is cached.

## 4. Needs attention

Tool `needs_attention` — tab board, role Admin (Home's strip is an
Admin's). The runner reads `backup_state()` and the newest
function_errors rows (the strip's own scan depth) as the caller and
runs Home's four questions through `_shared/attention.ts` — the core
of `attention.js` (`ERRORS_WINDOW_MS`, `OVERDUE_GRACE_MS`,
`KIND_WORDS`, `agoPhrase`, `byFunction`, `attentionItems`) between
`shared core` markers, the function's copy annotated, held together by
`askTwins.test.mjs`; the dismissal helpers stay outside the core, the
browser's. The answer is the items' `text` and `where`, or that nothing
needs attention.

## 5. Cancel an approval

Tool `cancel_approval(ticket_id)` — tab ticket. The runner reads the
ticket as the caller, applies the RPC's own rule before proposing —
Awaiting approval, and the caller its technician or Admin or
Coordinator — and proposes `{ kind: "cancel_approval", ticket: { id },
job, summary, done }`; the card's confirm reads "Cancel approval". App
calls `Db.withdrawTicketApproval` (the definer RPC the three existing
buttons use; its own-or-office rule is the gate, zero rows is "it was
not awaiting approval"), drops the job's `tickets.<id>` cache entry so
Job detail reads the draft, bumps `filedNonce`, and answers the done
sentence.

## Testing

- `ticketCheck.test.mjs`: every finding, a clean ticket, the ceilings
  equal to data.js's.
- `askTwins.test.mjs` gains the attention pair.
- `askTools.test.mjs`: the five tools, their tabs and roles, trace
  lines; `askThread.test.mjs`: `cancel_approval` confirms with "Cancel
  approval", `open` is not a confirm and `formLabel` says "Open".
