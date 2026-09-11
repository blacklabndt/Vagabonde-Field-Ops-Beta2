# Beta 2 review for Claude

Requested by Kyle: review arithmetic, scalability and code quality, then hand findings to Claude for review.

Reviewed checkout: `d3b4b18` (`0.93-beta 2`), 11 September 2026. This is a source review with local reproductions, not a live database audit or a production load test. No application code, schema or deployed state was changed. Please review the findings before implementing fixes.

## Findings, in priority order

### F1 — P1: changing client tax changes previously sent and approved invoice totals

**Evidence:** `supabase/functions/_shared/ticketInvoice.ts:34–39` joins the current `clients.gst_rate` on every invoice load. `supabase/functions/_shared/invoice.ts:34–35,164–168` computes the document total from that joined rate. `vite-app/src/db.js:1160–1168` updates the client rate without snapshotting existing tickets. The latest `search_tickets` definition also joins the current client rate (`supabase/migrations/20260906154840_an_invoice_has_a_number.sql:168`).

**Trigger and impact:** email a $1,000 subtotal ticket at 5%, then change that client's rate to 0%. The existing email says $1,050, while a newly rendered approval page/invoice or accounting export says $1,000 for the same ticket. Approved/invoiced status does not freeze this joined value. Changing the rate back has the opposite effect. This is a historical billing integrity problem independent of whether the new tax rate is correct.

**Reproduction:** the attached script runs the real invoice arithmetic with identical lines and the two joined rates; totals are 105000 and 100000 cents. The live edit/send/approve sequence was not executed.

**Suggested correction:** store the applied tax rate and preferably calculated tax/total as part of the ticket's financial snapshot at the agreed lifecycle boundary, no later than sending for approval. Have the approval email, approval page, rendered invoice and CSV read the same snapshot. Decide explicitly how to migrate existing sent/approved tickets; do not silently backfill historical rates from today's client values. Test a client-rate edit between email and signature, and after invoicing.

### F2 — P1: accepted numeric precision differs from the billing arithmetic and database

**Evidence:** `vite-app/src/numberInput.js:32–48` permits unlimited fractional digits whenever the step is fractional. `components/common.jsx:875,895` preserves that number at commit/change. `components/rateAdmin.jsx:915–916` uses this input for rates. `db.js:277–284` preserves the raw precision in the write payload but computes the preview total via `data.js:347–348`, which first rounds quantity to thousandths and rate to cents. The invoice does the same (`invoice.ts:152–153`). Database columns are unrestricted `numeric` (`20260817040000_beta1_baseline.sql:527–528`), and the later database trigger sums `round(quantity * unit_rate, 2)` (`20260818140051_line_totals_are_cents.sql:23,32,63`).

**Examples reproduced:**

| Accepted values | Exact product, rounded to cents | App/invoice calculation |
|---|---:|---:|
| Quantity 1.2345, rate $100 | $123.45 | $123.50 |
| Quantity 100, rate $1.234 | $123.40 | $123.00 |

These inputs can enter through normal decimal inputs; this is not limited to direct database writes. The stored total/validation uses different mathematics from the document. Depending on the write path, this means a validation failure or a stored amount that disagrees with the rendered bill.

**Suggested correction:** define one precision contract and enforce it at input commit, persistence and database boundaries, or calculate from exact decimal inputs throughout. If the intended contract is quantity to three places and rate to two, reject or visibly normalize excess digits before saving and constrain stored data accordingly. Include end-to-end save/read/render/export tests for the examples above. Preserve the existing half-cent regression `1.5 * 60.05 = 90.08`.

### F3 — P2: Ask silently reports incomplete hours once a period exceeds the response cap

**Evidence:** `supabase/functions/ask/index.ts:653–664` reads `ticket_crew` once with `.limit(1000)`, with no pagination, ordering, count or truncation warning, then returns `sumHours` as the period total. The date helper permits roughly a year's range. The actual Timesheets read uses pagination, so the two surfaces can disagree.

**Trigger and impact:** 1,001 matching crew rows of one straight hour produce 1,000 hours in Ask instead of 1,001. Other hour categories, mileage and distinct days can also be understated. With a lower API cap the threshold arrives sooner. The pure sum is correct; the runner omits its inputs.

**Reproduction:** attached script compares the complete and capped synthetic inputs through the actual `sumHours`. The query cap is verified by source; no live API fixture was created.

