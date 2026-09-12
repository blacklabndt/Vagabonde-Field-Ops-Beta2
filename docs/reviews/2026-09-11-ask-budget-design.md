# Ask request and spending controls — design for Claude review

Status: proposed implementation details; no application or database changes in this pass.

## Verified integration points

- `_shared/askLoop.ts:154` makes a Messages request on every loop iteration, with up to 8 tool calls and a final answer request, each allowing 8,000 output tokens. Count outbound requests explicitly rather than deriving the budget from tool count.
- `ask/index.ts:987` makes a separate learning request (600 output tokens). It must use the same metered transport.
- `askLoop.ts` catches tool failures and includes their raw messages in tool-result content. HTTP error masking does not cover this model-input path. Claude should verify reachability from a failing database read and agree to passing only explicitly public errors to the model.

## Proposed admission contract

Service-only RPCs own the controls; authenticated clients cannot grant themselves leases, settle usage, or change limits. The Edge Function obtains the user ID from verified authentication, never the request body. Fail closed before paid work if the quota database cannot be reached.

Starting operational limits for review: one active request per user, 10 admitted requests per rolling minute, a 180-second lease, and at most 10 paid calls per admitted request including learning. These values are proposals, not previously agreed production settings. Use database time for admission and expiry.

An admission RPC serializes on the user, checks their current active profile, prunes expired request-window entries, then inserts a request UUID and expiry. A refused request does not consume the admitted-request allowance. Release and renewal compare the full request UUID; an older invocation cannot release its successor. Renew before each model call. A transport deadline must end before the lease expiry, although aborting locally cannot prove the provider stopped work.

## Spending contract

Keep concurrency leases separate from a durable call ledger. Each outbound attempt gets a fresh call UUID and an atomic reservation before transmission. A unique call UUID makes database retries idempotent; it is not permission to transmit the provider request twice. Do not automatically retry ambiguous outbound failures.

Serialize the project budget row when reserving. Check committed usage plus outstanding reservations plus this reservation against the configured UTC daily ceiling. The charge belongs to its reservation day even if the response arrives after midnight. Lock in one order everywhere: project budget, request, call. No client may supply the price or reservation amount.

A dollar ceiling requires verified model pricing AND a conservative input bound. Do not use `max_tokens` alone, character/4 estimates, or an undocumented token-count margin. Record exact model IDs, maximum accepted input, input/output prices and pricing version server-side; refuse unknown models. A conservative first implementation reserves the model's supported maximum billable input plus configured output at its highest applicable rates, with caching/batch discounts ignored. Verify that provider limits and pricing support this bound before shipping; if such a bound cannot be established, ship request limits separately and label dollar enforcement incomplete. A configured budget smaller than one reservation must produce an actionable refusal, not silently weaken the reservation.

Settle once from validated provider usage. Missing, malformed, or excessive usage keeps the full reservation and logs an operational fault. An unexpected usage value above the reservation disables new calls pending investigation. Failed settlement, request crashes, timeouts, and lease expiry do not refund reserved spend. Repeated settlement is idempotent. Reconciliation can lower a hold only with reliable usage evidence.

If learning cannot reserve budget, retain the main answer and display a safe `learnTrouble` message. If the main loop cannot reserve its next call, stop without another paid call and return a clear limit message; never claim incomplete tool results form a complete answer.

## Implementation units and evidence

1. Draft SQL under `supabase/handover/`: private settings, admissions, budget-day and call-ledger tables; service-only admission/reserve/settle/release RPCs. No prompts, API keys, or tool data in these tables. Add role probes for direct access denial and spoofed ownership.
2. Pure `_shared/askBudget.ts`: lease ownership, bounded call count and response-usage validation, with injected database/transport/clock for tests. Keep the actual network wrapper in an import-capable shared module. Both Messages call sites must use it.
3. Negative tests: concurrent admission; concurrent project reservations; stale release; expired lease; missing ledger; database failure; midnight settlement; duplicate settlement; malformed usage; ambiguous provider failure; learning denied after a successful answer; all tool-loop requests metered.
4. Two-connection SQL tests: prove only one same-user admission succeeds and total reserved spend never exceeds the configured ceiling. Also run the still-outstanding 40-note concurrent INSERT/replacement probe. Single-session role simulation cannot substitute for either race test.
5. Apply only the reviewed draft, run probes, retrieve and file the actual applied migration version. Run full test/typecheck/build gates; deploy `ask` and any required client changes, then verify unauthenticated refusal and signed-in quota behavior using test accounts without sending mail.

## Current access and remaining work

This pass found no callable Supabase connector and no `psql` command in this Codex session. That does not establish whether another session can run the races. Claude's reported live deployment is not independently verified here.

Dependency work remains separate: Vite/PWA upgrade with offline/update tests, plus CDN dependency inventory and advisory review. MFA stays out of scope; custom approval recipients remain intentional.
