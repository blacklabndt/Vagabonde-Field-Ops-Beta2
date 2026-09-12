// The connection's own doors, with the network and the database taken out.
//
// backup-oauth answers a browser the provider redirected, and that browser
// carries no token at all. What stands in for one is a nonce this app minted
// minutes earlier and spends the instant it reads it. The checks that door
// is made of are here rather than in the function, because they are pure and
// because getting one of them subtly wrong is how an OAuth callback becomes
// a way in: a mismatched state accepted, a stale nonce honoured, an empty
// string comparing equal to an empty string.
//
// Erasable TypeScript, no imports, nothing read from the environment —
// vite-app/src/backupShared.test.mjs imports this file straight and node
// strips the types.

import { secretsMatch } from "./constantTime.ts";

export const NONCE_MS = 10 * 60 * 1000;

// The same three as drive.ts's PROVIDERS and the panel's BACKUP_PROVIDERS,
// written out a third time because this file imports nothing. Exported so
// backupShared.test.mjs can hold the three copies against each other: a
// provider added to one list and not the others is a Connect button whose
// callback answers 404.
export const PROVIDERS: string[] = ["google", "microsoft", "dropbox"];

// ".../backup-oauth/google" — the last segment, and only when it names a
// provider we know. The function's own name is not one, so a bare POST to
// /backup-oauth is not mistaken for a callback.
export function providerInPath(pathname: string): string {
  const parts = String(pathname || "").split("/").filter(Boolean);
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  return PROVIDERS.includes(last) ? last : "";
}

// Where the provider sends the browser back to. It has to be identical in
// the consent URL, in the token exchange, and in what was typed into the
// provider's app registration — so it is derived once, here, from the app's
// own public address, and the panel derives its display copy the same way.
export function callbackUri(configuredBaseUrl: string, provider: string): { uri: string; base: string } {
  const configured = String(configuredBaseUrl ?? "").trim();
  let base = "";
  if (configured) {
    try { base = new URL(configured).origin; } catch { base = ""; }
  }
  if (!base || base === "null") {
    throw refuse(
      "The App address isn't set on the Admin screen. Fill it in first — the drive has to be told where to send you back to."
    );
  }
  return { uri: `${base}/backup/oauth/${provider}`, base };
}

// The provider's own app registration, as the Admin typed it in. Both halves
// or neither: a client ID with no secret gets as far as the consent screen
// and then fails at the exchange, which is a long way to walk for a message
// that could have been given here.
// A refusal written to be READ by whoever asked. A function's top-level catch
// shows a `plain` error's own words and replaces anything else with one fixed
// sentence, so an unmarked throw — a provider's body, a database message —
// cannot carry an account or a schema out to the browser. Defined here rather
// than imported because this file holds no imports of its own.
function refuse(words: string): Error {
  const e = new Error(words);
  (e as Error & { plain?: boolean }).plain = true;
  return e;
}

export function credentialsFrom(
  row: Record<string, string | null | undefined>, provider: string
): { id: string; secret: string } {
  const r = row ?? {};
  const id = String(r[`backup_client_id_${provider}`] ?? "").trim();
  const secret = String(r[`backup_client_secret_${provider}`] ?? "").trim();
  if (!id || !secret) {
    const missing = !id && !secret ? "client ID and client secret"
      : !id ? "client ID" : "client secret";
    throw refuse(
      `The ${provider} app registration is incomplete — its ${missing} has to be filled in on the Admin screen before you can connect.`
    );
  }
  return { id, secret };
}

// What the Admin is shown when the drive itself turned the connection away.
//
// drive.ts's ok() throws "<what> failed (<status>): <up to 400 characters of
// the provider's own response body>". That body is a JSON error blob at best
// and it has no business travelling in a redirect's query string, where a
// person reads it out of the address bar and a browser keeps it in history —
// so a message of that shape is answered with a sentence written here, which
// names the step and the status because that is the part anybody can act on.
// The raw message still goes to function_errors, which is where the
// provider's own words belong. Anything not of that shape is already this
// app's own writing (an incomplete registration, a missing refresh token, a
// refused nonce) and is passed through untouched.
export function providerRefusal(message: string): string {
  const said = String(message ?? "");
  const m = /^(.+?) failed \((\d{3})\):/.exec(said);
  if (!m) return said;
  const step = m[1];
  const status = Number(m[2]);
  // Only the token exchange answers to the client ID and secret. A 401 or
  // 403 on the step after it — the account, the folder — comes from a
  // drive that took the sign-in and then refused the API call, which for
  // Google is the Drive API not being enabled in the Cloud project (its
  // body says so in as many words, and the first connection met exactly
  // that): the credentials are fine and re-checking them helps nobody.
  const registration = /token exchange/i.test(step);
  if ((status === 401 || status === 403) && registration) {
    return `The drive refused the connection (${step}, ${status}). Check that provider's client ID and client secret on the Admin screen, then press Connect again.`;
  }
  if (status === 401 || status === 403) {
    const apiOff = /has not been used in project|is disabled/i.test(said);
    if (apiOff) {
      return `Google signed you in but its Drive API is not enabled in your Cloud project (${step}, ${status}). Enable "Google Drive API" in the Google Cloud console for the project the registration lives in, wait a minute, then press Connect again.`;
    }
    return `The drive signed you in but refused the next call (${step}, ${status}). The provider's own words are in the app's error log on the Admin screen — usually an API that is not enabled for the registration, or a permission the registration does not grant.`;
  }
  if (status === 429 || status >= 500) {
    return `The drive was too busy to finish the connection (${step}, ${status}). Press Connect again in a minute.`;
  }
  return `The drive refused the connection (${step}, ${status}). The provider's own words are in the app's error log.`;
}

// "" when the callback may proceed; otherwise the sentence the Admin sees.
// An absent expected value refuses, so a callback arriving out of nowhere —
// or a second one after the first spent the nonce — gets nothing.
export function nonceRefusal(
  expected: string | null | undefined, presented: string | null | undefined,
  mintedAtMs: number, nowMs: number
): string {
  const want = String(expected ?? "");
  const got = String(presented ?? "");
  // Constant time, never `===`: the nonce is the callback's whole
  // credential for its ten minutes, and a compare that stops at the first
  // byte that differs times out how much of it the caller has right.
  if (!secretsMatch(got, want)) {
    return "That connection link wasn't the one this app started. Press Connect again.";
  }
  if (!Number.isFinite(mintedAtMs) || !mintedAtMs || nowMs - mintedAtMs > NONCE_MS) {
    return "That connection took more than ten minutes. Press Connect again.";
  }
  return "";
}
