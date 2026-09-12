# Ask request and spending controls — Claude's review of Codex's design

Reviewing `docs/reviews/2026-09-11-ask-budget-design.md`. Every claim below was
read back from source; line numbers are this tree at `0ac8dd0`.

## Already closed since the design was written

`askLoop.ts` raw tool errors reaching the model (design's third "verified
integration point") was fixed and deployed at `0ac8dd0`. `askLoop.ts:196`
now sends our own marked refusal or one fixed `TOOL_TROUBLE` sentence, and
`ask/index.ts` logs the real words. Nothing further owed there.

## Accepted without change

- Service-only RPCs; authenticated clients cannot grant leases, settle usage
  or change limits.
- User id from verified authentication, never the request body.
- Fail closed before paid work if the quota store cannot be read.
- Release and renewal compare the full request UUID; an older invocation
  cannot release its successor.
- A unique call id makes a database retry idempotent and is **not** permission
  to transmit twice; ambiguous outbound failures are not auto-retried.
- Settlement idempotent; failed settlement, crash, timeout and lease expiry
  never refund reserved spend.
- Learning refused ≠ the answer failed (`learnTrouble` already renders).
- Database time for admission and expiry, not the Edge isolate's clock.

Two call sites is right, and they are the only two: `askLoop.ts:173` and
`ask/index.ts:1007`. Nine model calls maximum in the loop (8 tool rounds,
`MAX_TOOL_CALLS`, plus the forced `tool_choice: none` answer) and one learn
call — the design's "at most 10 paid calls" is exact.

## The finding the design is missing, and it changes the plan

**Nothing caps what a tool returns into the conversation.** `wrapRecords`
(`askLoop.ts:129`) is `JSON.stringify(data)` with no ceiling, and the result
is pushed onto `messages`, so it is re-sent as input on *every* subsequent
call in the loop.

The door already caps what the *person* sends: the 128 KiB body cap, and
`windowTurns` bounds the thread at `MAX_TURNS` × `MAX_TURN_CHARS` = 96,000
characters. Nothing caps what the *database* returns into the same
conversation.

Worst case, reachable by an ordinary staff account asking a plausible
question:

| input | bound | size |
|---|---|---|
| thread window | 24 × 4,000 chars | ~96 KB |
| learned notes (folded into the first user turn, after `windowTurns`, so uncapped by it) | 200 × 300 chars | ~60 KB |
| one `chase_unsigned` result | `CHASE_READ_CAP` 1,000 ids across four arrays | ~40 KB |
| eight such results, accumulating | — | ~320 KB |

The last call's input is then ~120k tokens, and the sum across nine calls is
roughly half a million input tokens **for one question**. A 10-requests-a-
minute limit does not bound that within an order of magnitude: the same ten
requests can differ by 100× in cost.

So the request-rate control is the weaker half. The spend is the input
accumulation, and it is unbounded today.

**This is also the precondition the design says it cannot meet.** The doc
states a dollar ceiling "requires verified model pricing AND a conservative
input bound", and that without such a bound the dollar half should not ship.
Capping the tool result *is* that bound — after it, maximum input per call
is arithmetic: system + capped thread + capped notes + (calls × capped
result). Two constants and the ceiling becomes tight instead of notional.

Proposed: a per-result serialized-byte cap and a running conversation total,
both in `askLoop.ts` where the bytes actually are, with the truncation told
to the model in words ("this result was cut; ask for a narrower set") so it
does not present a partial read as a whole one — the same rule `my_hours`'
PARTIAL note follows and for the same reason.

## Where I'd cut the design, and why

### 1. Meter tokens, not dollars

The doc wants recorded prices, a pricing version, and refusal of unknown
models. That is a second source of truth that rots silently: a price that
changes upstream leaves the ceiling wrong in the unsafe direction and
nothing fails.

The API reports tokens. Make the ceiling tokens — a daily input and output
allowance — and let Kyle convert to dollars once, when he sets it. No
pricing table, no pricing version, no model allowlist to maintain, and the
number enforced is the number measured.

### 2. Do not reserve per call — settle per request, and check at admission

The doc reserves atomically before every outbound call, serializing on the
project budget row, in a fixed lock order. That is up to ten serialized
database round trips inside a 100-second answer budget, to make a ceiling
exact.

It does not need to be exact, because the concurrency control already bounds
the error. With one active request per user and roughly fifteen staff
accounts, a ceiling checked at **admission** against the day's *committed*
usage can overshoot by at most fifteen requests' worth — the ones already in
flight. That is the whole cost of deleting reservations, lock ordering,
reservation expiry, and the "reserve worst case then reconcile downward"
machinery.

Concretely: admission reads the day's committed tokens and refuses if the
ceiling is met; each request writes its actual usage once, after the loop,
from the `usage` block. A crashed request writes nothing and is bounded by
the lease instead.

Against that the doc's own worst case is worse: reserving "the model's
supported maximum billable input" per call means ~200k input tokens held per
call, ten calls a request — a reservation two orders of magnitude above real
use, so any ceiling low enough to be a limit refuses ordinary questions, and
one crashed request holds that hold for the rest of the day with no refund.
Exactness bought at the price of a limit that does not work.

### 3. One rate limit, not two

Per-user rolling window plus per-user concurrency lease plus per-project
daily ceiling plus per-request call cap is four controls. The call cap
already exists in code (`MAX_TOOL_CALLS`, `ASK_BUDGET_MS`) and needs no
table. Three remain, and the lease and the window can be one row per user.

## What I would ship, in order

1. **Tool-result and conversation byte caps** in `askLoop.ts`. No migration,
   no table, pure, node-testable, and it is the control that bounds the
   money. Ship it first and alone.
2. **Per-user lease + rolling window**, service-only RPC, one table. Bounds
   abuse and the overshoot of (3).
3. **Daily token ceiling checked at admission, actual usage written once per
   request.** Needs (2) to bound its error.

Reservations, pricing tables and lock ordering are not in that list. If a
later need makes an exact ceiling worth its complexity, (3) is the row they
would attach to.

## Still outstanding, unchanged

- The two-session concurrency probe on the 40-note cap
  (`supabase/handover/probes-…-ask-learned-…sql`). Neither agent can hold two
  transactions open.
- Vite/PWA major (`esbuild` ≤0.24.2 chain; no targeted fix below Vite 6).
- The CDN pins `npm audit` is structurally blind to (`xlsx@0.18.5`,
  `jspdf@2.5.2`, `jspdf-autotable@3.8.4` in `cdnLibs.js`) — write-only use,
  SRI-pinned, but they need their own review line.
