// A bounded, paced worker pool for bulk sends — "Chase all unsigned" is the
// caller that needed it. That button had 4,292 approval emails to get out and
// sent them strictly one at a time, forever, with nothing to show for the wait
// and nothing to do about a refusal: a rate-limited send simply became one
// more number in a "failed" count, and the office never learned which tickets
// were left unchased.
//
// So: a few sends in flight at once, a floor on how often a new one starts
// (the transport has a per-second ceiling of its own and outrunning it just
// converts sends into 429s), a wait-and-retry for the refusals that mean "come
// back in a moment", and a stop that lets what is already in flight land.
//
// Deliberately pure — no db.js, no config.js, no React. It takes a send
// function and returns what happened, which is what makes the pacing, the
// ceiling and the backoff testable with fake senders and a fake clock instead
// of a live inbox.

// The two conditions worth waiting out rather than giving up on. mail.ts names
// them in the message on purpose ("Resend is rate-limiting…", "Resend is
// unavailable…") and the message is all that survives the trip back through
// the Edge Function, so the message is what we match. The looser phrases below
// catch the same conditions worded by something other than our own translation
// — a gateway in front of the function, say.
const TRANSIENT = /(is rate-limiting|is unavailable|rate limit|too many requests|temporarily unavailable|service unavailable)/i;

export function isTransientSendError(err) {
  return TRANSIENT.test(String((err && err.message) || err || ""));
}

// How long to wait before trying again, when the far end said so. mail.ts puts
// Resend's Retry-After on the error as seconds and also writes it into the
// message, because only the message crosses the function boundary. Returns
// milliseconds, or null when nobody said anything and the caller should fall
// back to its own backoff.
export function retryAfterFromError(err) {
  if (err && typeof err.retryAfter === "number" && err.retryAfter >= 0) return err.retryAfter * 1000;
  const m = /retry after (\d+(?:\.\d+)?) ?s/i.exec(String((err && err.message) || err || ""));
  if (!m) return null;
  const secs = Number(m[1]);
  return Number.isFinite(secs) ? secs * 1000 : null;
}

// Doubling from one second: 1s, 2s, 4s, 8s. `attempt` is the attempt that just
// failed, counting from 1.
export function backoffMs(attempt) {
  return 1000 * 2 ** (attempt - 1);
}

// The longest any single wait is honoured for. Retry-After is the far end's
// number, not ours, and it is free to say 3600: a worker that took that at
// face value would park one ticket for an hour while four thousand others
// waited behind it. A minute is longer than any real rate-limit window and
// short enough that giving up and reporting the ticket unchased is the better
// answer past it.
export const MAX_WAIT_MS = 60000;

// Long waits are slept in slices so Stop can be answered while one is running.
// The check used to come after the sleep, so a Stop pressed one second into a
// Retry-After of a minute was read fifty-nine seconds later — the button said
// "Stopping…" and the pool carried on.
const WAIT_SLICE_MS = 250;

// Runs `send(item)` over `items`.
//
// Options, all with sane defaults so a caller only names what it cares about:
//   concurrency   how many sends may be in flight (default 3)
//   minInterval   ms floor between two starts, across the whole pool
//   retries       how many extra tries a transient failure gets (default 3)
//   isRetryable   which errors those are
//   retryAfterMs  how long that error says to wait, or null
//   backoff       fallback wait, given the failed attempt number
//   onProgress    (finished, total) after every item settles — the "n of N"
//   shouldStop    asked before each start; true means start no more
//   sleep / now   injected for the tests, real timers otherwise
//
// Answers with { sent, failed: [{ item, error }], started, stopped, remaining }.
// It never throws for a failed item: a bulk send's whole point is that one bad
// address doesn't strand the other four thousand.
export async function runSendPool(items, send, opts = {}) {
  const list = Array.from(items || []);
  const concurrency = Math.max(1, opts.concurrency == null ? 3 : opts.concurrency);
  const minInterval = opts.minInterval == null ? 0 : opts.minInterval;
  const retries = opts.retries == null ? 3 : opts.retries;
  const isRetryable = opts.isRetryable || isTransientSendError;
  const retryAfter = opts.retryAfterMs || retryAfterFromError;
  const backoff = opts.backoff || backoffMs;
  const onProgress = opts.onProgress || (() => {});
  const shouldStop = opts.shouldStop || (() => false);
  const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const now = opts.now || (() => Date.now());

  const sent = [];
  const failed = [];
  let next = 0;      // the next item nobody has claimed
  let started = 0;
  let finished = 0;
  let stopped = false;
  // The pacing is one shared clock, not a per-worker one: three workers each
  // waiting their own interval would still start three sends at once.
  let nextSlot = -Infinity;

  const pace = async () => {
    const slot = Math.max(now(), nextSlot);
    nextSlot = slot + minInterval;
    const wait = slot - now();
    if (wait > 0) await sleep(wait);
  };

  // Waits `ms` (capped) in slices, and answers true if Stop was pressed at
  // any point during it — including before the first slice, so a Stop that
  // landed while the send was still in flight costs no wait at all.
  const waitOrStop = async ms => {
    let left = Math.min(ms, MAX_WAIT_MS);
    for (;;) {
      if (shouldStop()) return true;
      if (left <= 0) return false;
      const slice = Math.min(left, WAIT_SLICE_MS);
      await sleep(slice);
      left -= slice;
    }
  };

  const attempt = async item => {
    for (let n = 1; ; n++) {
      try {
        return await send(item);
      } catch (e) {
        if (n > retries || !isRetryable(e)) throw e;
        const told = retryAfter(e);
        // A Stop pressed during a two-second backoff should be a stop, not
        // another try — the sends already in flight are the ones we promised
        // to finish, and this one isn't in flight.
        if (await waitOrStop(told == null ? backoff(n) : told)) throw e;
      }
    }
  };

  const worker = async () => {
    for (;;) {
      if (shouldStop()) { stopped = true; return; }
      const i = next++;
      if (i >= list.length) return;
      started++;
      await pace();
      try {
        await attempt(list[i]);
        sent.push(list[i]);
      } catch (e) {
        failed.push({ item: list[i], error: e });
      }
      finished++;
      onProgress(finished, list.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return { sent, failed, started, stopped, remaining: list.length - started };
}
