# Round 4 Codex review

Reviewed `b59ce6c`, including the implementation in `a97a96d`. Scope: decimal billing, GST snapshot readers and reservation, numeric save boundaries, Ask hours paging, and backup table paging. This is a local source review and reproduction, not a fresh production audit. Kyle's handoff reports the migration and live probes passed; those results were not independently rerun here.

## Finding: P2 — backup table parts can outlive their slice without checkpointing

At `supabase/functions/backup-run/index.ts:802`, `stepTables` keeps reading until 25,000 rows or an empty page. The change correctly stops treating short pages as exhaustion, but now a low API cap can require thousands of sequential requests within one part. Unlike `stepFiles`, this function receives no deadline and has no request budget.

The outer loop checks its 100-second deadline only before calling `stepTables` (`:565–567`). The part uploads after the entire read loop (`:831–834`), and the persisted cursor and heartbeat update happens only after the function returns (`:582`). Consequently, a timed-out part has no saved progress; reclaim starts at the same cursor and repeats the same work. The heartbeat is considered stale after three minutes (`_shared/backupRun.ts:68`), also shorter than sufficiently long table reads.

**Reproduction:** `node docs/reviews/round4-backup-budget-repro.mjs` extracts the real `stepTables` function and production page/part constants. For a nonempty 25,000-row part it performs these request counts before any upload or return:

| API cap | Requests |
| --- | ---: |
| 1,000 | 25 |
| 250 | 100 |
| 1 | 25,000 |

At an assumed 100 ms per request, the last case would take approximately 2,500 seconds in reads alone. This is an estimate, not a measured network latency or a demonstrated production configuration. The request-count behavior is reproduced; the timeout/retry consequence follows from the checkpoint placement. Even a cap of 250 can overrun the budget when requests take over a second each.

**Suggested correction:** pass the slice deadline into `stepTables`, stop between pages on a time/request budget, and upload/checkpoint the rows already collected with `exhausted: false`. Keep empty-page exhaustion and the row ceiling. Allow headroom for compression/upload, and test that a second invocation resumes at the saved key without gaps or duplicates. Ask already has a separate request budget; its fix does not cover this reader.

## Round 3 recheck

- All 70 targeted tests passed across `billingPrecision`, `billingTwins`, `invoiceSnapshot`, `serverPaging`, `numberInput`, and `archive`.
- The approval sender reserves GST before loading/rendering the invoice. Snapshot readers preserve zero as an exemption and use the client fallback only for absent snapshots. The filed migration updates `search_tickets` and first invoicing consistently with this contract.
- The exact decimal twins preserve the reviewed legacy-precision examples, and the crew persistence boundary uses column-scale rounding.
- Ask hours has both row and request ceilings and explicitly labels partial results.
- No additional billing/GST defect was confirmed in this pass. Legacy null snapshots intentionally retain mutable client-rate fallback; this review does not claim historical rates were recovered.

## Documentation and verification limits

`CLAUDE.md` still opens with a pending-migration warning, and the older round-3 report still describes Ask traversal as unbounded. Both predate the final state and should be reconciled with the applied migration and final request budget to avoid misleading the next reviewer.

No application code, migration, deployed service, or database was changed. Only this report and the reproduction script were added. No full test gate, Deno typecheck, production build, browser test, or live SQL probe was run in this review; the 70-test result is limited to the targeted regression suite. The pre-existing untracked `.claude/settings.local.json` was left untouched.
