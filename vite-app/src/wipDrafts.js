// The half-entered work this device is still holding, read back as a list.
//
// The ticket editor and the JHA builder each keep a recovery copy in the
// offline cache as it is typed — `ticket.wip.<ticket id or job dbId>`
// (ticketMobile.jsx) and `jha.wip.<job dbId>` (jhaMobile.jsx). Those copies
// are already trusted enough to warn about at sign-out, and yet nothing in
// the app pointed at them: after a refresh you land on Home, and the only way
// back to a day's welds was to remember which job they were on and open that
// job's ticket screen again for the recovery banner to fire.
//
// This is the reading half of the "Half-entered on this device" strip. It is
// pure on purpose — no IndexedDB, no db.js — so the naming and the matching
// can be tested without a browser.

export const TICKET_WIP_PREFIX = "ticket.wip.";
export const JHA_WIP_PREFIX = "jha.wip.";

// A ticket copy's key ends in whichever the editor had to hand: the id of the
// draft being reopened, or the job's dbId when the ticket is new. A job dbId
// is a uuid; a ticket id is initials, a date stamp and a sequence
// (KK-0905-01), so the shape of the suffix tells the two apart with no read.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const looksLikeJobDbId = s => UUID_RE.test(String(s || ""));

// A suffix that is one of JavaScript's ways of saying "nothing" is not an id.
// The editors build their key by interpolation, so a job that somehow reached
// them without a dbId would leave "ticket.wip.undefined" behind — a row
// pointing at no job, offering to open it.
const NOT_AN_ID = new Set(["", "undefined", "null", "false", "true", "NaN"]);

// One cache key, taken apart. Null for anything that is not a recovery copy,
// so a caller can hand this every key it found.
export function parseWipKey(key) {
  const k = typeof key === "string" ? key : "";
  const kind = k.startsWith(TICKET_WIP_PREFIX) ? "ticket" : k.startsWith(JHA_WIP_PREFIX) ? "jha" : null;
  if (!kind) return null;
  const suffix = k.slice((kind === "ticket" ? TICKET_WIP_PREFIX : JHA_WIP_PREFIX).length);
  if (NOT_AN_ID.has(suffix)) return null;
  // An assessment is only ever keyed by its job. A ticket may be keyed by
  // either, and only the uuid case names a job we can look up.
  const byJob = kind === "jha" || looksLikeJobDbId(suffix);
  return { key: k, kind, jobDbId: byJob ? suffix : null, ticketId: byJob ? null : suffix };
}

// The job ids worth a lookup, deduplicated — what the strip asks Db.getJob
// for once per job rather than once per copy.
export function jobDbIdsOf(entries) {
  const out = [];
  for (const e of entries || []) {
    const parsed = parseWipKey(e && e.key);
    if (parsed && parsed.jobDbId && !out.includes(parsed.jobDbId)) out.push(parsed.jobDbId);
  }
  return out;
}

// What the strip renders, newest first — the copy someone was typing a minute
// ago is the one they came looking for.
//
// `jobs` is dbId → the shaped job record (db.js's shapeJob: `id` is the job
// number). `tickets` is the drafts list already on screen, which is how a
// copy keyed by a reopened ticket gets a job number without a second read:
// that ticket is a draft of this person's, so it is in that list.
//
// Nothing here filters by person, and nothing needs to: the cache belongs to
// one account at a time (OfflineCache's `cache.owner` / claimFor empties the
// store when anyone else signs in on the tablet), so every copy in it is the
// signed-in account's own.
export function buildWipRows(entries, { tickets = [], jobs = {} } = {}) {
  const rows = [];
  for (const e of entries || []) {
    const parsed = parseWipKey(e && e.key);
    if (!parsed) continue;
    const jobRecord = parsed.jobDbId ? jobs[parsed.jobDbId] || null : null;
    const draft = parsed.ticketId ? (tickets || []).find(t => t && t.id === parsed.ticketId) || null : null;
    rows.push({
      key: parsed.key,
      kind: parsed.kind,
      what: parsed.kind === "ticket" ? "Billing ticket" : "Hazard assessment",
      jobDbId: parsed.jobDbId,
      ticketId: parsed.ticketId,
      jobRecord,
      // The job number if anything knows it, and the raw id when nothing
      // does — an unresolved copy is still a copy, and saying "we are
      // holding something for a job we cannot name right now" beats leaving
      // it off the list the way the app used to.
      jobNumber: jobRecord ? jobRecord.id : draft ? draft.job : "",
      project: jobRecord ? jobRecord.project : draft ? draft.project : "",
      client: jobRecord ? jobRecord.client : draft ? draft.client : "",
      at: e.at || null
    });
  }
  // Undated copies last: an entry with no saved-at stamp is the oldest thing
  // the store can tell us about, not the newest.
  rows.sort((a, b) => (b.at || 0) - (a.at || 0));
  return rows;
}

// How the row names the job, for the table cell and for the discard prompt.
export function wipJobLabel(row) {
  if (!row) return "an unknown job";
  if (row.jobNumber) return row.jobNumber;
  if (row.ticketId) return `ticket ${row.ticketId}`;
  return `job ${row.jobDbId || "on this device"}`;
}

// When the copy was last written, in the words someone reading a list wants:
// the clock time for today's, "yesterday" for last night's, and a date for
// anything older. `at` is IndexedDB's own stamp on the record (ocPut writes
// Date.now()), so a copy that stopped being touched keeps the honest time it
// stopped.
export function wipWhen(at, now = Date.now()) {
  const d = new Date(at || NaN);
  if (Number.isNaN(d.getTime())) return "kept on this device";
  const time = d.toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return `kept today at ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `kept yesterday at ${time}`;
  return `kept ${d.toLocaleDateString("en-CA", { month: "short", day: "numeric" })} at ${time}`;
}