**Suggested correction:** aggregate in a caller-authorized database RPC, or walk crew rows by a stable unique key until exhausted. If an intentional limit is retained, label the result partial and refuse to present it as a complete period total. Test 1,001+ rows and a reduced API cap at the runner/query boundary.

### F4 — P2: backup marks a table complete after a short capped response

**Evidence:** `supabase/functions/backup-run/index.ts:801–817` requests `PAGE_ROWS`, then treats any shorter response as exhaustion. `supabase/functions/_shared/backupTables.ts:276` fixes `PAGE_ROWS` at 1,000. This bypasses the learned-cap handling already present in the frontend's `paging.js`.

**Trigger and impact:** if the PostgREST max-rows setting is lowered to 250, a table with 1,001 rows is backed up with only its first 250 rows, and the cursor advances to the next table. The resulting successful backup can lack most of a table. This finding is conditional on a lower server cap; I did not establish that production currently has that configuration.

**Reproduction:** the attached script extracts and executes the actual table reader with a simulated 250-row server cap. It makes one query, reports 250 rows and sets `exhausted: true` despite 751 remaining rows.

**Suggested correction:** continue until an empty page, or learn the effective page size and handle the one-page case safely. Preserve keyset ordering and persisted cursors. Test the actual reader against 250- and 1,000-row caps and exact page boundaries, and verify restored row counts against the source fixture.

### F5 — P3: period validation accepts nonexistent calendar dates

**Evidence:** `supabase/functions/_shared/hoursDose.ts:29–30` accepts any ISO-shaped string that `Date.parse` normalizes. `periodFrom` returns the original string (`:61–66`).

**Reproduction:** `isDay('2026-02-31')` returns true; `periodFrom('2026-02-31', '2026-03-03', fallback)` forwards the nonexistent date. The caller then sends it to date filters/RPCs, rather than rejecting it with the intended validation message. A database round trip was not run.

**Suggested correction:** validate year/month/day by a UTC round trip and require the resulting ISO calendar date to equal the input. Add non-leap February 29, February 30/31 and April 31, alongside valid leap-day controls.

## Verification and code quality assessment

- `node docs/reviews/2026-09-11-beta2-repro.mjs`: all five reproductions and positive controls passed. These assertions document current faulty behavior, not passing correctness criteria for a fix.
- Positive arithmetic controls: the standard line rounding example passed, as did an independent integer-reference sweep of every cent subtotal from $0.01 through $5,000 at 5% GST. This supports the ordinary constrained-input arithmetic; it does not cover every possible rate or magnitude.
- `npm test`: render-name/hook scan passed, then stopped because `biome` was unavailable.
- `node --test vite-app/src/*.test.mjs`: 673 passed, 3 file-level failures caused by missing `fake-indexeddb` (`archive`, `offlineCache`, `offlineQueue`), 676 reported tests total. These are dependency failures, not demonstrated application regressions.
- An offline dependency installation attempt failed with filesystem/cache permission errors. Lint, Deno typecheck, production build, browser E2E, SQL probes and production-scale load tests remain unverified in this checkout. Existing successful test results do not substitute for those checks.

The app has useful foundations: centralized pure helpers, integer accumulation, bounded concurrency, keyset pagination on critical frontend reads, resumable backup slices and many regression tests. The main quality gap is consistency across boundaries. Decimal input accepts values the arithmetic cannot preserve; the invoice joins mutable reference data despite immutable-ticket expectations; and newer server runners bypass the frontend's pagination protections. Fixing only the helpers or adding more twin-equality tests would miss these integration failures.

As a follow-up, reduce duplicated numeric and pagination policies between the browser and edge functions, or enforce them through shared boundary tests. `db.js` and the Ask runner also concentrate many unrelated workflows in large modules; extract by responsibility when making the corresponding fixes, rather than doing an unrelated broad rewrite. No performance throughput or maximum supported crew/data size is claimed by this review.

## Claude handoff

Please independently check F1–F4 against the intended lifecycle and database behavior first, then review F5. Confirm severity or explain any counterevidence, and propose a narrowly scoped fix order. In particular, decide the tax snapshot boundary and precision contract with Kyle's existing requirements before changing historical records. Review only at this handoff; Kyle requested findings for your review, not a deployment.

Evidence logs are alongside this report as `beta2-test-output.txt`, `beta2-unit-output.txt` and `beta2-install-output.txt`.
