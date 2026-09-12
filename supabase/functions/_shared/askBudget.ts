// What the assistant may spend, and how the spending is counted.
//
// Ask pays for two model calls per answer — the loop's and the learning
// pass's — and the character caps beside this file bound what ONE call
// carries. They do not bound how many calls a day holds. This does.
//
// WHY THE COUNT IS THE PROVIDER'S AND NEVER OURS. Anthropic documents its
// token counter as an ESTIMATE, and there is no published tokenizer for the
// models Ask uses, so nothing we could compute before a call is a bound on
// what the call is billed. What IS exact is the `usage` block the provider
// returns with every answer. So the ceiling is enforced on what has been
// SETTLED — figures the provider itself reported — and never on a guess.
//
// THAT LEAVES THE CALL IN FLIGHT, and it is bounded rather than estimated:
//
//     worst case  =  cap  +  (requests in flight) x ONE_CALL_MAX
//
// The check is made before every paid call, so the only spending that can
// cross the line is a call already going when it was crossed. `ONE_CALL_MAX`
// below is per model and is provider-ENFORCED, not counted by us: the context
// window (a larger input is refused with a 400) plus the `max_tokens` we send
// ourselves. It is loose — the character caps put the real figure two orders
// under it — but it is finite, documented, and rests on nothing Anthropic
// calls an estimate. The per-person lease is what keeps the first factor
// small; without it one account could hold any number of calls open across
// the line at once.
//
// Tokens and not dollars, deliberately. Input and output price differently
// and the rate differs per model, so a price table in here would be a second
// source of truth that rots in silence — an upstream price change would leave
// the ceiling wrong in the unsafe direction with nothing failing. The office
// converts once, when it sets the number.

// A request holds its lease for at most this long; after it, the request is
// taken to have died mid-answer and the next question takes the lease over.
// Comfortably longer than a whole answer (the loop stops at 100 s and the
// learning call is one short round after it), so a lease this old is a dead
// isolate and not a slow one.
export const LEASE_STALE_SECONDS = 300;

// The provider's own ceiling on ONE call, per model: `input` is the context
// window, which the API enforces by refusing a larger request, and `output`
// is the `max_tokens` this app sends. Not a measurement and not a target —
// the arithmetic above needs a number that cannot be exceeded, and this is
// the only kind there is.
export const ONE_CALL_MAX: Readonly<Record<string, number>> = {
  // claude-opus-5: 1,000,000 context, and askLoop sends max_tokens 8,000.
  "claude-opus-5": 1_000_000 + 8_000,
  // claude-haiku-4-5: 200,000 context, and askLearn sends max_tokens 600.
  "claude-haiku-4-5-20251001": 200_000 + 600
};

// The overshoot the design admits to, in tokens, given how many requests may
// be in flight at once. Spelled out so a reviewer can check the claim rather
// than take it, and so a change to either model or either max_tokens moves
// the number instead of quietly invalidating the sentence above.
export function worstOvershoot(inFlight: number): number {
  let one = 0;
  for (const model of Object.keys(ONE_CALL_MAX)) one = Math.max(one, ONE_CALL_MAX[model]);
  return Math.max(0, Math.floor(inFlight)) * one;
}

// The provider's usage block, read whole. `input_tokens` ALONE is not the
// input: a cached prefix is billed under its own two names, and reading only
// the first would undercount every call the day prompt caching is turned on —
// silently, and in the direction that spends more than the ceiling allows.
interface UsageBlock {
  input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  output_tokens?: unknown;
}

const whole = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

// What one answered call cost, from the body the provider returned. A reply
// with no usage block, or one shaped differently than expected, answers null
// and NOT zero: an unreadable bill is not a free call, and the caller holds
// the estimate instead of writing a nought over it.
export function usageTokens(body: unknown): { input: number; output: number } | null {
  if (!body || typeof body !== "object") return null;
  const u = (body as { usage?: unknown }).usage;
  if (!u || typeof u !== "object") return null;
  const b = u as UsageBlock;
  const named = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"];
  let any = false;
  for (const k of named) if (k in b) any = true;
  if (!any) return null;
  const input = whole(b.input_tokens) + whole(b.cache_creation_input_tokens) + whole(b.cache_read_input_tokens);
  return { input, output: whole(b.output_tokens) };
}

// A call that could not be settled still has to be carried, or a ledger write
// that fails becomes the way to spend past the ceiling. When the provider's
// figure cannot be read or cannot be written down, the request holds this
// much against itself for the rest of its own life — the model's whole
// documented maximum, because that is the only number that cannot be an
// undercount.
export function unsettledHold(model: string): number {
  const known = ONE_CALL_MAX[model];
  if (typeof known === "number") return known;
  let most = 0;
  for (const m of Object.keys(ONE_CALL_MAX)) most = Math.max(most, ONE_CALL_MAX[m]);
  return most;
}

// May this call be made? `settled` is the day's total as the database last
// answered it; `held` is what this request has spent or been unable to settle
// since. A null or non-positive cap is no ceiling, which is what a project
// that has not set one gets — and is what applying the migration alone
// leaves, so nothing changes until the office chooses a number.
export function mayCall(settled: number, held: number, cap: number | null | undefined): boolean {
  if (cap === null || cap === undefined) return true;
  const c = Number(cap);
  if (!Number.isFinite(c) || c <= 0) return true;
  return whole(settled) + whole(held) < c;
}

// ── the words ──────────────────────────────────────────────────────────────
//
// Both are ours and both say what to do, so both travel: a person told "there
// was a problem" asks the same question again, which is the one thing neither
// of these wants.

export const BUSY_WORDS =
  "Ask is still working on your last question. Wait for that answer, then ask this one.";

export const SPENT_WORDS =
  "Ask has used up what it is allowed to spend today. It will work again tomorrow morning; an Admin can raise the daily limit on the Admin screen.";

// The learning pass is best effort and never fails an answer, so its refusals
// are a line under the answer rather than an error in place of it.
export const LEARN_SPENT_WORDS =
  "The answer above stands, but Ask did not add to what it has learned — it has used up what it is allowed to spend today.";

export const LEARN_TROUBLE_WORDS =
  "The answer above stands, but Ask could not add to what it has learned this time.";
