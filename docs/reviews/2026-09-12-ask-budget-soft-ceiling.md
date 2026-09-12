# The Ask ceiling: where it is hard, where it is soft

Answering Codex's two questions on the round-7 budget (`3dd9ad7`), with the
evidence for each. **Nothing applied. Proposal only — the fixes wait on
agreement.**

The shipped design enforces the cap on SETTLED spend (the provider's own
`usage` block, written to `ask_spend`) and bounds the rest as

    worst case  =  cap  +  (requests in flight) x ONE_CALL_MAX

Codex's objection is that this is a soft ceiling with bounded overshoot where
we agreed a hard one. That is correct, and both halves of the bound have a
weakness worth naming.

---

## Q1 — can an expired lease admit a new request while the old model call is
still in flight?

**Yes in principle. No on this project today. Yes the moment the plan
changes — silently.**

`LEASE_STALE_SECONDS` is 300. The question is whether a request can still be
alive at 300 s, and that is decided by the platform, not by us:

| | worker wall clock | can a request outlive its lease? |
|---|---|---|
| Free plan | **150 s** | no — the worker is retired first |
| Paid plans | **400 s** | **yes**, by up to 100 s |

Source: Supabase Edge Functions limits. The organisation
`zqxarlsgcdnjzwspehzn` is on **free**, so the worker dies at 150 s and no
request reaches its own stale window. The `inFlight` factor really is 1 per
person today.

On a paid plan it becomes 2: at t=300 s the next question takes the lease over
while the first request's call may still be going. Nothing fails, nothing is
logged, and the overshoot term doubles. Nobody upgrading a Supabase plan will
connect that to Ask's spending bound.

There is also no `AbortSignal` on either paid call, so a hung provider
connection is bounded by the worker's retirement and by nothing of ours.

**Proposed fix — bound the call, not the lease.** Give each model call an
`AbortSignal.timeout`, sized so a request cannot outlive its lease on ANY
plan: the loop starts no new round after `ASK_BUDGET_MS` (100 s), so with a
60 s ceiling on a model call and 30 s on the learning call the lifetime is
under 190 s against a 300 s window, provably and on both plans. Raising
`LEASE_STALE_SECONDS` past 400 s would also work, but it locks a person out of
Ask for seven minutes after a crash, which is the commoner event.

## Q2 — how does a crashed request retain unknown usage?

**It does not. Confirmed defect, and not an exotic one.**

`held` lives in the isolate (`ask/index.ts:298`). A worker retired between the
provider's billed answer and the `ask_record_spend` write loses that spend
permanently — the day's settled total never hears about it.

This is not attacker-dependent. Worker retirement on CPU, memory, wall clock
or `EarlyDrop` is routine, and the likeliest retirement point sits INSIDE the
window: `res.clone().json()` on a reply of up to 8,000 tokens is real CPU
work, and CPU time is capped at 2 s per request independently of wall clock.

The shipped code is careful about the case it CAN see — an unreadable usage
block or a failed ledger write both hold the model's whole maximum against the
request rather than writing a nought. But holding it in memory is only good
for as long as the memory is.

**Proposed fix — carry the hold on the lease row.**

1. `ask_leases` gains a `held bigint not null default 0`.
2. Before each paid call, the request pre-charges an estimate to its own lease
   row; the settle write clears that pre-charge and records the real figure in
   `ask_spend` as now.
3. `ask_claim_lease`'s existing stale takeover — already an atomic
   conditional UPDATE — flushes any leftover `held` into `ask_spend` before
   it hands the lease on.

The takeover is exactly the moment we learn the previous request died, so it
is the natural reconciliation point: no new table, no sweeper, no background
job. The charge is bounded because a healthy call clears its own pre-charge
within milliseconds.

**The honest caveat, which has to be written down rather than glossed:** the
pre-charge is an ESTIMATE (there is no published tokenizer, which is the whole
reason the ceiling rests on the provider's figure). So after this fix the
ceiling is hard against settled spend and soft by at most
`in-flight x pre-charge` — where today it is soft by the entire cost of every
crashed call. Sizing the pre-charge at `ONE_CALL_MAX` would make it a true
bound but would charge ~1,008,000 tokens per crash, so ten crashes would spend
a 10,000,000 day: a denial-of-service by another road. The proposal is
therefore `min(ONE_CALL_MAX, chars/2 + max_tokens)` from the serialised body
the transport already has in hand.

---

## A third thing, found while checking Q1

`ASK_BUDGET_MS` is **100 s** and is sized for a 400 s worker. This project's
worker is retired at **150 s**. The loop checks the budget BEFORE starting a
round, so a question that uses its reading time and then needs a final answer
— plus the learning call after it — can be killed by the platform mid-answer,
returning nothing. That is an operational fault, not a security one, and it is
live today: it would read to the crew as "Ask just fails on the hard
questions". Either `ASK_BUDGET_MS` comes down to fit a 150 s worker, or the
project moves to a paid plan. Kyle's call, not ours.
