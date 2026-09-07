import { sbClient, VAPID_PUBLIC_KEY } from "./config.js";
import { money, todayLocal, localDate, dayMonth, ticketDateStamp, primaryContact, ageInDays, storageKeySafe, STANDARD_RATE_LINES, nonNegative, lineTotal, decimalString, ticketStatusWriteRefusal, gstRateOf } from "./data.js";
import { OfflineCache } from "./offlineCache.js";
import { Toasts } from "./toastBus.js";
import { OfflineQueue, isNetworkError } from "./offlineQueue.js";
import { RESPONSE_ROW_CAP, fetchAllPages, fetchAllKeyset, mapLimit } from "./paging.js";
import { ticketFingerprint } from "./ticketFingerprint.js";

// The one sentence a completed job answers with, wherever its row was read
// — assertJobOpen reads the row itself; updateTicket has it embedded on the
// ticket's own pre-read and must say the same thing.
function assertJobRowOpen(job) {
  if (job.status === "Complete") {
    throw new Error(`Job ${job.job_number} is marked complete — an admin has to reopen it before anything can be added.`);
  }
}

// How many ticket batches the line export walks at once. Each batch is its
// own keyset walk, sequential within itself as the paging rule wants; the
// batches are disjoint tickets, so they need not wait on each other.
const EXPORT_LINE_WALKS = 4;

// A signed storage link lives ten minutes; a chat-media one is handed out
// again while under eight (see Db.signedUrl).
const SIGNED_URL_LIFE_S = 60 * 10;
const SIGNED_URL_REUSE_MS = 8 * 60 * 1000;
const _chatMediaUrls = new Map();
// Sign-out's: the next account on a shared tablet is not handed links
// minted under the last one's token. Exported on its own so App.jsx can
// reach it beside forgetHeldDrafts without touching the Db object.
export function forgetChatMediaUrls() { _chatMediaUrls.clear(); }

// The idempotency-key lookup a field save starts before its open check, so
// the two round trips overlap. A builder does nothing until something waits
// on it, hence the Promise.resolve; a lookup that fails resolves with its
// error rather than rejecting, so a refusal from the open check — thrown
// while this is still in flight — leaves nothing unhandled behind it.
function startKeyLookup(table, columns, clientKey) {
  if (!clientKey) return null;
  return Promise.resolve(sbClient.from(table).select(columns).eq("client_key", clientKey).maybeSingle())
    .catch(e => ({ data: null, error: e }));
}

// Thin data-access layer over the tables that are wired to Supabase so far
// (see README "What's wired"). Screens call these instead of touching
// `supabase` directly, so the swap from mock state to real queries stays
// contained to one file per domain as more screens get wired.

// Sentinel id for the house default rate schedule — a rate_schedules row
// with client_id null, edited through the same screen as a client's own.
export const DEFAULT_SCHEDULE = "__default__";

// The per-client "open jobs" lists the New ticket dialog reads offline
// (listActiveJobsForClient). Dropped whenever a job leaves the open set —
// deleted, or marked complete — so a stale list can't offer a job that a
// ticket would then fail against forever in the outbox.
const dropClientJobLists = async () => {
  const keys = await OfflineCache.keys("jobs.client.").catch(() => []);
  await Promise.all(keys.map(k => OfflineCache.remove(k)));
};

// Zero-byte object that makes an otherwise-empty folder exist in Storage.
const FOLDER_MARKER = ".keep";

// How much of the team chat loads at once. A full page coming back is the
// signal that older messages exist beyond it.
const CHAT_PAGE = 100;
// The sender join is spelled with its column hint: chat_messages points at
// profiles twice (profile_id and pinned_by), and a bare `profiles(...)` made
// PostgREST refuse the whole read as ambiguous. The quoted self-join embeds
// through the COLUMN name (`reply_to(...)`), which is PostgREST's way of
// saying "the row this one points at" — the table-with-hint spelling read
// the same relationship backwards and returned the row's CHILDREN as an
// array, which rendered as the empty "Someone —" quote box.
const CHAT_COLUMNS =
  "id, profile_id, body, image_key, gif_url, audio_key, file_key, file_name, reply_to, pinned_at, created_at, " +
  "profiles!profile_id(name, first_name, last_name), " +
  "quoted:reply_to(id, body, image_key, gif_url, audio_key, file_name, profiles!profile_id(name, first_name, last_name)), " +
  "reactions:chat_reactions(emoji, profile_id)";

