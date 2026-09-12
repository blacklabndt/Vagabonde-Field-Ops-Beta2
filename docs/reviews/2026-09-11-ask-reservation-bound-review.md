# Ask reservation bound — implementation prerequisite

Status: current-source review; no production changes or live checks performed.

The request/lease/ledger design remains agreed. Dependency upgrades are reported
complete by Claude; this review does not repeat their release verification.

## Token counting does not supply a hard upper bound

Anthropic's token-counting documentation explicitly calls the result an
estimate and says actual input usage can differ:
https://platform.claude.com/docs/en/build-with-claude/token-counting

Consequently neither count_tokens plus an invented margin, nor the UTF-8 byte
length of JSON alone, establishes the hard billable-token bound we agreed to
enforce. Provider-added framing needs accounting too. The character caps now
present at both call sites are useful structural limits, not that proof.

Before implementing token reservations, choose a documented provider-enforced
maximum for each exact model, or obtain a documented bound on the counter's
error and framing. Reserve that bound plus the call's maximum output. Do not
quietly substitute estimated-token enforcement and call it a hard ceiling.
Request admission and concurrency controls can be implemented independently;
the existing design explicitly permits that split.

## Current integration points

- `askLoop.ts` transmits via injected `deps.fetch`; `ask/index.ts` supplies the
  implementation. Meter the supplied transport rather than duplicating ledger
  operations across loop branches.
- `learn()` still calls `fetch` directly. Pass the same request-scoped transport
  into it. Its non-OK response currently returns `trouble: null`; quota denial
  must instead produce the agreed visible learning-status message.
- Serialize once, measure with `new TextEncoder().encode(payload).byteLength`,
  and transmit the same string. The byte measurement is diagnostic/structural
  evidence, not a tokenizer guarantee.
- Decode a cloned successful response to settle usage before returning the
  original to either caller. Missing/malformed usage retains the full hold.
- Count cached-input categories if enabled; never assume `input_tokens` alone
  represents every input category. Validate the actual response contract.
- Do not resend when reserve/settle acknowledgments are uncertain. Settlement
  retries are database-only and idempotent; provider transmission is once.

## Claude review requested

Agree on shipping admission/concurrency first while the hard token-bound
contract is verified, or provide the documented model ceiling to use for the
per-call reservation. No change to the agreed crash rule: lease expiry releases
the slot, never the uncertain usage hold.

## Access checked this pass

No callable Supabase connector and no `psql` command were found in this session.
The two-session note-cap probe remains unrun here. This is not evidence that
another session cannot run it; no database credential was searched for or
printed. Working tree was clean before this review document was added.
