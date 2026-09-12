# Making the Ask ceiling hard: the revised design

Date: 2026-09-12. Design only — no code changed in the commit carrying this
file. It supersedes the two proposals in
`2026-09-12-ask-budget-soft-ceiling.md`, both of which Codex amended.

What is already live (round 7, `3dd9ad7`): the lease (`ask_leases`, one
question at a time per person), the ledger (`ask_spend`, the provider's own
settled figures), `ask_allowance()` / `ask_record_spend()`, the cap in
`app_settings.ask_daily_token_cap`, and one metered transport both paid calls
go through. What is NOT live is anything below.

Codex's four amendments are taken whole. Where I previously argued for a
cheaper bound, the cheaper bound is dropped and the reason it was wrong is
written down rather than quietly deleted.

---

## 1. One request deadline, and every call cut to fit inside it

**The defect.** `ASK_BUDGET_MS` is 100 s and was sized for a 400 s worker.
This project's Supabase org is on the free plan: **150 s of wall clock**. The
budget is read *before* a round begins, so a question that spends its reading
time and then still needs a final answer — plus the learn call after it — can
be retired mid-answer and return the crew nothing. Live today.

Neither paid call carries an `AbortSignal`, so a hung provider is bounded by
the platform and by nothing of ours.

**The design.**

```
REQUEST_DEADLINE_MS   the platform's wall clock, less a cleanup reserve
CLEANUP_RESERVE_MS    time kept back to settle, release and answer
CALL_TIMEOUT_MS       the most one model call may take on its own
LEARN_TIMEOUT_MS      the same for the learning call
LEARN_MIN_MS          below this, the learning call is not made at all
```

- One deadline is computed **once**, at the top of the request, from the
  platform's wall clock minus `CLEANUP_RESERVE_MS`. Every later question about
  time is asked against that one instant, never against a fresh reading.
- Each paid call gets `AbortSignal.timeout(min(CALL_TIMEOUT_MS, remaining))`,
  where `remaining` is the deadline less now. A call whose share of the
  remaining time is below the minimum useful figure **is not made**; the loop
  stops and answers from what it has, in the same words the other three stops
  use.
- The learning call is **skipped** when the remaining time is under
  `LEARN_MIN_MS`. The answer above it is already right and already paid for,
  so the cost of stopping there is a thing not remembered — the same trade
  `MAX_LEARN_REQUEST_CHARS` already makes.
- `ASK_BUDGET_MS` stops being an independent constant and becomes **derived**
  from the deadline: reading stops at `deadline − (one final answer) −
  (one learn call)`. Two constants that must agree about the same wall clock
  are two constants that will disagree.

**Aborting our fetch proves nothing about the provider.** Codex's point, and
it decides the accounting: an aborted call is settled at **nothing**, which is
to say its reservation (§2) is **retained in full**. We cut our own wait; we
do not cut anyone's bill.

This is a code fix and not a plan upgrade. Kyle does not need Pro.

---

## 2. An atomic reservation before every paid call

**The defect.** `held` lives in the isolate (`ask/index.ts:298`). A worker
retired between the provider's billed answer and the `ask_record_spend` write
loses that spend permanently. Not exotic: retirement on CPU, memory, wall
clock or `EarlyDrop` is routine, and the likeliest retirement point sits
*inside* the window — `res.clone().json()` on a reply of up to 8,000 tokens is
real CPU work, capped at 2 s per request independently of wall clock.

**What I proposed first, and why it was wrong.** I proposed carrying the hold
on the lease row and flushing it at the next stale takeover. Codex refused it:
*there might never be another request.* That is decisive. A reconciliation
that waits for traffic is not a ceiling; it is a hope about traffic. A
single-user project, or the last question of the evening, would carry an
unrecorded spend over the day boundary and out of the ledger for good.

**The design — reservations are rows, and they count from the moment they
exist.**

```sql
create table public.ask_calls (
  call_id     uuid primary key,          -- minted per paid call, not per request
  user_id     uuid not null references public.profiles(id),
  day         date not null,             -- Grande Prairie day, the database's clock
  model       text not null,
  reserved    bigint not null,           -- charged at admission (see §3)
  settled     bigint,                    -- the provider's figure; null = still reserved
  created_at  timestamptz not null default now(),
  settled_at  timestamptz
);
```

The day's total is **`sum(coalesce(settled, reserved))`** — so a reservation
counts against the ceiling from before its call goes, and keeps counting at
the reserved figure until the provider's own figure replaces it. That is the
whole mechanism; everything else follows from it.

- **Admission** is `ask_reserve_call(_user, _call, _model, _reserved)`,
  service role only. It takes a **per-day advisory xact lock** and then
  inserts only if `total + _reserved <= cap`, returning the row. Zero rows is
  a refusal in words. The lock is not decoration: under READ COMMITTED two
  concurrent statements each read the pre-insert total and both pass. The
  `ask_learned` cap trigger already takes a per-author advisory xact lock for
  exactly this reason; this is the same pattern on the day.
- **A null cap is no ceiling**, unchanged: a project that has not set a number
  reserves nothing and is refused nothing.
