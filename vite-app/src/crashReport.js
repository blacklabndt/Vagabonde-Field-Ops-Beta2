// The browser's half of the error log — what a screen may say when it breaks.
//
// Every Edge Function writes its failures to function_errors and the office
// reads them. ErrorBoundary wrote console.error on a phone in a truck, which
// is the same as writing nothing. This is the send, and it is deliberately
// tiny: four identifiers, none of them free text, fired and forgotten.
//
// The reason it is not the error's message and stack is in the twin, and it
// is worth repeating here: approval tokens and OAuth codes travel in URLs,
// and React puts both messages and stacks within reach of props. Scrubbing
// with patterns fails open, and what it fails open with is a live token in a
// database row. So the message is read on this device to pick a category and
// then dropped.
//
// Nothing here may ever interfere with the error screen. The whole send sits
// in a try/catch with a swallowed rejection: if the report cannot go, the
// person still gets their "This screen hit a problem" and their Reload.

// ═══ shared core (twin: supabase/functions/_shared/crashReport.ts) ═══

/** Every category a crash may be filed under. Fixed: the browser picks, it never invents. */
export const CATEGORIES = [
  "chunk-load",
  "network",
  "type-error",
  "range-error",
  "reference-error",
  "syntax-error",
  "unknown"
];

/** The tab keys of TABS in data.js, plus the two screens that are not tabs. */
export const ROUTE_IDS = [
  "board", "job", "jha", "upload", "ticket", "mytickets", "chat", "files",
  "contacts", "equipment", "timesheets", "rates", "tracker", "users", "mail",
  "root", "unknown"
];

/** Which boundary caught it: the one around the whole app, or the one around a screen. */
export const COMPONENT_IDS = ["root", "screen"];

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
export function cleanAppVersion(version) {
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
export function categorize(error) {
  const err = error;
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
export function oneOf(list, v) {
  return typeof v === "string" && list.indexOf(v) !== -1 ? v : null;
}

// ═══ end shared core ═══

/**
 * The four values a crash is reduced to, from an error and where it happened.
 * A route the app does not have a tab for — a context screen's key that was
 * renamed, say — becomes "unknown" rather than being sent as itself: the
 * server would refuse it and the report would be lost for no gain.
 *
 * Exported so the test can check the body without a network.
 */
export function crashBody(error, routeId, componentId) {
  return {
    error_category: categorize(error),
    route_id: oneOf(ROUTE_IDS, routeId) || "unknown",
    component_id: oneOf(COMPONENT_IDS, componentId) || "screen",
    app_version: cleanAppVersion(typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev")
  };
}

/**
 * Send it, or do not, and either way say nothing. No await reaches the
 * render path: the boundary has already decided what to draw by the time
 * this runs, and a failed send must not change that.
 *
 * The server applies the rate limit, one report per account per minute, by
 * colliding on the primary key. A device crash-looping is therefore one row
 * a minute, not a flood — and nothing here needs to remember anything
 * between crashes to make that true.
 *
 * The invoke is handed in rather than imported so this module needs no
 * browser to load: crashSend.js binds the real client, and the test binds
 * one that throws and one that rejects, which is the only behaviour here
 * that matters — that neither reaches the caller.
 */
export function makeReportCrash(invoke) {
  return function reportCrash(error, routeId, componentId) {
    try {
      const body = crashBody(error, routeId, componentId);
      // An unusable build stamp is the one refusal worth making here: the
      // server would refuse it too, and this saves the round trip.
      if (!body.app_version) return;
      Promise.resolve(invoke(body)).catch(() => {});
    } catch {
      // Reporting is the nice-to-have; the error screen is not.
    }
  };
}
