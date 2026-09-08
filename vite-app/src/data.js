// ─────────────────────────────────────────────────────────────────────────
// Shared constants and pure helpers: money and date formatting, ticket
// numbering, pay periods, the tab and role tables, and the standing hazard
// and rate-card lists every screen builds from.
//
// Nothing here touches the network. The tables themselves live in Supabase
// and are read through db.js; what stays here is the arithmetic and the
// vocabulary, in one place so that the job screen and the billing screen
// can never disagree about a ticket number or what a standard rate line is.
// ─────────────────────────────────────────────────────────────────────────

const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

export const money = n => "$" + (Number(n) || 0).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Today as YYYY-MM-DD in the *browser's* timezone.
//
// `new Date().toISOString().slice(0, 10)` looks like it does this and doesn't:
// it returns the UTC date, which in Alberta rolls over at 17:00 local. Every
// evening ticket was being dated tomorrow, and any raised on the 15th after
// 17:00 was filed into the following pay period.
export const todayLocal = () => {
  const d = new Date();
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
};

// Parses a plain YYYY-MM-DD as *local* midday. Midday, not midnight, so that a
// DST transition can't push the value onto the neighbouring day.
export const localDate = s => {
  const [y, m, d] = String(s || "").split("-").map(Number);
  return (y && m && d) ? new Date(y, m - 1, d, 12) : new Date(NaN);
};

export const dayMonth = d => String(d.getDate()).padStart(2, "0") + " " +
  d.toLocaleDateString("en-CA", { month: "short" }).replace(".", "");

export const initialsOf = name => (name || "")
  .replace(/[^A-Za-z\s.]/g, "").split(/[\s.]+/).filter(Boolean)
  .map(w => w[0].toUpperCase()).slice(0, 3).join("");

// The date part of a ticket number: MMDD-YY.
//
// Ticket numbers read {initials}-{MMDD}-{YY}-{NN} (KK-0812-26-01). Kept as a
// helper rather than inlined so the number minted on the job screen and the one
// minted on the billing screen can never drift apart.
export const ticketDateStamp = d =>
  String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0") +
  "-" + String(d.getFullYear()).slice(2);

// Access lists arrive from the `profiles` table and can be null on a row that
// predates the column, or on one an admin emptied. Every read of them went
// through `.includes` / `[0]` / `.length` unguarded, so a single null column
// took the whole app to a blank screen at sign-in. One coercion, used
// everywhere a tab list is read.
//
// Contacts is a universal lookup — a phone number for the rep on the lease is
// not privileged information the way rates and timesheets are. So it is added
// to every account that has any access at all. An account with no tabs stays
// locked out: that emptiness is what App treats as "profile with no access".
//
// Lives here rather than in common.jsx so the sign-in logic that depends on it
// can be tested without pulling in React.
export const UNIVERSAL_TABS = ["contacts"];
export const tabList = v => {
  const tabs = Array.isArray(v) ? v : [];
  if (!tabs.length) return tabs;
  return tabs.concat(UNIVERSAL_TABS.filter(t => !tabs.includes(t)));
};

export const TABS = [
  { key: "board", label: "Home" },
  { key: "job", label: "Job detail" },
  { key: "jha", label: "JHA builder" },
  { key: "upload", label: "Report upload" },
  { key: "ticket", label: "Billing ticket" },
  { key: "mytickets", label: "Open tickets" },
  { key: "chat", label: "Team chat" },
  { key: "files", label: "Files" },
  { key: "contacts", label: "Contacts" },
  { key: "equipment", label: "Equipment" },
  { key: "timesheets", label: "Timesheets" },
  { key: "rates", label: "Rate admin" },
  { key: "tracker", label: "Billing tracker" },
  { key: "users", label: "Users & access" },
  { key: "mail", label: "Admin" }
];

