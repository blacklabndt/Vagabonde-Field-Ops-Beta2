# The three concurrency probes, run

12 Sept 2026. Outstanding since round 7: the whole Ask ceiling rests on two
concurrent reservations not both passing, and no session had two connections
at once to ask that question. An unverified lock is exactly the shape the
first defect took — a read-then-write window nobody looked at.

Two connections were had by firing two Management-API queries at the live
project at once: each lands on its own backend, so the first can hold a
transaction open while the second tries to enter. The holder sleeps four
seconds inside the transaction; the second's wall clock is measured from this
side. Every probe below cleaned up after itself, and the final row counts are
part of the transcript for that reason.

Uncontended round trip to this project: **753 ms**. Every "blocked" figure
below is ~4.3–4.6 s against that, which is the holder's sleep and not the
network.

## 1. `ask_reserve_call` — the admission race (the main claim)

The day was filled to `cap − 1,008,000`, so exactly one more reservation fits.
Both askers want 1,008,000.

```
day total before the race: 8992000   room: 1008000
A: 4973 ms ok
B: 4572 ms [{"ok":false}]
after: {"n":2,"total":10000000}
cleaned, rows left: 0
```

B waited for A's transaction, then read the day **including A's row** and was
refused. The day ended **exactly at the cap**. Without the per-day advisory
xact lock both would have read 8,992,000, both found room, and the day would
have closed at 11,008,000 — the ceiling failing at the one moment it is being
tested.

**Control**, same race with the day nearly empty:

```
control  B blocked 4399 ms and answered [{"ok":true}]
```

So the refusal above was the **ceiling**, not the lock. The lock serialises;
it does not refuse.

## 2. `ask_learned` — the 40-note cap

39 notes seeded for a test account, one seat left, two writers:

```
B blocked 4299 ms and was refused: ERROR: 23514: That account has already
taught Ask as much as it can hold (40 notes)...
Bob now holds 40 notes (40 is the cap)
cleaned; Bob holds 0 · Kyle still holds 3
```

Exactly 40. The trigger's `pg_advisory_xact_lock(hashtextextended(said_by))`
holds.

## 3. `ask_claim_lease` — and it found a defect

```
second asker waited 4469 ms and got null (TWO AT ONCE)
```

Not two at once — **a refusal expressed as NULL**. `ask_claim_lease` was
`language sql` ending `returning true`, and its `on conflict do update ...
where <stale>` matches no row when the lease is live, so the function returned
NULL. That is 20260912041955's defect again, in the sibling nobody re-read.

Ask reads it as `took.data !== true`, so the live app fails **closed** and no
second question was ever admitted: a trap, not a hole — laid directly under
the next person to write `=== false`, and the reason the probe could not
assert the refusal it existed to assert.

Fixed live as **20260912045301**, plpgsql returning `found`. Same two
connections again:

```
second asker waited 4290 ms and got false
a stale lease is still takeable: true
a live one is not:              false
rows left for Bob: 0
```

Behaviour unchanged; the refusal is now a value a caller can test.

## 4. Settlement, while the connection was open

```
settle once : true
settle twice: false
unbilled on a settled call: false
unbilled on a call nobody reserved: false
row after: {"reserved":500,"settled":30}
spend rows written: [ { calls: 1, input_tokens: 10, output_tokens: 20 } ]
cleaned. ask_calls rows left: 0   ask_spend rows left: 0
```

Settlement is idempotent by `call_id`; the unbilled door refuses a call the
provider already billed, **visibly** — which is what 20260912041955 bought and
what this transcript is the evidence for.

## What remains unverified

The reservation is `ONE_CALL_MAX` and that figure is the provider's, not
ours: a context window the API itself enforces with a 400, plus the
`max_tokens` we send. Nothing here tests that claim, and nothing on this side
can — it is the vendor's to confirm.
