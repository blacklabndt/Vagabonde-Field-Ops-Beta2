# Ask's ledger: a malformed bill, and which refusals really cost nothing

Codex's round-7 review left two accounting gaps. Both are now closed in code,
with behavioural tests. Nothing about the 10,000,000 cap changed.

## ① `usageTokens()` accepted a malformed bill and called it free

**Confirmed as reported.** The old reading coerced field by field
(`whole()` → `0` for anything unreadable), so `{usage:{input_tokens:null}}`
settled a real call at 0 in and 0 out, and a reply with no `output_tokens`
settled its output at nought. That is precisely the nought-over-an-unreadable-
cost the rest of the file exists to refuse, and it contradicted the stated
rule that an unreadable bill keeps its reservation.

**Now:** `input_tokens` and `output_tokens` are **mandatory**, and each must be
a JSON number, whole, and not negative. `cache_creation_input_tokens` and
`cache_read_input_tokens` are **optional** — absent or explicitly `null` reads
as 0, because that is how "no caching on this call" has been spelled — but a
value that is present and unreadable makes the whole block unreadable. Any
failure answers `null`, and `null` means the row stays unsettled at
`reserveFor(model)`.

Strings are malformed too, including `"100"`: the API documents these counters
as integers, so a string means we are not reading the body we think we are.

14 malformed shapes are asserted to answer `null`
(`askBudget.test.mjs`, "a malformed counter makes the whole bill unreadable").
`{input_tokens: 0, output_tokens: 0}` — a genuine nothing — still reads as
`{0,0}`.

## ② Zero settlement: two of the seven were not supported

Codex is right that the errors page describes the seven types without ever
saying "nothing was billed". The repair is not to assert the guarantee; it is
to stop settling where the vendor's own text does not place the refusal before
generation.

**Each type is now paired with the one status the vendor documents it at.** The
errors page says `invalid_request_error` "may also be used for other 4XX status
codes not listed in this section" — so that type at 422 or 499 is the API
declining something this file has never read about. Previously it settled at
nought; now the pair fails and the reservation stands. (This also caught that
`billing_error` is **402**, not a 400.)

What each surviving pair rests on:

| pair | the sentence |
|---|---|
| 413 `request_too_large` | "On the direct Claude API, Cloudflare returns this error before the request reaches the API servers." — explicit |
| 400 `invalid_request_error` | "There was an issue with the format or content of your request" — not accepted, so nothing ran. Also the office's own spend limit: "When usage reaches a spend limit you set, requests return HTTP 400" |
| 401 `authentication_error` | the key is "malformed, revoked, or expired"; usage is metered per organization ("Limits are set at the organization level"), and an unauthenticated call resolves to none |
| 402 `billing_error` | "There's an issue with your billing or payment information" — the account is not in a state to be charged |
| 403 `permission_error` | the key "does not have permission to use the specified resource" — the resource was not used |
| 404 `not_found_error` | "The requested resource was not found" — no model was reached |

**429 no longer settles on the type alone**, and the docs give a reason to
distrust it rather than mere silence: of the three rate limits, "ITPM rate
limits are estimated at the beginning of each request" and RPM is a limit on
requests, but **"OTPM rate limits are evaluated in real time as output tokens
are produced"**. A refusal reachable while output is being produced is a
refusal that may already have been billed.

So a 429 settles at nought only when the body says which limit it was, and the
answer is one of the two decided before generation:

- the spend cap, named in `error.details.error_code` as
  `enforced_spend_limit_reached`, of which the docs say "API usage pauses …
  While usage is paused, API requests return HTTP 429" — paused usage is not
  billed usage;
- a message naming the request or input-token limit (a 429 arrives
  "describing which rate limit was exceeded").

An output-token message, an acceleration-limit wording we have never seen, an
empty message, a `details` object of another shape: **held in full.**

**The price, stated.** Each held 429 costs the day 1,008,000 tokens of
headroom, so ten of them on the loop model close a 10M day. That is the
conservative-refusal trade Codex asked for, in the direction of refusing
rather than silently bypassing. It is also why the workable floor for this
crew is 16–20M, as already written in `askBudget.ts`.

## Sources

- Errors: <https://platform.claude.com/docs/en/api/errors>
- Rate limits: <https://platform.claude.com/docs/en/api/rate-limits>

Fetched 2026-09-12. Cited, not measured: measurement can falsify a vendor
statement and can never establish one.

## Not changed

- The cap stays 10,000,000. Raising it is Kyle's.
- No migration. This is `_shared/askBudget.ts`, `ask/index.ts` comment, tests.
- Still open from round 7: nothing. Both of Codex's items are here; the three
  concurrency probes were run and filed in
  `2026-09-12-ask-concurrency-probes.md`.
