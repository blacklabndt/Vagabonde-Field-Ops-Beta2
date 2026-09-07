// How old the outstanding money is, and whose it is.
//
// "Who owes me and how long has it been" is the Monday-morning question, and
// the tracker answered it with a paged table you had to read. public
// .ticket_aging() does the grouping in the database — one row per client per
// bucket, over every ticket that has been sent but has not been through
// (Awaiting approval, Approved, Invoiced; there is no Paid status) — and this
// module turns those rows into the four tiles and the by-client table.
//
// It is here rather than in the screen because the edges are the whole
// meaning: a ticket 30 days old is in the 30 bucket and one 29 days old is
// not, and that is a rule worth a test rather than an inline ternary. The
// database does the bucketing; these labels and this rollup are the only
// other place the same edges are written down, so they are written down once.
//
// Deliberately free of React and db.js: it takes rows and returns totals.

// The buckets, in the order they are shown. `key` is the string the database
// hands back; `note` says which days are in it, because "30 days" on a tile
// is ambiguous about whether the 30th day is in or out.
export const AGING_BUCKETS = [
  { key: "current", label: "Current", note: "under 30 days old" },
  { key: "30", label: "30 days", note: "30 to 59 days old" },
  { key: "60", label: "60 days", note: "60 to 89 days old" },
  { key: "90", label: "90+ days", note: "90 days or more" }
];

// The order tiles and columns are drawn in is AGING_BUCKETS', never the
// buckets object's: three of the four keys read as integers, and a JS object
// puts integer-like keys first in numeric order whatever order they went in.
export const AGING_KEYS = AGING_BUCKETS.map(b => b.key);

// What a client with no client record on the job is called. It is a real
// group — those tickets are outstanding money too — and calling it nothing
// would leave a blank row somebody has to guess at.
export const NO_CLIENT = "No client on the job";

// Integer-cents addition, the house money rule (gstOn in data.js). A running
// float sum drifts a half-cent low at certain boundaries; summing cents and
// dividing once is exact.
const addMoney = (a, b) => (Math.round(a * 100) + Math.round(b * 100)) / 100;

// A fresh set of empty buckets. Count is always a number; total starts null
// and stays null until a row brings a figure, because the database hands a
// role that may not see prices null totals and Number(null) is 0 — a figure,
// indistinguishable from a client who really owes nothing.
const emptyBuckets = () => Object.fromEntries(AGING_KEYS.map(k => [k, { count: 0, total: null }]));

function addInto(cell, count, total) {
  cell.count += count;
  if (total != null) cell.total = addMoney(cell.total == null ? 0 : cell.total, Number(total));
}

// rows: what Db.ticketAging() returns — { clientId, client, bucket, count,
// total }, one per client per bucket, total null for a role without prices.
//
// Returns the four tile figures, the whole outstanding position, and one row
// per client sorted by what they owe. Sorting falls back to the count for a
// role whose totals are all null: sorting every client as equal would put
// them in whatever order the database happened to answer in, which changes
// between reads.
export function rollUpAging(rows) {
  const buckets = emptyBuckets();
  const byClient = new Map();
  let count = 0;
  let total = null;

  for (const r of rows || []) {
    const key = AGING_KEYS.includes(r.bucket) ? r.bucket : null;
    // A bucket this build has never heard of would otherwise vanish from the
    // tiles while still being counted in the total, so the two would
    // disagree with no sign of why. Skipping it whole keeps them honest.
    if (!key) continue;
    const n = Number(r.count) || 0;
    addInto(buckets[key], n, r.total);
    count += n;
    if (r.total != null) total = addMoney(total == null ? 0 : total, Number(r.total));

    // Grouped by id, not by name: two clients may share a name, and the
    // rows for a job with no client all arrive with a null id.
    const id = r.clientId || "";
    let c = byClient.get(id);
    if (!c) {
      c = { clientId: r.clientId || null, name: r.client || NO_CLIENT, count: 0, total: null, buckets: emptyBuckets() };
      byClient.set(id, c);
    }
    addInto(c.buckets[key], n, r.total);
    c.count += n;
    if (r.total != null) c.total = addMoney(c.total == null ? 0 : c.total, Number(r.total));
  }

  const clients = [...byClient.values()].sort((a, b) => {
    const money = (b.total == null ? 0 : b.total) - (a.total == null ? 0 : a.total);
    if (money) return money;
    if (b.count !== a.count) return b.count - a.count;
    // Named order last, so two clients owing the same amount don't swap
    // places between reads.
    return a.name.localeCompare(b.name);
  });

  return { buckets, clients, count, total };
}

// PostgREST answers PGRST202 for a routine it cannot find, and older gateways
// only say it in words — so the code is the reliable half and a message is
// believed only when it names this function. The same two-part test the dose
// ledger uses (timesheets.jsx), and for the same reason: a permission refusal
// or a timeout must reach the screen as itself, not as "not deployed yet".
export function isMissingTicketAging(error) {
  if (!error) return false;
  if (error.code === "PGRST202") return true;
  const msg = String(error.message || "");
  return msg.includes("ticket_aging") && /could not find|does not exist|not found/i.test(msg);
}