// Screens that only make sense with a job under them. They never appear in
// the drawer — for anyone — because a JHA builder opened from the menu
// operates on whichever job happens to be active, which is how the wrong
// job gets edited. The route to them is the one Kyle described: Home or
// Open tickets, pick the job, work from its own buttons.
//
// The tabs themselves still exist and still matter: they are PERMISSION.
// Row-level security and the storage buckets gate on them, which is how
// hiding them by deleting them from tab_access broke report uploads for
// two admins without a visible symptom. Visibility is decided here, in
// code, for everybody; access is decided per person, in Users & access.
export const CONTEXT_TABS = ["job", "jha", "upload", "ticket"];

// Kept in step with public.tabs_for_role() in the migrations, which is what
// the signup trigger seeds a new account from — the two had drifted, leaving
// accounts created in the app without the tabs this table promises them.
export const ROLE_PRESETS = {
  Admin: ["board", "job", "jha", "upload", "ticket", "mytickets", "files", "contacts", "equipment", "timesheets", "rates", "tracker", "users", "mail", "chat"],
  Coordinator: ["board", "job", "jha", "upload", "ticket", "mytickets", "files", "contacts", "equipment", "timesheets", "tracker", "chat"],
  // Technicians get the directory read-write too: the person who finds out
  // the site rep's number is usually the one standing on the lease.
  // Timesheets too: the screen shows a technician their own hours and
  // nobody else's, and "where are my hours?" was the first question a new
  // hire asked. Mirrored in tabs_for_role() (migration "round two").
  Technician: ["board", "job", "jha", "upload", "ticket", "mytickets", "files", "contacts", "timesheets", "chat"],
  // A helper assists a technician on site: they sign onto the JHA and appear
  // on the ticket crew for their hours and dose, but they do not raise
  // tickets or upload reports themselves, so those tabs stay off.
  Helper: ["board", "job", "jha", "files", "contacts", "chat"]
};

// The contact every screen pre-fills from: an organisation's primary, or its
// only one if nobody has been promoted yet (rows predating the directory).
export function primaryContact(contacts, orgType, orgId) {
  if (!orgId) return null;
  const mine = (contacts || []).filter(c => c.org_type === orgType && c.org_id === orgId);
  return mine.find(c => c.is_primary) || mine[0] || null;
}

// Everyone on file for an organisation, primary first then by name — the
// rep dropdowns are fed from this rather than from the primary alone, so a
// night foreman who isn't the default is one pick away instead of a retype.
// One definition: it used to be written out in three dialogs, over the
// whole directory, on every keystroke. Callers memoize on (contacts, id).
export function contactsForOrg(contacts, orgType, orgId) {
  if (!orgId) return [];
  return (contacts || []).filter(c => c.org_type === orgType && c.org_id === orgId)
    .sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0) || (a.name || "").localeCompare(b.name || ""));
}

// Roles that can be added to a ticket crew, and the crew_role each carries.
// Kept apart from ROLE_PRESETS so the crew grouping does not change every
// time an office role is added.
const CREW_ROLE_OF = { Helper: "Helper" };
export const crewRoleFor = profile => CREW_ROLE_OF[profile && profile.role] || "Technician";

// Who sees money. Prices — rate cards, ticket lines, the totals they add up
// to — are for Admins and Technicians, per Kyle: the database refuses the
// lines to everyone else and nulls the totals it hands back. Every screen
// that shows an amount asks this one question rather than keeping its own
// answer, which is how Open tickets and Job detail came to disagree.
export const seesPrices = user => !!user && (user.role === "Admin" || user.role === "Technician");

