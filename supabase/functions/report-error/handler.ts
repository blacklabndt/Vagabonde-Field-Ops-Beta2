// report-error, without a network or a database in it.
//
// The endpoint's whole judgement lives here so it can be RUN by a test
// rather than read by one: who the report belongs to, whether the body is
// small enough to look at, what the four fields must be, and what happens
// when the insert collides or fails. index.ts supplies a Supabase client
// for each of those; nothing in this file knows what one is.
//
// The order of the checks is itself a rule. The account is settled before a
// single byte of the body is read, so an unauthenticated flood costs this
// function one getUser call and no memory at all.

import { validateCrashReport, minuteBucket, MAX_BODY_BYTES } from "../_shared/crashReport.ts";

/** The name the office's error log files a browser crash under. */
export const LOG_FUNCTION_NAME = "browser";

type DbError = { code?: string; message?: string } | null;

/** Everything this handler cannot do for itself, handed in by index.ts. */
export type CrashDeps = {
  /** The account behind the Authorization header, or null. Verified, never parsed here. */
  getUser: (authHeader: string) => Promise<{ id: string } | null>;
  /**
   * file_browser_crash: the ledger row and the office's copy, in ONE database
   * transaction. Returns the function's own word for what happened —
   * "filed" or "rate_limited" — or the database's error. Anything that is
   * not the ledger key's own collision rolls the whole call back and comes
   * back here as an error — never as the rate limit.
   *
   * Two PostgREST inserts could not be wrapped in a transaction, which let
   * the office's copy be the half that went missing while the rate limit
   * refused every retry for the rest of the minute.
   */
  fileCrash: (args: Record<string, unknown>) => Promise<{ outcome: string | null; error: DbError }>;
  /** Insert into function_errors. Used for ONE thing: this endpoint's own failure. */
  insertLog: (row: Record<string, unknown>) => Promise<DbError>;
  /** The server's clock. The minute bucket comes from here and never from the body. */
  now: () => Date;
};

/** The little the handler needs of a Request, so a test can be the rest. */
export type CrashRequest = {
  method: string;
  headers: { get: (name: string) => string | null };
  body: ReadableStream<Uint8Array> | null;
};

/**
 * The body, up to a ceiling — and nothing past it ever held in memory.
 *
 * arrayBuffer() would buffer whatever was sent and THEN let us measure it,
 * which makes the ceiling a report rather than a limit. This counts as the
 * chunks arrive, and the moment the total goes over it cancels the stream:
 * the sender is refused mid-upload and this process is holding 512 bytes.
 *
 * Returns null for "over the ceiling" — the one refusal that happens before
 * anything is parsed.
 */
export async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  max: number
): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        // Stop the upload rather than drain it. cancel() may reject on a
        // connection already gone, which is not this function's problem.
        try { await reader.cancel(); } catch { /* already closed */ }
        return null;
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* cancelled above */ }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}

/** The same sentence the office's log will show, built only from allowlisted slugs. */
export function logMessage(report: { component_id: string; route_id: string; error_category: string }): string {
  return `ErrorBoundary (${report.component_id}) on ${report.route_id}: ${report.error_category}`;
}

export type CrashResult = { status: number; body: Record<string, unknown> };

/** The database function's two answers. Anything else is treated as a failure. */
export const FILED = "filed";
export const RATE_LIMITED = "rate_limited";

/**
 * One crash report, start to finish.
 *
 * A collision on the primary key is the rate limit: the caller is told ok
 * and nothing is written — including no row in the office's log, or a
 * crash-looping phone would fill the log it was meant to inform.
 *
 * Filed and visible are the same event. Both rows land inside one database
 * transaction, so there is no outcome where the crash is on the ledger —
 * holding the minute's rate limit — and absent from the screen the office
 * reads. If the pair cannot be written, the caller is told so and the minute
 * is still free for the next report.
 */
export async function handleReport(req: CrashRequest, deps: CrashDeps): Promise<CrashResult> {
  const user = await deps.getUser(req.headers.get("Authorization") ?? "");
  if (!user) return { status: 401, body: { error: "Not signed in" } };

  const raw = await readBounded(req.body, MAX_BODY_BYTES);
  if (raw === null) return { status: 413, body: { error: "Report too large." } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { status: 400, body: { error: "Not a report." } };
  }

  const checked = validateCrashReport(parsed);
  if ("error" in checked) return { status: 400, body: { error: checked.error } };

  const report = checked.report;
  const { outcome, error } = await deps.fileCrash({
    ...report,
    user_id: user.id,
    minute_bucket: minuteBucket(deps.now())
  });

  // The collision comes back as a word and never as an error: the ledger
  // insert carries ON CONFLICT on its own key, so the only uniqueness
  // failure that can still reach here is some OTHER constraint — and that is
  // a failure, not a report quietly called filed with the minute spent.
  if (outcome === RATE_LIMITED) {
    return { status: 200, body: { ok: true, rateLimited: true } };
  }

  if (error || outcome !== FILED) {
    // The office reads function_errors; a reporting endpoint that failed
    // quietly would be the same blindness one layer further in.
    try {
      await deps.insertLog({
        function_name: "report-error",
        message: error?.message ?? `file_browser_crash returned ${JSON.stringify(outcome)}`,
        context: { code: error?.code ?? null }
      });
    } catch { /* logging is best effort */ }
    return { status: 400, body: { error: "The report could not be filed." } };
  }

  // Both rows are in. The office's copy went in beside the ledger row, in
  // the same transaction, under LOG_FUNCTION_NAME with logMessage()'s
  // sentence — built there out of columns the check constraints have already
  // vetted, so nothing free-text can reach function_errors down this path.
  return { status: 200, body: { ok: true } };
}