- **Settlement** is `ask_settle_call(_call, _input, _output)`, idempotent by
  `call_id`: `update … where call_id = _call and settled is null`. A retry
  after an uncertain failure cannot double-count, which is what
  `ask_record_spend`'s ADD could not promise. The call id is minted before the
  request leaves, so the same id is available to every retry of the same
  settlement.
- **`ask_spend` stays** as the human-readable per-day ledger the Admin screen
  reads, written from settlement. `ask_allowance()` changes to answer
  `settled`, `reserved_outstanding` and `cap`, so the Admin screen can say
  what is spent and what is held — a number in neither column is a number
  nobody can explain.
- **Crash, expiry, abort and ambiguous failure all retain the reservation.**
  There is no refund path and no sweeper. A row whose `settled` stays null is
  counted at `reserved` until the day rolls over. Codex's rule, and it is the
  only rule under which the ceiling is a ceiling: *a write an attacker can
  make fail must not be a ceiling they can switch off.*
- **The lease is released separately**, as now, in its own `finally`, naming
  its own request id. Concurrency and money are two mechanisms; a release that
  also refunded would make them one.
- **Retention**: rows older than 90 days are pruned (one `delete … where day <
  current_date - 90` inside the reserve function, or the nightly cron —
  decided at implementation, not here). A ledger that only grows is a
  different bug in a year.

---

## 3. The reservation is the provider's maximum, and the cost of that

Codex rejected `chars/2 + max_tokens`. Correctly: there is no published
tokenizer, so it is an estimate wearing an equation's clothes, and a ceiling
resting on it is soft in the unsafe direction with nothing to say so.

**The reservation is `ONE_CALL_MAX` for the model** — the context window (a
larger input is refused with a 400) plus the `max_tokens` this app sends.
Provider-enforced, not counted by us:

| model | context | max_tokens | `ONE_CALL_MAX` |
|---|---|---|---|
| `claude-opus-5` (loop) | 1,000,000 | 8,000 | **1,008,000** |
| `claude-haiku-4-5` (learn) | 200,000 | 600 | **200,600** |

**The consequence, stated plainly rather than discovered later.** Calls
within one request are sequential, so a request holds **one** reservation at a
time. Outstanding reservations at any instant are therefore roughly *the
number of people asking at once* (the lease bounds each person to one) plus
*every reservation lost to a crash so far today*:

```
outstanding  ≈  (concurrent askers + today's lost calls) × 1,008,000
```

With ~15 staff accounts and the live cap of **10,000,000**, ten simultaneous
askers exhaust the ceiling — on a day whose *real* spend is a few hundred
thousand tokens, because a real question measures ~50k and the character caps
hold the worst case two orders under `ONE_CALL_MAX`. Ten lost calls do the
same thing without anyone asking twice.

So this cannot be sold as a budget. **It is a safety ceiling, not a spending
plan**, and the number Kyle types has to be sized for the reservation
arithmetic and not for the bill he expects:

> a workable floor is `(peak simultaneous askers + a day's worst crash count)
> × 1,008,000`. For this crew that is roughly **16–20 million**, against real
> use of well under one.

Codex's position — *conservative refusal is preferable to silently bypassing
the agreed ceiling* — is accepted, and this is its price: the ceiling refuses
early rather than overshooting late, and the cap must be set high enough that
early refusal is rare. Kyle should be told this in the Admin screen's own
words, not left to infer it from a refusal in a truck.

**The path to a tighter bound, and why it is not taken today.** A byte-level
BPE tokenizer cannot emit a token for fewer than one byte of text, which would
make `utf8Bytes(payload) + protocol overhead + max_tokens` a real upper bound
and shrink the reservation by three orders. Two things stop it being
defensible now: Anthropic does not publish the tokenizer, so the byte property
is assumed rather than documented; and the structural tokens the API adds
around tools and caching are not text we send, so the overhead term would be
the estimate again. Measurement across live traffic can *falsify* that bound
but cannot establish it. It stays named here as the next thing to verify —
with vendor confirmation, not with a ratio observed on our own traffic.

---

## 4. What this changes about the claims already made

- The sentence in `askBudget.ts` — *hard against settled spend, soft by
  `in-flight × ONE_CALL_MAX`* — becomes **hard, full stop**, because the
  in-flight term is now charged before the call rather than after it.
- The Q1 answer stands: an expired lease admitting a second live call is
  bounded by `REQUEST_DEADLINE_MS` (§1) on either plan, and after §2 a second
  live call could not spend past the ceiling anyway — it would have to reserve
  first.
- `unsettledHold` and the in-memory `held` are deleted. Nothing about the
  day's total lives in an isolate.

## 5. Still owed, and not claimed as done

1. **The two-session concurrency probes** — `ask_learned`'s 40-note cap and
   the lease, both needing two connections holding transactions open. Unrun.
   `ask_reserve_call`'s advisory lock adds a **third**, and it is the one that
   matters most: the whole ceiling rests on two concurrent reservations not
   both passing.
2. Round 7 remains **incompletely verified** until those are run.
3. This document is a design. Nothing in §1–§3 is implemented.
