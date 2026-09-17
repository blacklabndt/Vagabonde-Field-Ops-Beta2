// A refusal that is only a clock — the function's copy.
//
// The twin of vite-app/src/jwtRetry.js, and the reason there are two: the
// browser's clients and this one both talk to the same PostgREST, and the
// same cached clock refuses both. The server side is the half the overnight
// ticks meet, with nobody signed in to try again.
//
// See the browser's copy for why retrying a PGRST303 cannot send anything
// twice: PostgREST turns the request away while it is still reading claims,
// before a transaction is opened or a row is touched.

// ═══ shared core (twin of vite-app/src/jwtRetry.js) ═══
// Two retries, then the refusal stands. The cache is a tick behind, not
// broken: a quarter second clears it, a second is the outside.
export const FUTURE_JWT_DELAYS_MS = [250, 1000];

// Only the database's own endpoint. Auth, Storage and Edge Functions
// validate elsewhere and a 401 from them means what it says.
export const FUTURE_JWT_PATH = /\/rest\/v1\//;

// 401 AND the code AND the words. PGRST303 alone is the whole family of
// claims failures — an expired token is one of them, and retrying that is
// how a signed-out session turns into three requests instead of one.
export function isFutureJwtRefusal(status: number, bodyText: string | null | undefined): boolean {
  if (status !== 401) return false;
  if (typeof bodyText !== "string" || !bodyText) return false;
  let body: Record<string, unknown> | null;
  try { body = JSON.parse(bodyText); } catch { return false; }
  if (!body || typeof body !== "object") return false;
  return body.code === "PGRST303" && /issued at future/i.test(String(body.message ?? ""));
}

// Waits, unless the caller gives up first. Answers true when it was the
// caller. The listener goes either way — a screen-lifetime signal must not
// collect one of these per request it outlives.
export function waitOrAbort(ms: number, signal: AbortSignal | null | undefined): Promise<boolean> {
  return new Promise(resolve => {
    if (!signal) { setTimeout(() => resolve(false), ms); return; }
    if (signal.aborted) { resolve(true); return; }
    const onAbort = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(false); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
// Wraps a fetch. Re-entering the wrapped one is deliberate: whatever it
// does per attempt — a timeout ceiling, its own listeners — it does again,
// fresh, and cleans up after each attempt before the next one starts.
export function futureJwtRetrying(inner: FetchLike): FetchLike {
  return async function fetchRetryingFutureJwt(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    let res = await inner(input, init);
    // A Request object's body is spent by the first attempt; only a string
    // URL with a plain init can be sent twice.
    if (typeof input !== "string" || !FUTURE_JWT_PATH.test(input)) return res;
    const signal = init && init.signal;
    for (const delay of FUTURE_JWT_DELAYS_MS) {
      if (res.status !== 401) return res;
      // The caller's copy is never touched — it reads its own body.
      let text = "";
      try { text = await res.clone().text(); } catch { return res; }
      if (!isFutureJwtRefusal(res.status, text)) return res;
      if (signal && signal.aborted) return res;
      if (await waitOrAbort(delay, signal)) return res;
      res = await inner(input, init);
    }
    return res;
  };
}
// ═══ end shared core ═══
