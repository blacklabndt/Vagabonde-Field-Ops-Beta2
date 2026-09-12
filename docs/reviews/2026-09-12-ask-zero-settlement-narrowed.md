# Zero settlement, narrowed to the one sentence that carries it

2026-09-12 · round 7 · `ask` only · no migration

Codex's last objection, in his words: the errors page "explicitly places 413
before API processing, but doesn't provide that assurance for every retained
case", and the 429 substring checks "accept messages merely mentioning 'input
token' or 'request rate'".

Both stand. The allow-list is now one entry.

## What settles at nothing

| status | type | the vendor's sentence |
|---|---|---|
| 413 | `request_too_large` | "On the direct Claude API, Cloudflare returns this error before the request reaches the API servers." |

Refused before the API had it, so there was nothing there to run or to bill.
It is the only refusal on the page that says **where** it was decided.

## What came off, and what each was

Every one of these was a good argument and not one was a vendor sentence.

- **400 `invalid_request_error`** — "an issue with the format or content of
  your request" says the request was not *accepted*. It does not say where it
  was refused, and the same page says this type "may also be used for other
  4XX status codes not listed in this section".
- **401 `authentication_error`** — a key "malformed, revoked, or expired"
  resolves to no organization, and limits "are set at the organization
  level". From which we reasoned that an unbillable caller is unbilled.
  Reasoned, not read.
- **402 `billing_error`, 403 `permission_error`, 404 `not_found_error`** —
  the same shape: an account that cannot be charged, a resource not
  permitted, a model not found. Plausible; unstated.
- **429 `rate_limit_error`, message path** — this one came off on evidence
  rather than caution. Only two of the three limits precede generation
  ("ITPM rate limits are estimated at the beginning of each request"; RPM
  bounds requests), while "OTPM rate limits are evaluated in real time as
  output tokens are produced". We told them apart by reading `error.message`
  for "input token" or "requests per minute" — a guess about prose the vendor
  never promised to keep stable. Codex's objection is exact: a message
  *mentioning* input tokens does not state that the refusal preceded
  generation. A long-input request refused on OTPM would name both.
- **429 spend cap (`error_code = enforced_spend_limit_reached`)** — went with
  it. "API usage pauses … While usage is paused, API requests return HTTP
  429" is a sentence about the *account's* state, not about this request's
  billing. One structured field does not turn an inference into a statement.

`billedNothing` no longer reads `message`, `details`, or any substring. A
test asserts that: prose is not evidence about billing, so there is nothing
left to key on.

## The price, written down

Every refusal above now holds `reserveFor(model)` — 1,008,000 on the loop
model. A wrong API key answers 401 every time, so **ten attempts at a
misconfigured deploy close a 10,000,000 day on nothing at all**, and Ask
stays shut until midnight or until an Admin raises the cap.

That is conservative refusal taken to its end, and it is the direction Codex
named at every step. Three things make it survivable:

1. the ceiling is a **safety** limit, not a spending plan;
2. the floor for this crew is the 16–20M named in the design doc;
3. `ask_calls` keeps `reserved` and `settled` in separate columns, so a day
   closed by held refusals can be told apart from a day genuinely spent.

## Tests

Three rewritten, `855` total (unchanged count; the old three were replaced).

- 413 with the documented envelope settles at nought; 413 with Cloudflare
  HTML, `error code: 1015`, a truncated body, or an unknown type does not.
- Each of the six formerly-accepted pairs now asserts `false`.
- **Ambiguous rate-limit wording**, the case Codex asked for by name: four
  messages that mention "input token" / "request rate" while saying nothing
  about when the refusal was decided — including one that names both input
  and output limits, and one refused "after output had begun" — all hold.

## Gate

Biome 201 files · typecheck 21 functions (deno@2.9.6) · 855 tests · build +
PWA. Cap unchanged at 10,000,000. No migration. `CLAUDE.md` untouched.
