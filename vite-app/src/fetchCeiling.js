// The request ceiling lives in its own file so the tests can drive the real
// thing: config.js cannot be imported by node (it builds the Supabase client
// and reads import.meta.env), and the retry wrapping this is only worth
// anything if the two compose the way they are wired below.
// Every request gets a ceiling.
//
// Without one, a request made after the access token has expired can hang
// indefinitely with no signal: supabase-js tries to refresh the token first
// and retries that refresh against a network that isn't answering. The call
// never settles, so the screen waiting on it never resolves either — which is
// how "Creating…" or "Loading rates…" turns into a permanent state rather
// than a failure the offline queue could catch.
//
// 30 seconds is generous for a database or auth call. It is not for a file:
// supabase-js routes Storage and Edge Function traffic through this same
// fetch, and a 15 MB interpreted report on one bar of LTE needs minutes, not
// thirty seconds — cut off, it read as "no connection", went to the offline
// queue, and the queue's retry cut it off again, forever, with four bars
// showing. So uploads run unbounded and function calls get minutes; the
// token refresh that precedes them still goes to /auth/v1 and is still
// bounded, which is the hang this ceiling exists for. Genuinely offline,
// fetch rejects immediately anyway.
const REQUEST_TIMEOUT_MS = 30000;
const UNBOUNDED = /\/storage\/v1\//;
// Edge Functions render PDFs and send mail: minutes at the outside, never
// forever. They used to share Storage's exemption, and a function call that
// never settled — a radio attached to nothing — left the outbox flush
// pending for the life of the tab, so nothing queued ever synced again and
// (the toasts are muted for the flush) nothing was ever confirmed again.
const FUNCTIONS = /\/functions\/v1\//;
const FUNCTION_TIMEOUT_MS = 5 * 60 * 1000;

export function fetchWithCeiling(input, init = {}) {
  const url = typeof input === "string" ? input : (input && input.url) || "";
  if (UNBOUNDED.test(url)) return fetch(input, init);

  const controller = new AbortController();
  const ceiling = FUNCTIONS.test(url) ? FUNCTION_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), ceiling);

  // Respect a caller's own signal as well as ours — and let go of it when the
  // request settles. `{ once: true }` removes the listener when it FIRES, not
  // when the fetch finishes, so a caller that reuses one long-lived controller
  // (a screen-lifetime signal over a session's worth of reads) accumulated a
  // listener per request on a signal that never aborts, and every one of them
  // held that request's controller.
  const relay = () => controller.abort();
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener("abort", relay, { once: true });
  }

  return fetch(input, { ...init, signal: controller.signal })
    .catch(err => {
      // Reported as a network failure, not an abort, so the offline queue and
      // the read cache recognise it as "no connection" and do their job.
      if (err && err.name === "AbortError") throw new TypeError("Failed to fetch — the request timed out.");
      throw err;
    })
    .finally(() => {
      clearTimeout(timer);
      if (init.signal) init.signal.removeEventListener("abort", relay);
    });
}
