# Lane 2 — money and the office (Claude)

Beta 2, 12 Sept 2026. Read-only against the live project unless stated.
Written from evidence actually collected in this session; the earlier
subagent run of this lane died before filing, and only the probe scripts
survived. Every claim below names the probe that produced it.

Probes: `vite-app/e2e/hunt/lane2-money.mjs`, `lane2-nulls.mjs`,
`lane2-helper-money.mjs`, `lane2-fingerprint.mjs`. Not rerun:
`lane2-gstguard.mjs` and `lane2-ownership.mjs` — both attempt writes, and
Codex's cybersecurity review (`2026-09-12-codex-cybersecurity-retry.md`)
rules mutation probes out against live data. Their claims are therefore
recorded below as UNVERIFIED, not as passes.

## What holds

**Ticket arithmetic agrees with the database, to the cent.** 396 live
tickets with lines were read with their lines and re-totalled with
`data.js`'s `lineTotal`; every one matched the trigger's stored
`round(quantity * unit_rate, 2)` sum exactly. No third formula has crept
in. (`lane2-money.mjs`)

**`gstOn` is exact.** Every whole-cent subtotal from $0.01 to $5,000.00 at
each rate live in `clients` (only 5% is in use) was checked against an
independent BigInt reference. No drift. (`lane2-money.mjs`)

**The unit suite is green:** 911 tests pass, including the twin checks
(`askTwins`, `backupSchedule`) that hold `chasePlan.js`/`chasePlan.ts` and
`attention.js`/`attention.ts` together, and `cdnPins`. That is the evidence
for the chase-twin and accounting-export parity claims; I did not find a
way to make either drift.

**The GST snapshot has no dirty rows.** No ticket that was approval-sent,
approved or invoiced since the migration (`2026-09-11T20:48:44Z`) carries a
null `gst_rate`. In fact no ticket carries a non-null one either: all 206
are legacy, and all activity predates the migration — which is exactly the
documented legacy behaviour. (`lane2-nulls.mjs`)

## Findings

### 1. A Helper reads every ticket's total off the table — HIGH (confidentiality)

`Prices are for Admins and Technicians` is enforced in three places and not
in the fourth. Signed in as the seed Helper `qa 2`
(`role: Helper`, tabs `board, job, jha, files, contacts, chat`):

- `ticket_lines`, `rate_lines`, `rate_line_history`, `rate_overrides` — all
  answer `[]`. Correct.
- `search_tickets`, `ticket_tracker_stats`, `ticket_aging` — all answer with
  `total: null`, `unsigned_total: null`, `approved_total: null`. Correct,
  and the reason those RPCs exist.
- `GET /rest/v1/tickets?select=total` — **answers in full.** One page
  returned 1,000 totals summing **$2,545,054.77**, and
  `order=total.desc&status=eq.Invoiced` handed back the five largest
  invoiced tickets with their job ids.

Cause: `create policy "tickets select" ... using (is_staff())` in the
baseline (line 1481). `is_staff()` is "holds at least one tab", so every
crew account reads every ticket row, and `tickets` has no column-level
SELECT restriction — the column grant on that table covers UPDATE only.
The money-nulling RPCs are then a client-side convention that one direct
REST call walks past. `seesPrices(user)` gates the screens, never the data.

Impact: any crew account — and any locked account for the hour its token
lives, though `profiles_select` was already narrowed for that case — can
read the whole book of business: per-ticket revenue, invoiced totals,
invoice numbers, and by joining `job_id`, revenue per client. Helpers are
crew rather than outsiders, so this is disclosure inside the building, not
outside it. It is still the one rule Kyle stated about prices, unenforced
at the table.

Not a one-line fix: narrowing the policy to the price roles would blind
Job detail's ticket list for a Helper, which legitimately shows a job's
tickets without their money. The shape that fits the existing design is a
column-level SELECT grant — revoke `total`, `invoice_number` and
`invoiced_at` from `authenticated` and hand them out through the RPCs that
already decide money — or a view. Either is a migration and a decision, so
it is reported, not patched.

### 2. The approval page's change-detector watches the wrong GST rate — MEDIUM

`invoiceFingerprint` in `_shared/approvalToken.ts` digests
`d.job.clients.gst_rate`. `invoiceTotals` in `_shared/invoice.ts` prices the
page from `d.ticket.gst_rate` — the snapshot — whenever the ticket has one.
Since the 11 Sept snapshot migration those are different numbers, and the
function's own comment ("an exemption switched on or off ... still moves the
total the rep is putting their name to") states a premise that stopped being
true that day. Both halves reproduce purely, no network
(`lane2-fingerprint.mjs`):

- **False refusal.** Ticket snapshot 5%, client re-rated 5% → 0% while the
  rep has the page open. The page's figures are *identical* ($1,050.00 both
  times, because the snapshot prices it) but the fingerprint changes, so the
  POST answers "This ticket has changed since this page was opened" and the
  rep cannot sign a page that did not change. The office has to resend.
- **Missed change.** Snapshot 5% → 0% with the client's rate fixed: the
  page's total moves ($1,050.00 → $1,000.00) and the fingerprint does not.

The second half is the serious shape and is currently hard to reach —
`gst_rate` is the service role's, `freeze_ticket_gst` only reserves on the
first approval attempt, and retries and withdrawals keep the value — so I
could not drive it live without a write. The first half is reachable by an
Admin re-rating a client on any ordinary afternoon, and it degrades safely.

Fix is one line in `invoiceFingerprint`: digest the rate the total is
actually computed from (`d.ticket.gst_rate ?? d.job?.clients?.gst_rate`),
which is what `invoiceTotals` does. Worth a test that pins the two to the
same preference, since this is the second time the snapshot's readers have
had to be walked one by one.

## Unverified — needs a safe fixture, not a live probe

Recorded so nobody reads silence as a pass:

- The `gst_rate` write guards (column UPDATE grant, the restrictive INSERT
  policy pinning client-created tickets null, `freeze_ticket_gst` refusing a
  signed-in caller). `lane2-gstguard.mjs` PATCHes a live Draft.
- Own-or-Admin on `ticket_lines` writes, and a non-Admin's
  `mark_tickets_invoiced`. `lane2-ownership.mjs` INSERTs and DELETEs lines
  on another technician's live ticket.
- The whole approve → withdraw → re-rate → invoice sequence end to end. It
  needs a ticket that may be approved and withdrawn, which on this project
  means a real approval mail.
- The archive's build → verify zip → drift refusal → clear path. The clear
  is one of the app's two bulk deletes and was not gone near.

Each of those wants a fixture whose seed ownership is proved first, cleanup
by exact id, and responses saved redacted — Codex's conditions.