// One place that turns a timestamp into the "12 Feb 06:31" the tables use, and
// returns "" rather than "Invalid Date" for a null column.
function stamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return isNaN(d) ? "" : d.toLocaleString("en-CA", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

// Profiles carry first/last names now, but older rows may only have the
// display string — prefer the parts, fall back to what's there.
function fullName(p) {
  const joined = [p.first_name, p.last_name].filter(Boolean).join(" ").trim();
  return joined || p.name || "";
}

// pushManager.subscribe wants the VAPID public key as raw bytes, not the
// base64url string everything else passes around.
function vapidKeyBytes() {
  const b64 = VAPID_PUBLIC_KEY.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  return Uint8Array.from(atob(b64 + pad), c => c.charCodeAt(0));
}

// What the chat screen renders, from a chat_messages row with its profiles
// join. The realtime feed delivers rows without the join, so `name` can come
// back empty there — the screen fills it from people it already knows.
function shapeChatMessage(m) {
  return {
    id: m.id,
    profileId: m.profile_id,
    name: m.profiles ? fullName(m.profiles) : "",
    body: m.body,
    imageKey: m.image_key || null,
    gifUrl: m.gif_url || null,
    audioKey: m.audio_key || null,
    fileKey: m.file_key || null,
    fileName: m.file_name || null,
    replyTo: m.reply_to || null,
    // Reactions arrive as bare rows; the screen groups them per emoji.
    // Null means "this copy didn't carry them" (realtime rows have no
    // embed) — distinct from an empty array, which is authoritative.
    reactions: m.reactions ? m.reactions.map(r => ({ emoji: r.emoji, profileId: r.profile_id })) : null,
    // The message this one answers, flattened to what the quote block
    // shows. Realtime rows arrive without the join — the screen resolves
    // those from messages it already holds. The Array guard is armour
    // against the backwards self-embed ever coming back: children-as-
    // array must never render as an empty quote.
    quoted: m.quoted && !Array.isArray(m.quoted) ? {
      id: m.quoted.id,
      name: m.quoted.profiles ? fullName(m.quoted.profiles) : "",
      body: m.quoted.body || "",
      label: m.quoted.image_key ? "(picture)" : m.quoted.gif_url ? "(GIF)" : m.quoted.audio_key ? "(voice note)" : m.quoted.file_name ? "(file)" : ""
    } : null,
    // Whether this copy resolved the reply_to join. A joined select carries
    // the `quoted` embed key (null when the parent is gone); a raw realtime
    // payload has no such key. The merge trusts an authoritative null here
    // to clear a deleted quote, and defers to what it already has otherwise
    // — see mergeIn in chatMerge.js.
    hasQuoteJoin: "quoted" in m,
    pinnedAt: m.pinned_at || null,
    createdAt: m.created_at,
    at: stamp(m.created_at)
  };
}

// A failed Edge Function returns its JSON body inside the error's `context`
// Response — without unwrapping it every failure reads "Edge Function returned
// a non-2xx status code", which tells the user nothing.
async function readFnError(error) {
  try {
    const body = await error.context.json();
    if (body && body.error) return body.error;
  } catch (_) { /* not JSON, fall through */ }
  return error.message || "The email service didn't respond.";
}

// The Error every failed invoke throws — so a lost connection stays
// recognisable as one.
//
// functions-js answers a fetch that never left the device with a
// FunctionsFetchError, whose message is the fixed string "Failed to send a
// request to the Edge Function" and whose `context` is the underlying
// TypeError rather than a Response. Nothing in those words says "network",
// so the offline queue read a dead radio as a real refusal: the item was
// parked as unsyncable and the next flush raised the false "charges weren't
// applied" alarm. It also buried config.js's timeout rewrite, which turns an
// aborted /functions/v1 call into "Failed to fetch" precisely so the queue
// would know. So the underlying failure's own words are kept, and the Error
// carries a flag — the queue asks the flag, never the prose.
async function fnError(error) {
  const context = error && error.context;
  // A Response carries the function's own JSON body; anything else means the
  // request never got an answer to read.
  const network = !!error && (error.name === "FunctionsFetchError" || !!(context && typeof context.json !== "function"));
  if (network) {
    const e = new Error((context && context.message) || error.message || "The request couldn't be sent.");
    e.networkFailure = true;
    return e;
  }
  return new Error(await readFnError(error));
}

// Shapes a raw jobs row (with its client/contractor/created-by joins) into
// what every screen expects — shared by the job lists and the single-row
// lookups below so a job reads the same way wherever it's fetched from.
function shapeJob(j) {
  return {
    dbId: j.id, id: j.job_number, project: j.project,
    client: j.clients ? j.clients.name : "", clientId: j.client_id,
    // The tax the client actually pays, carried on the job because that is
    // where every ticket screen already has it. gstRateOf reads a job with
    // no rate on it — a cached copy from before the column, a row out of an
    // older backup — as the ordinary 5% rather than as exempt.
    clientGstRate: gstRateOf(j.clients ? j.clients.gst_rate : null),
    contractor: j.contractors ? j.contractors.name : "", contractorId: j.contractor_id,
    lsd: j.lsd, afe: j.afe, area: j.area, method: j.method, procedure: j.procedure,
    scope: "RT · scope TBD", status: j.status,
    // The id as well as the name: a screen has to be able to ask "did I
    // raise this", and two people can share a name.
    createdBy: j.profiles ? j.profiles.name : "", createdById: j.created_by,
    createdAt: stamp(j.created_at),
    // The raw instant too: the display stamp has no year, and the archive
    // files a job under the month it was raised.
    createdAtIso: j.created_at || null
  };
}

// The PDFs a job delete has just orphaned. Both delete_job and
// archive_clear_jobs hand back the keys of the objects whose rows they
// removed, because after the delete there is nothing left to read them from
// and the two private buckets would keep the files for ever.
//
// Best effort, and counted rather than thrown: the rows are already gone by
// the time this runs, so a refused removal is an untidy bucket, not a lost
// record — and the caller can say how many are left behind.
//
// The batches are independent, so a few go at a time: a year's archive clear
// hands back thousands of keys, and one batch after another was tens of
// serial round trips on the tail of an operation that already runs long.
async function removeStoredPdfs(result) {
  const batches = [];
  for (const [bucket, keys] of [["jhas", (result && result.jha_keys) || []], ["reports", (result && result.report_keys) || []]]) {
    for (let i = 0; i < keys.length; i += 100) batches.push({ bucket, batch: keys.slice(i, i + 100) });
  }
  const left = await mapLimit(batches, 4, async ({ bucket, batch }) => {
    const { error: rmErr } = await sbClient.storage.from(bucket).remove(batch);
    if (!rmErr) return 0;
    console.warn(`Couldn't remove ${batch.length} object(s) from ${bucket}:`, rmErr.message);
    return batch.length;
  });
  return left.reduce((n, x) => n + x, 0);
}

// A light in-memory cache for the reference-data lists (clients, contractors,
// contacts, profiles) that most screens read but rarely write: switching
// Home → Contacts → Home used to re-fetch the same unchanged lists every
// time. Cached for 30s, or until something writes to that table, whichever
// comes first — short enough that a stale add elsewhere in the app isn't
// felt for long, long enough to kill the repeat-navigation round trips.
const _cache = {};
const _generation = {};
// The read in flight for a key, so two callers in the same tick share one
// walk: opening a job started listContacts from getJobRecord and from the
// job screen's own mount effect at once, and with nothing stored yet both
// missed and both paged the whole directory. A write to the table
// (invalidate) drops the in-flight entry too, so the next caller reads
// fresh rather than joining a walk that started before the write.
const _inflight = {};
const CACHE_TTL_MS = 30000;
async function cached(key, fetcher) {
  const hit = _cache[key];
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  if (_inflight[key]) return _inflight[key];
  // A read that was already in flight when something wrote to this table must
  // not be the thing that repopulates the cache — it fetched the old rows.
  // The generation counter is what tells the two apart.
  const startedAt = _generation[key] || 0;
  // Declared before the async body runs, so a fetcher that threw
  // synchronously could not hit the finally below before `read` exists.
  let read;
  read = (async () => {
    try {
      const value = await fetcher();
      if ((_generation[key] || 0) === startedAt) _cache[key] = { value, at: Date.now() };
      return value;
    } finally {
      if (_inflight[key] === read) delete _inflight[key];
    }
  })();
  _inflight[key] = read;
  return read;
}
// Floors anything that feeds a bill — rates, quantities, hours. A negative
// Rates and quantities both come off the ticket screen, so they are floored
// together on the way in — and the total is recomputed from the floored
// figures, never from what the caller worked out.
const cleanLine = l => ({
  kind: l.kind, label: l.label, unit: l.unit,
  quantity: nonNegative(l.quantity), unit_rate: nonNegative(l.unit_rate)
});
// Summed in integer cents of per-line totals — the same formula the
// database's sync trigger uses, so the pre-write overflow check and the
// stored figure can never disagree.
const totalOf = lines => lines.reduce((s, l) => s + Math.round(lineTotal(l.quantity, l.unit_rate) * 100), 0) / 100;

// tickets.total is numeric(10,2): eight digits before the point. Found in
// beta testing by billing a nine-figure ticket — the database refused it
// with "numeric field overflow", which is not a sentence a technician can
// act on, and the two-step write left debris behind. Checked here, before
// anything is written.
const MAX_TICKET_TOTAL = 99999999.99;
const assertBillable = total => {
  if (total > MAX_TICKET_TOTAL) {
    // Through the app's one money formatter, like every other amount on a
    // screen. It used to quote the figure with no cents, which made the
    // refusal the one place in the app that named a total to the dollar.
    throw new Error(
      `This ticket adds up to ${money(total)}, which cannot be right — check the quantities and rates against what was actually worked.`
    );
  }
};

// A race lost against another actor is reported as what it was. `plain`
// marks a message complete in itself — screens show it bare instead of
// wrapping it in retry advice; `ticketGone` additionally tells the caller
// the row no longer exists (the offline queue re-creates from its payload,
// the cancel path treats it as already done).
const plainError = (message, extra) => Object.assign(new Error(message), { plain: true, ...extra });

// An empty read can also mean the session died mid-edit: with no session
// supabase-js falls back to the anon key, and anon sees zero rows without
// any error — which must never be reported as "the ticket is gone".
// Checked only on the empty-result paths, so the happy path pays nothing.
const assertSessionAlive = async () => {
  const { data } = await sbClient.auth.getSession();
  if (!data || !data.session) {
    throw plainError("You're signed out, so nothing could be checked or changed. Sign in again and retry — everything on screen is still there.");
  }
};

// The same database refusal, translated, for anything that slips past the
// client-side check (a stale tab, a hand-crafted request).
const friendlyLineError = e =>
  e && e.code === "22003"
    ? new Error("A figure on this ticket is too large to bill — check the quantities and rates.")
    : e;

// 23505 is a unique violation; the constraint name tells us which one. Jobs
// have two unique columns (the id and the number), and only the number is
// something a person chose.
const isDuplicateJobNumber = error =>
  !!error && error.code === "23505" && /job_number/.test(error.message || "");

const jobNumberTakenMessage = jobNumber =>
  `Job ${jobNumber} already exists — job numbers have to be unique. Give this one a different number.`;

function invalidate(...keys) {
  for (const k of keys) delete _inflight[k];
  keys.forEach(k => {
    delete _cache[k];
    _generation[k] = (_generation[k] || 0) + 1;
  });
}

// Row shapers for the three lists that hang off a job. Pulled out of the
// per-job reads so the batch prefetch below stores exactly the same shape —
// two copies of this mapping would drift, and the drift would only show up
// offline, which is the worst place to find it.
// The local calendar day of a timestamp, for comparing against a plain date.
function localDay(ts) {
  const d = ts ? new Date(ts) : null;
  if (!d || isNaN(+d)) return "";
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function shapeJha(j) {
  return {
    id: j.id,
    pdfKey: j.pdf_key,
    template: j.template || "",
    dosimetry: Array.isArray(j.dosimetry) ? j.dosimetry : [],
    details: j.details || {},
    unitNumber: j.unit_number || "",
    siteRep: j.site_rep || "",
    // The day the assessment covers, which is not always the day it was
    // typed in — see the work_date migration.
    workDate: j.work_date || "",
    // Written up for a different day than it was entered — worth showing, so
    // nobody reads the filing date as the date of the work.
    backdated: !!(j.work_date && j.signed_at && j.work_date !== localDay(j.signed_at)),
    // Rows filed before the close-out step existed have no status — they are
    // finished, not waiting for readings.
    status: j.status || "Closed",
    closedAt: stamp(j.closed_at),
    file: j.pdf_key ? j.pdf_key.split("/").pop() : (j.template ? j.template.replace(/s+/g, "-") + ".pdf" : "jha.pdf"),
    at: stamp(j.signed_at),
    by: j.profiles ? j.profiles.name : "",
    sentAt: stamp(j.sent_at),
    sentTo: j.sent_to || ""
  };
}
// `hazards` is deliberately not selected. Job detail used to summarise the
// last assessment's hazards as a grid of chips and no longer does, and it
// was the only reader — a jsonb array of a dozen objects per JHA, carried
// over field data and written into the offline cache for nothing. The PDF
// renderer reads the column itself, server-side, from the row.
const JHA_COLUMNS = "id, job_id, template, pdf_key, signed_at, work_date, status, closed_at, dosimetry, details, unit_number, site_rep, sent_at, sent_to, profiles(name)";

function shapeReport(r) {
  return {
    pdfKey: r.pdf_key,
    id: r.id,
    file: r.filename, welds: r.welds, result: r.result,
    at: stamp(r.uploaded_at),
    sent: r.sent_at ? "Yes" : "Pending",
    sentAt: stamp(r.sent_at),
    sentTo: r.sent_to || ""
  };
}

function shapeJobTicket(t) {
  return {
    id: t.id, date: dayMonth(localDate(t.work_date)),
    age: ageInDays(t.created_at),
    amount: Number(t.total), status: t.status, tech: t.profiles ? t.profiles.name : "",
    // Who raised it, so the screen can offer "cancel approval" to the same
    // people the database would let do it: that technician, or an admin.
    techId: t.technician_id
  };
}
const JOB_TICKET_COLUMNS = "id, job_id, work_date, status, total, created_at, technician_id, profiles(name)";

// Everything the archive's job text file says about a ticket, in one row.
const ARCHIVE_TICKET_COLUMNS = "id, work_date, status, total, delays, client_contact, contractor_contact, approved_at, approved_by_email, approval_sent_at, approval_sent_to, invoiced_at, queried_at, query_text, query_by, profiles(name), ticket_lines(kind, label, unit, quantity, unit_rate, line_order)";
function shapeArchiveTicket(t) {
  // line_order is the column the invoice prints by; PostgREST hands embedded
  // rows over in heap order, so the archive has to put them back in it.
  const lines = [...(t.ticket_lines || [])].sort((a, b) => Number(a.line_order || 0) - Number(b.line_order || 0));
  return {
    id: t.id, workDate: t.work_date, status: t.status, total: Number(t.total || 0), delays: t.delays || "",
    clientContact: t.client_contact ? t.client_contact.name : "",
    contractorContact: t.contractor_contact ? t.contractor_contact.name : "",
    approvedAt: t.approved_at, approvedBy: t.approved_by_email || "",
    sentAt: t.approval_sent_at, sentTo: t.approval_sent_to || "",
    invoicedAt: t.invoiced_at, queriedAt: t.queried_at, queryText: t.query_text || "", queryBy: t.query_by || "",
    tech: t.profiles ? t.profiles.name : "",
    lines
  };
}

// One ticket's crew, or a whole job's. ticket_id rides along so the batched
// read can file each row under the ticket it belongs to.
// The ticket's editable content as this device last saw the server hold it:
// the two reads the editor opens a draft with, and the line replacement that
// follows a save. One slot, because one ticket is open at a time — a read for
// a different ticket takes it over rather than accumulating.
//
// It exists for the outbox. A queued save replays the whole ticket and the
// last write wins, so a truck back in range at 18:00 writes over whatever the
// office saved meanwhile — and said nothing about it. The queued payload
// carries this fingerprint; the replay compares it with what is on the row by
// then, and a difference is somebody else's work about to be replaced.
//
// Kept here rather than on the ticket screen because this is the layer that
// sees the load AND the write that follows it. Measured against the copy the
// editor was opened with, a draft saved online and then edited again would
// accuse its own author of overwriting somebody.
//
// A few tickets, not one: the outbox replays read tickets through these same
// calls, and a single slot was taken by whichever ticket the flush touched
// last — so the draft open in the editor lost its baseline exactly while
// the outbox was busy, and its next queued save carried none. Small and
// bounded, because it only has to outlive one editing session.
const SEEN_TICKETS_MAX = 8;
const seenTickets = new Map();
const rememberTicketPart = (ticketId, part) => {
  if (!ticketId) return;
  const held = seenTickets.get(ticketId) || {};
  seenTickets.delete(ticketId);
  seenTickets.set(ticketId, Object.assign(held, part));
  while (seenTickets.size > SEEN_TICKETS_MAX) seenTickets.delete(seenTickets.keys().next().value);
};

const CREW_COLUMNS = "id, ticket_id, profile_id, crew_role, straight_hours, ot_hours, solo_hours, solo_ot_hours, dose_mr, mileage_km, profiles(name, first_name, last_name, is_subcontractor, level, id_code)";
function shapeCrew(c) {
  return {
    id: c.id, profileId: c.profile_id, role: c.crew_role,
    straight: Number(c.straight_hours), ot: Number(c.ot_hours),
    solo: Number(c.solo_hours), soloOt: Number(c.solo_ot_hours),
    dose: Number(c.dose_mr), mileage: Number(c.mileage_km),
    name: c.profiles ? fullName(c.profiles) : "",
    // The client's field invoice names each person's level and number
    // beside their hours. Both are set in Users & access: "Level" is the
    // cert grade printed in the LEVEL column, "CGSB# / NRCAN#" the number.
    level: c.profiles ? (c.profiles.level || "") : "",
    certNo: c.profiles ? (c.profiles.id_code || "") : "",
    isSub: c.profiles ? c.profiles.is_subcontractor : false
  };
}

// The board is re-fetched on every filter tap and every return to Home;
// re-pulling the detail for ten jobs each time would be a lot of traffic for
// data that rarely changes within a minute.
let _lastDetailPrefetch = 0;
const DETAIL_PREFETCH_GAP_MS = 60000;

// Quantity granularity per catalog unit; see getPublishedRatesForClient.
const CATALOG_STEP = { h: 0.5, day: 0.5, days: 0.5, km: 0.1 };

export const Db = {
  // The three reference lists every screen pre-fills from. Two layers: the
  // 30-second in-memory cache kills repeat round trips inside a session, and
  // the IndexedDB one underneath it keeps the last good copy for a day with
  // no signal.
  //
  // Paged through fetchAllPages, because these lists mean "all of them" and
  // PostgREST answers at most 1,000 rows per response, silently. The seeded
  // load test found it: 1,167 contacts came back as a directory that
  // quietly ended partway through the alphabet. Ordered by name THEN id —
  // seeded data proves duplicate names happen, and a page boundary landing
  // inside a run of one name would otherwise drop or double people.
  async _allRows(table) {
    return fetchAllPages(async (page, size) => {
      const { data, error, count } = await sbClient
        .from(table)
        .select("*", page === 0 ? { count: "exact" } : {})
        .order("name").order("id")
        .range(page * size, page * size + size - 1);
      if (error) throw error;
      return { rows: data || [], total: count ?? (data || []).length };
    });
  },

  async listClients() {
    return cached("clients", () => OfflineCache.readThrough("clients", () => this._allRows("clients")));
  },

  async listContractors() {
    return cached("contractors", () => OfflineCache.readThrough("contractors", () => this._allRows("contractors")));
  },

  async listContacts() {
    return cached("contacts", () => OfflineCache.readThrough("contacts", () => this._allRows("contacts")));
  },

  // One organisation's people. Ordered because the Contacts screen lists them;
  // the internal callers only ever `find()` in the result, so they don't care
  // either way. There were two of these for a while — this one and an
  // unordered twin — which is a coin-flip about which query you get.
  // People by name, email, phone or title, across every organisation — the
  // directory searched organisations only, and "who do I call at that
  // lease?" is usually a name. Client-side over the cached lists the app
  // already holds for its pickers, so it also answers with no signal.
  async searchPeople(q, limit = 12) {
    const needle = String(q || "").trim().toLowerCase();
    if (!needle) return [];
    const [contacts, clients, contractors] = await Promise.all([this.listContacts(), this.listClients(), this.listContractors()]);
    const orgName = new Map([
      ...(clients || []).map(c => ["client:" + c.id, c.name]),
      ...(contractors || []).map(k => ["contractor:" + k.id, k.name])
    ]);
    return (contacts || [])
      .filter(c => [c.name, c.email, c.phone, c.title].some(v => String(v || "").toLowerCase().includes(needle)))
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
      .slice(0, limit)
      .map(c => ({
        ...c,
        org: { type: c.org_type, id: c.org_id, key: c.org_type + ":" + c.org_id, name: orgName.get(c.org_type + ":" + c.org_id) || "" }
      }));
  },

  // One organisation's people, all of them. Paged for the same reason
  // _allRows above is: this was a plain select, and PostgREST answers at most
  // 1,000 rows without saying so — a client with more contacts than that had
  // its directory quietly end partway through the alphabet, and the Contacts
  // screen and the pickers behind it had no way to know. Ordered by name then
  // id so a page boundary landing inside a run of one name cannot drop or
  // double anybody.
  async listContactsForOrg(orgType, orgId) {
    return fetchAllPages(async (page, size) => {
      const { data, error, count } = await sbClient
        .from("contacts")
        .select("*", page === 0 ? { count: "exact" } : {})
        .eq("org_type", orgType).eq("org_id", orgId)
        .order("name").order("id")
        .range(page * size, page * size + size - 1);
      if (error) throw error;
      return { rows: data || [], total: count ?? (data || []).length };
    });
  },

  async searchOrgDirectory({ page = 0, pageSize = 20, scope = "All", search = "" } = {}) {
    const { data, error } = await sbClient.rpc("search_org_directory", { q: search, scope, page_num: page, page_size: pageSize });
    if (error) {
      // No signal: answer from the cached directory instead. The New ticket
      // dialog's client picker is this search, and without it there was no
      // way to start a ticket from Home out of range — the one thing the
      // offline queue exists for. Contact counts are not cached; nobody
      // picks a client by them.
      if (!isNetworkError(error)) throw error;
      const q = String(search || "").trim().toLowerCase();
      const orgs = [];
      try {
        if (scope !== "Contractors") (await this.listClients()).forEach(c => orgs.push({ type: "client", id: c.id, name: c.name }));
        if (scope !== "Clients") (await this.listContractors()).forEach(c => orgs.push({ type: "contractor", id: c.id, name: c.name }));
      } catch (e) {
        // Cold cache: the directory is saved at sign-in, so this is a device
        // that has never been in range signed in. Say that, not "Failed to
        // fetch" — and keep it a network error for anything that checks.
        if (!isNetworkError(e)) throw e;
        throw new TypeError("Failed to fetch — no connection, and the directory hasn't been saved on this device yet. Once you've signed in once in range, it stays available offline.");
      }
      const hits = orgs
        .filter(o => !q || String(o.name || "").toLowerCase().includes(q))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const rows = hits.slice(page * pageSize, (page + 1) * pageSize)
        .map(o => ({ key: o.type + ":" + o.id, type: o.type, id: o.id, name: o.name, contactCount: 0 }));
      return { rows, total: hits.length };
    }
    const rows = (data || []).map(o => ({
      key: o.org_type + ":" + o.org_id, type: o.org_type, id: o.org_id,
      name: o.name, contactCount: Number(o.contact_count)
    }));
    const total = data && data.length ? Number(data[0].total_count) : 0;
    return { rows, total };
  },

  // ── Contacts directory ───────────────────────────────────────────────
  // Many contacts per organisation, one of them primary. Everything that
  // pre-fills a rep (New job, job record, ticket email) reads the primary,
  // so promoting someone here changes what those screens offer next time.

  async createContact({ orgType, orgId, name, title, email, phone, notes, isPrimary }) {
    const clean = (name || "").trim();
    if (!clean) throw new Error("Give the contact a name.");
    // The first contact for an organisation is its primary whether or not the
    // box was ticked — otherwise an org can end up with contacts on file and
    // nothing for the job screens to pre-fill.
    // A count, not the rows: this used to page the organisation's whole
    // directory to learn whether it was empty.
    const { count, error: cErr } = await sbClient.from("contacts")
      .select("id", { count: "exact", head: true }).eq("org_type", orgType).eq("org_id", orgId);
    if (cErr) throw cErr;
    const onFile = count || 0;
    const primary = isPrimary || onFile === 0;
    if (primary && onFile) await this.clearPrimary(orgType, orgId);
    const { data, error } = await sbClient.from("contacts").insert({
      org_type: orgType, org_id: orgId, name: clean,
      title: (title || "").trim() || null,
      email: (email || "").trim() || null,
      phone: (phone || "").trim() || null,
      notes: (notes || "").trim() || null,
      is_primary: primary,
      last_used_at: new Date().toISOString()
    }).select().single();
    if (error) throw error;
    invalidate("contacts");
    return data;
  },

  async updateContact(id, { name, title, email, phone, notes }) {
    const clean = (name || "").trim();
    if (!clean) throw new Error("Give the contact a name.");
    const { error } = await sbClient.from("contacts").update({
      name: clean,
      title: (title || "").trim() || null,
      email: (email || "").trim() || null,
      phone: (phone || "").trim() || null,
      notes: (notes || "").trim() || null
    }).eq("id", id);
    if (error) throw error;
    invalidate("contacts");
  },

  async deleteContact(id) {
    const { error } = await sbClient.from("contacts").delete().eq("id", id);
    if (error) throw error;
    invalidate("contacts");
  },

  // Clearing before setting, in two statements: the unique partial index
  // allows one primary per organisation, so writing the new one first would
  // collide with the old.
  async clearPrimary(orgType, orgId) {
    const { error } = await sbClient.from("contacts").update({ is_primary: false })
      .eq("org_type", orgType).eq("org_id", orgId).eq("is_primary", true);
    if (error) throw error;
  },

  async setPrimaryContact({ id, orgType, orgId }) {
    await this.clearPrimary(orgType, orgId);
    const { error } = await sbClient.from("contacts").update({ is_primary: true }).eq("id", id);
    if (error) throw error;
    invalidate("contacts");
  },

  // Contractors are created as a side effect of a job elsewhere; the
  // directory can add one on its own so a contact can be filed before the
  // first job for them exists.
  async createContractor({ name }) {
    const clean = (name || "").trim();
    if (!clean) throw new Error("Give the contractor a name.");
    const escaped = clean.replace(/[%_\\]/g, m => "\\" + m);
    const { data: existing } = await sbClient.from("contractors").select("*").ilike("name", escaped).maybeSingle();
    if (existing) return existing;
    const { data, error } = await sbClient.from("contractors").insert({ name: clean }).select().single();
    if (error) throw error;
    invalidate("contractors");
    return data;
  },

  // Deleting a job, and saying what happens to what is filed against it.
  //
  // One RPC rather than a delete plus three updates from here: moving a JHA,
  // a report and a ticket and then removing the job has to be all-or-nothing,
  // and a browser that loses signal half way through would otherwise leave
  // the contents split across two jobs.
  //
  // `transferToId` moves everything to that job. `discard` destroys it with
  // the job. Neither one set, and the database refuses if anything is
  // attached — see 20260815000000.
  // ── Archive ──────────────────────────────────────────────────────────
  // Every job raised between two local days (inclusive), oldest first — the
  // archive's job list. The boundaries are this device's local midnights,
  // which for the crew is Edmonton: a job raised at 20:00 on 31 December
  // belongs to that year, whatever UTC says.
  async listJobsCreatedBetween(fromDay, toDay) {
    const start = new Date(`${fromDay}T00:00:00`);
    const end = new Date(`${toDay}T00:00:00`);
    end.setDate(end.getDate() + 1);
    const data = await fetchAllPages(async (page, size) => {
      const { data: rows, error, count } = await sbClient
        .from("jobs")
        .select("id, job_number, project, lsd, afe, area, method, procedure, status, created_at, client_id, contractor_id, created_by, clients(name, gst_rate), contractors(name), profiles!jobs_created_by_fkey(name)", page === 0 ? { count: "exact" } : {})
        .gte("created_at", start.toISOString())
        .lt("created_at", end.toISOString())
        .order("created_at").order("id")
        .range(page * size, page * size + size - 1);
      if (error) throw error;
      return { rows: rows || [], total: count ?? (rows || []).length };
    });
    return data.map(shapeJob);
  },

  // A whole job's tickets, with everything the archive's text file says about
  // them, in one read rather than one read each.
  //
  // The archive used to ask per ticket, which for a year is sixteen thousand
  // sequential round trips — over an hour of waiting before the zip even
  // starts. Chunked, because `in` puts every id in the URL and PostgREST caps
  // the response at 1,000 rows: a chunk of 200 tickets is one row each, well
  // inside both. Keyed by ticket id so the caller can keep its own order.
  async listTicketsForArchive(ticketIds) {
    const out = new Map();
    for (let i = 0; i < ticketIds.length; i += 200) {
      const { data, error } = await sbClient.from("tickets")
        .select(ARCHIVE_TICKET_COLUMNS)
        .in("id", ticketIds.slice(i, i + 200));
      if (error) throw error;
      for (const row of data || []) out.set(row.id, shapeArchiveTicket(row));
    }
    return out;
  },

  // The crew rows for a job's tickets, in one read per chunk. Paged by key
  // inside each chunk: a chunk of tickets carries several crew rows each, so
  // this is the one of the two that can genuinely run into the 1,000-row cap.
  async listCrewForTickets(ticketIds) {
    const out = new Map();
    for (const id of ticketIds) out.set(id, []);
    for (let i = 0; i < ticketIds.length; i += 200) {
      const chunk = ticketIds.slice(i, i + 200);
      const rows = await fetchAllKeyset(async after => {
        let query = sbClient.from("ticket_crew").select(CREW_COLUMNS).in("ticket_id", chunk);
        if (after != null) query = query.gt("id", after);
        const { data, error } = await query.order("id").limit(RESPONSE_ROW_CAP);
        if (error) throw error;
        return data || [];
      });
      for (const c of rows) {
        const list = out.get(c.ticket_id);
        if (list) list.push(shapeCrew(c));
      }
    }
    return out;
  },

  // A stored PDF, as bytes. Both buckets are private; the signed-in Admin's
  // read is the RLS decision.
  async downloadObject(bucket, key) {
    const { data, error } = await sbClient.storage.from(bucket).download(key);
    if (error) throw error;
    return new Uint8Array(await data.arrayBuffer());
  },

  // The one bulk delete in the app: the archived jobs and everything filed
  // against them, Admin-only in the database (archive_clear_jobs, definer),
  // then their PDFs out of storage, then every cache that remembered them.
  // Storage removal is best effort — the rows are gone by then, and an
  // orphaned object in a private bucket is untidy, not a record.
  async archiveClearJobs(jobIds) {
    const { data, error } = await sbClient.rpc("archive_clear_jobs", { p_job_ids: jobIds });
    if (error) throw error;
    const result = data || {};
    const filesLeft = await removeStoredPdfs(result);
    invalidate("job_numbers");
    invalidate("profiles");
    // The half-entered ticket and assessment copies are keyed by the job they
    // are being built against (ticketMobile and jhaMobile both key on the
    // job's dbId; a ticket already saved is keyed by its own id instead, and
    // there is nothing here to match that against). They matched none of the
    // patterns below, so a recovery copy for a job that has just been
    // archived and removed outlived it — counted for ever after in the "you
    // have half-entered work on this device" warning at sign-out, for a job
    // whose screen can no longer be opened to finish or discard it.
    const cleared = new Set((jobIds || []).map(String));
    const wipJob = k => { const m = /^(?:ticket|jha)\.wip\.(.+)$/.exec(k); return m ? m[1] : null; };
    const keys = await OfflineCache.keys("").catch(() => []);
    await Promise.all(keys
      .filter(k => k === "jobs.recent" || /^(job|jhas|reports|tickets|jha\.last|jobs\.client)\./.test(k)
        || cleared.has(wipJob(k)))
      .map(k => OfflineCache.remove(k)));
    return {
      jobs: Number(result.jobs || 0), tickets: Number(result.tickets || 0),
      jhas: Number(result.jhas || 0), reports: Number(result.reports || 0), filesLeft
    };
  },

  async deleteJob({ jobId, transferToId = null, discard = false }) {
    const { data, error } = await sbClient.rpc("delete_job", {
      p_job_id: jobId,
      p_transfer_to: transferToId,
      p_discard: discard
    });
    if (error) throw error;
    // The same tidying the archive's clear does, for the same reason: a job
    // deleted with its work takes the JHA and report rows with it on the
    // cascade, and their PDFs would sit in the two buckets with nothing left
    // pointing at them. delete_job hands the keys back for exactly this (it
    // returns none on a transfer, where the rows and their files live on).
    const filesLeft = await removeStoredPdfs(data);
    // The board, the job itself and its history are all now wrong on this
    // device, and the deleted job must not come back from the cache — nor
    // should the chat keep linkifying its number. "job_numbers" is an
    // in-memory cached() key; "jobs.recent" is the offline board page and
    // lives in OfflineCache, so invalidate() never touched it — it has to
    // be removed there, or an offline board falls back to a stale page
    // still holding the deleted job (whose per-job entries are gone below,
    // so tapping it errors).
    invalidate("job_numbers");
    // Every key at once (they are distinct rows, and remove swallows its own
    // failures), rather than one transaction awaited after another.
    const gone = ["jobs.recent", "job." + jobId, "job.reps." + jobId, "jhas." + jobId, "reports." + jobId, "tickets." + jobId];
    // The half-entered ticket and assessment copies too, and for the same
    // reason the archive's clear sweeps them: they are keyed by the job's
    // dbId, so they outlive the job that gave them meaning and are counted
    // for ever after in the "half-entered work on this device" warning at
    // sign-out — for a screen that can no longer be opened to finish or
    // discard them. "jha.last" is a cache rather than a draft, and just as
    // dead. (A ticket already saved is keyed by its own id, and there is
    // nothing here to match that against.) Both paths: transferred or
    // deleted with its work, this job is gone either way.
    gone.push("ticket.wip." + jobId, "jha.wip." + jobId, "jha.last." + jobId);
    // A transfer moves the JHAs, reports and tickets onto the target job, so
    // the target's remembered history is now the one that is wrong — it names
    // none of what it has just been given.
    if (transferToId) {
      gone.push("jhas." + transferToId, "reports." + transferToId, "tickets." + transferToId, "jha.last." + transferToId);
    }
    await Promise.all(gone.map(k => OfflineCache.remove(k)));
    await dropClientJobLists();
    return { ...(data || {}), filesLeft };
  },

  // The open jobs for one client, newest first — what the "New ticket" button
  // on the board offers once a client is chosen.
  //
  // Filtered on client_id rather than by searching the client's name: the
  // picker already knows which client it handed over, and two clients whose
  // names share a word would otherwise bleed into each other's list. Complete
  // jobs are left out because a ticket can't be raised against one anyway —
  // offering them would be a list of things that refuse to be picked.
  async listActiveJobsForClient(clientId) {
    if (!clientId) return [];
    // Cached per client, so a client whose jobs were listed once in range
    // can be ticketed from Home out of range (the New ticket dialog reads
    // this after the cached directory search).
    return OfflineCache.readThrough("jobs.client." + clientId, async () => {
      const { data, error } = await sbClient
        .from("jobs")
        .select("id, job_number, project, lsd, afe, area, method, procedure, status, created_at, client_id, contractor_id, created_by, clients(name, gst_rate), contractors(name), profiles!jobs_created_by_fkey(name)")
        .eq("client_id", clientId)
        .eq("status", "Active")
        .order("created_at", { ascending: false })
        .limit(RESPONSE_ROW_CAP);
      if (error) throw error;
      return data.map(shapeJob);
    });
  },

  // The same shape as the job lists above, for exactly one row — used to seed
  // the initial active job on sign-in without pulling every job to pick the
  // newest.
  async getMostRecentJob() {
    const { data, error } = await sbClient
      .from("jobs")
      .select("id, job_number, project, lsd, afe, area, method, procedure, status, created_at, client_id, contractor_id, created_by, clients(name, gst_rate), contractors(name), profiles!jobs_created_by_fkey(name)")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return data ? shapeJob(data) : null;
  },

  // Is this number already on a job? One lookup straight down the unique
  // index behind job_number.
  //
  // Advisory only: two coordinators can both pass this in the same instant
  // and one still loses at the insert, which is what the 23505 translation in
  // createJob is for. This catches the ordinary case — a number issued on
  // paper last week — against the field rather than after the form is filled.
  //
  // Trimmed and guarded because it is called on every keystroke now: an empty
  // box is not a collision, and " J-1 " is the same number as "J-1".
  async jobNumberExists(jobNumber) {
    const n = (jobNumber || "").trim();
    if (!n) return false;
    const { data, error } = await sbClient.from("jobs").select("id").eq("job_number", n).maybeSingle();
    if (error) throw error;
    return !!data;
  },

  // A suggestion, never a claim: the highest number carrying the newest
  // job's prefix, plus one. Job numbers are freeform — the newest job used
  // to be read as "J-" + digits, so a card numbered S-1042 suggested J-1,
  // and J-50 followed by J-12 suggested J-13.
  async getNextJobNumber() {
    // The newest number alone — getMostRecentJob's row carries three joins
    // this never reads.
    const { data: recent, error: rErr } = await sbClient.from("jobs").select("job_number")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (rErr) throw rErr;
    if (!recent) return "J-1";
    const m = /^(.*?)(\d+)$/.exec(String(recent.job_number || "").trim());
    if (!m) return "";
    const prefix = m[1];
    const { data, error } = await sbClient.from("jobs").select("job_number")
      .ilike("job_number", prefix.replace(/[%_]/g, "\\$&") + "%")
      .order("created_at", { ascending: false }).limit(500);
    if (error) throw error;
    const width = m[2].length;
    let top = parseInt(m[2], 10);
    for (const row of data || []) {
      const mm = /^(.*?)(\d+)$/.exec(String(row.job_number || ""));
      if (mm && mm[1] === prefix) top = Math.max(top, parseInt(mm[2], 10));
    }
    return prefix + String(top + 1).padStart(width, "0");
  },

  // The dispatch board. Only the plain first page — no filter, no search — is
  // kept for offline use: that is the "what am I on today" view, and caching
  // every filter/search permutation would be a lot of storage for questions
  // nobody asks with no signal. When the network is down, that one page is
  // served whatever was asked for, and `fromCache` tells Home to say so
  // rather than pretending the filter was applied.
  async searchJobs({ page = 0, pageSize = 10, status = "All", search = "", searchField = "any" } = {}) {
    const shape = data => {
      const rows = (data || []).map(j => ({
        dbId: j.id, id: j.job_number, project: j.project,
        client: j.client_name || "", clientId: j.client_id,
        contractor: j.contractor_name || "", contractorId: j.contractor_id,
        lsd: j.lsd, afe: j.afe, area: j.area, method: j.method, procedure: j.procedure,
        scope: "RT · scope TBD", status: j.status,
        createdBy: j.created_by_name || "", createdById: j.created_by,
        createdAt: stamp(j.created_at)
      }));
      return { rows, total: data && data.length ? Number(data[0].total_count) : 0 };
    };

    const isBoardDefault = page === 0 && status === "All" && !search;
    try {
      const { data, error } = await sbClient.rpc("search_jobs", {
        q: search, status_filter: status, search_field: searchField, page_num: page, page_size: pageSize
      });
      if (error) throw error;
      const result = shape(data);
      OfflineCache.markLive();
      if (isBoardDefault) {
        OfflineCache.put("jobs.recent", result);
        // Each job on its own key too, so opening one offline works even
        // though Job detail fetches it by id rather than off the list.
        result.rows.forEach(j => OfflineCache.put("job." + j.dbId, j));
        // And the contents of each — deliberately not awaited, so the board
        // paints on the first response rather than the fourth.
        this.prefetchJobDetails(result.rows.map(j => j.dbId));
      }
      return result;
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      const hit = await OfflineCache.read("jobs.recent");
      if (!hit) throw e;
      OfflineCache.noteServingCached(hit.at);
      return { ...hit.value, fromCache: true, cachedAt: hit.at };
    }
  },

  // Everything Job detail draws, for every job on the board, fetched in three
  // queries rather than thirty. Without this, a job opens offline showing its
  // header and three empty cards — the JHAs, reports and tickets were only
  // ever cached for jobs somebody had already opened in range, which is not
  // knowable in advance from a truck.
  //
  // Best effort and non-blocking: it runs after the board has already
  // rendered, and a failure means the old behaviour, not a broken board.
  async prefetchJobDetails(jobIds) {
    const ids = (jobIds || []).filter(Boolean);
    if (!ids.length) return;
    if (Date.now() - _lastDetailPrefetch < DETAIL_PREFETCH_GAP_MS) return;
    _lastDetailPrefetch = Date.now();

    try {
      // Paged: a page of long-running jobs can hold more than 1,000 tickets
      // between them, and a capped read used to hand the oldest jobs an
      // empty list — which the cache below then wrote over a complete one,
      // so Job detail read "None on file yet." offline for a job with a
      // dozen tickets. A page that fails throws, and nothing is written.
      const all = (table, cols, newestFirst) => fetchAllPages(async (page, size) => {
        const { data: rows, error, count } = await sbClient
          .from(table).select(cols, page === 0 ? { count: "exact" } : {})
          .in("job_id", ids)
          .order(newestFirst, { ascending: false }).order("id")
          .range(page * size, page * size + size - 1);
        if (error) throw error;
        return { rows: rows || [], total: count ?? (rows || []).length };
      });
      const [jhas, reports, tickets] = await Promise.all([
        all("jhas", JHA_COLUMNS, "signed_at"),
        all("reports", "*", "uploaded_at"),
        all("tickets", JOB_TICKET_COLUMNS, "created_at")
      ]);

      // Written per job, including the empty ones. An absent key and an empty
      // list mean different things offline: absent throws and logs "failed to
      // load", empty renders "None on file yet." — which is the truth.
      const spread = (prefix, rows, shape) => {
        const byJob = new Map(ids.map(id => [id, []]));
        (rows || []).forEach(row => {
          const bucket = byJob.get(row.job_id);
          if (bucket) bucket.push(shape(row));
        });
        byJob.forEach((value, id) => OfflineCache.put(prefix + id, value));
      };
      spread("jhas.", jhas, shapeJha);
      spread("reports.", reports, shapeReport);
      spread("tickets.", tickets, shapeJobTicket);
    } catch (e) {
      // Offline, or the request was refused — either way the board is already
      // on screen and nothing here is worth interrupting it for.
    }
  },

  async getJob(jobDbId) {
    return OfflineCache.readThrough("job." + jobDbId, async () => {
      const { data: j, error } = await sbClient
        .from("jobs")
        .select("id, job_number, project, lsd, afe, area, method, procedure, status, created_at, client_id, contractor_id, created_by, clients(name, gst_rate), contractors(name), profiles!jobs_created_by_fkey(name)")
        .eq("id", jobDbId).single();
      if (error) throw error;
      return shapeJob(j);
    });
  },

  // Same, keyed by job number — the id the new-job dialog hands back, before
  // the caller knows the row's dbId.
  async getJobByNumber(jobNumber) {
    const { data: j, error } = await sbClient
      .from("jobs")
      .select("id, job_number, project, lsd, afe, area, method, procedure, status, created_at, client_id, contractor_id, created_by, clients(name, gst_rate), contractors(name), profiles!jobs_created_by_fkey(name)")
      .eq("job_number", jobNumber).single();
    if (error) throw error;
    return shapeJob(j);
  },

  // A completed job is closed to new work: no JHAs, reports, tickets or record
  // edits. Only an admin can close or reopen one (the button is admin-only, and
  // this is checked again here rather than trusted from the screen).
  async setJobComplete(jobDbId, complete) {
    const { data: auth } = await sbClient.auth.getUser();
    // A dead session used to surface as "cannot read property id of null",
    // which reads like an app bug rather than "you've been signed out".
    if (!auth || !auth.user) throw new Error("Your session has expired — sign in again.");
    const { data: me, error: pErr } = await sbClient.from("profiles")
      .select("role").eq("id", auth.user.id).single();
    if (pErr) throw pErr;
    if (me.role !== "Admin") throw new Error("Only an admin can complete or reopen a job.");
    const { error } = await sbClient.from("jobs")
      .update({ status: complete ? "Complete" : "Active" }).eq("id", jobDbId);
    if (error) throw error;
    await dropClientJobLists();
  },

  // Anything that adds to a job goes through here first. A job someone marked
  // complete has been reported on and invoiced — a ticket landing on it a week
  // later is the error this prevents.
  async assertJobOpen(jobDbId) {
    const { data, error } = await sbClient.from("jobs").select("status, job_number").eq("id", jobDbId).maybeSingle();
    if (error) throw error;
    // maybeSingle rather than single, so a job that hasn't synced yet says so.
    // It reads as PostgREST's "Cannot coerce the result to a single JSON
    // object" otherwise, which tells the person holding the phone nothing.
    // But a session that died mid-shift reads as anon, and anon sees no jobs
    // at all — every job on the truck would then be "still waiting to sync",
    // which sends the technician looking at their signal instead of at the
    // sign-in they actually need.
    if (!data) {
      await assertSessionAlive();
      throw new Error("This job hasn't reached the database yet — it's still waiting to sync. It'll go through once the job ahead of it does.");
    }
    assertJobRowOpen(data);
  },

  // Contractors are created inline when a job names a new one (see
  // createJob), but clients are deliberate: they carry a rate schedule, so
  // adding one is its own act rather than a side effect.
  async createClient({ name, minimumCallout, effectiveFrom, gstRate }) {
    const clean = (name || "").trim();
    if (!clean) throw new Error("Give the client a name.");

    // `%` and `_` are wildcards to ilike, so a client literally called
    // "Site_A" would match "SiteXA" and be wrongly rejected as a duplicate.
    const escaped = clean.replace(/[%_\\]/g, m => "\\" + m);
    const { data: existing } = await sbClient.from("clients").select("id").ilike("name", escaped).maybeSingle();
    if (existing) throw new Error(`“${clean}” is already on file.`);

    const { data, error } = await sbClient.from("clients").insert({
      name: clean,
      minimum_callout: (minimumCallout || "").trim() || null,
      effective_from: effectiveFrom || todayLocal(),
      gst_rate: gstRateOf(gstRate)
    }).select().single();
    if (error) throw error;
    invalidate("clients");

    // Start them following the house card, literally: the schedule is born
    // with the follows_default flag on, so their tickets price at Default
    // rates until an admin flips the switch and gives them their own card.
    // Best effort: a missing schedule is not a reason to fail the client.
    // supabase-js reports a refusal in `error`, it does not throw — the
    // try/catch this used to be never ran, and a client whose schedule was
    // refused (an account without the rates tab creating one) simply had no
    // card, with the ticket screen the first place to notice.
    const { error: schedErr } = await sbClient.from("rate_schedules").insert({ client_id: data.id, follows_default: true });
    if (schedErr) console.warn("Client created, but their rate schedule was not:", schedErr.message);
    return data;
  },

  // The tax on this client's tickets, as a percent. Zero is exempt and is a
  // real answer, so the rate is normalised rather than falsy-checked — 0 has
  // to reach the database, and a blank box must not.
  //
  // The database is the gate: private.guard_client_update refuses this
  // column to anyone but an Admin, and the refusal comes back as the message
  // the caller shows. Live only — a GST rate is not something to change with
  // no signal and hope it lands, and the ticket in the truck already has the
  // rate it was priced at.
  async updateClientGst(id, gstRate) {
    const { data, error } = await sbClient.from("clients")
      .update({ gst_rate: gstRateOf(gstRate) })
      .eq("id", id).select("id, gst_rate").single();
    if (error) throw error;
    // The client list is cached. A job already open on somebody's screen
    // carries the rate it was joined with and keeps it until that screen
    // loads the job again, which is the same way a client's name behaves.
    invalidate("clients");
    return data;
  },

  // `id` is optional, but the New job dialog always supplies one now, and a
  // job created offline supplies its own (see queueNewJob) so that the id it
  // was given in the field is the id it keeps once it syncs. Minting it on
  // the device is also what lets a create whose response went missing be
  // retried instead of duplicated — see the lookup below.
  async createJob({ id, jobNumber, project, clientName, lsd, afe, createdBy, clientRep, contractorName, contractorRep }) {
    // Writing the two reps back into the directory — persisted server-side
    // now, not localStorage, so the next job for this client/contractor is
    // pre-filled for every coordinator, not just this browser.
    //
    // A local because both early returns below are replays of a job whose
    // insert already landed, and the filing is precisely the step that may
    // not have: it is what fails after the insert and leaves the item
    // queued. Reached only by the tail, the retry that finally succeeded
    // returned the existing row and never filed anybody, so the job showed
    // the organisation's primary rep for ever.
    const fileReps = async (clientId, contractorId) => {
      // Two organisations, so the two filings go out together.
      await Promise.all([
        clientId && clientRep && clientRep.name ? this.rememberContact("client", clientId, clientRep) : null,
        contractorId && contractorRep && contractorRep.name ? this.rememberContact("contractor", contractorId, contractorRep) : null
      ]);
    };

    // Replaying a queued job has to be safe to do twice. The insert can
    // succeed and a later step fail — filing the reps into the directory, say
    // — which leaves the item queued; without this, every retry from then on
    // dies on the job number's unique constraint and the job can never finish
    // syncing. Because the id was minted on the device, "did this already
    // land?" is a question we can actually answer.
    if (id) {
      // The two org ids come back with it, because the reps are filed
      // against them and this branch has no other way to know them: the
      // client lookup below is skipped entirely on the way out.
      const { data: already, error: keyErr } = await sbClient.from("jobs")
        .select("id, client_id, contractor_id").eq("id", id).maybeSingle();
      // A discarded error here is how a queued job pins itself for ever: the
      // lookup fails on a stalled connection, the insert below then dies on
      // jobs_job_number_key because an earlier attempt did land, and the
      // outbox keeps retrying a job that the database already holds. Thrown,
      // a network failure is one the queue simply tries again later.
      if (keyErr) throw keyErr;
      if (already) {
        await fileReps(already.client_id, already.contractor_id);
        return already;
      }
    }

    const { data: client, error: cErr } = await sbClient.from("clients").select("id").eq("name", clientName).single();
    if (cErr) throw cErr;

    let contractorId = null;
    if (contractorName) {
      const { data: existing } = await sbClient.from("contractors").select("id").eq("name", contractorName).maybeSingle();
      if (existing) contractorId = existing.id;
      else {
        const { data: created, error: crErr } = await sbClient.from("contractors").insert({ name: contractorName }).select("id").single();
        if (crErr) throw crErr;
        contractorId = created.id;
      }
    }

    const row = {
      job_number: jobNumber, project, client_id: client.id, contractor_id: contractorId,
      lsd, afe: String(afe || "").trim() || null, status: "Active", created_by: createdBy
    };
    if (id) row.id = id;
    const { data: job, error } = await sbClient.from("jobs").insert(row).select().single();
    // job_number is UNIQUE, so this is the guard that actually holds — the
    // check on the form is a courtesy that can lose a race with another
    // coordinator. Left raw it reads "duplicate key value violates unique
    // constraint jobs_job_number_key", which is not something to hand
    // somebody in a truck.
    if (error) {
      if (isDuplicateJobNumber(error)) {
        // Taken — but by whom? A replay whose first attempt committed after
        // the lookup above read collides with itself, and the honest answer
        // to "create this job" is the row it already made. Only if the id
        // isn't there is the number really somebody else's.
        if (id) {
          const { data: mine } = await sbClient.from("jobs").select("id, job_number, client_id, contractor_id").eq("id", id).maybeSingle();
          if (mine && mine.job_number === jobNumber) {
            // Its own replay, one step further on than the lookup above —
            // and owed the same filing, for the same reason.
            await fileReps(mine.client_id, mine.contractor_id);
            return { id: mine.id };
          }
        }
        throw new Error(jobNumberTakenMessage(jobNumber));
      }
      throw error;
    }
    // The chat's linkifier caches the number list; a just-created job
    // should linkify on the next chat visit, not after a TTL.
    invalidate("job_numbers");

    await fileReps(client.id, contractorId);
    return job;
  },

  // Starting a job on site, with no signal.
  //
  // The id is minted here rather than by Postgres, which is the whole trick:
  // a job created at 07:00 in a truck needs a real `job_id` immediately,
  // because the JHA filed against it ten minutes later and the ticket raised
  // at the end of the day both have to point at something. Letting the
  // database assign it at sync time would mean rewriting every queued item
  // that referenced the temporary one. A uuid minted on the device is already
  // unique and survives the trip unchanged.
  //
  // The job number is the one thing that can't be settled out here: it is
  // UNIQUE and nothing on this device knows what the office has issued. So it
  // is typed, not suggested, and a collision surfaces in the queue panel as a
  // refusal to sync rather than being silently resolved.
  // …and when the caller has already minted one, that is the id this uses.
  // The New job dialog does: it tries createJob first, and a lost response
  // (the 30-second abort rethrows as a network error) sends it here. Minting
  // a second uuid at that point would queue a job the database may well
  // already hold under the first one, and the replay — finding no row with
  // the new id — would die on the job number's unique index for ever, taking
  // the day's JHA and ticket with it.
  async queueNewJob({ id: givenId, jobNumber, project, clientId, clientName, lsd, afe, createdBy, createdByName, clientRep, contractorName, contractorRep }) {
    const id = givenId || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

    const contractors = await this.listContractors().catch(() => []);
    const known = contractorName ? contractors.find(c => c.name === contractorName) : null;

    const job = {
      dbId: id, id: jobNumber, project,
      client: clientName || "", clientId: clientId || null,
      contractor: contractorName || "", contractorId: known ? known.id : null,
      lsd, afe: String(afe || "").trim() || null, area: null, method: null, procedure: null,
      scope: "RT · scope TBD", status: "Active",
      createdBy: createdByName || "", createdAt: stamp(new Date().toISOString())
    };

    await OfflineQueue.enqueue("job", {
      id, jobNumber, project, clientName, lsd, afe, createdBy,
      clientRep, contractorName, contractorRep
    });

    // Make it a real job as far as this device is concerned: on the board,
    // openable, and with empty history rather than absent history — an
    // absent key reads as "couldn't load", an empty one as "none on file yet".
    OfflineCache.put("job." + id, job);
    OfflineCache.put("jhas." + id, []);
    OfflineCache.put("reports." + id, []);
    OfflineCache.put("tickets." + id, []);
    // The two rep columns as well, which the record reads from a key of their
    // own. Not a stand-in: createJob never sets client_contact_id or
    // contractor_contact_id, so the organisations' primaries genuinely are
    // this job's reps until somebody edits them, and null for both is exactly
    // what the row will say when it syncs. Without it, getJobRecord's read
    // fails out of range and the job comes back repsUnknown — Create ticket
    // and Edit greyed out on a job the crew raised in the field minutes ago.
    OfflineCache.put("job.reps." + id, { client_contact_id: null, contractor_contact_id: null });
    const board = await OfflineCache.read("jobs.recent").catch(() => null);
    const rows = board && board.value && board.value.rows ? board.value.rows : [];
    OfflineCache.put("jobs.recent", {
      rows: [job, ...rows.filter(r => r.dbId !== id)],
      total: (board && board.value ? board.value.total : 0) + 1
    });
    // And the client's open-jobs list, which is the New ticket dialog's only
    // source out of range: without this the crew can raise a job in the field
    // and then not be able to bill against it until the queue drains.
    // Only when a list is already remembered, though — writing one where
    // there was none turns "this device doesn't know that client's jobs" into
    // "that client has exactly one open job", and the dialog states it as
    // fact. Same head-of-list, dedupe-by-dbId as the board above, because a
    // retried createJob comes back here with the id it already minted.
    if (clientId) {
      const listKey = "jobs.client." + clientId;
      const list = await OfflineCache.read(listKey).catch(() => null);
      if (list && Array.isArray(list.value)) {
        OfflineCache.put(listKey, [job, ...list.value.filter(r => r.dbId !== id)]);
      }
    }

    return job;
  },

  // Files the rep a job was created with into the directory. This was a single
  // upsert onto a unique (org_type, org_id) — which meant every new job
  // overwrote the organisation's one contact. Now it matches on the person
  // (name, case-insensitive) and adds them alongside the others.
  async rememberContact(orgType, orgId, rep) {
    const name = (rep.name || "").trim();
    if (!name) return;
    const existing = await this.listContactsForOrg(orgType, orgId);
    const match = existing.find(c => (c.name || "").trim().toLowerCase() === name.toLowerCase());
    const stampNow = new Date().toISOString();
    if (match) {
      // Only fill blanks — a rep typed in a hurry on the job form shouldn't
      // wipe a phone number someone curated in the directory.
      const patch = { last_used_at: stampNow };
      if (!match.email && rep.email) patch.email = rep.email.trim();
      if (!match.phone && rep.phone) patch.phone = rep.phone.trim();
      await sbClient.from("contacts").update(patch).eq("id", match.id);
      invalidate("contacts");
      return;
    }
    await sbClient.from("contacts").insert({
      org_type: orgType, org_id: orgId, name,
      email: (rep.email || "").trim() || null,
      phone: (rep.phone || "").trim() || null,
      is_primary: !existing.some(c => c.is_primary),
      last_used_at: stampNow
    });
    // Like every other contacts write: the job record read moments after
    // creating a job goes through the 30-second contacts cache, and without
    // this the brand-new client's rep came back blank for that long.
    invalidate("contacts");
  },

  // ── JHAs ─────────────────────────────────────────────────────────────
  async listJhasForJob(jobDbId) {
    return OfflineCache.readThrough("jhas." + jobDbId, async () => {
    // `hazards` comes back too: Job detail shows what the last filed JHA
    // actually covered, rather than a fixed sample list.
    const { data, error } = await sbClient
      .from("jhas").select(JHA_COLUMNS)
      .eq("job_id", jobDbId).order("signed_at", { ascending: false });
    if (error) throw error;
    return data.map(shapeJha);
    });
  },

  // How this person last rated each hazard, so the JHA builder can start from
  // their own judgement instead of blank.
  //
  // No new table for this: every filed assessment already stores its ratings
  // inside `jhas.hazards`, so "what did I put last time" is a question the
  // existing records can answer. A separate preferences table would be a
  // second copy of the same fact, free to drift from what was actually filed.
  //
  // Merged field by field, newest first. Severity, probability and frequency
  // are set independently and often partially — someone who only changed the
  // severity last time should still get their usual probability back, not a
  // blank next to it.
  // The site information and equipment record of the job's most recent
  // assessment — muster point, communication, hospital, first aid, the H₂S
  // serial, the switches — so day two of a job doesn't retype day one.
  // Cached per job like the rest of the job's paperwork.
  async lastJhaDetailsForJob(jobDbId) {
    if (!jobDbId) return null;
    return OfflineCache.readThrough("jha.last." + jobDbId, async () => {
      const { data, error } = await sbClient
        .from("jhas").select("details, work_date, signed_at")
        .eq("job_id", jobDbId)
        .order("signed_at", { ascending: false })
        .limit(1).maybeSingle();
      if (error) throw error;
      if (!data || !data.details) return null;
      return { site: data.details.site || null, equipment: data.details.equipment || null, workDate: data.work_date || null };
    });
  },

  async lastHazardRatings(profileId) {
    if (!profileId) return {};
    return OfflineCache.readThrough("hazardratings." + profileId, async () => {
      const { data, error } = await sbClient
        .from("jhas").select("hazards, signed_at")
        .eq("signed_by", profileId)
        .order("signed_at", { ascending: false })
        .limit(25);
      if (error) throw error;

      const remembered = {};
      for (const row of data || []) {
        const list = Array.isArray(row.hazards) ? row.hazards : [];
        for (const h of list) {
          if (!h || !h.name || !h.rating) continue;
          const seen = remembered[h.name] || (remembered[h.name] = {});
          for (const key of ["s", "p", "f"]) {
            if (seen[key] === undefined && h.rating[key]) seen[key] = h.rating[key];
          }
        }
      }
      // Drop any hazard that ended up with nothing on it.
      Object.keys(remembered).forEach(name => {
        if (!Object.keys(remembered[name]).length) delete remembered[name];
      });
      return remembered;
    });
  },

  // Is there an assessment still waiting on its end readings? The ticket
  // screens ask this to remind rather than to block — a JHA left open is a
  // paperwork problem, not a reason to stop someone billing the day.
  async openJhaForJob(jobDbId) {
    const { data, error } = await sbClient
      .from("jhas").select("id, signed_at").eq("job_id", jobDbId).eq("status", "Open")
      .order("signed_at", { ascending: false }).limit(1);
    if (error) return null;   // pre-migration databases have no status column
    return data && data.length ? data[0] : null;
  },

  // Has a JHA been filed for this job today? Asked when a ticket is raised.
  async jhaFiledToday(jobDbId) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const { data, error } = await sbClient
      .from("jhas").select("id").eq("job_id", jobDbId).gte("signed_at", start.toISOString()).limit(1);
    if (error) return true;    // never nag on the strength of a failed query
    return !!(data && data.length);
  },

  // Closing out: the end readings, and with them the dose. Start is always 0,
  // so the end reading IS the dose for the assessment — computed here rather
  // than trusted from the screen, so both places can't disagree.
  async closeOutJha({ jhaId, dosimetry, closedBy }) {
    const rows = (dosimetry || []).map(d => {
      // The same reading of a comma as every other number field
      // (decimalString): "0,125" is an eighth of a milliroentgen, not 125.
      const raw = d.endReading === "" || d.endReading == null ? null : Number(decimalString(d.endReading));
      // Dose is carried to one decimal place — that's the precision the DRDs
      // are read to, so 2.11 files as 2.1 rather than implying more.
      const dose = raw == null || isNaN(raw) ? null : Math.round(raw * 10) / 10;
      return { ...d, startReading: 0, endReading: dose, doseMr: dose };
    });
    const { data: updated, error } = await sbClient.from("jhas").update({
      dosimetry: rows, status: "Closed", closed_at: new Date().toISOString(), closed_by: closedBy
    }).eq("id", jhaId).select("id");
    if (error) throw error;
    // An update that no row-level security policy allows is not an error: it
    // reports success having changed nothing. Without this check the dialog
    // closed cleanly and the assessment stayed Open, with nothing to explain
    // why — so ask for the row back and treat silence as the failure it is.
    //
    // Silence has two causes, though, and this used to report both as the
    // same one: a permissions problem, naming a migration that is long since
    // applied, when the ordinary cause is the assessment having been deleted
    // on another device between opening the dialog and pressing the button.
    // updateTicket looks again before it blames anybody; so does this now.
    if (!updated || !updated.length) {
      await assertSessionAlive();
      const { data: still, error: rErr } = await sbClient
        .from("jhas").select("id").eq("id", jhaId).maybeSingle();
      if (rErr) throw rErr;
      if (!still) {
        throw plainError("That assessment no longer exists — it was deleted on another device, so there is nothing to close out.");
      }
      throw plainError("That assessment wasn't updated — your account isn't allowed to close out this JHA. Ask an admin to close it out, or to give your account the access.");
    }
    // The stored PDF now has end readings on it — redraw it. Awaited here,
    // unlike on filing: close-out is the version anyone files or sends on.
    try { await this.renderJhaPdf(jhaId); }
    catch (e) { console.warn("Closed out, but the PDF didn't re-render:", e.message); }
    return rows;
  },

  // No real PDF is rendered client-side yet (see README) — this stores the
  // hazard selection, signatures and a placeholder filename, which is
  // enough for "Signed JHAs on file" to be real data instead of a mock array.
  async createJha({ jobDbId, template, hazards, signedBy, siteRep, pdfKey, dosimetry, unitNumber, details, workDate, clientKey = null }) {
    // Started before the open check, awaited after it (see createTicket).
    let keyLookup = startKeyLookup("jhas", "*", clientKey);
    await this.assertJobOpen(jobDbId);
    // The same idempotency key tickets and reports carry (jhas.client_key,
    // unique): an assessment whose insert landed but whose answer was lost
    // on the radio replays from the outbox as a lookup of the row that
    // already exists, not as a second signed safety record for the day.
    // The pre-started lookup is consumed once; the 23505 branch below calls
    // this a second time, after the insert was refused, and must read the
    // database again — re-awaiting the settled promise gave it the same
    // null that led to the insert, and the row on file was never returned.
    const existing = async () => {
      const pending = keyLookup || startKeyLookup("jhas", "*", clientKey);
      keyLookup = null;
      const { data: already, error: keyErr } = await pending;
      if (keyErr) throw keyErr;
      // The row that landed while its answer was lost never had its PDF
      // rendered either — the render is fired from the insert path, which
      // that first attempt never reached. Rendering here is idempotent
      // (close-out renders over the same key), and without it the filed
      // assessment carried a pdf_key with nothing behind it.
      if (already) this.renderJhaPdf(already.id).catch(e => console.warn("JHA on file, but the PDF didn't render:", e.message));
      return already;
    };
    if (clientKey) {
      const already = await existing();
      if (already) return already;
    }
    const { data, error } = await sbClient.from("jhas").insert({
      job_id: jobDbId, template, hazards, signed_by: signedBy, site_rep: siteRep,
      // signed_at is when this was written down and is never editable;
      // work_date is the day it covers and is.
      signed_at: new Date().toISOString(), work_date: workDate || null, pdf_key: pdfKey,
      dosimetry: dosimetry || [], unit_number: unitNumber || null,
      details: details || {}, status: "Open", client_key: clientKey
    }).select().single();
    if (error) {
      // 23505 on the key: this very assessment landed a moment ago.
      if (error.code === "23505" && clientKey && /client_key/.test(error.message || "")) {
        const already = await existing();
        if (already) return already;
      }
      throw error;
    }
    // Render the PDF, best effort: a failed render must not lose an assessment
    // that has already been filed. A re-render happens at close-out anyway.
    this.renderJhaPdf(data.id).catch(e => console.warn("JHA filed, but the PDF didn't render:", e.message));
    return data;
  },

  // Draws the FLHA as a PDF in the render-jha Edge Function and files it in
  // the private `jhas` bucket. Called on filing and again on close-out, so the
  // stored document always matches the row.
  async renderJhaPdf(jhaId) {
    const { data, error } = await sbClient.functions.invoke("render-jha", { body: { jhaId } });
    if (error) throw await fnError(error);
    return data;
  },

  // Emails the assessment's PDF. Unlike a report — which is stored first and
  // emailed second, so it can sit as Pending and be resent — a JHA already
  // exists by the time anyone sends it, so this is only the send. The
  // function stamps sent_at/sent_to on success.
  async sendJhaEmail({ jhaId, to, cc, message }) {
    const { data, error } = await sbClient.functions.invoke("send-jha", {
      body: { jhaId, to, cc, message }
    });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    return data;
  },

  // Removes an assessment and its stored PDF. A technician removes their
  // own filings; an Admin removes any — the RLS policy is the enforcement;
  // this reports the refusal rather than letting a delete that touched
  // nothing pass as success.
  async deleteJha(jhaId) {
    const { data: rows, error: readErr } = await sbClient
      .from("jhas").select("pdf_key").eq("id", jhaId);
    if (readErr) throw readErr;
    // Already gone — deleted from another device, or a double-tap. The goal
    // state is reached; without this, the zero-row delete below would blame
    // the person's permissions for a row that simply no longer exists.
    if (!rows || !rows.length) return;
    const pdfKey = rows[0].pdf_key;

    const { data: gone, error } = await sbClient
      .from("jhas").delete().eq("id", jhaId).select("id");
    if (error) throw error;
    // A delete no policy allows is not an error: it reports success having
    // removed nothing. Ask for the rows back and treat silence as a refusal.
    if (!gone || !gone.length) {
      throw new Error("That assessment wasn't deleted — a hazard assessment can only be removed by the technician who filed it, or an Admin.");
    }
    // The PDF goes with the row, best effort: an orphaned object in a private
    // bucket is untidy, not wrong, and must not resurrect the delete's error
    // state after the record is already gone.
    if (pdfKey) {
      try { await sbClient.storage.from("jhas").remove([pdfKey]); }
      catch (e) { console.warn("JHA deleted, but its PDF wasn't removed:", e.message); }
    }
  },

  // ── Equipment ────────────────────────────────────────────────────────
  // Equipment tracking — exposure devices, survey meters, dosimeters, tools.
  // Read is open to anyone with the tab; write is re-checked at the database
  // (see the equipment write policy) since Admin/Coordinator-only is a real
  // permission boundary, not just a hidden button.
  // Every piece there is — paged, since this was the one all-of-them read
  // left that PostgREST would have capped at 1,000 without a word.
  async listEquipment() {
    return OfflineCache.readThrough("equipment.all", async () => {
    const data = await fetchAllPages(async (page, size) => {
      const { data: rows, error, count } = await sbClient
        .from("equipment").select("*, profiles(name)", page === 0 ? { count: "exact" } : {})
        .order("type").order("serial_number").order("id")
        .range(page * size, page * size + size - 1);
      if (error) throw error;
      return { rows: rows || [], total: count ?? (rows || []).length };
    });
    return data.map(e => ({
      id: e.id, type: e.type, serial: e.serial_number,
      calibrationDue: e.calibration_due, assignedTo: e.assigned_to,
      assignedName: e.profiles ? e.profiles.name : "", status: e.status
    }));
    });
  },

  async getEquipmentStats() {
    const { data, error } = await sbClient.rpc("equipment_stats");
    if (error) throw error;
    const r = (data && data[0]) || {};
    return { overdue: Number(r.overdue_count || 0), dueSoon: Number(r.due_soon_count || 0) };
  },

  async searchEquipment({ page = 0, pageSize = 10, filter = "All", search = "" } = {}) {
    const { data, error } = await sbClient.rpc("search_equipment", { filter_key: filter, page_num: page, page_size: pageSize, search: String(search || "").trim() });
    if (error) throw error;
    const rows = (data || []).map(e => ({
      id: e.id, type: e.type, serial: e.serial_number,
      calibrationDue: e.calibration_due, assignedTo: e.assigned_to,
      assignedName: e.assigned_name || "", status: e.status
    }));
    const total = data && data.length ? Number(data[0].total_count) : 0;
    return { rows, total };
  },

  async createEquipment({ type, serial, calibrationDue, assignedTo, status }) {
    const { error } = await sbClient.from("equipment").insert({
      type, serial_number: (serial || "").trim() || null,
      calibration_due: calibrationDue || null, assigned_to: assignedTo || null,
      status: status || "In service"
    });
    if (error) throw error;
  },

  async updateEquipment(id, { type, serial, calibrationDue, assignedTo, status }) {
    const { error } = await sbClient.from("equipment").update({
      type, serial_number: (serial || "").trim() || null,
      calibration_due: calibrationDue || null, assigned_to: assignedTo || null, status
    }).eq("id", id);
    if (error) throw error;
  },

  async deleteEquipment(id) {
    const { error } = await sbClient.from("equipment").delete().eq("id", id);
    if (error) throw error;
  },

  // ── Reports ──────────────────────────────────────────────────────────
  async listReportsForJob(jobDbId) {
    return OfflineCache.readThrough("reports." + jobDbId, async () => {
    const { data, error } = await sbClient
      .from("reports").select("*").eq("job_id", jobDbId).order("uploaded_at", { ascending: false });
    if (error) throw error;
    return data.map(shapeReport);
    });
  },

  // Uploads the actual PDF to the private `reports` bucket, then records
  // the row. Falls back to storing metadata only if the browser gave us no
  // File (the mobile screen's demo rows, or a same-name collision).
  async uploadReport({ jobDbId, jobNumber, file, welds, result, interpretedBy, send, sendTo, clientKey = null }) {
    // Started before the open check, awaited after it (see createTicket).
    const keyLookup = startKeyLookup("reports", "*", clientKey);
    await this.assertJobOpen(jobDbId);
    // The same idempotency key as createTicket: a report whose insert landed
    // but whose answer was lost must not be filed — and emailed — twice.
    // A lookup that failed is not a lookup that found nothing: proceeding
    // past a refused or malformed pre-check is exactly the double filing
    // the key exists to prevent, so its error is the save's error.
    if (keyLookup) {
      const { data: already, error: keyErr } = await keyLookup;
      if (keyErr) throw keyErr;
      if (already) return already;
    }
    let pdfKey = null;
    if (file) {
      // The key is sanitised, the display name is not: storage refuses
      // non-ASCII keys and mangles # ? % — a phone-named "Réport 📷.pdf"
      // failed outright in beta testing. The reports row below keeps the
      // original name for every screen that shows it.
      const path = `${storageKeySafe(jobNumber, "job")}/${Date.now()}-${storageKeySafe(file.name, "report.pdf")}`;
      const { error: upErr } = await sbClient.storage.from("reports").upload(path, file);
      if (upErr) {
        if (/row-level security/i.test(upErr.message || "")) {
          throw new Error("Your account doesn't have the Report upload or Job detail tab, so the file can't be stored — an admin can grant access in Users & access.");
        }
        throw upErr;
      }
      pdfKey = path;
    }
    const { data, error } = await sbClient.from("reports").insert({
      job_id: jobDbId, filename: file ? file.name : "report.pdf", pdf_key: pdfKey,
      welds, result, interpreted_by: interpretedBy,
      sent_at: send ? new Date().toISOString() : null, sent_to: send ? sendTo : null,
      client_key: clientKey
    }).select().single();
    if (error) {
      // The row for this key exists after all — the first attempt's answer
      // was lost. Hand that row back, and drop the copy of the PDF this
      // attempt just stored so the bucket doesn't keep an orphan.
      if (error.code === "23505" && clientKey && /client_key/.test(error.message || "")) {
        const { data: already } = await sbClient.from("reports").select("*").eq("client_key", clientKey).maybeSingle();
        if (already) {
          if (pdfKey && pdfKey !== already.pdf_key) await sbClient.storage.from("reports").remove([pdfKey]).then(() => {}, () => {});
          return already;
        }
      }
      throw error;
    }
    return data;
  },

  // Both buckets are private: a stored object has no public URL, so viewing a
  // PDF means minting a signed one at click time. 10 minutes is plenty to open
  // it and short enough that a copied link dies quickly.
  //
  // chat-media links are remembered in memory for most of their life: a
  // room of photos signed one link per picture on mount, and a pinned one
  // twice (the strip and the row). Never through OfflineCache — a
  // ten-minute link written to the device would be handed out dead — and
  // only for that bucket, whose objects are never rewritten in place. A
  // caller whose link failed to load passes `fresh` to mint past the memo.
  async signedUrl(bucket, pdfKey, { fresh = false } = {}) {
    if (!pdfKey) return null;
    const mint = async () => {
      const { data, error } = await sbClient.storage.from(bucket).createSignedUrl(pdfKey, SIGNED_URL_LIFE_S);
      if (error) throw error;
      return data.signedUrl;
    };
    if (bucket !== "chat-media") return mint();
    const held = _chatMediaUrls.get(pdfKey);
    if (held && !fresh) {
      if (held.url && Date.now() - held.at < SIGNED_URL_REUSE_MS) return held.url;
      if (held.pending) return held.pending;
    }
    const pending = mint().then(
      url => { _chatMediaUrls.set(pdfKey, { url, at: Date.now() }); return url; },
      e => { if (_chatMediaUrls.get(pdfKey)?.pending === pending) _chatMediaUrls.delete(pdfKey); throw e; }
    );
    _chatMediaUrls.set(pdfKey, { pending });
    return pending;
  },

  // ── Email (Postmark, via Supabase Edge Functions) ────────────────────
  // The Postmark token lives as a Supabase secret and is only ever read
  // server-side — hence going through a function rather than calling the
  // Postmark API from the browser.

  // Removes a report and its stored PDF. The same shape as deleteJha, for the
  // same reasons: RLS is the enforcement (Admin or Technician), a delete that
  // touched no rows is reported as the refusal it is, and the storage object
  // goes second, best effort, so a failed cleanup can't resurrect an error
  // after the record is already gone.
  async deleteReport(reportId) {
    const { data: rows, error: readErr } = await sbClient
      .from("reports").select("pdf_key").eq("id", reportId);
    if (readErr) throw readErr;
    // Already gone — same idempotence as deleteJha, for the same reason.
    if (!rows || !rows.length) return;
    const pdfKey = rows[0].pdf_key;

    const { data: gone, error } = await sbClient
      .from("reports").delete().eq("id", reportId).select("id");
    if (error) throw error;
    if (!gone || !gone.length) {
      throw new Error("That report wasn't deleted — deleting a report takes an Admin or Technician account.");
    }
    if (pdfKey) {
      try { await sbClient.storage.from("reports").remove([pdfKey]); }
      catch (e) { console.warn("Report deleted, but its PDF wasn't removed:", e.message); }
    }
  },

  async sendReportEmail({ reportId, to, cc, message }) {
    const { data, error } = await sbClient.functions.invoke("send-report", {
      body: { reportId, to, cc, message }
    });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    return data;
  },

  // The field invoice for a ticket, as HTML, rendered by the same code that
  // renders the client's copy. The office view and the client's copy are then
  // one document rather than two descriptions of one.
  //
  // Comes back as a string in JSON rather than as an HTML response on purpose:
  // Supabase rewrites HTML served from the functions domain to text/plain, and
  // the app drops this into an iframe anyway.
  async renderTicketInvoice(ticketId) {
    const { data, error } = await sbClient.functions.invoke("render-invoice", { body: { ticketId } });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    return data.html;
  },

  // ── Admin screen settings ──────────────────────────────────────────────
  // The single app_settings row: every vendor key and deployment address
  // the app needs (Resend, KLIPY, the approval-link base). RLS keeps it
  // Admin-only, so everyone else errors rather than reads blanks.
  async getAppSettings() {
    const { data, error } = await sbClient.from("app_settings")
      .select("resend_api_key, from_reports, from_billing, reply_to, klipy_api_key, approval_base_url, invoice_terms, invoice_remit_to, business_number").maybeSingle();
    if (error) throw error;
    return data || {};
  },

  async saveAppSettings({ resendApiKey, fromReports, fromBilling, replyTo, klipyApiKey, approvalBaseUrl,
    invoiceTerms, invoiceRemitTo, businessNumber }) {
    // The approval link is built as `${base}/approve?t=…` and dropped into
    // an email — a bare "app.example.com" renders as dead text in every
    // client's inbox and errors nowhere. Refuse the shapes that can't work.
    // The sending addresses must live on a domain verified in Resend, and
    // personal-mail domains can never be — Resend 403s every send "from"
    // gmail and friends. Refusing here, with the way out named, beats the
    // trap found in testing: filling these with a personal address turns
    // testing mode off and breaks all sending at once.
    const FREEMAIL = /@(gmail|googlemail|hotmail|outlook|live|msn|yahoo|icloud|me\.com|aol|proton|protonmail|shaw|telus)\b/i;
    for (const [label, v] of [["Reports come from", fromReports], ["Billing comes from", fromBilling]]) {
      const a = (v || "").trim();
      if (a && FREEMAIL.test(a)) {
        throw new Error(`${label} can't be a personal ${a.split("@")[1] || ""} address — Resend only sends from a domain verified in your Resend account. Leave it blank to stay in testing mode, or use an address on the verified company domain.`);
      }
    }
    const base = (approvalBaseUrl || "").trim();
    if (base) {
      let parsed = null;
      try { parsed = new URL(base); } catch { /* not a URL at all */ }
      if (!parsed || !/^https?:$/.test(parsed.protocol)) {
        throw new Error("The app address needs to be a full URL starting with https:// — for example https://app.example.com.");
      }
      if (parsed.search || (parsed.pathname && parsed.pathname !== "/")) {
        throw new Error("The app address should be just the site's root — no path or ? on the end.");
      }
    }
    const { error } = await sbClient.from("app_settings").upsert({
      id: true,
      resend_api_key: (resendApiKey || "").trim() || null,
      from_reports: (fromReports || "").trim() || null,
      from_billing: (fromBilling || "").trim() || null,
      reply_to: (replyTo || "").trim() || null,
      klipy_api_key: (klipyApiKey || "").trim() || null,
      approval_base_url: (approvalBaseUrl || "").trim().replace(/\/+$/, "") || null,
      // What the field invoice prints besides the money. Blank saves null,
      // and a null prints nothing at all — an invoice with an empty "Terms:"
      // on it looks like a document somebody forgot to finish. The remit-to
      // block keeps its line breaks: it is an address.
      invoice_terms: (invoiceTerms || "").trim() || null,
      invoice_remit_to: (invoiceRemitTo || "").trim() || null,
      business_number: (businessNumber || "").trim() || null,
      updated_at: new Date().toISOString()
    });
    if (error) throw error;
  },

  // One proof email through the real sending path, from the Email setup
  // screen. The response names the from-address actually used, so the
  // screen can say whether it went out under the test sender or the
  // verified domain.
  async sendTestEmail(to) {
    const { data, error } = await sbClient.functions.invoke("mail-test", { body: { to } });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    return data;
  },

  // The drawer's Feature request form, mailed to the owner by the function
  // (which fixes the recipient itself). A direct call, never queued: it is
  // a nice-to-have, and a form that fails offline says so and keeps its
  // words in the dialog for another try.
  async sendFeatureRequest({ title, details }) {
    const { data, error } = await sbClient.functions.invoke("feature-request", { body: { title, details } });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    return data;
  },

  // ── Automatic backup ───────────────────────────────────────────────────
  // Everything the panel is allowed to know, in one Admin-only definer RPC.
  // The refresh token and the three client secrets are in the same row and
  // are deliberately not in the answer — backup_state() reports them as
  // has_secret_google and friends, so a browser can say "a secret is set"
  // without ever holding one.
  async backupState() {
    const { data, error } = await sbClient.rpc("backup_state");
    if (error) throw error;
    return data || {};
  },

  // The schedule and the three app registrations. A blank secret field
  // means "leave the stored one alone", never "erase it": the panel cannot
  // show a stored secret, so an empty box is the normal state and treating
  // it as a deletion would silently break the connection on every save.
  // backupSettingsPatch is where that lives, and where it is tested.
  // Loaded when called, not at the top of this file: db.js is in every
  // screen's chunk, and a static import here put the backup panel's logic
  // (and the Edmonton date math behind nextRunAt) into the shell every
  // field phone downloads. The panel is the only caller.
  async saveBackupSettings(form) {
    const { backupSettingsPatch } = await import("./backupPanelLogic.js");
    const { error } = await sbClient.from("app_settings").upsert(backupSettingsPatch(form, Date.now()));
    if (error) throw error;
  },

  // The consent URL is minted server-side, because it carries a nonce that
  // only the function may write. The panel sends the browser to what comes
  // back; the drive sends it to /backup/oauth/<provider> afterwards.
  async backupOauthStartUrl(provider) {
    const { data, error } = await sbClient.functions.invoke("backup-oauth", { body: { action: "start", provider } });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    if (!data || !data.url) throw new Error("The drive didn't give a sign-in address.");
    return data.url;
  },

  async disconnectBackup() {
    const { data, error } = await sbClient.functions.invoke("backup-oauth", { body: { action: "disconnect" } });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
  },

  // "Back up now" — a queued run, and an answer straight away. The function
  // starts the first slice itself and abandons it: a slice is a hundred
  // seconds of work and nothing here is going to wait for one. The panel
  // watches backup_runs for what happens next.
  async backupNow() {
    const { data, error } = await sbClient.functions.invoke("backup-run", { body: { action: "now" } });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    return data || {};
  },

  // What is in the drive, newest first. Each entry is read from that
  // folder's own manifest, so a folder with none is reported incomplete
  // rather than offered as something to restore from.
  async listBackups() {
    const { data, error } = await sbClient.functions.invoke("backup-run", { body: { action: "list" } });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    return (data && data.backups) || [];
  },

  // The whole manifest, including the jobs index the per-job restore picks
  // from. Fetched only when that dialog opens: it is the big one.
  async backupManifest(folderId) {
    const { data, error } = await sbClient.functions.invoke("backup-run", { body: { action: "manifest", folderId } });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    return (data && data.manifest) || null;
  },

  // The run in flight, if there is one — read straight from the table,
  // which an Admin may select and nobody may write.
  async currentBackupRun() {
    const { data, error } = await sbClient.from("backup_runs")
      .select("id, kind, status, phase, counts, error, folder_name, created_at, started_at, finished_at, heartbeat_at")
      .in("status", ["queued", "running"]).order("created_at").limit(1).maybeSingle();
    if (error) throw error;
    return data || null;
  },

  async listBackupRuns(limit = 10) {
    const { data, error } = await sbClient.from("backup_runs")
      .select("id, kind, status, phase, counts, error, folder_name, created_at, started_at, finished_at")
      .order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return data || [];
  },

  // A poke while somebody is watching, so a run does not sit still between
  // five-minute cron ticks. Fire and forget: the panel polls the table for
  // the truth, and a failed nudge costs nothing.
  async nudgeBackup() {
    try { await sbClient.functions.invoke("backup-run", { body: { action: "tick" } }); }
    catch { /* the cron is the safety net */ }
  },

  // What the restore dialog needs before it offers anything: whether this
  // backup may be loaded into this database at all, and how big it is. The
  // schema comparison is the server's — the browser has no way to know which
  // migration this project last applied.
  async restorePreflight(folderId) {
    const { data, error } = await sbClient.functions.invoke("backup-restore", {
      body: { action: "preflight", folderId }
    });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    return data || {};
  },

  // The typed folder name goes to the server as well as being checked in the
  // dialog: the browser's copy of a gate is a courtesy, and the function's is
  // the gate. The answer comes back the moment the run is on the table — the
  // restore itself takes as long as the backup did, and the panel watches
  // backup_runs for the rest of it.
  async restoreAll({ folderId, folderName, confirm }) {
    const { data, error } = await sbClient.functions.invoke("backup-restore", {
      body: { action: "restore_all", folderId, folderName, confirm }
    });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    return data || {};
  },

  // Putting a few jobs back — the everyday mistake, as opposed to the
  // disaster. There is no typed word here because nothing is deleted and
  // nothing live is overwritten: a record already in the app is left alone,
  // and a ticket number already in use comes back as a collision the panel
  // lists by name rather than a second ticket bearing somebody's invoice
  // reference.
  async restoreJobs({ folderId, folderName, jobIds }) {
    const { data, error } = await sbClient.functions.invoke("backup-restore", {
      body: { action: "restore_jobs", folderId, folderName, jobIds }
    });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    return data || {};
  },

  async sendTicketApproval({ ticketId, to, cc }) {
    const { data, error } = await sbClient.functions.invoke("send-ticket-approval", {
      body: { ticketId, to, cc }
    });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    return data;
  },

  // Pulls a sent ticket back before the client signs it. Not a delete: the
  // day's lines and crew hours stay put, the ticket goes back to Draft to be
  // fixed and resent, and the client's signing link dies with the token —
  // approve-ticket looks the row up by that token, so a cleared token is a
  // dead link, not a link to a draft.
  //
  // The status filter on the update is the race with the client: if they
  // signed a moment ago, zero rows change here (RLS refuses too, on
  // approved_at) and the refusal says what probably happened. Approved and
  // invoiced tickets are the client's document — same line deleteTicket
  // draws.
  async withdrawTicketApproval(ticketId) {
    // A definer RPC, because the token columns are no longer any signed-in
    // account's to write (the round-three column grant on tickets: the
    // editor gets status, the reps, delays and chased_at, and nothing else).
    // The function applies the same own-or-office rule as any ticket write
    // and answers with the number of rows it changed.
    const { data: changed, error } = await sbClient.rpc("withdraw_ticket_approval", { p_id: ticketId });
    if (error) throw error;
    if (!changed) {
      throw new Error("That approval wasn't cancelled — the client may have just approved it, or the ticket isn't yours. Reload the job to see where it stands.");
    }
  },

  // The Job record panel. Assembled from the job row plus the two directory
  // contacts, rather than kept as its own table — otherwise "Contractor" here
  // and the contractor column on the dispatch board are two different facts
  // that quietly disagree.
  async getJobRecord(job) {
    // Started here, awaited after the reps read below: neither needs the
    // other, and on a cold app the directory is a full paged walk that the
    // panel used to wait out before the reps read even began. The no-op
    // catch marks a rejection handled until the await below raises it.
    const contactsRead = this.listContacts();
    contactsRead.catch(() => {});

    // Which people this particular job names. `jobs.client_contact_id` and
    // `contractor_contact_id` have been in the schema since the beginning and
    // were never used — the record just showed whoever happened to be the
    // organisation's primary, so every job for a client showed the same rep
    // and editing it did nothing. A job that hasn't named anyone still falls
    // back to the primary, which is what it always did.
    let named = {};
    // True when the read failed and the reps below are the organisation's
    // primaries rather than this job's own. The panel can still be shown —
    // it is what it always showed — but Edit is not offered, because Save
    // would write the primary back as this job's named rep.
    let repsUnknown = false;
    try {
      // Remembered under its own key rather than folded into "job.<id>":
      // that one is written wholesale by the board for every job on the page
      // and holds the job row, which does not carry these two columns.
      //
      // Read straight from PostgREST, this was the one thing on the panel
      // that could not be had offline — and isNetworkError is true for
      // anything attempted while the radio is off, so every job opened out
      // of range came back repsUnknown and had Create ticket and Edit greyed
      // out for the day, while Home's + Ticket and + New JHA opened on the
      // same record. A job whose record was opened once in range now answers
      // with its own reps.
      named = await OfflineCache.readThrough("job.reps." + job.dbId, async () => {
        // postgrest-js reports a failure in `error`; it does not throw, so
        // the refusal has to be raised by hand for readThrough to see it —
        // and this was a try/catch once, which meant the branch below never
        // ran and every failure, a refusal as much as a dead connection,
        // silently became "this job names nobody".
        const { data, error } = await sbClient.from("jobs")
          .select("client_contact_id, contractor_contact_id").eq("id", job.dbId).maybeSingle();
        if (error) throw error;
        return data || {};
      }) || {};
    } catch (e) {
      // Nothing cached and the read really failed. The primaries are a fine
      // stand-in for reading — except for the archive, which asked for the
      // record as it is or not at all. Anything that is not the network is a
      // real answer and belongs to the caller.
      if (OfflineCache.isLiveOnly() || !isNetworkError(e)) throw e;
      repsUnknown = true;
    }

    const contacts = await contactsRead;
    const byId = id => (id && contacts.find(c => c.id === id)) || null;
    const clientContact = byId(named.client_contact_id) || primaryContact(contacts, "client", job.clientId);
    const contractorContact = byId(named.contractor_contact_id) || primaryContact(contacts, "contractor", job.contractorId);

    const fmt = c => c ? [c.name, c.phone, c.email].filter(Boolean).join(" · ") : "";
    // The joined string is what the ticket email and the JHA read; the parts
    // are what the edit form needs so nobody has to type a "·".
    const parts = c => ({
      id: c ? c.id : "", name: c ? c.name : "",
      email: c ? (c.email || "") : "", phone: c ? (c.phone || "") : ""
    });

    return {
      job: job.id,
      client: job.client,
      clientRep: fmt(clientContact),
      clientRepDetail: parts(clientContact),
      contractor: job.contractor || "",
      contractorRep: fmt(contractorContact),
      contractorRepDetail: parts(contractorContact),
      afe: job.afe || "",
      area: job.area || "",
      lsd: job.lsd || "",
      method: job.method || "",
      procedure: job.procedure || "",
      started: job.createdAt || "",
      repsUnknown
    };
  },

  // Turns whatever the job record's rep boxes contain into a contact row, and
  // returns its id. Picking someone from the dropdown and editing their phone
  // number updates the directory entry; typing a name nobody has on file adds
  // them; typing a name somebody else already holds links to them without
  // overwriting them. Returns null for an empty name, which unlinks the rep.
  async resolveJobContact(orgType, orgId, rep) {
    if (!orgId || !rep) return null;
    const name = (rep.name || "").trim();
    if (!name) return null;
    const email = (rep.email || "").trim() || null;
    const phone = (rep.phone || "").trim() || null;

    const existing = await this.listContactsForOrg(orgType, orgId);
    const picked = rep.id ? existing.find(c => c.id === rep.id) : null;
    const match = picked || existing.find(c => (c.name || "").trim().toLowerCase() === name.toLowerCase());

    if (picked) {
      // Somebody chosen from the dropdown and then corrected: the boxes are
      // about this person, so they win. Only write if something actually
      // changed — an unedited pick shouldn't touch the directory at all.
      if (picked.name !== name || (picked.email || null) !== email || (picked.phone || null) !== phone) {
        const { error } = await sbClient.from("contacts")
          .update({ name, email, phone, last_used_at: new Date().toISOString() }).eq("id", picked.id);
        if (error) throw error;
        invalidate("contacts");
      }
      return picked.id;
    }

    if (match) {
      // A name typed over the top of somebody else's. RepEditor drops the
      // link when the name changes but leaves the email and phone boxes
      // alone, so what's in them belongs to the *previous* rep — and this
      // used to write them straight over the person the new name matched,
      // giving a curated directory entry a stranger's phone number.
      //
      // So: rememberContact's rule (fill blanks only), and never the name —
      // the row already carries the spelling everyone else's jobs point at.
      const patch = { last_used_at: new Date().toISOString() };
      if (!match.email && email) patch.email = email;
      if (!match.phone && phone) patch.phone = phone;
      const { error } = await sbClient.from("contacts").update(patch).eq("id", match.id);
      if (error) throw error;
      invalidate("contacts");
      return match.id;
    }

    const { data, error } = await sbClient.from("contacts").insert({
      org_type: orgType, org_id: orgId, name, email, phone,
      is_primary: !existing.some(c => c.is_primary),
      last_used_at: new Date().toISOString()
    }).select("id").single();
    if (error) throw error;
    invalidate("contacts");
    return data.id;
  },

  // Writes the editable fields back to the job. Contractor is matched by name
  // and created if it's new — same behaviour as the New job dialog, so typing
  // a contractor here doesn't silently do nothing.
  async updateJobRecord(job, record) {
    await this.assertJobOpen(job.dbId);
    let contractorId = job.contractorId ?? null;
    const name = (record.contractor || "").trim();
    if (name && name !== (job.contractor || "")) {
      const { data: existing } = await sbClient.from("contractors").select("id").eq("name", name).maybeSingle();
      if (existing) contractorId = existing.id;
      else {
        const { data: created, error } = await sbClient.from("contractors").insert({ name }).select("id").single();
        if (error) throw error;
        contractorId = created.id;
      }
    } else if (!name) {
      contractorId = null;
    }

    // The reps, which this used to drop on the floor: the boxes were editable
    // and nothing was ever written, so a corrected phone number vanished on
    // the next load.
    // Two organisations, nothing shared, so the two reads-and-writes go out
    // together rather than one after the other.
    const [clientContactId, contractorContactId] = await Promise.all([
      this.resolveJobContact("client", job.clientId, record.clientRepDetail),
      contractorId ? this.resolveJobContact("contractor", contractorId, record.contractorRepDetail) : null
    ]);

    const { error } = await sbClient.from("jobs").update({
      contractor_id: contractorId,
      client_contact_id: clientContactId,
      contractor_contact_id: contractorContactId,
      afe: record.afe || null,
      area: record.area || null,
      lsd: record.lsd || null,
      method: record.method || null,
      procedure: record.procedure || null
    }).eq("id", job.dbId);
    if (error) throw error;
    // The remembered copy of this job's reps is now the previous pair, and
    // the next time the panel opens out of range it would show them as
    // though they were the edit that just landed. Removed rather than
    // rewritten: the next read in range fills it again.
    await OfflineCache.remove("job.reps." + job.dbId);
    return contractorId;
  },

  // ── Shared files ─────────────────────────────────────────────────────
  // Backed by a `shared` storage bucket. There is no folders table: Supabase
  // Storage keys are paths, so "Procedures/MND-RT-04.pdf" IS a folder — which
  // means no directory tree to keep in sync with the objects in it.
  //
  // One wrinkle: an empty prefix doesn't exist to the API. Creating a folder
  // writes a zero-byte `.keep` marker inside it, and listings hide that file.

  // Storage caps a listing at 1000 rows and defaults to 100, so a folder that
  // outgrows the page size would silently show only part of itself. Page until
  // a short batch comes back.
  async listAllEntries(prefix) {
    const PAGE = 500;
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await sbClient.storage
        .from("shared")
        .list(prefix, { limit: PAGE, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw error;
      out.push(...(data || []));
      if (!data || data.length < PAGE) return out;
    }
  },

  // Every file in every folder whose name (or path) contains `q` — "where
  // does the RT procedure live?" shouldn't need knowing the folder. Walks
  // the tree one listing per folder (a few dozen at most) and keeps the walk
  // for the session; the Files screen forgets it after any change it makes.
  async searchFiles(q) {
    const needle = String(q || "").trim().toLowerCase();
    if (!needle) return [];
    if (!this._fileTree) {
      this._fileTree = this._walkFiles("").catch(e => { this._fileTree = null; throw e; });
    }
    const all = await this._fileTree;
    return all.filter(f => f.name.toLowerCase().includes(needle) || f.path.toLowerCase().includes(needle));
  },
  async _walkFiles(prefix) {
    const { folders, files } = await this.listFiles(prefix);
    const nested = await Promise.all(folders.map(f => this._walkFiles(f.path)));
    return files.concat(...nested);
  },
  forgetFileTree() { this._fileTree = null; },

  async listFiles(prefix = "") {
    const data = await this.listAllEntries(prefix);

    const folders = [];
    const files = [];
    for (const entry of data) {
      if (entry.name === FOLDER_MARKER) continue;
      // Storage reports a prefix as a row with no id/metadata.
      if (!entry.id) folders.push({ name: entry.name, path: prefix ? `${prefix}/${entry.name}` : entry.name });
      else files.push({
        name: entry.name,
        path: prefix ? `${prefix}/${entry.name}` : entry.name,
        size: entry.metadata ? entry.metadata.size : 0,
        type: entry.metadata ? entry.metadata.mimetype : "",
        at: entry.updated_at || entry.created_at
      });
    }
    return { folders, files };
  },

  async createFolder(prefix, name) {
    // Folder names live inside storage keys, which refuse what filenames
    // allow — same sanitiser as report uploads, same reason.
    const clean = storageKeySafe(name.trim(), "");
    if (!clean) throw new Error("Give the folder a name — letters and numbers, mostly.");
    const path = (prefix ? `${prefix}/` : "") + clean + "/" + FOLDER_MARKER;
    const { error } = await sbClient.storage
      .from("shared").upload(path, new Blob([""]), { upsert: true });
    if (error) throw error;
    return clean;
  },

  async uploadSharedFile(prefix, file) {
    const path = (prefix ? `${prefix}/` : "") + storageKeySafe(file.name, "file");
    const { error } = await sbClient.storage
      .from("shared").upload(path, file, { upsert: false });
    if (error) {
      if (/exists/i.test(error.message)) throw new Error(`“${file.name}” is already in this folder.`);
      throw error;
    }
    return path;
  },

  // Storage's remove does not error on an object the delete policy declines:
  // it comes back absent from the answer. So the answer is checked, the way
  // every zero-row update in this file is — the policy is Admin/Coordinator
  // (20260906181829) and a refused delete has to read as one.
  async deleteSharedFile(path) {
    const { data, error } = await sbClient.storage.from("shared").remove([path]);
    if (error) throw error;
    if (!data || !data.length) throw plainError("That file wasn't deleted — deleting from the shared drive is an Admin's or a Coordinator's.");
  },

  // Removing a folder means removing everything under it — Storage has no
  // recursive delete, so walk the tree and remove the objects.
  async deleteFolder(path) {
    const keys = [];
    // Sibling subfolders are independent — walking them one at a time made a
    // deeply-nested shared drive a slow serial crawl. Each folder's own
    // entries still resolve before recursing into its children.
    const walk = async prefix => {
      const entries = await this.listAllEntries(prefix);
      const subfolders = [];
      for (const entry of entries) {
        const child = `${prefix}/${entry.name}`;
        if (!entry.id) subfolders.push(child);
        else keys.push(child);
      }
      await Promise.all(subfolders.map(walk));
    };
    await walk(path);
    // `remove` takes a bounded list, so delete in batches rather than handing
    // it a folder's worth of keys in one call.
    for (let i = 0; i < keys.length; i += 100) {
      const batch = keys.slice(i, i + 100);
      const { data, error } = await sbClient.storage.from("shared").remove(batch);
      if (error) throw error;
      if ((data || []).length < batch.length) {
        throw plainError("Not everything in that folder was deleted — deleting from the shared drive is an Admin's or a Coordinator's.");
      }
    }
  },

  sharedFileUrl(path) { return this.signedUrl("shared", path); },

  // ── Crew & timesheets ────────────────────────────────────────────────
  // A ticket bills the client one hours figure; the crew rows say how those
  // hours land on each person's timesheet. The two can legitimately differ
  // (a 2-person crew billed as crew-hours), so the ticket screen shows both
  // and never silently forces them to agree.

  async listCrewForTicket(ticketId) {
    const { data, error } = await sbClient
      .from("ticket_crew").select(CREW_COLUMNS).eq("ticket_id", ticketId);
    if (error) throw error;
    const crew = data.map(shapeCrew);
    rememberTicketPart(ticketId, { crew });
    return crew;
  },

  async saveCrewForTicket(ticketId, crew) {
    // Replace rather than diff: a ticket's crew is small and edited as a
    // whole, and this keeps removals from needing their own bookkeeping.
    //
    // Written as an upsert on (ticket_id, profile_id), then a delete of
    // whoever is no longer on the crew. It used to be delete-then-insert with
    // the old rows held back, the shape updateTicket still keeps for the
    // billing lines. Two devices saving one draft in the same instant
    // interleaved as A-delete, B-delete, A-insert, B-insert, and B's insert
    // collided on the unique key: the technician read the raw constraint name
    // and B's hours were dropped. An upsert cannot collide, so the race is a
    // plain last-write-wins — what the lines already do.
    //
    // The order is the other half of it. The upsert goes first, so a failure
    // anywhere leaves the ticket with a person too many rather than with no
    // crew at all, and the rollback the old shape needed goes with it: crew
    // rows are payroll and the dosimetry record, and an empty crew is the one
    // outcome that must not be reachable.
    if (crew.length) {
      const { error } = await sbClient.from("ticket_crew").upsert(
        crew.map(c => ({
          ticket_id: ticketId, profile_id: c.profileId, crew_role: c.role || "Technician",
          // Hours and mileage bill exactly like a quantity does, and dose is a
          // physical reading — none of them go below zero.
          straight_hours: nonNegative(c.straight), ot_hours: nonNegative(c.ot),
          solo_hours: nonNegative(c.solo), solo_ot_hours: nonNegative(c.soloOt),
          dose_mr: nonNegative(c.dose), mileage_km: nonNegative(c.mileage)
        })),
        { onConflict: "ticket_id,profile_id" }
      );
      if (error) throw humanizeError(error);
    }
    // Whoever came off the crew. This method is not in SAVE_MESSAGES — it is
    // part of saving a ticket, not its own action — so nothing above it
    // translates a refusal into words, which is how the constraint name
    // reached the screen in the first place.
    let gone = sbClient.from("ticket_crew").delete().eq("ticket_id", ticketId);
    const keep = crew.map(c => c.profileId).filter(Boolean);
    if (keep.length) gone = gone.not("profile_id", "in", `("${keep.join('","')}")`);
    const { error: dErr } = await gone;
    if (dErr) throw humanizeError(dErr);
    // The row's crew is now the crew that was sent, so the base a queued save
    // is measured against moves with it (see rememberTicketPart). Recorded in
    // the shape it was stored in — the role default and the floors included —
    // or a later save would be compared against figures that differ only
    // because the database tidied them on the way in.
    rememberTicketPart(ticketId, {
      crew: crew.map(c => ({
        profileId: c.profileId, role: c.role || "Technician",
        straight: nonNegative(c.straight), ot: nonNegative(c.ot),
        solo: nonNegative(c.solo), soloOt: nonNegative(c.soloOt),
        dose: nonNegative(c.dose), mileage: nonNegative(c.mileage)
      }))
    });
  },

  // Every crew entry in a pay period, with the ticket and job behind it —
  // this is the whole timesheet screen in one query.
  async listTimesheetEntries({ start, end }) {
    // Paged to exhaustion rather than fetched in one go: this is what people
    // get paid from, and the 1000-row response cap would silently take hours
    // off the end of a busy period.
    //
    // By key, not by offset. This used to walk ranges concurrently and claim
    // that ordering by id kept them from overlapping — it doesn't: OFFSET
    // counts rows, so a crew row deleted while the read is in flight shifts
    // every later row up and the one that crossed a page boundary is never
    // asked for. One entry short is somebody's afternoon, and nothing on the
    // timesheet says a row is missing. Asking for "the next thousand after
    // this id" costs the concurrency and cannot skip.
    const SELECT = "id, profile_id, crew_role, straight_hours, ot_hours, solo_hours, solo_ot_hours, dose_mr, mileage_km, profiles(name, first_name, last_name, is_subcontractor), tickets!inner(id, work_date, status, jobs(job_number, project, clients(name)))";
    const data = await fetchAllKeyset(async after => {
      let query = sbClient
        .from("ticket_crew")
        .select(SELECT)
        .gte("tickets.work_date", start)
        .lte("tickets.work_date", end);
      if (after != null) query = query.gt("id", after);
      const { data: batch, error } = await query.order("id").limit(RESPONSE_ROW_CAP);
      if (error) throw error;
      return batch || [];
    });

    return data.map(c => {
      const t = c.tickets || {};
      const j = t.jobs || {};
      return {
        id: c.id,
        profileId: c.profile_id,
        name: c.profiles ? fullName(c.profiles) : "",
        isSub: c.profiles ? c.profiles.is_subcontractor : false,
        role: c.crew_role,
        date: t.work_date,
        ticketId: t.id,
        ticketStatus: t.status,
        job: j.job_number || "",
        project: j.project || "",
        client: j.clients ? j.clients.name : "",
        straight: Number(c.straight_hours),
        ot: Number(c.ot_hours),
        solo: Number(c.solo_hours),
        soloOt: Number(c.solo_ot_hours),
        dose: Number(c.dose_mr),
        mileage: Number(c.mileage_km)
      };
    }).sort((a, b) =>
      String(a.date || "").localeCompare(String(b.date || "")) ||
      String(a.ticketId || "").localeCompare(String(b.ticketId || "")));
  },

  async listApprovals({ start }) {
    const { data, error } = await sbClient
      .from("timesheet_approvals")
      .select("profile_id, approved_at, approved_by, pdf_key, profiles!timesheet_approvals_approved_by_fkey(name)")
      .eq("period_start", start);
    if (error) throw error;
    return data;
  },

  // The PDF is what approval means: the figures the admin saw, frozen.
  // The file goes up before the row is written, so an approval can never
  // point at a document that is not there — if the upload fails, the
  // period simply stays unapproved and the admin tries again. One file
  // per person per period at a deterministic path; re-approving a
  // reopened period overwrites it rather than minting a sibling.
  async approveTimesheet({ profileId, start, end, approvedBy, pdfBytes }) {
    let pdfKey = null;
    if (pdfBytes) {
      pdfKey = `${profileId}/${start}.pdf`;
      const { error: upErr } = await sbClient.storage.from("timesheets")
        .upload(pdfKey, new Blob([pdfBytes], { type: "application/pdf" }),
          { upsert: true, contentType: "application/pdf" });
      if (upErr) throw upErr;
    }
    const { error } = await sbClient.from("timesheet_approvals").upsert({
      profile_id: profileId, period_start: start, period_end: end,
      approved_at: new Date().toISOString(), approved_by: approvedBy, pdf_key: pdfKey
    }, { onConflict: "profile_id,period_start" });
    if (error) throw error;
  },

  async unapproveTimesheet({ profileId, start }) {
    const { error } = await sbClient.from("timesheet_approvals")
      .delete().eq("profile_id", profileId).eq("period_start", start);
    if (error) throw error;
    // Best effort: the approval is gone either way, and the path is
    // deterministic, so any orphan is overwritten by the next approve.
    await sbClient.storage.from("timesheets").remove([`${profileId}/${start}.pdf`]).catch(() => {});
  },

  // The "Approved timesheets" tab: every period of yours that has been
  // signed off, newest first. RLS on the storage bucket means the View
  // button only works on your own folder (or all of them for an admin),
  // but the listing itself comes from the approvals table.
  async listMyApprovedTimesheets(profileId) {
    const { data, error } = await sbClient
      .from("timesheet_approvals")
      .select("period_start, period_end, approved_at, pdf_key, profiles!timesheet_approvals_approved_by_fkey(name)")
      .eq("profile_id", profileId)
      .order("period_start", { ascending: false });
    if (error) throw error;
    return (data || []).map(r => ({
      start: r.period_start, end: r.period_end, at: r.approved_at,
      pdfKey: r.pdf_key, by: r.profiles ? r.profiles.name : "—"
    }));
  },

  // ── Tickets ──────────────────────────────────────────────────────────
  async listTicketsForJob(jobDbId) {
    return OfflineCache.readThrough("tickets." + jobDbId, async () => {
    const { data, error } = await sbClient
      .from("tickets").select(JOB_TICKET_COLUMNS)
      .eq("job_id", jobDbId).order("created_at", { ascending: false });
    if (error) throw error;
    return data.map(shapeJobTicket);
    });
  },

  async getTicketTrackerStats() {
    const { data, error } = await sbClient.rpc("ticket_tracker_stats");
    if (error) throw error;
    const r = (data && data[0]) || {};
    return {
      unsigned: { count: Number(r.unsigned_count || 0), total: Number(r.unsigned_total || 0) },
      over7: { count: Number(r.over7_count || 0), total: Number(r.over7_total || 0) },
      approved: { count: Number(r.approved_count || 0), total: Number(r.approved_total || 0) },
      invoiced: { count: Number(r.invoiced_count || 0), total: Number(r.invoiced_total || 0) }
    };
  },

  // How old the outstanding money is, and whose. One row per client per
  // aging bucket over every ticket that has been sent but not been through
  // — the grouping is the database's, because "all of them" here is every
  // ticket ever raised and PostgREST caps a response at 1,000 rows without
  // saying so.
  //
  // The null total is kept as null: ticket_aging nulls the money for a role
  // that may not see prices, and Number(null) is 0 — a figure, and one that
  // reads as a client who owes nothing.
  //
  // A missing routine (PGRST202, or a message naming it) means the migration
  // has not been applied here yet; the error goes back untouched and the
  // tracker decides what to do about it — isMissingTicketAging in
  // ticketAging.js is the test.
  async ticketAging() {
    const { data, error } = await sbClient.rpc("ticket_aging");
    if (error) throw error;
    return (data || []).map(r => ({
      clientId: r.client_id || null,
      client: r.client_name || "",
      bucket: r.bucket,
      count: Number(r.tickets || 0),
      total: r.total == null ? null : Number(r.total)
    }));
  },

  // `q` matches the ticket number, job number, project, client or technician;
  // `from`/`to` bound the work date (YYYY-MM-DD, inclusive). All optional.
  async searchTickets({ page = 0, pageSize = 10, status = "All", q = "", from = null, to = null } = {}) {
    const { data, error } = await sbClient.rpc("search_tickets", {
      status_filter: status, page_num: page, page_size: pageSize,
      q: String(q || "").trim(), date_from: from || null, date_to: to || null
    });
    if (error) throw error;
    const rows = (data || []).map(t => ({
      id: t.id, date: dayMonth(localDate(t.work_date)), workDate: t.work_date,
      age: ageInDays(t.created_at),
      // Null stays null. search_tickets nulls the money for a role that may
      // not see prices, and Number(null) is 0 — a figure, indistinguishable
      // from a ticket that really is worth nothing.
      amount: t.total == null ? null : Number(t.total), status: t.status, tech: t.technician_name || "",
      job: t.job_number || "", project: t.project || "", client: t.client_name || "",
      chasedAt: t.chased_at || null, invoicedAt: t.invoiced_at || null,
      queriedAt: t.queried_at || null, queryText: t.query_text || "", queryBy: t.query_by || "",
      // Not money: the client's tax rate, their id, and the number an
      // invoice went out under, for the tracker and the accounting export.
      // Absent on a database before 20260906 — the export reads absence as
      // the ordinary 5% and a blank cell.
      gstRate: t.client_gst_rate == null ? null : Number(t.client_gst_rate),
      clientId: t.client_id || null,
      // undefined when the column is not on this database at all (the RPC
      // returns no such field), null when it is there and empty — the export
      // reads the difference.
      invoiceNumber: t.invoice_number === undefined ? undefined : (t.invoice_number == null ? null : Number(t.invoice_number))
    }));
    const total = data && data.length ? Number(data[0].total_count) : 0;
    // The money across every matching ticket, not only this page's — null
    // for roles that don't see prices (the function nulls it).
    const filteredTotal = data && data.length && data[0].filtered_total != null ? Number(data[0].filtered_total) : null;
    return { rows, total, filteredTotal };
  },

  // Approved → Invoiced, and back for a slip. Admin-only in the database
  // (mark_tickets_invoiced); the approved-ticket immutability policies are
  // untouched, this RPC is the one door. Returns how many rows moved.
  async markTicketsInvoiced(ticketIds) {
    const { data, error } = await sbClient.rpc("mark_tickets_invoiced", { p_ids: ticketIds, p_invoiced: true });
    if (error) throw error;
    return Number(data || 0);
  },
  async unmarkTicketsInvoiced(ticketIds) {
    const { data, error } = await sbClient.rpc("mark_tickets_invoiced", { p_ids: ticketIds, p_invoiced: false });
    if (error) throw error;
    return Number(data || 0);
  },

  // "Chased" is a fact about the ticket, not about the page: a reload used
  // to forget which clients had been nudged.
  async markTicketChased(ticketId) {
    const { data, error } = await sbClient.from("tickets")
      .update({ chased_at: new Date().toISOString() }).eq("id", ticketId).select("id");
    if (error) throw error;
    if (!data || !data.length) throw plainError(`Ticket ${ticketId} couldn't be flagged — it may have been approved or cancelled meanwhile.`);
  },

  // Every ticket matching a filter, for the accounting export — paged, because
  // "give me all of them" is exactly the request the 1000-row cap silently
  // truncates, and a short CSV of financial records is worse than none.
  //
  // It takes the whole filter the tracker is showing — status, search and the
  // work-date window — not just the status. It used to take the status alone,
  // so an admin who had narrowed the screen to one client's March and pressed
  // Export got a CSV of all history, which looks like a wrong answer to a
  // question nobody asked.
  //
  // Sequential, unlike the other exhaustive reads. search_tickets is an RPC
  // that pages by page_num, and there is no cursor to hand it, so this cannot
  // be walked by key: OFFSET is all there is. Which means the honest caveat —
  // a ticket deleted while the export runs shifts the rows behind it and one
  // can be skipped. Going one page at a time makes the window as narrow as it
  // can be from here; closing it properly needs a cursor on the function.
  async listTicketsForExport({ status = "All", q = "", from = null, to = null } = {}) {
    const all = [];
    // The size the pages are really coming back at. This asks for the cap;
    // if the API's max-rows setting is ever lowered, what page 0 returns is
    // the true page size and every later page has to be asked for at that
    // size, or the offsets step straight over the rows the short page never
    // sent. Stopping on a short page — which is what this used to do — could
    // not tell "that was the last of them" from "that was all it would send".
    let size = RESPONSE_ROW_CAP;
    let total = 0;
    for (let page = 0; ; page++) {
      const res = await this.searchTickets({ page, pageSize: size, status, q, from, to });
      if (!res.rows.length) break;
      for (const r of res.rows) all.push(r);
      if (page === 0) {
        total = res.total;
        if (res.rows.length < size) size = res.rows.length;
      }
      // search_tickets reports how many tickets match, so the walk ends on
      // that count rather than on the shape of a page.
      if (all.length >= total) break;
    }
    return all;
  },

  // What the accounting export knows about a ticket beyond its tracker row:
  // for the per-line export, the charges it is made of. Handed the rows
  // whole, because the invoice number and date ride on search_tickets since
  // 20260906 — they are read off the rows rather than off the tickets again
  // in batches, which was eighty round trips a year for figures already in
  // hand.
  //
  // A database before that migration returns rows with no invoice_number
  // field at all — searchTickets leaves invoiceNumber undefined then, and
  // null when the column is there and empty — and the CSV goes out with
  // those cells blank and a line saying why.
  //
  // The lines are walked by key inside each batch, never by offset. Two
  // hundred tickets carry well over the 1000-row cap in lines alone, so the
  // walk is the read and not a precaution — and line_order is one sequence
  // across the whole table, so "the next thousand after this one" is a true
  // keyset walk. It is also the column the printed invoice orders by, so the
  // CSV lists a ticket's charges in the order the client agreed them. The
  // batches are disjoint sets of tickets, so a few walk at once; the keyset
  // rule is about the order within one walk, which each keeps.
  async listTicketExportDetail(tickets, { withLines = false, batchSize = 200 } = {}) {
    const rows = (tickets || []).filter(t => t && t.id);
    const invoices = {};
    const seen = new Set();
    for (const t of rows) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      invoices[t.id] = { number: t.invoiceNumber == null ? "" : t.invoiceNumber, invoicedAt: t.invoicedAt || null };
    }
    const invoiceNumbers = !rows.length || rows.some(t => t.invoiceNumber !== undefined);
    const lines = {};
    if (withLines) {
      const ids = [...seen];
      const batches = [];
      for (let i = 0; i < ids.length; i += batchSize) batches.push(ids.slice(i, i + batchSize));
      const walked = await mapLimit(batches, EXPORT_LINE_WALKS, batch => fetchAllKeyset(async after => {
        let query = sbClient.from("ticket_lines")
          .select("ticket_id, kind, label, unit, quantity, unit_rate, line_order")
          .in("ticket_id", batch);
        if (after != null) query = query.gt("line_order", after);
        const { data, error } = await query.order("line_order").limit(RESPONSE_ROW_CAP);
        if (error) throw error;
        return data || [];
      }, r => r.line_order));
      for (const batchRows of walked) for (const r of batchRows) (lines[r.ticket_id] || (lines[r.ticket_id] = [])).push(r);
    }
    return { invoices, lines, invoiceNumbers };
  },

  // Every unsigned ticket's client contact, for the tracker's bulk chase —
  // a small, purpose-built fetch rather than paging through search_tickets
  // to reassemble the same thing.
  async listUnsignedTicketContacts() {
    // Paged: "chase everything unsigned" means everything — a capped read
    // would quietly leave the tickets past row 1,000 unchased while the
    // dialog reported the truncated count as the whole job done.
    //
    // By key rather than by offset, for the same reason the timesheet read is:
    // a ticket getting approved or cancelled while this walks (which is
    // exactly what happens on a busy morning) would shift the offsets and drop
    // a still-unsigned ticket out of the chase without a word.
    const data = await fetchAllKeyset(async after => {
      let query = sbClient
        .from("tickets").select("id, client_contact, chased_at, queried_at")
        .eq("status", "Awaiting approval");
      if (after != null) query = query.gt("id", after);
      const { data: rows, error } = await query.order("id").limit(RESPONSE_ROW_CAP);
      if (error) throw error;
      return rows || [];
    });
    // queried_at comes along because a rep who pressed "Query this ticket"
    // is waiting on the office, not on a reminder — and send-ticket-approval
    // clears the query on every resend, so a bulk chase would wipe the
    // question off the tracker before anyone had answered it.
    return data.map(t => ({
      id: t.id, contactLabel: t.client_contact ? t.client_contact.name : "",
      chasedAt: t.chased_at || null, queriedAt: t.queried_at || null
    }));
  },

  // The hazard assessments this person filed and has not closed out yet,
  // across every job — an open JHA is a dose record with no end reading,
  // and until now nothing listed them anywhere but the job's own page.
  async listMyOpenJhas(profileId) {
    const data = await fetchAllPages(async (page, size) => {
      const { data: rows, error, count } = await sbClient
        .from("jhas")
        .select("id, work_date, signed_at, status, job_id, jobs(job_number, project, clients(name))",
          page === 0 ? { count: "exact" } : {})
        .eq("signed_by", profileId)
        .eq("status", "Open")
        .order("signed_at", { ascending: false }).order("id")
        .range(page * size, page * size + size - 1);
      if (error) throw error;
      return { rows: rows || [], total: count ?? (rows || []).length };
    });
    return data.map(j => ({
      id: j.id, jobDbId: j.job_id,
      job: j.jobs ? j.jobs.job_number : "", project: j.jobs ? j.jobs.project : "",
      client: j.jobs && j.jobs.clients ? j.jobs.clients.name : "",
      workDate: j.work_date, filedAt: j.signed_at, age: ageInDays(j.signed_at)
    }));
  },

  async listMyTickets(technicianId) {
    // The Open tickets screen is the tickets this technician still has to
    // send out: their drafts, per Kyle. Filtered at the server (the working
    // set stays tiny; sent and billed tickets dominate lifetime volume) and
    // paged anyway, so a forgotten draft past row 1,000 can never be the one
    // that silently drops off — that draft is exactly what the screen exists
    // to surface.
    const data = await fetchAllPages(async (page, size) => {
      const { data: rows, error, count } = await sbClient
        .from("tickets")
        .select("id, work_date, status, total, created_at, jobs(job_number, project, clients(name))",
          page === 0 ? { count: "exact" } : {})
        .eq("technician_id", technicianId)
        .eq("status", "Draft")
        .order("created_at", { ascending: false }).order("id")
        .range(page * size, page * size + size - 1);
      if (error) throw error;
      return { rows: rows || [], total: count ?? (rows || []).length };
    });
    return data.map(t => ({
      id: t.id, date: dayMonth(localDate(t.work_date)),
      age: ageInDays(t.created_at),
      amount: Number(t.total), status: t.status,
      job: t.jobs ? t.jobs.job_number : "", project: t.jobs ? t.jobs.project : "",
      client: t.jobs && t.jobs.clients ? t.jobs.clients.name : ""
    }));
  },

  // The next ticket number for these initials on this date, counted in the
  // database (see the next_ticket_number migration). Used both to show the
  // number on screen before anything is saved and to mint the real one at
  // save time — same function either way, so the preview can't disagree with
  // what actually gets written.
  async nextTicketNumber(initials, workDate) {
    const prefix = initials + "-" + ticketDateStamp(localDate(workDate)) + "-";
    try {
      const { data, error } = await sbClient.rpc("next_ticket_number", {
        _initials: initials, _work_date: workDate
      });
      if (error) throw error;
      // Remember where the sequence had got to, so the offline path below can
      // carry on from the same place instead of guessing.
      OfflineCache.put("ticketno." + prefix, data);
      return data;
    } catch (e) {
      if (!isNetworkError(e)) throw e;

      // No signal, so run the server's rule against what this device knows:
      // the last number the database handed out for this prefix, plus every
      // ticket queued under it since. On one device, for one technician,
      // that is the same answer the server would give.
      //
      // It can still be overtaken — a second device, or another technician
      // sharing initials, raises one while this is out of range — and no
      // client-side count can know that. So the number is provisional, the
      // screen says so, and the database mints the real one on replay.
      const hit = await OfflineCache.read("ticketno." + prefix).catch(() => null);
      const lastKnown = hit ? parseInt(String(hit.value).slice(prefix.length), 10) : NaN;
      const base = isNaN(lastKnown) ? 1 : lastKnown;

      const queued = await OfflineQueue.list().catch(() => []);
      const alreadyQueuedUnderThisPrefix = queued.filter(item =>
        item.type === "ticket" &&
        item.payload && !item.payload.alreadyCreated &&
        item.payload.initials === initials &&
        item.payload.workDate === workDate
      ).length;

      if (hit) OfflineCache.noteServingCached(hit.at);
      return prefix + String(base + alreadyQueuedUnderThisPrefix).padStart(2, "0");
    }
  },

  // A ticket number is the primary key, and it is minted here — at save time,
  // never earlier. The number shown while the ticket is being built is a
  // preview: by the time a ticket queued offline at 07:00 replays at 18:00,
  // its preview is often taken, and the id that matters is the one minted now.
  //
  // Minting and inserting can't be one atomic act without either a reservation
  // table or a gapless-sequence lock held across the round trip, so the
  // primary key is the arbiter: on a collision, mint again and retry. Two
  // technicians would have to submit inside the same few milliseconds to see
  // one retry, and nothing about it is visible to them.
  // `clientKey` is the idempotency key the screen minted for this unsaved
  // ticket. A save whose response was lost on the radio used to replay as a
  // second ticket with a second number; with the key, the unique index
  // turns the repeat into a lookup of the row that already landed, which is
  // handed back as `{ existing: true }` so the caller knows its lines and
  // crew may still need writing.
  async createTicket({ initials, jobDbId, technicianId, workDate, clientContact, contractorContact, lines, status, delays, clientKey = null }) {
    // The key lookup and the open check touch different tables and neither
    // needs the other's answer, so they go out together; they are awaited
    // in the old order so the job's refusal still wins over the key's.
    const keyLookup = startKeyLookup("tickets", "id, total", clientKey);
    // The first mint goes out beside them too: next_ticket_number is a pure
    // read (max + 1 over the tickets and the burned numbers, nothing
    // reserved), so a mint the open check then refuses burns nothing. It is
    // consumed on the first attempt only; a collision mints fresh. Resolved
    // with its error rather than rejected, so a refusal thrown while it is
    // still in flight leaves nothing unhandled.
    let firstMint = this.nextTicketNumber(initials, workDate).then(v => ({ v }), e => ({ e }));
    await this.assertJobOpen(jobDbId);
    lines = lines.map(cleanLine);
    const total = totalOf(lines);
    assertBillable(total);

    // A failed lookup is the save's failure, not a green light (see
    // uploadReport).
    if (keyLookup) {
      const { data: already, error: keyErr } = await keyLookup;
      if (keyErr) throw keyErr;
      if (already) return { id: already.id, total: Number(already.total), existing: true };
    }

    let id = null;
    for (let attempt = 0; ; attempt++) {
      if (firstMint) {
        const minted = await firstMint;
        firstMint = null;
        if (minted.e) throw minted.e;
        id = minted.v;
      } else {
        id = await this.nextTicketNumber(initials, workDate);
      }
      // Inserted at zero, not at the total these lines are about to add up
      // to. The row and its lines are two separate requests and therefore two
      // separate transactions, so for the length of the first one the ticket
      // exists with no lines under it — and a ticket claiming money it has no
      // lines for is exactly the state that left KK-0814-26-01 showing $17.00
      // of nothing when an RLS policy refused the second request. The trigger
      // on ticket_lines sets the real figure the moment they land, and the
      // deferred constraint refuses any row where the two disagree.
      const { error } = await sbClient.from("tickets").insert({
        id, job_id: jobDbId, technician_id: technicianId, work_date: workDate,
        status, client_contact: clientContact, contractor_contact: contractorContact,
        total: 0,
        delays: delays || null,
        client_key: clientKey
      });
      if (!error) break;
      // 23505 = unique violation. On the key: this very ticket landed a
      // moment ago and the answer was lost — return it. On the number:
      // somebody took it between the mint and the insert — mint again.
      // Anything else is a real failure.
      if (error.code === "23505" && clientKey && /client_key/.test(error.message || "")) {
        const { data: already, error: keyErr } = await sbClient.from("tickets").select("id, total").eq("client_key", clientKey).maybeSingle();
        if (keyErr) throw keyErr;
        if (already) return { id: already.id, total: Number(already.total), existing: true };
      }
      if (error.code !== "23505" || attempt >= 4) throw error;
    }

    if (lines.length) {
      const { error: lErr } = await sbClient.from("ticket_lines").insert(
        lines.map(l => ({ ticket_id: id, ...l }))
      );
      if (lErr) {
        // The ticket row is already in — a failure here would strand an
        // empty draft nobody asked for. It has no lines and was never sent,
        // so deleting it is safe; if even the delete fails, the empty draft
        // is the honest leftover state and the error still surfaces.
        await sbClient.from("tickets").delete().eq("id", id).then(() => {}, () => {});
        throw friendlyLineError(lErr);
      }
    }
    return { id, total };
  },

  // Cancelling a ticket raised in error. A real delete, not a status: a ticket
  // number that was never worked should not sit in the tracker forever
  // explaining itself. Lines and crew rows go with it (both cascade on the
  // ticket), so nobody's timesheet keeps hours from a ticket that no longer
  // exists.
  //
  // Approved and invoiced tickets are never cancellable — by then it is the
  // client's document, and a correction is a new ticket.
  async deleteTicket(ticketId) {
    // A reopened draft's recovery copy is keyed by the ticket id
    // (ticketMobile's wipKey). Left behind, a cancelled ticket went on
    // appearing in Open tickets' "half-entered on this device" strip,
    // offering to open a ticket that no longer exists — from the editor's
    // Cancel and from the bulk cancel alike, which both come through here.
    // The overwrite note (overwriteNote.js) goes with it: a banner about a
    // ticket that no longer exists would be read on a number a later ticket
    // may reuse.
    const forgetTicketWip = async id => {
      try { await OfflineCache.remove("ticket.wip." + id); } catch (_) { /* the copy is a convenience */ }
      try { await OfflineCache.remove("ticket.overwrote." + id); } catch (_) { /* likewise */ }
    };
    const { data: row, error: rErr } = await sbClient.from("tickets").select("status").eq("id", ticketId).maybeSingle();
    if (rErr) throw rErr;
    // Two people cancelling the same mistake: the second should hear it's
    // done, not a coercion error from the missing row. But an empty read
    // with no session would say "gone" about a live ticket — rule that out
    // first.
    if (!row) {
      await assertSessionAlive();
      await forgetTicketWip(ticketId);
      throw plainError(`Ticket ${ticketId} is already gone — it was cancelled on another device.`, { ticketGone: true });
    }
    if (row.status === "Approved" || row.status === "Invoiced") {
      throw new Error(`Ticket ${ticketId} is ${row.status.toLowerCase()} — it can't be cancelled. Raise a credit or a corrected ticket instead.`);
    }
    // The row itself goes first, and it is the guarded step. The old order —
    // crew, then lines, then the row — had a real failure mode: a client
    // approving in the seconds between the status read above and the delete
    // meant RLS refused the row (approved_at set) but the crew and lines were
    // already destroyed, leaving an approved ticket gutted and a "cancelled"
    // toast on screen. Row-first can't do that: the children cascade with it,
    // and in a schema that ever lost the cascade the parent delete would
    // refuse on the foreign keys before touching anything.
    //
    // A delete no policy allows reports success having removed nothing, so
    // ask for the row back and treat silence as the refusal it is.
    const { data: gone, error } = await sbClient.from("tickets").delete().eq("id", ticketId).select("id");
    if (error) throw error;
    if (!gone || !gone.length) {
      throw new Error(`Ticket ${ticketId} wasn't cancelled — the client may have just approved it. Reload to see where it stands.`);
    }
    // Cascade has taken the crew and lines with the row; these are the
    // belt-and-braces sweep and expect to find nothing.
    // Together: neither can fail loudly or affect the other, and Open
    // tickets cancels drafts one after another, so these sat on that path
    // twice per ticket.
    await Promise.all([
      sbClient.from("ticket_crew").delete().eq("ticket_id", ticketId).then(() => {}, () => {}),
      sbClient.from("ticket_lines").delete().eq("ticket_id", ticketId).then(() => {}, () => {})
    ]);
    await forgetTicketWip(ticketId);
  },

  // The last ticket raised on this job, with its lines and crew — what "start
  // from the last one" copies forward.
  //
  // Multi-day jobs are the norm and they repeat: the same weld sizes shot day
  // after day, the same two people in the truck. Re-picking all of it from
  // dropdowns every evening is the most repeated typing in the app.
  //
  // Ordered by work date and then by when it was raised, so two tickets on the
  // same day resolve to the later one rather than to whichever the planner
  // happened to return first.
  async lastTicketForJob(jobDbId, excludeTicketId) {
    let q = sbClient.from("tickets")
      .select("id, work_date, ticket_lines(kind, label, unit, quantity)")
      .eq("job_id", jobDbId);
    // Reopening a draft shouldn't offer to copy that same draft over itself.
    if (excludeTicketId) q = q.neq("id", excludeTicketId);
    // A handful, not one: since an empty draft became saveable, the newest
    // ticket can be a blank placeholder parked for the day — offering to
    // copy a blank (and then claiming "lines copied") is worse than looking
    // one further back for the last ticket that actually billed something.
    const { data, error } = await q
      .order("work_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(5);
    if (error) throw error;
    const row = (data || []).find(r => (r.ticket_lines || []).length);
    if (!row) return null;
    const crew = await this.listCrewForTicket(row.id).catch(() => []);
    return { id: row.id, workDate: row.work_date, lines: row.ticket_lines || [], crew };
  },

  // One ticket with its lines, for reopening a draft in the billing screen.
  async getTicket(ticketId) {
    const { data, error } = await sbClient.from("tickets")
      .select("id, job_id, technician_id, work_date, status, total, delays, client_contact, contractor_contact, ticket_lines(kind, label, unit, quantity, unit_rate)")
      .eq("id", ticketId).single();
    if (error) throw error;
    rememberTicketPart(ticketId, { lines: data.ticket_lines || [], delays: data.delays });
    return data;
  },

  // What this device last saw the server holding for a ticket, fingerprinted
  // — the base a queued save carries into the outbox with it. Null whenever
  // either half is missing or belongs to a different ticket, and null means
  // "do not compare", never an accusation.
  lastKnownTicketFingerprint(ticketId) {
    const seen = ticketId ? seenTickets.get(ticketId) : null;
    if (!seen || !seen.lines || !seen.crew) return null;
    return ticketFingerprint(seen.lines, seen.crew, seen.delays);
  },

  // Saving a reopened draft. Lines are replaced wholesale for the same reason
  // crew rows are — a ticket's lines are edited as one document.
  //
  // The status guard is here rather than only in the screen: a ticket the
  // client has approved is what they agreed to pay, and nothing in the app may
  // quietly rewrite it afterwards.
  async updateTicket({ ticketId, clientContact, contractorContact, lines, status, delays }) {
    // The job rides on the pre-read: its open check used to be a second
    // round trip, strictly after this one, in front of every save and every
    // queued replay. A job the embed cannot show (unsynced, or invisible)
    // falls through to assertJobOpen so the wording of that case is its own.
    const { data: row, error: rErr } = await sbClient.from("tickets").select("status, job_id, total, jobs(status, job_number)").eq("id", ticketId).maybeSingle();
    if (rErr) throw rErr;
    // Cancelled on another device while this editor was open. Say so —
    // the screen's generic wrapper ("press Save again") would be a lie
    // here, so the flag lets it show this message bare. An empty read with
    // no session must not masquerade as a cancellation, so check that first.
    if (!row) {
      await assertSessionAlive();
      throw plainError(`Ticket ${ticketId} no longer exists — it was cancelled on another device, so there is nothing to save onto.`, { ticketGone: true });
    }
    if (row.jobs) assertJobRowOpen(row.jobs); else await this.assertJobOpen(row.job_id);
    // Whether this save may land on that row at all. The rule itself is
    // ticketStatusWriteRefusal in data.js, so it can be read and tested
    // without a database; both of its clauses are about money that has
    // already gone to the client. Asked before the lines are priced, since a
    // save that isn't allowed to land should not be costed first. In the
    // editor it is the message on screen; the outbox's replay reads the flag
    // below and goes on to write the crew hours, which are still the day's
    // pay whatever has happened to the billing.
    const refusal = ticketStatusWriteRefusal(row.status, status, ticketId);
    // Flagged, not left to be recognised by its wording: the outbox's replay
    // has to tell "the client already has this ticket" apart from every other
    // refusal, because the day's crew hours are still writable and still have
    // to be saved. A string match would break the first time the sentence is
    // reworded, and the sentence is written for a technician, not for code.
    if (refusal) throw plainError(refusal, row.status === "Awaiting approval" ? { sentForApproval: true } : undefined);
    lines = lines.map(cleanLine);
    const total = totalOf(lines);
    assertBillable(total);
    // No total in the patch. The old lines are still in place at this point,
    // so writing the new sum here would leave the row disagreeing with them
    // until the replacement below lands — which is the window the constraint
    // exists to close. Replacing the lines moves the total on its own.
    //
    // Written back as itself rather than left out of the patch: a save that
    // carries neither delays nor a rep would otherwise update no columns at
    // all, and an empty patch is not a request PostgREST will take — nor
    // would it still be the permission probe the failure branch below reads.
    const patch = { status };
    // undefined means the caller isn't touching delays; "" means cleared.
    if (delays !== undefined) patch.delays = delays || null;
    // Same rule for the reps, and for the same reason: undefined is "not
    // mine to touch", but a rep the technician deliberately cleared arrives
    // as an empty name (or null) and has to be written, or the screen says
    // one thing and the approval email goes to the old contact.
    if (clientContact !== undefined) patch.client_contact = clientContact;
    if (contractorContact !== undefined) patch.contractor_contact = contractorContact;
    // Ask for the row back: an update no policy allows reports success
    // having changed nothing (same trap as the delete below), which here
    // would mean quietly not-saving another technician's ticket — or, with
    // the line replacement next, half-saving it and surfacing raw RLS
    // errors. Refuse in plain words before any of that starts.
    const { data: hit, error: uErr } = await sbClient.from("tickets").update(patch).eq("id", ticketId).select("id");
    if (uErr) throw uErr;
    if (!hit || !hit.length) {
      // The policy refused silently — but silence has four causes, and
      // three of them are races that can land after the pre-read above:
      // the row was deleted, the client just approved it, or the session
      // died. Only the leftover case is genuinely someone else's ticket,
      // so look again before blaming ownership.
      await assertSessionAlive();
      const { data: now, error: nErr } = await sbClient.from("tickets")
        .select("status, approved_at").eq("id", ticketId).maybeSingle();
      if (nErr) throw nErr;
      if (!now) {
        throw plainError(`Ticket ${ticketId} no longer exists — it was cancelled on another device, so there is nothing to save onto.`, { ticketGone: true });
      }
      if (now.approved_at || now.status === "Approved" || now.status === "Invoiced") {
        throw plainError(`Ticket ${ticketId} was just ${now.status === "Invoiced" ? "invoiced" : "approved by the client"} — it can't be changed any more. Raise a new ticket for any correction.`);
      }
      throw plainError(`Ticket ${ticketId} belongs to another technician — your account can't change it. Ask them, or the office, to make the edit.`);
    }

    // Replacing the lines is delete-then-insert, and the gap between the two
    // is where a dropped connection or a refused insert used to destroy a
    // ticket's existing billing — found in beta testing, when an overflow on
    // the insert left the ticket empty at $0. The old lines are held here
    // and put back if the replacement fails; the edit fails, the money
    // doesn't vanish.
    // line_order comes back with them, and orders them: it is the column the
    // invoice prints by, and PostgREST hands rows over in heap order unless
    // asked otherwise. Read unordered and put back on a sequence default, the
    // restored ticket would keep every line and every dollar but lose the
    // card's order — welds and charges interleaved on the client's bill,
    // which is not the ticket the technician saved.
    const { data: oldLines, error: oErr } = await sbClient
      .from("ticket_lines").select("kind, label, unit, quantity, unit_rate, line_order")
      .eq("ticket_id", ticketId).order("line_order");
    if (oErr) throw oErr;
    // Nothing read from a ticket that carries money means the lines are
    // there and this account can't see them (prices are Admins' and
    // Technicians'; the policy hides the rows rather than refusing the
    // read). Replacing what can't be seen would be deleting it — the
    // database refuses the delete to those roles too, but the editor should
    // not even try: the hours, reps and delays are saved, the billing is
    // left exactly as it was.
    if (!(oldLines && oldLines.length) && Number(row.total || 0) > 0) {
      return { id: ticketId, total: Number(row.total) };
    }

    const { error: dErr } = await sbClient.from("ticket_lines").delete().eq("ticket_id", ticketId);
    if (dErr) throw dErr;
    if (lines.length) {
      const { error: lErr } = await sbClient.from("ticket_lines").insert(
        lines.map(l => ({ ticket_id: ticketId, ...l }))
      );
      if (lErr) {
        if (oldLines && oldLines.length) {
          // The spread carries each line's own line_order back with it —
          // supplying the column is allowed (it is an ordinary insertable
          // column whose default merely calls the sequence), so the restored
          // lines land in the order they were saved in rather than in
          // whatever order they were read out.
          await sbClient.from("ticket_lines")
            .insert(oldLines.map(l => ({ ticket_id: ticketId, ...l })))
            .then(() => {}, () => {});
        }
        throw friendlyLineError(lErr);
      }
    }
    // The row now holds what this save wrote, so that is what the next queued
    // save is measured against. Without this the base would still be the copy
    // the editor was opened with, and a technician who saved once online and
    // then queued a later edit would be told they had overwritten somebody.
    // `undefined` delays means the caller wasn't touching them, so the
    // remembered note stays as it was.
    rememberTicketPart(ticketId, delays === undefined ? { lines } : { lines, delays: delays || null });
    return { id: ticketId, total };
  },

  // ── Rates (read-only lookup for the ticket screen) ──────────────────
  // Every rate change ever made to a schedule, newest first — what "Rate
  // history" shows, backed by the trigger in the migrations.
  async getRateLineHistory(scheduleId) {
    // Paged: "every rate change ever" is an all-of-them read, and a
    // long-lived house card can accumulate more than the 1000-row cap,
    // which would silently drop the oldest changes from the audit dialog.
    // Ordered by changed_at then id so the pages can't overlap or skip.
    const data = await fetchAllPages(async (page, size) => {
      const { data: rows, error, count } = await sbClient
        .from("rate_line_history")
        .select("id, label, kind, unit, old_rate, new_rate, changed_at, profiles(name)",
          page === 0 ? { count: "exact" } : {})
        .eq("schedule_id", scheduleId)
        .order("changed_at", { ascending: false }).order("id")
        .range(page * size, page * size + size - 1);
      if (error) throw error;
      return { rows: rows || [], total: count ?? (rows || []).length };
    });
    return data.map(h => ({
      id: h.id, label: h.label, kind: h.kind, unit: h.unit,
      oldRate: Number(h.old_rate), newRate: Number(h.new_rate),
      changedBy: h.profiles ? h.profiles.name : "—", changedAt: h.changed_at
    }));
  },

  // Pulls the most recently published schedule for a client and shapes it
  // into the billing catalog the ticket screen offers: every line on the
  // card, in the card's dragged order, priced as the card says. Contents,
  // not just prices — a custom line on the card is offered, a line removed
  // from the card is gone from the menu rather than offered at $0.
  // Wrapped for offline: without the client's catalog the billing screen has
  // nothing to price against and refuses to open, which is what made building
  // a ticket in the field impossible even though saving one was handled.
  async getPublishedRatesForClient(clientId) {
    return OfflineCache.readThrough("catalog." + clientId, () => this._fetchPublishedRates(clientId));
  },

  async _fetchPublishedRates(clientId) {
    // The client's newest schedule decides where the catalog comes from: a
    // schedule that follows the house card prices from the default schedule,
    // live; one that doesn't prices from its own published lines, exactly
    // as before.
    const { data: latest, error: sErr } = await sbClient
      .from("rate_schedules").select("id, follows_default, published_at")
      .eq("client_id", clientId)
      .order("effective_from", { ascending: false }).limit(1).maybeSingle();
    if (sErr) throw sErr;

    let schedule = null;
    if (latest && latest.follows_default) {
      const { data: def, error: dErr } = await sbClient
        .from("rate_schedules").select("id").is("client_id", null)
        .not("published_at", "is", null)
        .order("effective_from", { ascending: false }).limit(1).maybeSingle();
      if (dErr) throw dErr;
      schedule = def;
    } else if (latest && latest.published_at) {
      schedule = latest;
    } else {
      // The newest schedule may be an unpublished draft sitting in front of
      // an older published one — the published one still prices tickets.
      const { data: pub, error: pErr } = await sbClient
        .from("rate_schedules").select("id").eq("client_id", clientId)
        .not("published_at", "is", null)
        .order("effective_from", { ascending: false }).limit(1).maybeSingle();
      if (pErr) throw pErr;
      schedule = pub;
    }
    // No schedule found — but "none published" and "signed out" look the
    // same from here: with the session gone the reads above run as anon,
    // which sees no rate_schedules rows at all. Told apart, because the
    // billing screen turns the first into "this client has no published rate
    // schedule" — a message that sends someone to the Rate admin screen to
    // fix a card that was never broken.
    if (!schedule) {
      await assertSessionAlive();
      return null;
    }

    const { data: lines, error: lErr } = await sbClient
      .from("rate_lines").select("*").eq("schedule_id", schedule.id)
      .order("position", { ascending: true, nullsFirst: false }).order("label");
    if (lErr) throw lErr;

    // The card's rows, expanded the way a ticket bills them: a size row is
    // three per-weld items (film, CR, DR), a method is one, and the expense
    // group is the other-charges list. Item labels are built exactly the way
    // tickets have always stored them, so old drafts reopen unchanged. Keys
    // are kind:label — unique per the schedule's line index.
    const RT = { rt_film: "RT film", rt_cr: "RT CR", rt_dr: "RT DR" };
    const welds = [];
    const seenSizes = new Set();
    for (const l of lines) {
      if (RT[l.kind]) {
        if (seenSizes.has(l.label)) continue;
        seenSizes.add(l.label);
        for (const kind of Object.keys(RT)) {
          const row = lines.find(x => x.kind === kind && x.label === l.label);
          if (row) welds.push({ key: kind + ":" + row.label, label: row.label + " · " + RT[kind], rate: Number(row.rate), isWeld: true });
        }
      } else if (l.kind === "custom_weld") {
        // One-cell lines from before custom sizes grew all three kinds.
        welds.push({ key: "custom_weld:" + l.label, label: l.label, rate: Number(l.rate), isWeld: true });
      }
    }
    for (const l of lines) {
      if (l.kind === "method" || l.kind === "custom_method") {
        // Not isWeld: the weld count on the ticket header counts RT welds
        // shot, the way it always has.
        welds.push({ key: l.kind + ":" + l.label, label: l.label + " — per weld", rate: Number(l.rate), isWeld: false });
      }
    }
    const others = lines
      .filter(l => l.kind === "expense" || l.kind === "custom_expense")
      .map(l => ({
        key: l.kind + ":" + l.label, label: l.label, rate: Number(l.rate),
        // The quantity box honours this step now (a whole step takes no
        // decimal point at all), so the units that are really measured in
        // fractions have to say so here: hours by the half, days by the
        // half, kilometres by the tenth. Everything else is counted.
        unit: l.unit || "ea", step: CATALOG_STEP[l.unit] || 1
      }));
    return { welds, others };
  },

  // ── Rate admin (full editable schedule, not just the read-only lookup
  //    above) ───────────────────────────────────────────────────────────
  // The house default schedule is a rate_schedules row with no client_id.
  // Modelling it as a real schedule rather than a separate table means the
  // same editor, the same publish flow and the same line types apply to it.
  async getEditableSchedule(clientId) {
    const isDefault = clientId === DEFAULT_SCHEDULE;
    const q = sbClient.from("rate_schedules").select("*");
    let { data: schedule, error: sErr } = await (isDefault ? q.is("client_id", null) : q.eq("client_id", clientId))
      .order("effective_from", { ascending: false }).limit(1).maybeSingle();
    if (sErr) throw sErr;
    if (!schedule) {
      const { data: created, error: cErr } = await sbClient
        .from("rate_schedules").insert({ client_id: isDefault ? null : clientId }).select().single();
      if (cErr) throw cErr;
      schedule = created;
    }
    let { data: lines, error: lErr } = await sbClient.from("rate_lines").select("*")
      .eq("schedule_id", schedule.id)
      // The dragged order first; label keeps rows stable for anything from
      // before the position column, which sorts to the end as null.
      .order("position", { ascending: true, nullsFirst: false }).order("label");
    if (lErr) throw lErr;

    // The standard card is laid out once, when a schedule is empty — which
    // in practice means it was just created. This used to top up whatever
    // was MISSING on every open, which made removing a standard line
    // cosmetic: it came back at zero the next time anyone looked,
    // contradicting both the remove button's promise and the Restore
    // standard lines button, whose whole job is bringing removed lines back
    // on purpose. The editor draws its rows from the lines themselves now,
    // so an absent line is simply not there.
    if (!(lines || []).length) {
      const seed = STANDARD_RATE_LINES.map(l => ({ schedule_id: schedule.id, ...l, rate: 0 }));
      const { data: seeded, error: seedErr } = await sbClient.from("rate_lines").insert(seed).select();
      if (seedErr) throw seedErr;
      lines = seeded;
    }
    return { schedule, lines };
  },

  // A rate is what the client gets billed, so it can't be negative. The
  // database rejects one outright; clamping here means the field just refuses
  // to go below zero instead of surfacing a constraint violation.
  async setRateLine(id, rate) {
    const { error } = await sbClient.from("rate_lines").update({ rate: nonNegative(rate) }).eq("id", id);
    if (error) throw error;
  },

  async addRateLine({ scheduleId, kind, label, unit, rate, position = null }) {
    const { data, error } = await sbClient.from("rate_lines")
      .insert({ schedule_id: scheduleId, kind, label, unit, rate: nonNegative(rate), position }).select().single();
    if (error) throw error;
    return data;
  },

  // The dragged order, written back one position per line. Parallel
  // single-row updates rather than an upsert: an upsert would need every
  // column of every row, and a miss here should refuse loudly — an update
  // no policy allows reports success having moved nothing.
  async reorderRateLines(updates) {
    const results = await Promise.all(updates.map(u =>
      sbClient.from("rate_lines").update({ position: u.position }).eq("id", u.id).select("id")
    ));
    for (const { error } of results) if (error) throw error;
    if (results.some(r => !r.data || !r.data.length)) {
      throw new Error("The new order didn't fully save — reload the schedule and try again.");
    }
  },

  async deleteRateLine(id) {
    const { error } = await sbClient.from("rate_lines").delete().eq("id", id);
    if (error) throw error;
  },

  async publishSchedule(scheduleId) {
    const { error } = await sbClient.from("rate_schedules").update({ published_at: new Date().toISOString() }).eq("id", scheduleId);
    if (error) throw error;
  },

  // The switch on a client's card. On: their tickets price from the house
  // card, live, and their own lines lie dormant. Off: their own card prices
  // again, exactly as it was left.
  async setFollowsDefault(scheduleId, follows) {
    const { data, error } = await sbClient.from("rate_schedules")
      .update({ follows_default: !!follows }).eq("id", scheduleId).select("id");
    if (error) throw error;
    if (!data || !data.length) {
      throw new Error("That schedule wasn't updated — rate cards are an admin's to change.");
    }
  },

  // Who prices from the house card, and which rate_schedules row the house
  // card is. Both answers come out of the same read because the Rate admin
  // screen needs both: how many clients an edit to the house card reprices,
  // and the schedule whose history explains a follower's price rise.
  // A client can have more than one schedule row — a newer draft in front of
  // an older card — and the newest by effective_from is the one that prices
  // their tickets, which is how _fetchPublishedRates decides it too. Paged,
  // because "every schedule" is an all-of-them read.
  async listScheduleFollowers() {
    const rows = await fetchAllPages(async (page, size) => {
      const { data, error, count } = await sbClient
        .from("rate_schedules")
        .select("id, client_id, follows_default, effective_from", page === 0 ? { count: "exact" } : {})
        // Grouped by client with the newest first, so the first row seen for
        // a client is the operative one; id keeps the pages from overlapping.
        .order("client_id").order("effective_from", { ascending: false }).order("id")
        .range(page * size, page * size + size - 1);
      if (error) throw error;
      return { rows: data || [], total: count ?? (data || []).length };
    });
    let defaultScheduleId = null;
    const newest = new Map();
    for (const r of rows) {
      // No client_id is the house card itself; the first one seen is the
      // newest, the same row getEditableSchedule opens.
      if (!r.client_id) { if (!defaultScheduleId) defaultScheduleId = r.id; continue; }
      if (!newest.has(r.client_id)) newest.set(r.client_id, r);
    }
    return {
      defaultScheduleId,
      followerIds: [...newest.values()].filter(r => r.follows_default).map(r => r.client_id)
    };
  },

  // Copies the house default into a schedule — the card itself, not just
  // its figures:
  //
  //   - a line the schedule does not carry  -> inserted, priced or not
  //   - a line it carries at zero           -> filled in from the default
  //
  // A line with a rate already on it is never touched: a negotiated 6in rate
  // must not silently revert to the house figure. Zero is not a negotiated
  // rate, it is an unset one. Nothing is ever removed, either — lines this
  // schedule has that the default lacks are its own business.
  //
  // `fromScheduleId` copies some other card in instead of the house card —
  // the Rate admin's "Copy rates from", where a new client is priced like a
  // client already on file. The work is identical; only where the lines are
  // read from changes.
  async copyDefaultInto(scheduleId, fromScheduleId = null) {
    let sourceId = fromScheduleId;
    if (!sourceId) {
      const { data: def } = await sbClient
        .from("rate_schedules").select("id").is("client_id", null)
        .order("effective_from", { ascending: false }).limit(1).maybeSingle();
      if (!def) throw new Error("There is no default schedule yet — set one up first.");
      sourceId = def.id;
    }
    if (sourceId === scheduleId) {
      throw new Error(fromScheduleId
        ? "That is the same rate card — there is nothing to copy."
        : "This is the default schedule — there is nothing to copy into it.");
    }

    const [{ data: source }, { data: existing }] = await Promise.all([
      sbClient.from("rate_lines").select("*").eq("schedule_id", sourceId),
      sbClient.from("rate_lines").select("id, kind, label, rate, position").eq("schedule_id", scheduleId)
    ]);
    if (!source || !source.length) {
      throw new Error(fromScheduleId
        ? "That client's rate card has nothing on it yet, so there is nothing to copy."
        : "The default schedule has nothing on it yet — set it up first.");
    }

    const key = l => l.kind + "\u0000" + l.label;
    const mine = new Map((existing || []).map(l => [key(l), l]));

    const toAdd = [];
    const toFill = [];
    const toMove = [];
    for (const l of source) {
      const match = mine.get(key(l));
      // Structure copies whether or not the line is priced yet: the house
      // card's rows — its size bands, its methods — are themselves the
      // template, and they used to be skipped at $0, which made "Fill from
      // default" a no-op on a card whose rates hadn't been typed in yet.
      // The default's dragged order comes along with each line.
      if (!match) {
        toAdd.push({ schedule_id: scheduleId, kind: l.kind, label: l.label, unit: l.unit, rate: l.rate, position: l.position });
      } else {
        if (Number(l.rate) && !Number(match.rate)) toFill.push({ id: match.id, rate: l.rate });
        // The order comes along for lines the card already had, too — the
        // ticket dropdowns and the invoice follow position, and a card that
        // follows the house card should read in the house card's order,
        // not half in its own.
        if (l.position != null && match.position !== l.position) toMove.push({ id: match.id, position: l.position });
      }
    }
    // The card's own lines — the customs the house card doesn't have — are
    // renumbered after the house order, in the order they already had, so
    // none of them lands on a position a standard line just took. Without
    // this, turning follow off left a client's blended-rate line sharing a
    // position with a size band, and the ticket dropdowns and the invoice
    // read in whichever order the database felt like.
    const houseMax = source.reduce((m, l) => Math.max(m, l.position == null ? 0 : Number(l.position)), 0);
    const customs = (existing || [])
      .filter(l => !source.some(s => key(s) === key(l)))
      .sort((a, b) => (a.position == null ? 0 : a.position) - (b.position == null ? 0 : b.position));
    customs.forEach((l, i) => {
      const position = houseMax + 1 + i;
      if (l.position !== position) toMove.push({ id: l.id, position });
    });
    // One round trip per line, all at once (reorderRateLines does the same):
    // a full house card is sixty lines, and sixty sequential updates on
    // field signal was a minute of "Saving…".
    const moved = await Promise.all(toMove.map(m =>
      sbClient.from("rate_lines").update({ position: m.position }).eq("id", m.id)
    ));
    const moveErr = moved.find(r => r.error);
    if (moveErr) throw moveErr.error;

    if (toAdd.length) {
      const { error } = await sbClient.from("rate_lines").insert(toAdd);
      if (error) throw error;
    }
    if (toFill.length) {
      // One round trip covering every row via bulk_set_rate_lines() (see
      // migrations) — a plain UPDATE...FROM unnest(), not an upsert, so it
      // can't trip over rate_lines' other required columns the way a
      // partial-row upsert could.
      const { error } = await sbClient.rpc("bulk_set_rate_lines", {
        ids: toFill.map(f => f.id), rates: toFill.map(f => f.rate)
      });
      if (error) throw error;
    }
    return toAdd.length + toFill.length + toMove.length;
  },

  // Every override there is — reference data for the Rate admin table, so
  // the concurrent walk is the right one; unpaged, PostgREST stopped at
  // 1,000 without a word.
  async listOverrides() {
    return fetchAllPages(async (page, size) => {
      const { data, error, count } = await sbClient
        .from("rate_overrides")
        .select("*, jobs(job_number, client_id)", page === 0 ? { count: "exact" } : {})
        .order("id")
        .range(page * size, page * size + size - 1);
      if (error) throw error;
      return { rows: data || [], total: count ?? (data || []).length };
    });
  },

  async createOverride({ jobId, description, basis, bidRef }) {
    const { data, error } = await sbClient.from("rate_overrides")
      .insert({ job_id: jobId, description, basis, bid_ref: bidRef || null, active: true, locked: false })
      .select("*, jobs(job_number, client_id)").single();
    if (error) throw error;
    return data;
  },

  // Locked overrides are priced into an approved ticket, so removing one
  // would change what a client already signed for. The guard is here rather
  // than only in the screen: any future caller gets it too.
  async deleteOverride(id) {
    const { data: row, error: rErr } = await sbClient
      .from("rate_overrides").select("locked").eq("id", id).maybeSingle();
    if (rErr) throw rErr;
    if (row && row.locked) throw new Error("That override is locked — a ticket on the job has already been approved against it.");
    const { error } = await sbClient.from("rate_overrides").delete().eq("id", id);
    if (error) throw error;
  },

  async toggleOverrideActive(id, active) {
    const { error } = await sbClient.from("rate_overrides").update({ active }).eq("id", id);
    if (error) throw error;
  },

  // ── Users & access ───────────────────────────────────────────────────
  // Newest first. `before` is the last row already on screen, so "load more"
  // is a keyset walk — the twenty older than that one — rather than an
  // offset that would skip a row when the log grew between two presses.
  // `functionName` narrows to one function, because twenty copies of the same
  // line hide the older, different error that matters.
  async listFunctionErrors(limit = 20, { before = null, functionName = "" } = {}) {
    let q = sbClient.from("function_errors").select("*");
    if (functionName) q = q.eq("function_name", functionName);
    if (before && before.created_at) {
      // Quoted: a timestamp carries ":" and "+", which PostgREST reads as
      // its own syntax inside an or() unless the value is in double quotes.
      const ts = `"${before.created_at}"`;
      q = q.or(`created_at.lt.${ts},and(created_at.eq.${ts},id.lt.${before.id})`);
    }
    const { data, error } = await q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit);
    if (error) throw error;
    return data;
  },
  // The names in the log, for the panel's filter — the log is small (it is
  // cleared by hand) so a distinct over it is a cheap read. Capped where
  // PostgREST would cap it silently: a log nobody has cleared still fills
  // the dropdown from its first thousand entries rather than pretending to
  // have read them all.
  async listFunctionErrorNames() {
    const { data, error } = await sbClient.from("function_errors").select("function_name").order("function_name").limit(RESPONSE_ROW_CAP);
    if (error) throw error;
    return [...new Set((data || []).map(r => r.function_name))];
  },

  // The Admin screen's Clear button. A definer RPC, Admin-only inside the
  // database — signed-in accounts hold no delete grant on the log.
  async clearFunctionErrors() {
    const { data, error } = await sbClient.rpc("clear_function_errors");
    if (error) throw error;
    return data;
  },

  // The people who can be put on a crew or a JHA today: everyone whose
  // account is not locked. Users & access keeps using listProfiles, which
  // includes the locked ones so they can be seen and their history kept.
  async listActiveProfiles() {
    return (await this.listProfiles()).filter(p => !p.deactivated_at);
  },

  async listProfiles() {
    return cached("profiles", () => OfflineCache.readThrough("profiles", async () => {
      // Paged like every other "all of them" list: PostgREST caps a response
      // at 1,000 rows, and the timesheet roster adds an empty sheet for
      // every profile this returns — a capped read would silently drop
      // whoever sorted past the cap. Ordered by id in the query for stable
      // pages; the display sort stays client-side, by name.
      const data = await fetchAllPages(async (page, size) => {
        const { data: rows, error, count } = await sbClient
          .from("profiles")
          .select("*", page === 0 ? { count: "exact" } : {})
          .order("id")
          .range(page * size, page * size + size - 1);
        if (error) throw error;
        return { rows: rows || [], total: count ?? (rows || []).length };
      });
      // `displayName` is what the app shows; `name` stays untouched so an
      // account whose parts were never filled in still reads sensibly.
      return data
        .map(p => ({ ...p, displayName: fullName(p) }))
        .sort((a, b) =>
          (a.last_name || a.displayName).localeCompare(b.last_name || b.displayName) ||
          a.displayName.localeCompare(b.displayName)
        );
    }));
  },

  async updateProfileDetails(id, { firstName, lastName, isSubcontractor, cert, level, unitNumber, idCode }) {
    const name = [firstName, lastName].filter(Boolean).join(" ").trim();
    const patch = { first_name: firstName || null, last_name: lastName || null, is_subcontractor: !!isSubcontractor };
    if (name) patch.name = name;
    if (cert !== undefined) patch.cert = cert;
    // Level and the CGSB/NRCAN number both print on the client's field
    // invoice. Empty means "not set", which the invoice shows as a dash
    // rather than inventing a grade for somebody.
    if (level !== undefined) patch.level = level || null;
    // Equipment fields: sent only when the caller passed them, so an older
    // screen that doesn't know about them can't blank them out.
    if (unitNumber !== undefined) patch.unit_number = unitNumber.trim() || null;
    if (idCode !== undefined) patch.id_code = idCode.trim() || null;
    const { error } = await sbClient.from("profiles").update(patch).eq("id", id);
    if (error) throw error;
    invalidate("profiles");
  },

  // A worker keeping their own three dosimeter serials, from the JHA
  // builder. It cannot be an update on profiles: that policy wants the users
  // tab, which the field does not hold, so this goes through the definer RPC
  // that writes those three columns on auth.uid()'s own row and nothing
  // else. All three are sent every time — the panel only appears for someone
  // who has none of them, and a half-written profile asks the same question
  // again on the next job.
  //
  // PGRST202 (or a message naming the function) means the migration has not
  // been applied here yet; the caller decides what to do about that, so the
  // error goes back untouched.
  async setOwnDosimetry({ tld, drd, alarm }) {
    const { data, error } = await sbClient.rpc("set_own_dosimetry", {
      p_tld: String(tld || "").trim(),
      p_drd: String(drd || "").trim(),
      p_alarm: String(alarm || "").trim()
    });
    if (error) throw error;
    // The crew list carries these serials, and the JHA builder derives a
    // kit from it — a stale copy would put the old blanks back on the next
    // assessment this session.
    invalidate("profiles");
    return data;
  },

  async updateProfileTabs(id, tabs) {
    const { error } = await sbClient.from("profiles").update({ tab_access: tabs }).eq("id", id);
    if (error) throw error;
    invalidate("profiles");
  },

  async updateProfileRole(id, role, tabs) {
    const { error } = await sbClient.from("profiles").update({ role, tab_access: tabs }).eq("id", id);
    if (error) throw error;
    invalidate("profiles");
  },

  // Deletes the account for real — the profile row and the auth.users record
  // behind it — via the delete-user Edge Function, which holds the
  // service-role key this can never touch client-side.
  async deleteUserAccount(userId) {
    const { data, error } = await sbClient.functions.invoke("delete-user", { body: { userId } });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    invalidate("profiles");
    // { ok } when the account is gone; { ok, deactivated, message } when it
    // had work on file and was locked instead — the screen says which.
    return data || {};
  },

  // The other side of that lock: lifts the Auth ban, clears deactivated_at
  // and puts the role's tabs back, through the unlock-user Edge Function —
  // the ban is the service role's to lift, so it can't be done from here.
  // Comes back as { ok, user, message } and sometimes a warning; the role
  // is untouched, so the person returns at the rank they left at.
  async unlockUserAccount(userId) {
    const { data, error } = await sbClient.functions.invoke("unlock-user", { body: { userId } });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    invalidate("profiles");
    return data || {};
  },

  // Creates a real staff account — Admin-to-Admin, through the create-user
  // Edge Function, which holds the service-role key and verifies the
  // caller is a signed-in Admin before touching Auth. This used to go
  // through the public signUp endpoint with the role riding in client
  // metadata, which made the rank the client's claim on an endpoint anyone
  // with the publishable key could reach; the provisioning trigger now
  // caps metadata roles to the field ones, and the function writes the
  // real rank itself. Accounts arrive email-confirmed — the admin standing
  // there is the confirmation — so the new tech signs in immediately.
  // Emails an account a link to set its password — the same set-password
  // screen "Forgot password" lands on. Admin only; the password-reset
  // function checks, and looks the address up itself from the account.
  async sendPasswordReset(userId) {
    const { data, error } = await sbClient.functions.invoke("password-reset", { body: { userId } });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    return data;
  },

  // `invite`: no temporary password — the function mints one nobody knows
  // and emails the person a set-password link instead.
  async createUserAccount({ firstName, lastName, email, password, role, cert, level, isSubcontractor, invite = false }) {
    const name = [firstName, lastName].filter(Boolean).join(" ").trim();
    const { data, error } = await sbClient.functions.invoke("create-user", {
      body: { email, password: invite ? "" : password, name, role, cert, invite: !!invite }
    });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    // No account came back, so nothing exists to go on with: that is a
    // failure, and the only one this call still throws.
    if (!data || !data.user) throw new Error("The account wasn't created — the server didn't say who it made.");
    invalidate("profiles");
    // Past this line the account EXISTS. Everything that can still go wrong
    // is a thing to fix on the account, not a reason to hide it: these come
    // back as a warning so the screen can list the new person and say what
    // is left to do. Throwing them used to lose both.
    const warnings = [];
    // An invitation that didn't send — the function already says it in the
    // voice of what to press next.
    if (data.warning) warnings.push(data.warning);
    // The trigger provisions the profile from auth metadata, which has no
    // slot for the name parts or the subcontractor flag — so set them after.
    try {
      // Muted for the same reason as above: filling in the name parts is
      // part of creating the account, so it should not also say "saved".
      Toasts.mute();
      try { await this.updateProfileDetails(data.user.id, { firstName, lastName, isSubcontractor, cert, level }); }
      finally { Toasts.unmute(); }
    } catch (e) {
      // Half an account is not a success: without these the person prints
      // with a blank level on the client's invoice and their mileage never
      // appears. Say so, and say what to do — the account exists, so
      // pressing Create again would only collide on the email.
      warnings.push(`The account was created, but the name, level and subcontractor flag didn't save (${e.message || "the save failed"}). Open the account in the list and fill them in there.`);
    }
    return { ...data, warning: warnings.join(" ") };
  },

  // ── The arcade ───────────────────────────────────────────────────────
  // Every easter egg's leaderboard, one table keyed by game. Both calls are
  // deliberately outside the offline queue: a score is not work, and it has
  // no business sitting in the same queue as a ticket, competing for a sync
  // slot or surviving a failed replay.
  async listArcadeScores(game) {
    const { data, error } = await sbClient
      .from("arcade_scores")
      .select("profile_id, best, updated_at, profiles(name)")
      .eq("game", game)
      .order("best", { ascending: false })
      .order("updated_at", { ascending: true })   // a tie goes to whoever got there first
      .limit(10);
    if (error) throw error;
    return (data || []).map(r => ({
      id: r.profile_id,
      name: r.profiles ? r.profiles.name : "",
      best: Number(r.best),
      at: r.updated_at
    }));
  },

  // Muted, because "Saved" popping up over a game you just lost is not a
  // message anybody needs. The database keeps whichever score is higher, so
  // this is safe to call with a stale number. No timestamp goes up with it:
  // updated_at breaks ties on the board, and the server stamps it itself —
  // a phone with its clock set wrong should not out-rank an honest one.
  async saveArcadeScore({ game, profileId, best }) {
    Toasts.mute();
    try {
      const { error } = await sbClient.from("arcade_scores").upsert(
        { game, profile_id: profileId, best },
        { onConflict: "game,profile_id" }
      );
      if (error) throw error;
    } finally { Toasts.unmute(); }
  },

  // ── Team chat ────────────────────────────────────────────────────────
  // One room for the whole crew. Deliberately outside the offline queue:
  // a message typed with no signal is a conversation with nobody, and
  // replaying it hours later would say it out of turn. Online-only,
  // fail soft — like the arcade.
  async listChatMessages(before) {
    const fetchPage = async () => {
      let q = sbClient
        .from("chat_messages")
        .select(CHAT_COLUMNS)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(CHAT_PAGE);
      if (before) q = q.lt("created_at", before);
      const { data, error } = await q;
      if (error) throw error;
      // Fetched newest-first so the limit takes the right end, shown
      // oldest-first because that is how a conversation reads.
      return {
        messages: (data || []).map(shapeChatMessage).reverse(),
        hasMore: (data || []).length === CHAT_PAGE
      };
    };
    // The latest page is kept for a dead zone: opening the chat with no
    // signal shows the last conversation this device saw rather than an
    // error. Reading only — sending stays online-only, on purpose.
    return before ? fetchPage() : OfflineCache.readThrough("chat_room", fetchPage);
  },

  // The strip at the top of the room. Newest pin first, and capped — if
  // twenty things are pinned at once, the strip is no longer a strip.
  async listPinnedChatMessages() {
    return OfflineCache.readThrough("chat_pins", async () => {
      const { data, error } = await sbClient
        .from("chat_messages")
        .select(CHAT_COLUMNS)
        .not("pinned_at", "is", null)
        .order("pinned_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data || []).map(shapeChatMessage);
    });
  },

  // ── Unread bookkeeping ──────────────────────────────────────────────
  // One bookmark per person; the badge is what arrived since, minus your
  // own words. Counting is a single indexed RPC, cheap enough for the
  // drawer to ask on a timer.
  async chatUnreadCount() {
    const { data, error } = await sbClient.rpc("chat_unread_count");
    if (error) throw error;
    return data || 0;
  },

  async getChatLastRead(profileId) {
    const { data, error } = await sbClient
      .from("chat_reads").select("last_read_at").eq("profile_id", profileId).maybeSingle();
    if (error) throw error;
    return data ? data.last_read_at : null;
  },

  // Silent by design: reading a room is not a save anyone needs announced.
  async markChatRead(profileId) {
    const { error } = await sbClient
      .from("chat_reads")
      .upsert({ profile_id: profileId, last_read_at: new Date().toISOString() }, { onConflict: "profile_id" });
    if (error) throw error;
  },

  // Every job number, for the chat's linkifier: a word in a message that
  // matches one becomes a tap-through to the job. Paged because "all of
  // them" always is, cached because the set barely moves.
  async listJobNumbers() {
    return cached("job_numbers", () =>
      fetchAllPages(async (page, size) => {
        const { data, error, count } = await sbClient
          .from("jobs")
          .select("job_number", { count: "exact" })
          .order("job_number", { ascending: true })
          .order("id", { ascending: true })
          .range(page * size, page * size + size - 1);
        if (error) throw error;
        return { rows: (data || []).map(j => j.job_number), total: count || 0 };
      })
    );
  },

  // One row with its sender's name — for a realtime arrival from somebody
  // the screen hasn't seen yet, whose event carries only the profile id.
  async getChatMessage(id) {
    const { data, error } = await sbClient
      .from("chat_messages")
      .select(CHAT_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data ? shapeChatMessage(data) : null;
  },

  // The GIF picker's search. KLIPY's integration terms require the
  // search itself to come from the user's own browser (no proxying), so
  // the Edge Function's only job is handing the app key to signed-in
  // accounts — fetched once per session, then every search goes straight
  // to api.klipy.com. An empty term asks for what's trending.
  async _klipyKey() {
    if (this._klipyKeyCache) return this._klipyKeyCache;
    const { data, error } = await sbClient.functions.invoke("gif-search", { body: {} });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    this._klipyKeyCache = data && data.appKey;
    if (!this._klipyKeyCache) throw new Error("GIF search isn't set up yet.");
    return this._klipyKeyCache;
  },

  async searchGifs(q) {
    const key = await this._klipyKey();
    const term = String(q || "").trim();
    const params = new URLSearchParams({ per_page: "24", content_filter: "medium" });
    if (term) params.set("q", term);
    const res = await fetch(
      `https://api.klipy.com/api/v1/${key}/gifs/${term ? "search" : "trending"}?${params}`
    );
    if (!res.ok) throw new Error(`The GIF service answered ${res.status} — try again in a moment.`);
    const payload = await res.json();
    const items = payload && payload.data && Array.isArray(payload.data.data) ? payload.data.data : [];
    // Two URLs per result: a small copy for the picker grid, a mid-size
    // copy for the message itself. Animated WebP where it exists — the
    // same animation at a fraction of a real .gif's bytes, which matters
    // on a field connection — with .gif as the fallback.
    const pick = (file, sizes, formats) => {
      for (const s of sizes) {
        const bucket = file && file[s];
        if (!bucket) continue;
        for (const f of formats) {
          if (bucket[f] && bucket[f].url) return bucket[f];
        }
      }
      return null;
    };
    return items
      .map(it => {
        const full = pick(it.file, ["md", "hd", "sm"], ["webp", "gif"]);
        const preview = pick(it.file, ["sm", "xs", "md"], ["webp", "gif", "jpg"]) || full;
        if (!full) return null;
        return {
          id: String(it.id || it.slug || full.url),
          full: full.url,
          preview: preview.url,
          // KLIPY's tiny blurred stand-in, a data URI — the grid paints it
          // instantly and the real frames fade in over it.
          blur: it.blur_preview || "",
          width: preview.width || 0,
          height: preview.height || 0
        };
      })
      .filter(Boolean);
  },

  // Text, a picture, a GIF, or a voice note — with a reply pointer if it
  // answers something. Media goes up first, under the sender's own folder
  // (the storage policy holds everyone to theirs); if the message row is
  // then refused, the upload is taken back down rather than stranded. A
  // GIF is only ever a KLIPY CDN URL — nothing of ours is uploaded for it.
  async sendChatMessage(profileId, body, { imageFile, gifUrl, audioFile, replyTo, file } = {}) {
    const text = String(body || "").trim();
    if (!text && !imageFile && !gifUrl && !audioFile && !file) throw new Error("Nothing to send.");
    const uploaded = [];
    const uploadMedia = async (file, extByType, refusal) => {
      // MediaRecorder reports "audio/webm;codecs=opus" — the bucket and
      // the extension both key on the base type.
      const baseType = (file.type || "").split(";")[0];
      const ext = extByType[baseType];
      if (!ext) throw new Error(refusal);
      const key = `${profileId}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await sbClient.storage
        .from("chat-media")
        .upload(key, file, { contentType: baseType });
      if (upErr) {
        throw /exceeded|maximum|too large|413/i.test(upErr.message || "")
          ? new Error("That file is too big to send — keep it under 8 MB.")
          : upErr;
      }
      uploaded.push(key);
      return key;
    };

    const imageKey = imageFile
      ? await uploadMedia(imageFile,
          { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" },
          "That file isn't a picture the chat can show — use a JPEG, PNG, WebP or GIF.")
      : null;
    const audioKey = audioFile
      ? await uploadMedia(audioFile,
          { "audio/webm": "webm", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/ogg": "ogg" },
          "That recording isn't a format the chat can play.")
      : null;

    const { data, error } = await sbClient
      .from("chat_messages")
      .insert({
        profile_id: profileId, body: text.slice(0, 4000),
        image_key: imageKey, gif_url: gifUrl || null, audio_key: audioKey,
        // A Files-page link: referenced, never owned — no cleanup path
        // may ever touch the shared bucket through a chat message.
        file_key: file ? file.path : null, file_name: file ? file.name : null,
        reply_to: replyTo || null
      })
      .select(CHAT_COLUMNS)
      .single();
    if (error) {
      if (uploaded.length) sbClient.storage.from("chat-media").remove(uploaded).then(() => {}, () => {});
      throw error;
    }
    return shapeChatMessage(data);
  },

  // Only an Admin's update passes the row policy, and only the pin columns
  // pass the grant — a refused pin comes back as zero rows, not an error.
  async pinChatMessage(id, profileId) {
    const { data, error } = await sbClient
      .from("chat_messages")
      .update({ pinned_at: new Date().toISOString(), pinned_by: profileId })
      .eq("id", id).select("id");
    if (error) throw error;
    if (!data || !data.length) throw new Error("Only an Admin can pin a message.");
  },

  async unpinChatMessage(id) {
    const { data, error } = await sbClient
      .from("chat_messages")
      .update({ pinned_at: null, pinned_by: null })
      .eq("id", id).select("id");
    if (error) throw error;
    if (!data || !data.length) throw new Error("Only an Admin can take a pin down.");
  },

  // Deleting is moderation, not editing your past: the screen offers it
  // to Admins only. (The RLS policy also lets an author delete their own
  // row — capability of the schema, deliberately wider than the UI.)
  async deleteChatMessage(id) {
    // The media keys have to be read before the row disappears — same
    // shape as deleteJha. No rows means already gone, which is the goal
    // state; a zero-row delete after that is a policy refusal.
    const { data: rows, error: readErr } = await sbClient
      .from("chat_messages").select("image_key, audio_key").eq("id", id);
    if (readErr) throw readErr;
    if (!rows || !rows.length) return;
    const keys = [rows[0].image_key, rows[0].audio_key].filter(Boolean);
    const { data: gone, error } = await sbClient
      .from("chat_messages").delete().eq("id", id).select("id");
    if (error) throw error;
    if (!gone || !gone.length) throw new Error("Only an Admin can remove a message.");
    if (keys.length) {
      try { await sbClient.storage.from("chat-media").remove(keys); }
      catch (_) { /* the message is gone; orphaned media is invisible */ }
    }
  },

  // Placing is an insert, taking back is a delete — the composite pk
  // makes a double-tap idempotent, so the caller just says which way.
  async setChatReaction(messageId, profileId, emoji, on) {
    if (on) {
      const { error } = await sbClient
        .from("chat_reactions")
        .upsert({ message_id: messageId, profile_id: profileId, emoji }, { onConflict: "message_id,profile_id,emoji" });
      if (error) throw error;
    } else {
      const { error } = await sbClient
        .from("chat_reactions")
        .delete().match({ message_id: messageId, profile_id: profileId, emoji });
      if (error) throw error;
    }
  },

  // Live feed for the room. Returns the unsubscribe, for the screen's
  // cleanup. Updates are pin changes — bodies are immutable. Delete
  // events carry only the row's id — that is all the replicated key
  // holds — which is also all the screen needs to drop it. Reactions
  // ride the same channel, as does presence: `me` is tracked once the
  // channel is up, and onPresence hears the room's roster change.
  //
  // onStatus gets the channel's own state reports ("SUBSCRIBED",
  // "CHANNEL_ERROR", …). They matter because a dropped feed is silent:
  // the socket reconnects itself, but a channel that lands in an error
  // state stays there, looking exactly like a quiet room. The screen
  // watches the status and rebuilds the feed — found the hard way, when
  // the realtime service restarted six times in an afternoon and every
  // open phone just stopped hearing the room.
  subscribeChatMessages({ me, onInsert, onUpdate, onDelete, onReaction, onPresence, onStatus }) {
    const channel = sbClient
      .channel("team-chat", me ? { config: { presence: { key: me.id } } } : undefined)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" },
        p => onInsert(shapeChatMessage(p.new)))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "chat_messages" },
        p => onUpdate(shapeChatMessage(p.new)))
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "chat_messages" },
        p => onDelete(p.old.id))
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_reactions" },
        p => { if (onReaction) onReaction({ messageId: p.new.message_id, profileId: p.new.profile_id, emoji: p.new.emoji, on: true }); })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "chat_reactions" },
        p => { if (onReaction) onReaction({ messageId: p.old.message_id, profileId: p.old.profile_id, emoji: p.old.emoji, on: false }); })
      .on("presence", { event: "sync" }, () => {
        if (!onPresence) return;
        const state = channel.presenceState();
        onPresence(Object.entries(state).map(([id, metas]) => ({
          profileId: id,
          name: (metas && metas[0] && metas[0].name) || ""
        })));
      })
      .subscribe(status => {
        if (status === "SUBSCRIBED" && me) {
          channel.track({ name: me.name }).catch(() => {});
        }
        if (onStatus) onStatus(status);
      });
    return () => { sbClient.removeChannel(channel); };
  },

  // ── Chat push notifications ──────────────────────────────────────────
  // The subscription lives in two places that must agree: the browser's
  // push manager (which mints the endpoint) and push_subscriptions (which
  // is what chat-push actually sends to). "On" means both exist and the
  // row is yours — on a shared tablet the browser may hold a subscription
  // that belongs to the last person, and that reads as "off" until you
  // claim it.
  chatPushSupported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  },

  async getChatPushState() {
    if (!this.chatPushSupported()) return "unsupported";
    if (Notification.permission === "denied") return "blocked";
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return "off"; // dev server, or a first load the worker hasn't claimed yet
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return "off";
    const { data, error } = await sbClient
      .from("push_subscriptions").select("id").eq("endpoint", sub.endpoint).maybeSingle();
    if (error) throw error;
    return data ? "on" : "off";
  },

  async enableChatPush() {
    if (!this.chatPushSupported()) {
      throw new Error("This device can't do notifications — on an iPhone, install the app first (Share → Add to Home Screen), then try from the installed app.");
    }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      throw new Error("Notifications are blocked for this app — allow them in the phone's settings and try again.");
    }
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) throw new Error("The app's service worker isn't ready — reload the app once and try again.");
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidKeyBytes()
    });
    const j = sub.toJSON();
    // The definer RPC, not a plain insert: on a shared tablet this
    // endpoint may still belong to the last person who used it, and
    // claiming it is exactly what flipping the switch means.
    const { error } = await sbClient.rpc("claim_push_subscription", {
      _endpoint: sub.endpoint, _p256dh: j.keys.p256dh, _auth: j.keys.auth
    });
    if (error) throw error;
  },

  async disableChatPush() {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (!sub) return;
    const { error } = await sbClient
      .from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    if (error) throw error;
    // The browser side goes second: if the row delete failed we'd rather
    // still hold the subscription than have the server push at a corpse.
    try { await sub.unsubscribe(); } catch (_) { /* the row is gone; sends to it now prune themselves */ }
  }
};

// ── "That saved" ─────────────────────────────────────────────────────────
//
// Every write a person actually performs, and what to call it afterwards.
// Announcing it here rather than at each screen means a new screen gets the
// confirmation for free, and no screen can forget one.
//
// Wording is the action in the past tense, from the user's side: they pressed
// Approve, so it says "Timesheet approved", not "timesheet_approvals row
// inserted". Deletes say so plainly — a disappearing row is exactly when you
// want to be told it was on purpose.
const SAVE_MESSAGES = {
  // Billing
  markTicketsInvoiced: "Marked invoiced",
  unmarkTicketsInvoiced: "Back to approved",
  markTicketChased: "Flagged as chased",
  // Contacts and organisations
  createContact: "Contact added",
  updateContact: "Contact saved",
  deleteContact: "Contact removed",
  setPrimaryContact: "Primary contact changed",
  createClient: "Client added",
  updateClientGst: "GST rate saved",
  createContractor: "Contractor added",

  // Jobs
  createJob: "Job created",
  updateJobRecord: "Job record saved",
  setJobComplete: "Job status changed",
  deleteJob: "Job deleted",

  // Hazard assessments
  createJha: "JHA filed",
  closeOutJha: "JHA closed out",
  sendJhaEmail: "Assessment sent",
  deleteJha: "Assessment deleted",

  // Reports and files
  uploadReport: "Report uploaded",
  sendReportEmail: "Report sent",
  deleteReport: "Report deleted",
  deleteSharedFile: "File deleted",
  deleteFolder: "Folder deleted",

  // Billing
  createTicket: "Ticket created",
  updateTicket: "Ticket saved",
  deleteTicket: "Ticket cancelled",
  sendTicketApproval: "Approval sent",
  withdrawTicketApproval: "Approval cancelled — the ticket is a draft again",
  sendPasswordReset: "Set-password link sent",
  archiveClearJobs: "Archived jobs cleared",

  // Email setup
  saveAppSettings: "Settings saved",
  sendTestEmail: "Test email sent",

  // Automatic backup
  saveBackupSettings: "Backup settings saved",
  disconnectBackup: "Drive disconnected",
  backupNow: "Backup started",
  restoreAll: "Restore started",
  restoreJobs: "Restoring the chosen jobs",

  // Rates
  setRateLine: "Rate saved",
  addRateLine: "Rate line added",
  deleteRateLine: "Rate line removed",
  reorderRateLines: "Line order saved",
  publishSchedule: "Schedule published",
  copyDefaultInto: "Default rates copied in",
  setFollowsDefault: "Rate card updated",
  createOverride: "Override added",
  deleteOverride: "Override removed",
  toggleOverrideActive: "Override updated",

  // Equipment
  createEquipment: "Equipment added",
  updateEquipment: "Equipment saved",
  deleteEquipment: "Equipment removed",

  // Timesheets
  approveTimesheet: "Timesheet approved",
  unapproveTimesheet: "Timesheet reopened",

  // Accounts
  createUserAccount: "Account created",
  deleteUserAccount: "Account removed",
  updateProfileDetails: "Account saved",
  updateProfileTabs: "Access updated",
  updateProfileRole: "Role changed",

  // Team chat
  deleteChatMessage: "Message removed",
  pinChatMessage: "Message pinned",
  unpinChatMessage: "Pin taken down",
  enableChatPush: "Notifications on — this device will hear about new messages",
  disableChatPush: "Notifications off"
};

// Left deliberately silent, because nobody did them on purpose:
//
//   clearPrimary        a step inside setPrimaryContact
//   rememberContact     files the rep a new job was created with
//   resolveJobContact   the same, for the job record
//   saveCrewForTicket   part of saving a ticket, not its own action
//   getEditableSchedule creates a draft schedule the first time a client's
//                       rates are opened — a read, as far as anyone can tell
//   renderJhaPdf        best-effort background render
//   sendChatMessage     the message appearing in the room is its own
//                       confirmation — a toast over it would say it twice
//
// Each of those fires inside something already in the table above, and would
// otherwise produce two confirmations for one press.
for (const [method, message] of Object.entries(SAVE_MESSAGES)) {
  const original = Db[method];
  if (typeof original !== "function") {
    // A rename would otherwise silently stop announcing that write.
    console.warn(`No Db.${method} to announce — SAVE_MESSAGES is out of date.`);
    continue;
  }
  Db[method] = async function (...args) {
    let result;
    try {
      result = await original.apply(this, args);
    } catch (e) {
      // The database's own words — "new row violates row-level security
      // policy", "duplicate key value" — reach the screen otherwise. Said
      // in the person's terms instead, at the one place every write passes.
      throw humanizeError(e);
    }
    // Only on the way out, so a write that throws says nothing — the screen
    // shows the real error instead of a confirmation that isn't true.
    Toasts.show(message);
    return result;
  };
}

// What a refused write means to the person who pressed the button. Errors
// that already carry a sentence written for them (plainError, ticketGone,
// the friendly line errors) pass through untouched; so do network failures,
// whose message the offline queue recognises by its wording. Everything
// else is matched on the Postgres/PostgREST code, never on the text.
export function humanizeError(e) {
  if (!e || e.plain || e.ticketGone || isNetworkError(e)) return e;
  const code = String(e.code || "");
  // A duplicate key on ticket_crew is not "the number or name is taken" — it
  // is two devices saving one ticket's crew in the same second, and the
  // person needs to be told whose hours are on the ticket now rather than to
  // go looking for a name they never typed. saveCrewForTicket upserts, so
  // this should no longer be reachable from there; it stays because the
  // sentence below it is worse than useless for these rows.
  if (code === "23505" && /ticket_crew/.test(`${e.message || ""} ${e.details || ""}`)) {
    return plainError("Another device saved this ticket's crew at the same moment. Open the ticket again to see the hours that landed, and re-enter yours if they're missing.");
  }
  const said = {
    "42501": "Your account isn't allowed to do that. An admin can grant the access in Users & access.",
    "23505": "That already exists — the number or name is taken. Check the list and try a different one.",
    "23503": "That's still in use by something else on file (a ticket, a job, an assessment), so it can't be removed.",
    "23514": "That value isn't one this field accepts.",
    "23502": "A required field is empty.",
    "PGRST116": "That record isn't there any more — it may have been deleted on another device. Refresh and try again.",
    "22003": "That number is too large to store — check the quantity or the rate."
  }[code];
  if (!said) return e;
  const friendly = new Error(said);
  friendly.code = e.code;
  friendly.cause = e;
  friendly.plain = true;
  return friendly;
}
