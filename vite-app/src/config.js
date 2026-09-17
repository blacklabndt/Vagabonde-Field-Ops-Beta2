import { createClient } from "@supabase/supabase-js";
import { futureJwtRetrying } from "./jwtRetry.js";

// Public project URL + publishable key. Both are meant to be exposed in a
// client app — access control is enforced by Postgres row-level security
// (see the migrations), never by keeping this key secret.
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://eielmvxzdwwprmmfamlq.supabase.co";
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "sb_publishable_iRMrq2AOLFWQvx4UxiCjmw_B_kSw1zg";

// The public half of the Web Push keypair — it's what a browser shows the
// push service when subscribing, and it is meant to be public. Its private
// twin lives only as the VAPID_PRIVATE_KEY Supabase secret.
export const VAPID_PUBLIC_KEY = "BCnt_FGpoYIxJsp4q2YCK6xfKMazrrCYVmfkRDRpLoLIak2c98B9UNlMmNE2CVkj6E-13PNEdYdvgSlYwVtJBeQ";

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

function fetchWithCeiling(input, init = {}) {
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


// The database's clock, not ours.
//
// PostgREST refuses a token whose `iat` is ahead of the clock it serves
// from a cache, with 401 PGRST303 "JWT issued at future" — the first read
// made in the moment after a token is minted (a sign-in, an overnight
// refresh) can meet it, and the same token a quarter second later cannot.
// Nothing here is wrong and nothing here can be set right, so that one
// answer is asked again instead of being passed on as a 401: unhandled, it
// reached the outbox as `lastError: "JWT issued at future"` and parked a
// day's work behind a badge. The retry wraps the ceiling rather than the
// other way round, so every attempt gets its own fresh timeout.
const sbFetch = futureJwtRetrying(fetchWithCeiling, SUPABASE_URL);

// Where supabase-js keeps the signed-in session. It derives this key from the
// project ref on its own; naming it here and handing it back is the only way
// the two cannot drift, and forgetStoredSession below has to be able to reach
// the exact key the client wrote.
export const AUTH_STORAGE_KEY = `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`;

export const sbClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { storageKey: AUTH_STORAGE_KEY },
  global: { fetch: sbFetch }
});

// Signing out is not always a sign-out.
//
// auth-js loads the session before it revokes anything, and loading it with
// an expired access token means refreshing it over the network. On a tablet
// out of range that refresh fails, and the failure is returned as the
// sign-out's error — before the stored session has been removed. So the
// person is shown the sign-in screen, the session is still on disk, and the
// next reload in signal refreshes it and signs them straight back in with no
// password. On a shared tablet that is the whole problem this app's sign-out
// exists to solve, so wherever signOut answers with an error, the stored
// session is removed here instead.
export function forgetStoredSession() {
  try { window.localStorage.removeItem(AUTH_STORAGE_KEY); }
  catch (e) { console.error("Couldn't remove the stored session:", e); }
}
