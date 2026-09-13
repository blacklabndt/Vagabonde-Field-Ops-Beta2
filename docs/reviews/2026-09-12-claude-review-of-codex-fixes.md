# Claude's review of Codex's fixes for the lane 1/2 findings

Verification run on the complete working tree, 12 Sept:
`npm --prefix vite-app test` — **922 pass, 0 fail** (render scan, lint,
Deno typecheck and the node suite); `npm run lint` — 216 files, clean;
`npm --prefix vite-app run build` — PWA built, 36 precache entries.

## The three application fixes: approved

**GST fingerprint** (`_shared/approvalToken.ts`). `d.ticket.gst_rate ??
d.job?.clients?.gst_rate ?? ""` is exactly the fix lane 2 called for: an
exempt zero survives `??`, and only a legacy null row falls through to the
client. `invoiceSnapshot.test.mjs` covers both directions.

*Transition note:* a rep who loaded the approval page before the deploy and
signs after it carries the old fingerprint and is refused once. Reloading
the link clears it. Not zero, but harmless.

**`dropAction`** (`askThread.js`). `{ ...t }` then `delete kept.action`
keeps every field the old whitelist dropped — files, learned, learnTrouble
— and cannot go stale when a new turn field is added. Regression test
covers four proposal kinds.

**Ask context** (`App.jsx`). `CONTEXT_TABS.includes(screen)` for the job and
`screen === "ticket"` for the ticket. Correct, and the ticket half also
closes the retained-ticket-from-another-job leak on Job detail, JHA and
Upload.

## The staged ticket-total SQL: sound, with two notes

Read against the live schema. The design holds:

- The view's `where (select public.is_staff())` is character-for-character
  the base `tickets select` policy's USING, and that is the **only**
  permissive SELECT policy on the table — so the owner-rights view grants
  no row the base table would have refused.
- The enforce file revokes only `total` in substance: the explicit
  `grant select (…)` restores every other column, which is what keeps
  `dose_totals` working. That function is SECURITY INVOKER and joins
  `public.tickets` on `t.id`/`t.work_date` — both in the granted list, and
  `count(*)` is satisfied by a privilege on any one column. Timesheets
  survives. Checked; it was the obvious way for this to break.
- No remaining caller-authority read of `tickets.total` exists outside the
  three rewritten RPCs. Every base-table read left in `db.js`, `ask`,
  `approve-ticket`, `scheduled-sends`, `mailApproval` and `backup-restore`
  either selects no `total` or runs as the service role. Verified by grep
  of all sixteen sites.
- Every column `TICKET_INVOICE_SELECT`, `JOB_TICKET_COLUMNS` and
  `ARCHIVE_TICKET_COLUMNS` name is present in the view.
- `shapeJobTicket`'s `t.total == null ? null : Number(t.total)` reaches only
  renders already behind `seesPrices`/`priced`/`showAmounts`, and
  `jobDetail`'s `ticketTotal` uses `Number(t.amount || 0)`. No `$NaN`.

**Note 1 — the reverse embed is the deploy risk.** `render-invoice` and
`getTicket` read `ticket_lines(...)` through `tickets_read`, and
`loadInvoice` also orders that embed by `line_order`. A forward embed
(`jobs`, `profiles`) infers from the plainly-selected FK column; a reverse
embed has to be matched back from `ticket_lines.ticket_id` to the view's
`id`. It should work, and it must be proved on the deployed API before
enforcement — an ordered embedded read through a view is the sharpest of
the checks in Codex's step 2, not a formality. If it fails, the invoice
viewer and reopening a draft both break.

**Note 2 — drop `approval_token` while the list is being written.** Both
the view and the enforce grant carry it. Nothing that runs on the caller's
authority reads it: the only two readers, `approve-ticket` and
`mailApproval`, hold the service role. It is a stored hash of a live
credential, and the explicit column list is the one moment when removing it
costs nothing. Status quo, so not a finding — but a free tightening.

**Note 3 — the PWA is the enforcement hazard.** Between the two phases an
installed build serves from its service worker until it updates. "Refresh
older browser builds" is not something the office can do for the crew.
Prefer a wide gap between phase 1 and phase 2, and confirm the new build is
actually live on a tablet before enforcing.

## Still open

The live disclosure is **not closed**. Phase 1 prepares; only the enforce
file shuts it. Neither SQL file is history until it is applied live and
filed under `supabase/migrations/` with the applier's version — Kyle's call.

Codex's `openTicket()` observation (the selected job changing before the
async load settles) is unreproduced and correctly left unfixed.

## The three notes, closed (12 Sept, Claude, on Kyle's instruction)

Nothing is applied live. Both SQL files remain drafts under
`supabase/handover/`; the disclosure is still open.

**Note 2 — the stored credential.** `approval_token` is gone from the view
and from the phase 2 grant list, and so are `approval_expires_at` and
`approved_ip`: no read on caller authority names any of the three anywhere
in the app, Ask or the functions. `approve-ticket` filters on the token
hash and `mailApproval` writes it, both with the service role, which this
never touches. Writing the grant list from scratch is the one moment those
columns can be left out without anybody noticing a loss.

Removing them from the view alone would have left `approved_ip` readable
on the base table — the grant list named it on a different line than the
one the edit matched. The harness caught it: the new assertions ask both
doors for each of the three columns, because dropping one is the other's
way in. `probes-ticket-money-select.mjs` is now 99 checks and passes.

**Note 1 — the reverse embed.** One of the three sites is gone rather than
verified. `TICKET_INVOICE_SELECT` named `tickets.total`, which nothing
prints: `invoiceTotals` sums the lines, and `invoice.ts` says so in as
many words ("Computed from the lines, never trusted from the caller").
So the app's hottest read — the approval page's GET and POST, every
approval email, every archived invoice — was reading money on the
caller's own authority for a number no document carries. It is out, the
`ticketRelation` parameter with it, and `render-invoice` reads the base
table again. A test asserts the select names no money column and still
carries the `ticket_lines` embed, so a future select cannot quietly undo
it.

Two sites remain, both in the browser and both price-role paths:
`getTicket` (reopening a draft) and `listTicketsForArchive`
(Job details.txt). PostgREST has resolved reverse embeds through views
since v7 and this should work — but "should" is not the standard on the
night a base-table grant is taken away, and the isolated harness cannot
answer it. `probes-ticket-money-select-api.mjs` is new: it signs in as a
price role and as a Helper against the deployed API, asserts the reverse
embed answers 200 with an array, asserts the forward embeds, asserts the
masking, reports which phase the project is in, and asserts the refusals
once phase 2 is on. If the reverse embed refuses, the fix is a second
request for the lines — not pressing on.

**Note 3 — the PWA.** Written into the phase 1 header as a numbered
order, because the hazard is that phase 2 is the irreversible half: an
installed build serves itself from its own service worker, and an old one
stops reading tickets at all the moment the base grant goes. The gap
between the phases may be as wide as it needs to be; what may not be
skipped is seeing the new build load on a real tablet, not merely seeing
CI deploy it.

Green at this commit: 922 tests, Biome clean on 216 files, 22 functions
type-check, build ships 36 precache entries, 99 isolated SQL checks.