// Whether a save may land on a ticket, given the status the row is at and the
// status the save is carrying. Returns the refusal to show, or null.
//
// Lifted out of db.js's updateTicket so the rule can be read and tested on its
// own: it is two sentences of prose in the middle of a long function, and both
// of them are about money that has already left the building.
//
// The Approved/Invoiced half is the obvious one — what the client agreed to
// pay is not something the app may quietly rewrite afterwards.
//
// The Awaiting-approval half is the one that reads like an accident and
// isn't. "Draft" is the word every save sends: the editor hardcodes it, and a
// queued replay carries the literal string it was enqueued with hours ago. So
// a Draft arriving over a ticket the office has since sent for signature is
// not somebody choosing to un-send it — it is a stale save about to move the
// money under a live approval link, and the rep would sign a different bill
// from the one they were emailed. Pulling a sent ticket back is
// withdraw_ticket_approval's job and nobody else's.
export function ticketStatusWriteRefusal(rowStatus, requestedStatus, ticketId = "This ticket") {
  if (rowStatus === "Approved" || rowStatus === "Invoiced") {
    return `Ticket ${ticketId} is ${rowStatus.toLowerCase()} — it can't be changed. Raise a new ticket for any correction.`;
  }
  if (rowStatus === "Awaiting approval" && requestedStatus === "Draft") {
    return `Ticket ${ticketId} has been sent for the client's signature — cancel the approval before changing it.`;
  }
  return null;
}

// ── Pay periods ────────────────────────────────────────────────────────
// Semi-monthly: the 1st–15th, then the 16th to the end of the month. Dates
// are handled as plain YYYY-MM-DD strings, never Date objects, because a
// Date parsed from "2026-08-01" is midnight UTC — which in Alberta is the
// previous evening, and would file the 1st under the wrong period.
const lastDayOf = (y, m) => new Date(y, m, 0).getDate();

export function payPeriodLabel(p) {
  const fmt = s => {
    const [y, m, d] = s.split("-").map(Number);
    return `${String(d).padStart(2, "0")} ${new Date(y, m - 1, 1).toLocaleDateString("en-CA", { month: "short" }).replace(".", "")}`;
  };
  return `${fmt(p.start)} – ${fmt(p.end)} ${p.start.slice(0, 4)}`;
}

// The last `count` periods, newest first — the period picker's options.
export function recentPayPeriods(count = 12, from = new Date()) {
  const out = [];
  let y = from.getFullYear();
  let m = from.getMonth() + 1;
  let firstHalf = from.getDate() <= 15;
  for (let i = 0; i < count; i++) {
    out.push({
      start: iso(y, m, firstHalf ? 1 : 16),
      end: iso(y, m, firstHalf ? 15 : lastDayOf(y, m))
    });
    if (firstHalf) { m -= 1; if (m === 0) { m = 12; y -= 1; } firstHalf = false; }
    else firstHalf = true;
  }
  return out;
}

export const hours = n => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);

// ── Dose periods ───────────────────────────────────────────────────────
// Calendar quarters and calendar years, newest first — the dose ledger's
// pickers. The crew's dosimetry year is the calendar year, per Kyle.
export function recentQuarters(count = 8, from = new Date()) {
  const out = [];
  let y = from.getFullYear();
  let q = Math.floor(from.getMonth() / 3);
  for (let i = 0; i < count; i++) {
    const m1 = q * 3 + 1;
    out.push({ kind: "quarter", label: `Q${q + 1} ${y}`, start: iso(y, m1, 1), end: iso(y, m1 + 2, lastDayOf(y, m1 + 2)) });
    q -= 1;
    if (q < 0) { q = 3; y -= 1; }
  }
  return out;
}
export function recentYears(count = 5, from = new Date()) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const y = from.getFullYear() - i;
    out.push({ kind: "year", label: String(y), start: iso(y, 1, 1), end: iso(y, 12, 31) });
  }
  return out;
}
// Which quarter (1–4) a YYYY-MM-DD work date falls in.
export const quarterOf = dateStr => Math.floor((Number(String(dateStr || "").slice(5, 7)) - 1) / 3) + 1;

// Whether a timestamp is within the last `days` days — "chased on Tuesday"
// is recent enough not to chase again on Thursday.
export const withinDays = (ts, days) => {
  if (!ts) return false;
  const t = new Date(ts).getTime();
  return !isNaN(t) && (Date.now() - t) < days * 86400000;
};

