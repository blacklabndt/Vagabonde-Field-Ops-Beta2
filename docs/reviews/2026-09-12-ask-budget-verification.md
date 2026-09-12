# Ask's daily allowance — what shipped and what was checked

Round 7's last open item: admission and concurrency controls, agreed with Codex
to go first while the hard token-bound contract was settled.

## The shape, and why it is this shape

Codex's review established the constraint that decided the design: Anthropic
documents its own token counter as an **estimate**, so nothing computed before
a call can be a hard bound on what that call is billed.

So the ceiling is enforced on what has been **settled** — the `usage` block the
provider itself returned — and never on a guess. That leaves the call in
flight, and it is bounded rather than estimated:

    worst case  =  cap  +  (requests in flight) x ONE_CALL_MAX

`ONE_CALL_MAX` is the model's context window (a larger input is refused with a
400) plus the `max_tokens` this app sends. Loose — the character caps put the
real figure two orders under it — but finite, documented and provider-enforced.

**The lease is what makes the first factor small.** One question at a time per
person is not politeness; without it a single account could hold any number of
calls open across the line at once.

Four corrections from Codex's review are in the code:

- **Both** paid calls go through one metered transport. The learning pass fired
  on every answer and was counted nowhere; `askBudget.test.mjs` reads the
  function back and fails on a bare `fetch(API_URL`.
- Every input category is counted, not `input_tokens` alone — a cached prefix
  is billed under two other names, and a ceiling that cannot see them would
  undercount silently from the day prompt caching is switched on.
- The response is settled from a **clone**; the caller still has to read the
  original.
- An unreadable bill, or a ledger write that failed, holds the model's whole
  maximum against that request for the rest of its life. It is never written
  down as nought, and it is never retried — `ask_record_spend` ADDS, so a retry
  after an uncertain failure would double-count the day.

## Two defects found while wiring it

**1. The Admin screen had no box, and the refusal named one.** `SPENT_WORDS`
told the person an Admin could raise the limit on the Admin screen. The column
existed, the function read it, and no screen could write it — so the only way
to lift the ceiling was SQL, which in practice means Ask dies at the default
and stays dead. An error that names what to do has to name something that
exists. There is now a "Daily limit (tokens)" field, and a test that fails if
the sentence and the screen stop agreeing.

Blank is no limit. A typed `0` is **refused in words** rather than saved,
because the function reads 0 as "no ceiling" and whoever typed it meant "stop
everything" — the one reading that must not be silent.

**2. `add column if not exists … default` does nothing when the column
exists — not even the default.** An interrupted turn had already applied this
migration (`20260912025816`) with the column and a seeding `UPDATE`. The
version applied deliberately (`20260912030901`) moved the default onto the
column, and its whole statement was skipped.

The result was the worst of the two: the **live row** read 10,000,000 while the
**column** carried no default, so a fresh replay — the disaster-recovery
project, the one this matters for — would have inserted its first
`app_settings` row with a null cap and given the assistant no ceiling at all.
This is `20260910023039`'s mistake one column over, and it was invisible
because the live project looked right.

`20260912031059` sets the default on its own, which `alter column` does
unconditionally.

## Migrations — three files, and why

The repo and the applied history reconcile 1:1, so all three applications are
filed, including the superseded one. `20260912025816` was reconstructed and its
bytes checked against `md5(statements[1])` in
`supabase_migrations.schema_migrations` before filing — an exact match, not a
retyping.

| version | what it was |
|---|---|
| `20260912025816` | the change, applied by an interrupted turn; column with no default, seeded by UPDATE |
| `20260912030901` | the same change with the default on the column — the `add column` no-op'd |
| `20260912031059` | `alter column … set default`, which actually attaches it |

## Verified

- **Eleven probes, run live** against `eielmvxzdwwprmmfamlq`, all PASS: the four
  RPCs refuse a signed-in caller; neither table takes a write from one; leases
  are unreadable and spend is empty for a non-Admin; one question at a time and
  the refused claim writes nothing; a release names its own request or does
  nothing; a stale lease is taken over; two people never wait on each other;
  spend accumulates and the answer is the day rather than the person; the
  ceiling is the project's summed across the crew; an Admin reads the ledger
  and writes none of it; the ceiling and **the column's default** are both
  there.
- Both tables were **empty again afterwards** — the probe left nothing behind.
- `npm --prefix vite-app test` — render scan, Biome, Deno typecheck (21
  functions), node suite.
- `npm --prefix vite-app run build` — Vite 7, PWA generated.

## Not verified, and still open

- **The two-session lease race.** The atomicity of `ask_claim_lease` under two
  simultaneous claims needs two connections holding transactions open at once.
  Neither agent has that. What the probes DO show is the single-statement shape
  it rests on: the refusal happens in the same statement that would have taken
  the lease, so there is no read-then-write window to lose. The procedure is at
  the foot of the probes file.
- **The hard token-bound contract** Codex asked for. `ONE_CALL_MAX` is a
  provider-enforced ceiling, not a tokenizer guarantee, and the character caps
  beside it are structural limits measured in UTF-16 code units — not bytes and
  not tokens. The design does not depend on one, because nothing is reserved
  ahead of a call; the settled figures are the provider's own.
