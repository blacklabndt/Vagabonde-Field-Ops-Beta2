// Restoring who is signed in, without letting the network decide whether the
// app opens.
//
// This used to be a straight line: ask Supabase for the session, then read the
// profile, then render. On a device with no signal that line has three ways to
// end badly, and all three were live:
//
//   1. `getSession()` refreshes an expired access token over the network, with
//      its own retries. Nothing bounded it, so with the radio off the promise
//      could simply never settle and the app sat on "Loading…" forever.
//   2. supabase-js does not throw on a failed request — it returns
//      `{ data: null, error }`. So a network failure looked exactly like "this
//      account has no profile", which is the one case the code responded to by
//      signing the user out. Going out of range logged people out.
//   3. That sign-out is itself a network call, which could hang in turn.
//
// So: every step is bounded, a network failure is never read as an answer, and
// the last known identity is kept on the device so a crew that opens the app on
// a lease is signed in rather than staring at a login form they cannot use.
//
// Pure and dependency-injected on purpose — it is the one piece of this app
// whose failure modes only show up when the network is gone, which makes it
// the piece most worth being able to test without one.

import { tabList } from "./data.js";

export const IDENTITY_KEY = "session.identity";

const TIMED_OUT = Symbol("timed-out");

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Shapes a profile row + auth user into what the app carries around as
// `currentUser`, or null if the account has no access at all.
export function identityFrom(profile, email) {
  const tabs = tabList(profile && profile.tab_access);
  if (!profile || !tabs.length) return null;
  return {
    id: profile.id, name: profile.name, email,
    role: profile.role, cert: profile.cert, tabs
  };
}

export async function restoreSession({
  getSession,
  fetchProfile,
  signOut,
  readIdentity,
  writeIdentity,
  isNetworkError,
  isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false,
  timeoutMs = 4000
}) {
  // "Nobody is remembered here" and "this device's memory could not be read"
  // wore the same face: a rejected IndexedDB read (a transaction aborted
  // under storage pressure, a store being upgraded in another tab) came back
  // as a plain null, indistinguishable from an expired identity. That is the
  // answer the boot reads to decide whether anybody still owns what is
  // stored, and a moment's IDB fault is no evidence that nobody does — so the
  // failure is reported as itself and the caller can refuse to act on it.
  //
  // A remembered identity is also only this session's to restore. Where there
  // IS a session — the profile read failed, not the sign-in — the stored
  // identity must be that same account, or it is the last person's and
  // belongs to nobody here: show sign-in rather than hand it over.
  const cached = async (reason, expectId = null) => {
    let identity = null;
    let identityUnreadable = false;
    try { identity = await Promise.resolve(readIdentity()); }
    catch { identityUnreadable = true; }
    if (identity && expectId && identity.id !== expectId) identity = null;
    if (identity) return { user: identity, offline: true, reason };
    return { user: null, offline: true, reason, identityUnreadable };
  };

  let sessionResult;
  try {
    sessionResult = await withTimeout(Promise.resolve(getSession()), timeoutMs);
  } catch {
    return cached("session-error");
  }
  if (sessionResult === TIMED_OUT) return cached("session-timeout");

  const session = sessionResult && sessionResult.data ? sessionResult.data.session : null;
  if (!session) {
    // No session is two very different situations wearing the same face.
    //
    // Signed out on purpose: the stored session is gone because the user
    // ended it. Show sign-in — and there is nothing cached to restore from,
    // because signing out clears this device's cache.
    //
    // Out of range: the access token had expired, supabase-js tried to
    // refresh it, the refresh failed on the network, and it reports that as
    // a perfectly ordinary "no session". This is the common one — any
    // session older than an hour comes back this way — and answering it with
    // a login form is the worst possible response, because signing in needs
    // the network too. Restore from what this device remembers instead.
    const sessionError = sessionResult && sessionResult.error;
    if ((sessionError && isNetworkError(sessionError)) || isOffline()) {
      return cached("no-session-offline");
    }
    return { user: null };
  }

  let profileResult;
  try {
    profileResult = await withTimeout(Promise.resolve(fetchProfile(session.user.id)), timeoutMs);
  } catch {
    return cached("profile-error", session.user.id);
  }
  if (profileResult === TIMED_OUT) return cached("profile-timeout", session.user.id);

  // The critical distinction: a request that failed is not the server saying
  // this account has no profile — and "failed" is ANY error, not only a
  // network one. isNetworkError is a message match plus navigator.onLine, so a
  // gateway 502, a PostgREST 5xx or an RLS blip on a device with perfect
  // signal fell straight through to the sign-out below, which App.jsx answers
  // by clearing the whole device cache: every half-entered ticket and
  // assessment on the tablet, gone because Supabase hiccupped at launch. The
  // sign-in path already knew this — components/auth.jsx keeps the session on
  // any error but a missing row — and boot did not; the two must agree.
  //
  // Revocation is untouched, because it is not an error: a locked or
  // tab-stripped account still reads its OWN profiles row (profiles_select,
  // migration 20260908063429) and comes back as data with no error, so it
  // still reaches identityFrom, still answers null, and is still signed out.
  if (profileResult && profileResult.error) {
    return cached("profile-unreadable", session.user.id);
  }

  const identity = identityFrom(profileResult && profileResult.data, session.user.email);
  if (identity) {
    await Promise.resolve(writeIdentity(identity)).catch(() => {});
    return { user: identity };
  }

  // The server answered, and this account really has nothing behind it.
  await Promise.resolve(signOut()).catch(() => {});
  return { user: null, signedOut: true };
}
