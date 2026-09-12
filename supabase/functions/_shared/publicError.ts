// publicError — which words a person is allowed to read back.
//
// Two kinds of failure reach an Edge Function's top-level catch, and they
// are not alike.
//
// The sentences WE write are the answer: "This assessment has no PDF yet —
// render it first", "cc is not a valid email address: bob@", "Email isn't
// set up yet — an Admin can add the Resend API key". Every one of them
// names something the person can go and do. Hiding those would leave a
// technician staring at a button that does nothing.
//
// A message from PostgREST, Postgres, Resend or Anthropic is not the
// answer. It names columns, constraints, functions, policies and accounts,
// and somebody who can make one appear can map the schema an error at a
// time — a Helper's session is enough to reach most of these doors. Round 6
// found seventeen functions handing those straight back to the browser.
//
// The two are told apart by MARKING, not by reading the words. A sentence
// of ours is raised through `refuse`, which flags the error; the catch shows
// a flagged error's own words and replaces everything else with one fixed
// sentence of the caller's choosing. So the default for anything unmarked —
// a supabase-js error, a provider's body, a TypeError from a bad shape,
// anything a later edit adds without thinking about it — is masked.
//
// That is the point of doing it this way round. Allow-by-default (mask what
// looks like a database message) fails open: the cost of an unforeseen
// message, or of a later edit adding a throw, is disclosure. Deny-by-default
// fails closed: the cost of forgetting is silence, which is the failure we
// can afford.
//
// Nothing is lost by masking. `detail` carries the raw words — the ones
// worth keeping and not worth showing, like the database's reason a send
// could not be marked — and `loggedWords` puts them in function_errors,
// where the digest and Home's strip read them.
//
// This module is the ONE definition for every function that can import. The
// import-free modules in the guard list (askSends, scheduledSends, chasePlan
// and the rest) spell the same three lines themselves, because they may hold
// no imports at all; askThread.test.mjs holds those copies to this shape.

type Marked = Error & { plain?: boolean; detail?: string };

/** A refusal written to be READ by the person who asked. */
export function refuse(words: string, detail?: string): Error {
  const e = new Error(words) as Marked;
  e.plain = true;
  if (detail) e.detail = detail;
  return e;
}

/** True only for an error raised through `refuse`. Judges the mark, never the words. */
export function plainRefusal(e: unknown): boolean {
  return (e as Marked | null)?.plain === true;
}

/**
 * What the browser may see: our own sentence, else the caller's fixed one.
 * `detail` is deliberately NOT included — it exists to be logged.
 */
export function publicWords(e: unknown, fallback: string): string {
  return plainRefusal(e) ? (e as Marked).message : fallback;
}

/**
 * What function_errors gets: everything, marked or not. The office reads
 * this log to find out what actually happened, so masking here would only
 * move the blindness rather than remove it.
 */
export function loggedWords(e: unknown): string {
  const err = e as Marked | null;
  const message = err?.message ?? String(e);
  return err?.detail ? `${message} — ${err.detail}` : message;
}