// Whole days between a timestamp and now. Counted from local midnight on each
// side, so "2 days old" doesn't tick over at whatever time of day the row
// happened to be written — which is what drove the "over 7 days" flag before.
export function ageInDays(ts) {
  if (!ts) return 0;
  const then = new Date(ts);
  if (isNaN(then)) return 0;
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const now = new Date();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((b - a) / 86400000));
}

// Only STANDARD_RATE_LINES below reads these two now — the ticket screen's
// menus come from the client's card itself, and the rate admin's rows come
// from the lines. They seed fresh schedules and order legacy position-less
// lines, nothing more.
const SIZE_LABELS = ['2" NPS', '4" NPS', '6" NPS', '8" NPS', '12" NPS'];

// An empty job record. `App` holds one of these until a job is actually
// opened. It used to hold a hard-coded sample record for a real job — which
// meant the mobile ticket and upload screens displayed, and addressed email
// to, one client's rep before any job had been chosen.
export const EMPTY_JOB_RECORD = {
  job: "", client: "", clientRep: "", contractor: "", contractorRep: "",
  afe: "", lsd: "", method: "", procedure: "", started: ""
};

// The job record, in the order the panel shows it: identifiers first, then the
// two organisations with their reps, then the start date.
export const JOB_FIELDS = [
  { key: "job", label: "Job" }, { key: "lsd", label: "LSD" }, { key: "afe", label: "AFE" },
  { key: "area", label: "Area" },
  { key: "client", label: "Client" }, { key: "clientRep", label: "Client rep" },
  { key: "contractor", label: "Contractor" }, { key: "contractorRep", label: "Contractor rep" },
  { key: "started", label: "Started" }
];

// The certification levels printed beside a technician's name on the client
// field invoice, and the legend printed under them. One list so the codes on
// the ticket and the legend explaining them can never drift apart.
export const TECH_LEVELS = [
  { code: "S",  label: "Specialist" },
  { code: "T2", label: "Level 2 Certified Technician" },
  { code: "T1", label: "Level 1 Certified Technician" },
  { code: "C",  label: "CEDO" },
  { code: "T",  label: "Trainee" },
  { code: "A",  label: "Administrative" }
];

