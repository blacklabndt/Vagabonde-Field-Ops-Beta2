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
// THAT LEAVES THE CALL IN FLIGHT, and it is CHARGED rather than watched.
// A reservation is a row in `ask_calls`, written before the call goes out,
// and the day's total is `sum(coalesce(settled, reserved))` — so a call in
// flight counts at the provider's documented maximum from before it leaves
// and keeps counting until the provider's own figure replaces it. Crash,
// abort, an unreadable bill, a settlement write that fails: every one of them
// leaves the row unsettled and the maximum held for the rest of the day.
// There is no refund path and no sweeper, deliberately — a write somebody can
// make fail must not be a ceiling they can switch off.
//
// The hold used to live in the isolate, and a worker retired between the
// billed answer and the ledger write lost that spend for good. The first
// repair proposed was to flush it at the next stale lease takeover; Codex
// refused it, rightly: THERE MIGHT NEVER BE ANOTHER REQUEST. A reconciliation
// that waits for traffic is not a ceiling, it is a hope about traffic.
//
// WHAT THIS COSTS, stated rather than discovered later. The reservation is
// `ONE_CALL_MAX`, and calls within a request are sequential, so
//
//     outstanding  ~  (people asking at once + today's lost calls) x 1,008,000
//
// which makes the number the office types a SAFETY ceiling and not a spending
// plan: for this crew a workable floor is 16-20 million against real use of
// well under one. Codex's rule — conservative refusal over silent bypass — is
// what that price buys.
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
// `input_tokens`, and the vendor's own pages are what say it does. Three
// sentences carry the whole claim, and each is quoted rather than recalled:
//
//  1. THE THREE INPUT NAMES ARE ONE TOTAL, AND THE WINDOW BOUNDS IT.
//     "If you use prompt caching, the input count is split across
//     `input_tokens`, `cache_read_input_tokens`, and
//     `cache_creation_input_tokens`, and all three count toward the window."
//     — Context windows
//  2. THE WINDOW IS ENFORCED BEFORE ANYTHING IS BILLED.
//     "If the input alone already exceeds the model's context window, the API
//     returns a 400 `invalid_request_error` ("prompt is too long") on every
//     model." — Context windows, Context window overflow behavior
//  3. OUTPUT CANNOT PASS `max_tokens`, THINKING INCLUDED.
//     "Thinking tokens are a subset of your `max_tokens` parameter, are
//     billed as output tokens, and count toward rate limits." — Context
//     windows, with thinking. Opus 5 thinks adaptively and by default at
//     `high` effort, so this sentence is the only thing keeping an answer's
//     output bounded, and it is the vendor's.
//
// So `window + max_tokens` bounds the sum of all four names — the figure
// `usageTokens` returns and the figure the ledger holds. Note what is NOT a
// hole: on 4.5 models and later, input + max_tokens ABOVE the window is
// accepted rather than refused, but generation then "stops with
// `stop_reason: "model_context_window_exceeded"`", so the sum is bounded
// either way.
//
// `cache_creation.ephemeral_5m_input_tokens` and its 1h twin are deliberately
// NOT counted: "the current `cache_creation_input_tokens` field equals the
// sum of the values in the `cache_creation` object", so adding them would
// double-count a total the ledger already holds.
//
// TWO THINGS WOULD QUIETLY UNMAKE THE BOUND, and both are absent today and
// asserted absent by askBudget.test.mjs:
//   - Server-side COMPACTION, which lets "the conversation continue past the
//     context window limit" — the very sentence that sentence 2 rests on.
//   - Server-side TOOLS, whose spend arrives under `server_tool_use` and is
//     not part of the four names at all. Ask's tools are all our own.
// Both are reached by an `anthropic-beta` header or a server tool type, and
// neither appears in any file Ask calls out of.
//
// The `max_tokens` halves are OURS and are read back out of the two files
// that send them (askBudget.test.mjs), so a raised answer budget cannot
// leave this table quietly two orders too small. The window halves are the
// vendor's documented figures and are cited, not measured: measurement could
// falsify them and can never establish them.
//
// Model IDs here are SNAPSHOTS, not moving pointers — "Every Claude model ID
// is a pinned snapshot, including the dateless IDs used from the 4.6
// generation on" — so the dateless `claude-opus-5` cannot grow a larger
// window under the same name.
export const ONE_CALL_MAX: Readonly<Record<string, number>> = {
  // claude-opus-5: 1M context (the default; no beta header), max output 128K,
  // and askLoop sends max_tokens 16,000 — raised from 8,000 so that the
  // model's reasoning and its sentences, which come out of that one number,
  // both fit. The figure is read back out of askLoop.ts by
  // askBudget.test.mjs, so the two cannot drift.
  "claude-opus-5": 1_000_000 + 16_000,
  // claude-haiku-4-5-20251001: 200K context, max output 64K, and askLearn
  // sends max_tokens 600.
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

// ONE COUNTER THE LEDGER IS WILLING TO BELIEVE: present, a JSON number, a
// whole number, and not negative. Anything else is MALFORMED, and malformed
// answers null for the WHOLE BLOCK rather than nought for the one field.
//
// This is Codex's finding and it was right. The old reading coerced per
// field, so `{"usage":{"input_tokens":null}}` settled a call at 0 in and 0
// out — a nought written over a cost nobody could read, which is the one
// thing every other path in this file refuses to do. A string that merely
// looks like a number is malformed too: the API documents these as integers,
// so a string means we are not reading the body we think we are.
const counter = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;

// What one answered call cost, from the body the provider returned. A reply
// with no usage block, one shaped differently than expected, or one carrying
// a counter that cannot be read answers null and NOT zero: an unreadable bill
// is not a free call, and the caller holds the reservation instead of writing
// a nought over it.
export function usageTokens(body: unknown): { input: number; output: number } | null {
  if (!body || typeof body !== "object") return null;
  const u = (body as { usage?: unknown }).usage;
  if (!u || typeof u !== "object" || Array.isArray(u)) return null;
  const b = u as UsageBlock;
  // MANDATORY, both of them. The Messages response documents `input_tokens`
  // and `output_tokens` on every answer, so a reply missing or mangling
  // either is a reply we cannot price — and an unpriced call keeps its
  // reservation at the model's whole maximum.
  const input = counter(b.input_tokens);
  const output = counter(b.output_tokens);
  if (input === null || output === null) return null;
  // OPTIONAL, because a call that read and wrote no cache need not name
  // them — but a value that IS there and cannot be read makes the total
  // unknown, not smaller. `null` is read as absent rather than as malformed:
  // that is how "no caching on this call" has been spelled before now, and
  // holding a maximum against a good call is its own kind of wrong.
  let cached = 0;
  for (const v of [b.cache_creation_input_tokens, b.cache_read_input_tokens]) {
    if (v === undefined || v === null) continue;
    const n = counter(v);
    if (n === null) return null;
    cached += n;
  }
  return { input: input + cached, output };
}

// What one call reserves, and what it goes on holding when it cannot be
// settled. The model's whole documented maximum, because the arithmetic above
// needs a figure that cannot be exceeded and this is the only kind there is.
// An unknown model name takes the largest known ceiling: a name we could not
// read must never become the cheapest guess.
export function reserveFor(model: string): number {
  const known = ONE_CALL_MAX[model];
  if (typeof known === "number") return known;
  let most = 0;
  for (const m of Object.keys(ONE_CALL_MAX)) most = Math.max(most, ONE_CALL_MAX[m]);
  return most;
}

// THE ONE REFUSAL THE VENDOR STATES IS DECIDED BEFORE THE API SEES IT.
//
// This table had seven entries and now has one, and the reason is Codex's
// and it is right: the errors page describes what each refusal MEANS, and
// "the request was refused" is a different claim from "nothing was billed".
// Only one of them carries the second claim in the vendor's own words:
//
//   413 request_too_large — "On the direct Claude API, Cloudflare returns
//     this error before the request reaches the API servers." Refused before
//     the API had it; there is nothing there to have run or billed.
//
// WHAT CAME OFF, AND WHY EACH WAS ONLY EVER AN INFERENCE. Every one of these
// is a good argument and not one of them is a vendor sentence:
//   400 invalid_request_error — "an issue with the format or content of your
//     request" says the request was not ACCEPTED. It does not say where it
//     was refused, and the same page says this type "may also be used for
//     other 4XX status codes not listed in this section".
//   401 authentication_error — a key "malformed, revoked, or expired"
//     resolves to no organization, and limits "are set at the organization
//     level"; from which we reasoned that an unbillable caller is unbilled.
//     Reasoned, not read.
//   402 billing_error, 403 permission_error, 404 not_found_error — the same
//     shape of argument: an account that cannot be charged, a resource not
//     permitted, a model not found. All plausible, none stated.
//   429 rate_limit_error — see below; it lost its substring path entirely.
//
// An ALLOW-list and never a deny-list, because Anthropic's versioning policy
// says of these objects that "the values within these objects may expand, and
// it is possible that the `type` values will grow over time". A name that
// grows into the API after this file was written arrives AMBIGUOUS and keeps
// its reservation.
//
// THE PRICE, WRITTEN DOWN RATHER THAN MET IN A TRUCK. Every refusal above
// now holds `reserveFor(model)` — 1,008,000 on the loop model. A wrong API
// key answers 401 every time, so ten attempts at a misconfigured deploy close
// a 10,000,000 day on nothing at all, and Ask then stays shut until midnight
// or until an Admin raises the cap. That is the conservative-refusal trade
// taken to its end: the ceiling is a SAFETY limit that fails closed, the
// floor for this crew is the 16-20M named in the design, and `ask_calls`
// keeps `reserved` and `settled` in separate columns precisely so a day
// closed by held refusals can be told apart from a day genuinely spent.
const REFUSED_BEFORE_RUNNING: Readonly<Record<string, number>> = {
  request_too_large: 413
};

// Did this refusal prove that NOTHING was billed?
//
// THE STATUS ALONE CANNOT SAY SO, which is Codex's point and it is right.
// `api.anthropic.com` sits behind Cloudflare — the docs say so themselves of
// 413: "On the direct Claude API, Cloudflare returns this error before the
// request reaches the API servers" — so a 4xx on this socket may have been
// written by a middlebox that never saw the API's answer, and a middlebox
// cannot know whether the call it proxied was run and billed. Worse, the
// errors page says `invalid_request_error` "may also be used for other 4XX
// status codes not listed in this section", so the status is not even a
// reliable index into the type.
//
// So the evidence is THE BODY. The API "always returns errors as JSON, with a
// top-level `error` object that always includes a `type` and `message`" and a
// `request_id` beside it. That envelope is the provider saying, in its own
// words, which decision it took. A Cloudflare page, a truncated body, a
// gateway's HTML, a type we do not recognise: none of them is that statement,
// and each keeps the reservation in full.
//
// AND THE BODY IS NOT ENOUGH EITHER. The envelope proves the API refused it;
// it does not prove where. So the type must also be one the vendor places
// BEFORE its servers — which, after Codex's reading, is the single pair in
// the table above. Everything at 500 and up is ambiguous, and so is 408: a
// timeout is not a refusal.
//
// THE 429 SUBSTRING PATH IS GONE, and it deserved to go on its own evidence
// rather than on caution. Of the three rate limits only two are settled
// before generation — "ITPM rate limits are estimated at the beginning of
// each request", and RPM bounds requests — while "OTPM rate limits are
// evaluated in real time as output tokens are produced". We then tried to
// tell them apart by reading `error.message` for "input token" or "requests
// per minute". That is a guess about prose the vendor never promised to keep
// stable, and Codex's objection is exact: a message MENTIONING input tokens
// is not a message stating the refusal preceded generation — an OTPM refusal
// on a long-input request would name both. The spend-cap `error_code` went
// with it: "API usage pauses" is a sentence about the account's state, not
// about this request's billing, and one structured field does not turn an
// inference into a statement. Every 429 now keeps its reservation.
export function billedNothing(status: number, body: unknown): boolean {
  if (!Number.isFinite(status) || status < 400 || status >= 500 || status === 408) return false;
  let parsed: unknown = body;
  if (typeof body === "string") {
    try { parsed = JSON.parse(body); } catch { return false; }
  }
  if (!parsed || typeof parsed !== "object") return false;
  const envelope = parsed as { type?: unknown; error?: unknown };
  if (envelope.type !== "error") return false;
  const err = envelope.error;
  if (!err || typeof err !== "object") return false;
  const named = (err as { type?: unknown }).type;
  if (typeof named !== "string") return false;
  // The type AND the status it is documented at; see the table's comment.
  // One pair passes this line, and nothing here reads `message`: prose is not
  // evidence about billing.
  return REFUSED_BEFORE_RUNNING[named] === status;
}

// There is deliberately no ceiling arithmetic in here any more. Admission is
// ask_reserve_call's, under a per-day advisory xact lock, because a check on
// this side would be a second opinion about a number two requests can be
// changing at once — which is the read-then-write window the lock exists to
// close. A null or non-positive cap is no ceiling; that reading lives in the
// function, and the migration is read back by askBudget.test.mjs so it cannot
// drift out of the one place it is now written.

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
// can be long (MAX_TOKENS is 16,000, and the reasoning is spent out of the
// same number); the learning call is one short round
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
