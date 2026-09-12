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
//
// IT HAS TO BOUND ALL FOUR NAMES THE LEDGER COUNTS, not just the one called
// `input_tokens`, and it does: `input_tokens`, `cache_creation_input_tokens`
// and `cache_read_input_tokens` are three parts of ONE input total, and the
// context window is the ceiling on that total — a request whose parts sum
// past it is refused with a 400 before anything is billed. So
// `window + max_tokens` is an upper bound on the sum of all four, which is
// the figure `usageTokens` returns and the figure the ledger holds.
//
// The `max_tokens` halves are OURS and are read back out of the two files
// that send them (askBudget.test.mjs), so a raised answer budget cannot
// leave this table quietly two orders too small. The window halves are the
// vendor's documented figures and are cited, not measured: measurement could
// falsify them and can never establish them.
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

// ── the clock ──────────────────────────────────────────────────────────────
//
// Money is not the only thing an answer spends. The second is wall clock, and
// it was being spent against a figure that does not exist here.
//
// THE DEFECT. `ASK_BUDGET_MS` was 100 s and was sized for a 400 s worker.
// This project's Supabase org is on the FREE plan, where an Edge Function is
// retired at 150 s. Reading stopped at 100 s, and then the model's final
// answer — and the learning call after it — had 50 s between them to finish
// inside a limit neither knew about. A question that used its reading time
// and then needed a real answer could be retired mid-sentence and return the
// crew nothing at all, which reads as "Ask just fails on the hard questions".
// Neither paid call carried an AbortSignal either, so a hung provider was
// bounded by the platform and by nothing of ours.
//
// THE SHAPE OF THE FIX. One deadline, computed ONCE at the top of the
// request, and every later question about time asked against that one
// instant. Nothing reads a wall clock of its own and nothing carries a
// budget of its own: two constants that must agree about the same 150 s are
// two constants that will disagree. `ASK_BUDGET_MS` is gone from askLoop.ts
// and the loop is handed `readUntil` instead — the instant reading must stop,
// DERIVED from the deadline by subtracting what is still owed after it.
//
// ABORTING OUR FETCH PROVES NOTHING ABOUT THE PROVIDER. Codex's point, and
// it decides the accounting rather than just the timeout: a call we stopped
// waiting for may have been answered, and billed, after we stopped. So an
// aborted call is settled at NOTHING — its hold is retained in full, exactly
// as an unreadable bill's is. We cut our own wait; we do not cut anyone's
// bill.

// What the platform gives a request. The free plan's figure, deliberately:
// this is the number that must not be exceeded, and a paid plan's 400 s is
// larger, so sizing for 150 s is right on either. If the project moves to
// Pro, raising this is a decision of its own — nobody upgrading a Supabase
// plan will connect it to how long Ask may spend reading.
export const WORKER_WALL_MS = 150_000;
// Kept back from the deadline for everything after the last paid call:
// settling the bill, releasing the lease, writing the notes the learning
// pass decided on, and serialising the answer.
export const CLEANUP_RESERVE_MS = 10_000;
// The most one call of each kind may take on its own. The loop's final answer
// can be long (MAX_TOKENS is 8,000); the learning call is one short round
// with max_tokens 600 and is normally two or three seconds.
export const CALL_TIMEOUT_MS = 45_000;
export const LEARN_TIMEOUT_MS = 20_000;
// Below this the learning call is not made at all: starting one that cannot
// finish spends money for a note nobody gets, and the answer above it is
// already right and already paid for.
export const LEARN_MIN_MS = 6_000;
// Below this no paid call is worth starting. Only reachable if something
// outside our accounting overran — a tool read is the database's time and is
// not bounded by us — and the refusal is words rather than a retirement.
export const MIN_CALL_MS = 3_000;

/** The one instant every later question about time is asked against. */
export function requestDeadline(startedMs: number): number {
  return startedMs + WORKER_WALL_MS - CLEANUP_RESERVE_MS;
}

// When reading has to stop: the deadline less what is still owed after the
// last tool — one final answer and one learning call. Derived, so a change to
// either timeout moves it instead of leaving a stale constant behind.
export function readUntil(deadline: number): number {
  return deadline - CALL_TIMEOUT_MS - LEARN_TIMEOUT_MS;
}

// How long this call may wait: its own ceiling, or whatever is left of the
// request, whichever is less. A figure at or below zero means the deadline has
// already gone.
export function callTimeout(deadline: number, nowMs: number, most: number): number {
  return Math.min(most, deadline - nowMs);
}

/** Is there time to learn from this answer? Asked before the body is built. */
export function timeToLearn(deadline: number, nowMs: number): boolean {
  return deadline - nowMs >= LEARN_MIN_MS;
}

// Both of ours, so both travel. The first says what to do about it; the
// second is a line under an answer that stands.
export const OUT_OF_TIME_WORDS =
  "Ask ran out of time on that one. Ask it again more narrowly — one job, one client, or a shorter period.";

export const LEARN_NO_TIME_WORDS =
  "The answer above stands, but Ask did not add to what it has learned — the question took too long to leave time for it.";