// Floors a figure at zero, for anything that feeds a bill. A negative rate,
// quantity or hour count prices a line below zero and quietly credits the
// client — the ticket totals up short with nothing anywhere reporting an
// error, which is the worst way for a number to be wrong. Zero stays a real
// value ("not priced yet", "no hours today"), so this floors, not rejects.
//
// One copy, here, because it used to live twice — in db.js and in the
// NumField — and only one of the two knew that a comma decimal is a decimal:
// "1,5" is how half the world's keyboards type one and a half, and a bare
// parseFloat silently reads it as 1.
export const nonNegative = value => {
  const n = typeof value === "number" ? value : parseFloat(decimalString(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// What a typed number means. "1,5" is one and a half; "1,200" is twelve
// hundred — on this crew's keyboards a comma before exactly three trailing
// digits is a thousands separator, and reading it as the decimal point
// turned a $1,200 day rate into $1.20 on the published card. With both
// marks present the last one is the decimal point and the rest are
// grouping ("1,234.5"). Anything else is left to parseFloat.
export const decimalString = value => {
  const s = String(value ?? "").trim();
  const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = Math.max(lastDot, lastComma);
    return s.slice(0, dec).replace(/[.,]/g, "") + "." + s.slice(dec + 1).replace(/[.,]/g, "");
  }
  if (lastComma >= 0) {
    const parts = s.split(",");
    // A comma before exactly three digits is a thousands separator only when
    // what precedes it could be thousands: "1,200" is twelve hundred, but
    // "0,125" is an eighth — a dose or an hour typed the European way, which
    // this rule once turned into 125.
    const grouping = parts.length > 2 || (/^\d{3}$/.test(parts[1]) && /^[1-9]\d{0,2}$/.test(parts[0]));
    return grouping ? parts.join("") : parts.join(".");
  }
  return s;
};

// A line's billable amount: quantity × rate, rounded to the cent. The one
// formula the database's total sync, the ticket screen and the printed
// invoice all share — migration 20260818140051 put the same round() into
// the triggers, after the audit found half an hour at a $9.25 rate could
// not be saved: the stored total rounded to 4.63 while the balance check
// summed the exact 4.625, and the database refused its own arithmetic.
// Whole cents times thousandths of a unit, in integers: the float product of
// 1.5 and 60.05 is 90.07499999999999, which rounds a cent below the
// round(quantity * unit_rate, 2) the trigger stores in tickets.total. A
// quantity is at most thousandths (CATALOG_STEP: halves and tenths).
export const lineTotal = (quantity, unitRate) =>
  Math.round(Math.round(Number(quantity || 0) * 1000) * Math.round(Number(unitRate || 0) * 100) / 1000) / 100;

// What a day's work can plausibly hold, per unit of the rate card. None of
// these is a limit — a ticket may legitimately carry any of them — they are
// the figure past which the ticket screen asks once whether that is really
// what was worked. The only guard until now was MAX_TICKET_TOTAL in db.js,
// which is the database's numeric(10,2) ceiling: it catches a nine-figure
// ticket and nothing under it, so 12,000 welds at $8 saved without a murmur
// and billed the client $96,000. A stray digit in the quantity box is the one
// way a ticket goes wrong quietly.
//
// Per unit, because the units mean different things: 200 km is an ordinary
// drive out of Grande Prairie, and 200 hours is a month.
export const SANE_QUANTITY_PER_UNIT = {
  weld: 200,     // a crew shoots dozens of welds in a day, not hundreds
  h: 24,         // hours billed on one line of one work date
  days: 31,      // LOA and day rates are sometimes back-billed over a stretch
  km: 2000,      // there and back from anywhere in the province
  ea: 200        // film, callouts, mobilizations
};
export const SANE_QUANTITY_DEFAULT = 200;
export const saneQuantityCeiling = unit =>
  Object.prototype.hasOwnProperty.call(SANE_QUANTITY_PER_UNIT, unit)
    ? SANE_QUANTITY_PER_UNIT[unit] : SANE_QUANTITY_DEFAULT;

// One person's hours on one ticket. A ticket covers a single work date, so
// anything past a full day is a typo worth a question — hours here are
// payroll, not billing.
export const SANE_CREW_HOURS = 24;

// GST on the client's field invoice. Alberta, so the 5% federal rate with no
// provincial component — but not every client pays it: a First Nations band,
// a Crown agency or a client billing through an exempt entity is zero-rated,
// and the office was deleting the GST line off those tickets by hand every
// time. The rate is a percent on the client's own row (clients.gst_rate),
// and this is the figure a client without one is billed at.
export const GST_RATE_DEFAULT = 5;
// The same rate as a fraction, kept because the invoice and the approval
// email still speak in fractions. 5 / 100 is exactly the double 0.05, so
// nothing that multiplies by it changes.
export const GST_RATE = GST_RATE_DEFAULT / 100;

// What a client's rate really is. A row from before the column existed — an
// older backup, a job cached on a tablet, a fresh database the migration has
// not reached — has nothing to say, and silence means the ordinary 5%, never
// zero: guessing exempt is the guess that undercharges. Anything outside
// 0–100 is not a tax rate, so it falls back the same way.
// Nothing at all is checked before the number: Number(null) and Number("")
// are both 0, which is a perfectly valid tax rate and exactly the wrong one
// to infer from an absent field.
export const gstRateOf = value => {
  if (value == null || value === "") return GST_RATE_DEFAULT;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : GST_RATE_DEFAULT;
};

// How a rate is written on screen. Zero is spelled out rather than shown as
// "GST 0%": a technician reading a total needs to know the client is exempt,
// not wonder whether the tax line failed to load.
export const gstLabel = ratePercent => {
  const n = gstRateOf(ratePercent);
  return n === 0 ? "GST exempt" : `GST ${Number(n.toFixed(2))}%`;
};

// Rounded on integer cents, not on dollars.
//
// `Math.round(subtotal * 0.05 * 100) / 100` looks equivalent and is not: in
// binary floating point a half-cent lands just below the boundary often
// enough to matter. Checked every whole-cent subtotal from $0.01 to $5,000
// and 408 of them come out a cent low that way — $0.70, $2.90, $20.70,
// $42.30 among them — always under-charging, so the company covers the
// difference. Rounding the subtotal to cents first removes the class.
//
// The rate is a percent, so the one-argument call every screen made before
// clients had their own rate still means 5%.
//
// Mirrored in supabase/functions/_shared/invoice.ts. The two must agree to
// the cent or the app and the client's copy quote different totals.
export const gstOn = (subtotal, ratePercent = GST_RATE_DEFAULT) =>
  Math.round(Math.round(subtotal * 100) * (gstRateOf(ratePercent) / 100)) / 100;

// Storage object keys are stricter than filenames: the API refuses
// non-ASCII outright ("Invalid key"), % breaks the request before it
// leaves, and # or ? silently truncate the key at what a URL considers
// the end of a path. Found in beta testing with a phone-style filename.
// Accents fold to their plain letters so "Réport.pdf" stays readable as
// "Report.pdf"; everything else the key can't carry becomes a dash. The
// original name is still shown everywhere — only the key is boring.
export const storageKeySafe = (name, fallback = "file") => {
  const cleaned = String(name || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
  return cleaned || fallback;
};

// A file's size in the unit it is actually in. The phone upload screen
// printed everything in MB to one decimal, so a 340 KB report read "0.0 MB"
// and looked like an empty attachment.
export const fileSize = bytes => {
  const n = Number(bytes) || 0;
  if (n < 1000) return `${Math.round(n)} bytes`;
  if (n < 1e6) return `${Math.round(n / 1000)} KB`;
  return `${(n / 1e6).toFixed(1)} MB`;
};

// The ceiling on an interpreted report. Nothing enforced one on the client
// before: `accept=` on a file input is a picker filter and no more, so a .txt
// and a 25 MB blank PDF both went up without a word. The number is ours, not
// the platform's — Storage stops at the project's 50 MiB and says so in the
// API's own words, and the mail function attaches up to MAX_ATTACHMENT_BYTES
// (7 MB) and sends anything larger as a link. 25 MB is generous for a scanned
// report and small enough that a phone on a lease can actually push it.
// Decimal megabytes, the same ones fileSize above prints in, so the size a
// refusal quotes and the limit it quotes are measured the same way.
export const MAX_REPORT_BYTES = 25 * 1e6;
export const MAX_REPORT_LABEL = "25 MB";

// Why a picked report is refused, or "" if it is fine. Both the phone screen
// and the desktop dialog ask this, so the two say the same sentence.
export function reportFileRefusal(file) {
  if (!file) return "";
  const name = file.name || "the file";
  // The type is what the browser thinks; the extension is what the person
  // chose. Either one saying PDF is enough — some phones hand over an empty
  // type for a file picked out of a cloud drive.
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(name);
  if (!isPdf) {
    return `${name} isn't a PDF. Interpreted reports are filed as PDFs — export it as one and attach that.`;
  }
  if (Number(file.size) > MAX_REPORT_BYTES) {
    return `${name} is ${fileSize(file.size)}, over the ${MAX_REPORT_LABEL} limit for a report. Split it, or export it at a lower scan quality, and attach it again.`;
  }
  return "";
}

// Reads the film and MPI numbering off an interpreted report's text and
// answers the Upload dialog's "Last numbers" field in its own format:
// "XF-16 to XF-44, MT-66, MT-70 to MT-71".
//
// Contiguous runs, not one span from lowest to highest. A report holding
// MT-66 and MT-70..71 does not hold MT-67..69 — those welds are on some
// other day's report — and "MT-66 to MT-71" would claim them. The
// contractor reconciles these numbers against the film in the envelope,
// so the field has to say exactly what is in the PDF and nothing more.
//
// The prefixes: XF, XS and XT number radiographic film, MT the MPI
// indications, UT the ultrasonic ones. Radiographic first in the answer,
// then surface, then volumetric — the order the paperwork reads in.
//
// The enemy is the procedure designation, which is paperwork wearing the
// same prefix as the welds — MT and UT are the methods' abbreviations, so
// their procedures are named after them too. Across real reports it has
// appeared three ways: "MT1 T1 Rev. 11", "MT 1", and "MT-01 REV 2 ASME V"
// on the same page as genuine MT-6..MT-9 rows. Three rules keep it out,
// each measured against a page where the collision actually happens, and
// every prefix gets all three because the UT procedure will pull exactly
// the same trick:
//   - the hyphen is required        ("MT1", "MT 1" are out)
//   - a zero-padded number is out   (rows write MT-6, never MT-06; the
//                                    template writes the procedure MT-01)
//   - a number followed by REV is out, whatever the padding
// A tech who zero-pads a real weld by hand loses that one from the range
// and edits the field, which stays a head start rather than an authority.
const NUMBER_PREFIXES = ["XF", "XS", "XT", "MT", "UT"];
export function lastNumbers(text) {
  const seen = {};
  for (const m of String(text || "").matchAll(/\b(XF|XS|XT|MT|UT)-(\d+)\b(?!\s*rev\b)/gi)) {
    if (/^0/.test(m[2])) continue;             // MT-01 is a procedure, not a weld
    const k = m[1].toUpperCase();
    if (!seen[k]) seen[k] = new Set();
    seen[k].add(Number(m[2]));
  }
  return NUMBER_PREFIXES
    .filter(k => seen[k])
    .map(k => {
      const nums = [...seen[k]].sort((a, b) => a - b);
      const runs = [];
      let start = nums[0];
      let prev = nums[0];
      for (const n of nums.slice(1)) {
        if (n === prev + 1) { prev = n; continue; }
        runs.push([start, prev]);
        start = prev = n;
      }
      runs.push([start, prev]);
      return runs
        .map(([a, b]) => (a === b ? `${k}-${a}` : `${k}-${a} to ${k}-${b}`))
        .join(", ");
    })
    .join(", ");
}

export const JHA_TEMPLATES = [
  "RT — Pipeline tie-in v4", "RT — Facility / plant piping v2",
  "RT — Shop radiography v1", "RT — Sour service (H₂S) v3"
];

// The standing hazard list the JHA builder opens with, every one of them
// unticked. They used to open ticked, which made "tick at least one hazard"
// a rule that could never fire: an assessment could be filed in three taps
// claiming all twelve with no severity, probability or frequency on any of
// them, and a pre-ticked safety form is a form to tap past. Same rule the
// ticket screen keeps on purpose — every charge on a ticket is one somebody
// picked from the dropdown.
export const SEED_HAZARDS = [
  { name: "Driving", control: "Follow all road rules, wear safety equipment, drive to conditions", level: "High", on: false },
  { name: "Entanglement", control: "Store equipment correctly, housekeeping to prevent injuries", level: "Med", on: false },
  { name: "Environmental", control: "Dress to conditions, stay hydrated, watch for extreme weather", level: "Med", on: false },
  { name: "Hazardous materials (WHMIS)", control: "Refer to MSDS sheets, sign transportation documentation", level: "High", on: false },
  { name: "Heavy equipment", control: "Make eye contact with the operator, keep a safe distance", level: "High", on: false },
  { name: "Housekeeping", control: "Keep the work area clutter-free to prevent injuries", level: "Med", on: false },
  { name: "Manual lifting", control: "Lift with your legs, do not twist or jerk", level: "Med", on: false },
  { name: "Pinch points", control: "Be aware of pinch points and avoid them whenever possible", level: "Med", on: false },
  { name: "Radiation (inc. NORM)", control: "ALARA, monitors, survey meters and signage to control area and monitor dose rates", level: "Critical", on: false },
  { name: "Slips / trips / falls", control: "Watch footing, wear proper footwear", level: "Med", on: false },
  { name: "Tools", control: "Examine tools for defects before use; do not use a defective tool", level: "Med", on: false },
  { name: "Weather related", control: "Dress to conditions; watch for extreme heat/cold, slippery or wet ground", level: "Med", on: false }
];

// The methods every schedule starts with. What a ticket can bill comes from
// the client's card itself now (Db catalog), not from this list — it exists
// to seed new schedules and order old, position-less lines.
const METHODS = [
  { key: "mt", label: "MT / MPI" }, { key: "pt", label: "PT" },
  { key: "vt", label: "VT" }, { key: "ht", label: "Hardness test" },
  { key: "ut", label: "UT" }
];

// The lines every rate schedule starts with, at zero. One list, used both
// when a schedule is first opened and by Restore standard lines, so the two
// can never disagree about what "standard" means.
// `position` is where a line starts on a fresh schedule — the same numbers
// migration 20260818030718 stamped on the live rows. The Rate admin screen
// orders by it and rewrites it when rows are dragged; the three RT kinds of
// one size share a position because the editor shows them as one row.
export const STANDARD_RATE_LINES = [
  ...SIZE_LABELS.flatMap((sz, i) => [
    { kind: "rt_film", label: sz, unit: "weld", position: i },
    { kind: "rt_cr", label: sz, unit: "weld", position: i },
    { kind: "rt_dr", label: sz, unit: "weld", position: i }
  ]),
  ...METHODS.map((m, i) => ({ kind: "method", label: m.label, unit: "weld", position: 10 + i })),
  // The crew rate is per truck, not per person: a second technician in the
  // same truck does not double it, and a second truck is a second ticket —
  // which is why these no longer say "Technician". Renamed live in migration
  // 20260818025620; the DB labels and these must stay identical, since old
  // tickets and legacy aliases are matched by label text.
  { kind: "expense", label: "Straight time", unit: "h", position: 20 },
  { kind: "expense", label: "Overtime", unit: "h", position: 21 },
  // Travel is billed apart from hours worked, at its own rate — that is how
  // the paper field ticket has always split it.
  { kind: "expense", label: "Travel — straight", unit: "h", position: 22 },
  { kind: "expense", label: "Travel — overtime", unit: "h", position: 23 },
  { kind: "expense", label: "Mileage", unit: "km", position: 24 },
  { kind: "expense", label: "Film & consumables", unit: "ea", position: 25 },
  { kind: "expense", label: "Subsistence / LOA", unit: "days", position: 26 },
  // The eight that used to be priced by constants in the ticket screen's
  // SERVICES list, moved onto the card by migration 20260818035752 so every
  // dollar a ticket bills comes from one editable place.
  { kind: "expense", label: "Standby time", unit: "h", position: 27 },
  { kind: "expense", label: "Callout premium", unit: "ea", position: 28 },
  { kind: "expense", label: "Source / isotope charge", unit: "days", position: 29 },
  { kind: "expense", label: "Truck / unit day rate", unit: "days", position: 30 },
  { kind: "expense", label: "Darkroom / processing", unit: "h", position: 31 },
  { kind: "expense", label: "Crawler unit", unit: "days", position: 32 },
  { kind: "expense", label: "Mobilization / demob", unit: "ea", position: 33 },
  { kind: "expense", label: "Safety watch / attendant", unit: "h", position: 34 }
];

// ─── tiny persistence layer ────────────────────────────────────────────
// localStorage, for the few preferences that belong to this device rather
// than to the account — the light/dark choice is the only one so far, and
// it should stay here rather than becoming a column. Anything that is a
// fact about the business goes to Supabase through db.js instead.
export const Store = {
  load(key, fallback) {
    try {
      const raw = localStorage.getItem("nde." + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  },
  save(key, value) {
    try { localStorage.setItem("nde." + key, JSON.stringify(value)); } catch (e) {}
  }
};
