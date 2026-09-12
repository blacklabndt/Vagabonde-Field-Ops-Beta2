# The per-call ceiling, verified — and the zero-settlement rule, rewritten

Codex, round 7, held the round open on two things:

> verify the maximum for **both models**, including every counted usage
> category … Also substantiate the zero-settlement rule: HTTP status alone
> doesn't prove zero billable usage.

Both are answered below. The first is confirmed, with citations and two
tripwires. The second was **not** substantiable as written, and the rule has
been changed rather than defended.

---

## 1 — `ONE_CALL_MAX`: confirmed

`ONE_CALL_MAX[model] = context window + the max_tokens we send`. The claim is
that this bounds the sum of the four names the ledger counts —
`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`,
`output_tokens`. Three documented sentences carry it:

| # | Claim | Vendor wording |
|---|---|---|
| 1 | The three input names are **one total**, and the window bounds that total | "If you use prompt caching, the input count is split across `input_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens`, and **all three count toward the window**." |
| 2 | The window is enforced **before anything is billed** | "If the input alone already exceeds the model's context window, the API returns a 400 `invalid_request_error` (\"prompt is too long\") **on every model**." |
| 3 | Output cannot pass `max_tokens`, **thinking included** | "Thinking tokens are **a subset of your `max_tokens` parameter**, are billed as output tokens, and count toward rate limits." |

Sentence 3 is the load-bearing one nobody had checked: Opus 5 thinks
adaptively, at `high` effort by default, and thinking is billed as output.
Had thinking sat outside `max_tokens`, the output half of the ceiling would
have been fiction.

### The two figures

| Model | Context window | Max output | We send | `ONE_CALL_MAX` |
|---|---|---|---|---|
| `claude-opus-5` (askLoop) | **1M** — the default, **no beta header needed** | 128K | `max_tokens: 8000` | **1,008,000** |
| `claude-haiku-4-5-20251001` (askLearn) | **200K** | 64K | `max_tokens: 600` | **200,600** |

The stated 1,008,000 stands.

### Three things checked that turned out **not** to be holes

- **`input + max_tokens` above the window is now accepted, not refused.**
  On 4.5 models and later the API takes the request and generation "stops
  with `stop_reason: "model_context_window_exceeded"`". Input is still capped
  at the window by sentence 2 and output at `max_tokens` by sentence 3, so
  the sum is bounded either way.
- **`cache_creation.ephemeral_5m_input_tokens` / `_1h_` are not missed
  categories.** "the current `cache_creation_input_tokens` field equals the
  sum of the values in the `cache_creation` object" — counting them would
  **double**-count.
- **`claude-opus-5` is a pinned snapshot, not a moving alias.** "Every Claude
  model ID is a pinned snapshot, including the dateless IDs used from the 4.6
  generation on." The dateless ID cannot grow a larger window under the same
  name, so the table cannot go stale without a code change.

### Two things that WOULD unmake the bound — now asserted absent

Both are silent, both are one header away, and neither is present today:

1. **Server-side compaction**, which lets "the conversation continue past the
   context window limit" — the exact sentence the input half rests on.
2. **Server-side tools**, whose spend arrives under `server_tool_use`, a name
   the ledger does not read at all. Every tool Ask offers is our own and runs
   in the isolate.

`askBudget.test.mjs` now fails if `anthropic-beta` appears in `askLoop.ts`,
`askLearn.ts`, `askTools.ts` or `ask/index.ts`, or if a server tool type is
named. A future beta header is a decision that has to re-verify this table,
not a line somebody adds on a Tuesday.

---

## 2 — The zero-settlement rule: Codex was right, and it has changed

The old rule was `status >= 400 && status < 500 && status !== 408`. Two
documented facts break it:

- **`api.anthropic.com` sits behind Cloudflare.** The errors page says so
  itself, of 413: "On the direct Claude API, **Cloudflare returns this error
  before the request reaches the API servers**." A 4xx on this socket may
  therefore have been written by a middlebox — and a middlebox cannot know
  whether the call it proxied was run and billed.
- **The status is not even a reliable index into the type.**
  "`invalid_request_error` … **may also be used for other 4XX status codes not
  listed in this section**."

So a status is not a statement by the provider. **The body is.** "The API
always returns errors as JSON, with a top-level `error` object that always
includes a `type` and `message` value", beside a `request_id`.

### The new rule

`billedNothing(status, body)` settles at nought **only** when all of:

1. status is 4xx and not 408;
2. the body parses as the documented envelope — `type: "error"`, an `error`
   object, a string `error.type`;
3. `error.type` is on an **allow-list** of refusals documented as decisions
   about the *request*: `invalid_request_error`, `authentication_error`,
   `billing_error`, `permission_error`, `not_found_error`,
   `request_too_large`, `rate_limit_error`.

An allow-list because the versioning policy says "the values within these
objects may expand, and it is possible that the `type` values will grow over
time" — a name that grows into the API after this file was written must
arrive as **ambiguous**, not as free. `conflict_error` (409) is the live
example of that and is deliberately off the list.

A Cloudflare HTML page, `error code: 1015`, a truncated body, an unknown
type: every one of them now keeps its reservation in full.

### The trade, stated

Settling 429s at nought exists so a burst of rate-limit refusals cannot eat a
day's ceiling with not a token spent. Under the new rule a 429 **from
Anthropic** still settles at nought; a 429 from a middlebox holds
1,008,000 for the day. A storm of those would be denial by another road — but
it fails **closed**, which is the direction Codex named as the trade the whole
design is buying.

---

## What is still not verifiable here

Nothing in this document is a measurement. Sentences 1–3 are the vendor's
statements about its own service, cited because measurement could falsify
them and could never establish them. If the vendor's behaviour ever departs
from its documentation, this ceiling departs with it — and the reason the
ledger settles on the `usage` block rather than on anything we compute is
that the vendor's own figure is the only thing that can catch it.
