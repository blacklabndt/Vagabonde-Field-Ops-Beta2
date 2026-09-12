// crashReport — what a browser is allowed to say when a screen crashes.
//
// The office already sees every Edge Function failure: all 21 of them log to
// public.function_errors. The browser was the blind half — ErrorBoundary
// wrote console.error and nothing else, so a screen that broke on a truck in
// the field broke silently.
//
// The obvious fix is to post the error's message and component stack. This
// module exists because that fix is wrong here. Approval tokens and OAuth
// codes travel in URLs, job numbers and client names sit in props, and any
// of the three can end up inside a React error message or a stack frame. No
// amount of regex scrubbing can promise they are gone: an allowlist of
// patterns to REMOVE fails open, and the thing it fails open with is a live
// approval token in a database row.
//
// So nothing free-text crosses the wire. A report is four values, and every
// one of them is picked from a fixed list or matched against a tight charset
// before it is stored:
//
//   error_category  one of CATEGORIES — derived from the error in the
//                   browser, which reads the message and then throws it away
//   route_id        one of ROUTE_IDS — the screen's tab key, never location
//   component_id    one of COMPONENT_IDS — which boundary caught it
//   app_version     the build stamp, charset- and length-bounded
//
// The honest cost, named rather than hidden: a report says a boundary
// tripped on this route in this build, not why. That is the price of not
// shipping job data off-box, and the office can still ask the person.
//
// Erasable TypeScript, no imports: node --test reads this file directly, so
// an enum, a constructor parameter property or a Deno.env would break the
// suite. The block below is a twin of vite-app/src/crashReport.js, and
// ROUTE_IDS is a third copy of TABS in data.js and of the check constraint
// on browser_crashes; crashReport.test.mjs reads all of them and fails on
// drift.

// ═══ shared core (twin: vite-app/src/crashReport.js) ═══

/** Every category a crash may be filed under. Fixed: the browser picks, it never invents. */
export const CATEGORIES: string[] = [
  "chunk-load",
  "network",
  "type-error",
  "range-error",
  "reference-error",
  "syntax-error",
  "unknown"
];

/** The tab keys of TABS in data.js, plus the two screens that are not tabs. */
export const ROUTE_IDS: string[] = [
  "board", "job", "jha", "upload", "ticket", "mytickets", "chat", "files",
  "contacts", "equipment", "timesheets", "rates", "tracker", "users", "mail",
  "root", "unknown"
];

/** Which boundary caught it: the one around the whole app, or the one around a screen. */
export const COMPONENT_IDS: string[] = ["root", "screen"];

// The build stamp vite.config.js writes: "0.93-beta 2 · <commit> · <date>".
// A charset, not a shape, so a later stamp format still validates — but a
// charset tight enough that no token, URL, quote or newline survives it.
// ASCII only, and the twin of browser_crashes' app_version check: the
// separator the stamp uses is folded to a hyphen by cleanAppVersion, so
// neither this rule nor the database's carries a multi-byte character.
export const APP_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z .+-]{0,59}$/;

/**
 * The build stamp, folded to the charset the server will accept. Anything
 * outside it becomes a hyphen rather than being dropped, so two different
 * builds cannot fold to the same string; over length it is cut, and an
 * unusable stamp comes back empty, which the validator refuses.
 */
export function cleanAppVersion(version: unknown): string {
  const text = typeof version === "string" ? version : "";
  const folded = text.replace(/[^0-9A-Za-z .+-]/g, "-").slice(0, 60);
  return APP_VERSION_RE.test(folded) ? folded : "";
}

/**
 * Which category an error belongs to. The message is READ here and goes no
 * further: what leaves the device is the slug alone.
 *
 * Chunk-load is asked first because Vite reports a chunk that would not load
 * as a TypeError, and on a field device — a tunnel, a new deploy mid-shift —
 * that is the crash that actually happens.
 */
export function categorize(error: unknown): string {
  const err = error as { name?: unknown; message?: unknown } | null;
  const name = typeof err?.name === "string" ? err.name : "";
  const message = typeof err?.message === "string" ? err.message : "";

  if (name === "ChunkLoadError") return "chunk-load";
  if (/dynamically imported module|Importing a module script failed|Loading chunk|error loading dynamically imported/i.test(message)) return "chunk-load";
  if (/Failed to fetch|NetworkError|Load failed|network request failed/i.test(message)) return "network";
  if (name === "TypeError") return "type-error";
  if (name === "RangeError") return "range-error";
  if (name === "ReferenceError") return "reference-error";
  if (name === "SyntaxError") return "syntax-error";
  return "unknown";
}

/** One of a list, or null. The whole of the validation's judgement. */
export function oneOf(list: string[], v: unknown): string | null {
  return typeof v === "string" && list.indexOf(v) !== -1 ? v : null;
}

// ═══ end shared core ═══

/** The whole request body, after validation. Nothing else is kept. */
export interface CrashReport {
  error_category: string;
  route_id: string;
  component_id: string;
  app_version: string;
}

/**
 * The hard byte ceiling on a request body, enforced before it is parsed.
 * Four short identifiers and their JSON keys are nowhere near it; anything
 * that is has no business being here.
 */
export const MAX_BODY_BYTES = 512;

/**
 * The server's answer on a body. Returns the report or the reason it was
 * refused — never a partly-filled report, and never the caller's own words
 * back. The client checks the same things as a courtesy; this pass is the
 * one that counts.
 */
export function validateCrashReport(body: unknown): { report: CrashReport } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Not a report." };
  const b = body as Record<string, unknown>;

  const error_category = oneOf(CATEGORIES, b.error_category);
  if (!error_category) return { error: "Unknown error_category." };
  const route_id = oneOf(ROUTE_IDS, b.route_id);
  if (!route_id) return { error: "Unknown route_id." };
  const component_id = oneOf(COMPONENT_IDS, b.component_id);
  if (!component_id) return { error: "Unknown component_id." };

  const app_version = typeof b.app_version === "string" ? b.app_version : "";
  if (!APP_VERSION_RE.test(app_version)) return { error: "Unknown app_version." };

  return { report: { error_category, route_id, component_id, app_version } };
}

/**
 * The rate limit's key: the minute the SERVER is in, never a clock the
 * browser controls. One row per account per minute, held by the primary key
 * on browser_crashes — so the limit is the insert itself and there is no
 * read-then-write window for two tabs to race through.
 */
export function minuteBucket(now: Date): string {
  return now.toISOString().slice(0, 16);
}
