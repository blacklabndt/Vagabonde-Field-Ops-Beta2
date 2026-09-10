// The client's field invoice.
//
// One renderer, two places: the page a client rep lands on from the approval
// email, and the copy attached to that email for their records. They must be
// the same document — a rep who signs the page and later opens the attachment
// should not find two different bills.
//
// The layout follows the paper LEM ticket the crew has always handed over
// (header, labour, equipment and materials, delays, total, signatures), so a
// rep who has signed a hundred of these does not have to learn a new one. The
// numbers do not come from that sheet: every rate is whatever the client's own
// rate card says at the moment the ticket is priced, and every total is
// computed from the line items rather than a formula kept by hand.
//
// Billing is per truck. A second technician in the same truck does not double
// the crew rate, and a second truck is a second ticket — so the labour block
// lists who was there, and charges once.

import { esc } from "./mail.ts";
import { wordmark } from "./wordmark.ts";

// Alberta: federal only, 5%. The default when a client carries no rate of
// its own; clients.gst_rate (a percent, 0 for an exempt client) wins. Read
// through gstRateOf so an absent or unreadable rate is the ordinary 5% and
// never a silent exemption — the same rule data.js keeps on the app side.
export const GST_RATE_DEFAULT = 5;
export const GST_RATE = GST_RATE_DEFAULT / 100;
export function gstRateOf(value: unknown): number {
  if (value == null || value === "") return GST_RATE_DEFAULT;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : GST_RATE_DEFAULT;
}
// The percent the document charges, off the client's row.
export const gstPercentOf = (d: InvoiceData) =>
  gstRateOf(d.job && d.job.clients ? (d.job.clients as { gst_rate?: unknown }).gst_rate : null);
// "GST @ 5%", or "GST exempt" — a zero rate is a fact about the client, not
// a line to print as 0%.
export const gstLabelOf = (d: InvoiceData) => { const p = gstPercentOf(d); return p === 0 ? "GST exempt" : "GST @ " + p + "%"; };

export interface InvoiceLine {
  kind: string; label: string; unit: string;
  quantity: number | string; unit_rate: number | string;
}
export interface InvoiceCrew {
  name?: string; level?: string; certNo?: string;
  straight?: number; ot?: number; mileage?: number;
}
// What the office puts on a bill besides the money: the terms it is payable
// on, where the cheque goes, and the GST registration an accounts department
// looks for before it will pay anything. They live on the app_settings row
// (Admin screen) because they belong to the business and change without the
// software. Each prints only when it has been set — a labelled empty line on
// a client's invoice reads worse than no line at all.
export interface InvoiceSettings {
  terms?: string | null;
  remitTo?: string | null;
  businessNumber?: string | null;
}

export interface InvoiceData {
  ticket: {
    id: string; work_date: string; status?: string; total: number | string;
    delays?: string | null;
    approved_by_email?: string | null; approved_at?: string | null;
    approved_signature?: string | null;
    // Where the approval link was emailed. Printed on the stamp so a signed
    // ticket says who was asked, not only who typed a name.
    approval_sent_to?: string | null;
    // The office's own invoice number, and when it was raised. Written by
    // mark_tickets_invoiced alone; null until a ticket is marked invoiced.
    invoice_number?: number | null;
    invoiced_at?: string | null;
  };
  job: {
    job_number?: string; project?: string; lsd?: string; afe?: string;
    area?: string; clients?: { name?: string; gst_rate?: number | string | null }; contractors?: { name?: string };
  };
  contact?: string;
  lines: InvoiceLine[];
  crew: InvoiceCrew[];
  levelLegend: string;
  settings?: InvoiceSettings;
}

const money = (n: number | string) =>
  "$" + Number(n || 0).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The same, for an amount carried as integer cents — which is how every
// total below is computed, and how it stays exact until the moment it prints.
export const moneyCents = (cents: number) => money(cents / 100);

const qty = (n: number | string) => {
  const v = Number(n || 0);
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
};

const day = (s: string) => {
  // Plain YYYY-MM-DD read as local midday, so a timezone can't move it a day.
  const [y, m, d] = String(s || "").split("-").map(Number);
  if (!y || !m || !d) return esc(s || "");
  const dt = new Date(y, m - 1, d, 12);
  return String(dt.getDate()).padStart(2, "0") + " " +
    dt.toLocaleDateString("en-CA", { month: "short" }).replace(".", "") + " " + y;
};

// A moment in time, in the crew's own zone. Edge Functions run in UTC, so a
// ticket signed at half past six on a Grande Prairie evening stamped itself
// with the next day's date on the bill the rep was signing. Every stamp a
// client or the office reads goes through here.
export const edmontonStamp = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(+d) ? "" : d.toLocaleString("en-CA",
    { timeZone: "America/Edmonton", dateStyle: "medium", timeStyle: "short" });
};

// The same moment as a plain date. An invoice is dated, not timed: "02:14"
// beside an invoice number reads like a machine raised the bill, which is
// true and is not what a client's accounts department wants to be told.
export const edmontonDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(+d) ? "" : d.toLocaleDateString("en-CA",
    { timeZone: "America/Edmonton", dateStyle: "medium" });
};

// The contact is stored as one label — "Rep · phone · email". The header
// prints all of it; the signature line wants only who is signing.
const nameOnly = (v: unknown) => String(v ?? "").split("·")[0].trim();

const dash = (v: unknown) => {
  const s = String(v ?? "").trim();
  return s ? esc(s) : '<span class="mute">&mdash;</span>';
};

// The drawn/uploaded signature, if the approval carried one. Injected as a
// data: URL, so no escaping question arises as long as the shape is exactly
// a PNG data URL — approve-ticket validates on the way in, and this guards
// again on the way out so a hand-edited row cannot smuggle markup.
const SIG_SHAPE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const sigImage = (v: string | null | undefined) =>
  v && SIG_SHAPE.test(v)
    ? `<img class="sigimg" src="${v}" alt="Signature">`
    : "";

// A line's billable amount, in cents: its product rounded to the cent — the
// same formula the database stores (sync_ticket_total, migration
// 20260818140051), so the printed line totals sum to exactly the printed
// subtotal, and both match the stored ticket total to the cent.
// Whole cents times thousandths of a unit, in integers: the float product of
// 1.5 and 60.05 is 90.07499999999999, which rounds a cent below the
// round(quantity * unit_rate, 2) the trigger stores in tickets.total — the
// same arithmetic as lineTotal in the app's data.js.
export const lineCents = (l: InvoiceLine) =>
  Math.round(Math.round(Number(l.quantity || 0) * 1000) * Math.round(Number(l.unit_rate || 0) * 100) / 1000);

// Subtotal, GST and grand total, all in integer cents — floats drift, cents
// don't. GST is rounded on the cent subtotal, mirroring gstOn in
// vite-app/src/data.js: rounding on dollars instead puts 408 of the first
// 500,000 whole-cent subtotals a cent low, and this must match the app to
// the cent.
//
// Exported because the approval page now quotes the amount due above the
// sheet. A second copy of this arithmetic there would be a second number
// free to disagree with the bill the client is being asked to sign.
export function invoiceTotals(d: InvoiceData) {
  const subtotal = (d.lines || []).reduce((s, l) => s + lineCents(l), 0);
  // The client's own rate, so an exempt client's bill carries no GST.
  const gst = Math.round(subtotal * (gstPercentOf(d) / 100));
  return { subtotal, gst, grand: subtotal + gst };
}

export const invoiceCss = `
  :root{--ink:#1d1f20;--mute:#6b6d6e;--line:rgba(29,31,32,.30);--hard:rgba(29,31,32,.55);
        --accent:#5980a6;--band:#e7e9ea;--paper:#fff}
  *{box-sizing:border-box}
  body{margin:0;background:#d9dcde;color:var(--ink);font-family:Helvetica,Arial,sans-serif;
       font-size:12px;line-height:1.35;padding:22px 14px}
  .sheet{width:min(940px,100%);margin:0 auto;background:var(--paper);border:1px solid var(--hard);
         padding:20px 22px 26px}
  .masthead{display:flex;align-items:flex-start;gap:18px;margin-bottom:14px}
  .brand{flex:0 0 auto}
  .sub{font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute);margin-top:5px}
  .docname{margin-left:auto;text-align:right}
  .docname .t{font-size:17px;font-weight:700;letter-spacing:.04em}
  .docname .n{font-size:11px;color:var(--mute);margin-top:2px}
  .docname .inv{font-size:13px;font-weight:700;margin-top:5px;letter-spacing:.02em}
  .pay{margin-top:14px;font-size:11.5px;max-width:340px}
  .pay .k{font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;color:#3b3d3e}
  .pay .remit{margin-top:8px;line-height:1.5}
  table{width:100%;border-collapse:collapse}
  td,th{border:1px solid var(--line);padding:4px 6px;vertical-align:middle}
  th{background:var(--band);font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;
     font-weight:700;text-align:left;color:#3b3d3e}
  .hdr td{word-break:break-word}
  .lbl{background:var(--band);font-size:9.5px;letter-spacing:.05em;text-transform:uppercase;
       font-weight:700;white-space:nowrap;width:1%;color:#3b3d3e}
  .band td{background:#33393f;color:#fff;font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;
           font-weight:700;text-align:center;padding:5px}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .mute{color:var(--mute)}
  .note{font-size:9.5px;color:var(--mute);padding:5px 2px}
  .totals{margin-top:9px;margin-left:auto;width:min(340px,100%)}
  .totals td{border:0;padding:3px 6px}
  .totals .k{color:var(--mute)}
  .totals .v{text-align:right;font-variant-numeric:tabular-nums}
  .totals .grand td{border-top:1px solid var(--hard);padding-top:7px;font-weight:700;font-size:14px}
  .totals .grand .v{font-size:19px}
  .sig{height:40px}
  .stamp{border:1px solid var(--accent);padding:11px 13px;margin-top:16px;font-size:12px}
  .sigimg{display:block;max-height:64px;max-width:240px;margin-bottom:6px}
  .wrap{overflow-x:auto}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  @media print{body{background:#fff;padding:0}.sheet{border:0;width:auto}}
  @media (max-width:720px){
    body{padding:10px 6px}.sheet{padding:14px}.two{grid-template-columns:1fr}
    /* The header is three label/value pairs across at desk width. Left as a
       six-column table on a phone it gives each value about 40px and breaks
       words one character per line — "North Kor ea Weld ing" — on the one
       device a client rep is most likely to sign from. Restacked to a single
       pair per line; the colgroup above stops applying once the cells are no
       longer table-layout. */
    .hdr, .hdr tbody, .hdr tr, .hdr td { display:block; width:auto }
    .hdr tr { display:grid; grid-template-columns:minmax(96px, 34%) 1fr }
    .hdr td { border-top:0 }
    .hdr tr:first-child td:first-child,
    .hdr tr:first-child td:nth-child(2) { border-top:1px solid var(--line) }
    .masthead{gap:10px}
    .docname .t{font-size:15px}
  }
`;

export function renderInvoice(d: InvoiceData): string {
  const job = d.job || {};
  const client = job.clients?.name || "";
  const contractor = job.contractors?.name || "";

  // Welds bill by diameter band, everything else by hours or quantity. Two
  // tables side by side, exactly as the paper ticket has them.
  const welds = (d.lines || []).filter(l => l.kind === "weld");
  const charges = (d.lines || []).filter(l => l.kind !== "weld");

  // Computed from the lines, never trusted from the caller: the stored total
  // and the sum of what is printed must agree, and if they ever cannot, the
  // printed lines are the ones the client is being asked to sign for.
  const total = invoiceTotals(d);

  const signed = d.ticket.approved_at || d.ticket.status === "Approved" || d.ticket.status === "Invoiced";

  // Once the office has marked the ticket invoiced it is the invoice, not a
  // field ticket that will be re-typed into one somewhere else, and it says
  // so at the top. The number outlives that status on purpose: a ticket
  // pulled back to Approved to be corrected keeps the number the client
  // already has in their system, so it still prints — under the field-ticket
  // heading, which is what the ticket is again until it is re-invoiced.
  const invoiced = d.ticket.status === "Invoiced";
  const invoiceNumber = d.ticket.invoice_number;
  const settings = d.settings || {};
  const terms = String(settings.terms ?? "").trim();
  const remitTo = String(settings.remitTo ?? "").trim();
  const businessNumber = String(settings.businessNumber ?? "").trim();

  const rows = (list: InvoiceLine[]) => list.length
    ? list.map(l => `<tr>
        <td>${esc(l.label)}</td>
        <td class="num">${qty(l.quantity)}${l.unit ? " " + esc(l.unit) : ""}</td>
        <td class="num">${money(l.unit_rate)}</td>
        <td class="num">${moneyCents(lineCents(l))}</td>
      </tr>`).join("")
    : `<tr><td colspan="4" class="mute">None on this ticket.</td></tr>`;

  return `
<div class="sheet">

  <div class="masthead">
    <div class="brand">
      ${wordmark(210)}
      <div class="sub">Full Service NDE &middot; Grande Prairie, AB</div>
      ${businessNumber ? `<div class="sub">GST # ${esc(businessNumber)}</div>` : ""}
    </div>
    <div class="docname">
      <div class="t">${invoiced ? "INVOICE" : "FIELD INVOICE"}</div>
      <div class="n">Labour &middot; Equipment &middot; Materials</div>
      ${invoiceNumber != null ? `<div class="inv">Invoice # ${esc(String(invoiceNumber))}</div>` : ""}
      ${invoiced && d.ticket.invoiced_at
        ? `<div class="n">Invoiced ${esc(edmontonDay(d.ticket.invoiced_at))}</div>` : ""}
    </div>
  </div>

  <div class="wrap"><table class="hdr">
    <colgroup>
      <col style="width:9%"><col style="width:24%">
      <col style="width:9%"><col style="width:24%">
      <col style="width:12%"><col style="width:22%">
    </colgroup>
    <tr>
      <td class="lbl">Date</td><td>${day(d.ticket.work_date)}</td>
      <td class="lbl">Client</td><td>${dash(client)}</td>
      <td class="lbl">LEM&nbsp;#&nbsp;/&nbsp;Report&nbsp;#</td><td><strong>${esc(d.ticket.id)}</strong></td>
    </tr>
    <tr>
      <td class="lbl">Contact</td><td>${dash(d.contact)}</td>
      <td class="lbl">Job No</td><td>${dash(job.job_number)}</td>
      <td class="lbl">Contractor</td><td>${dash(contractor)}</td>
    </tr>
    <tr>
      <td class="lbl">Project</td><td>${dash(job.project)}</td>
      <td class="lbl">PO / AFE</td><td>${dash(job.afe)}</td>
      <td class="lbl">Area</td><td>${dash(job.area)}</td>
    </tr>
    <tr>
      <td class="lbl">Location</td><td colspan="5">${dash(job.lsd)}</td>
    </tr>
  </table></div>

  <table><tr class="band"><td>Crew</td></tr></table>
  <div class="wrap"><table>
    <thead><tr>
      <th>Name</th><th>Level</th><th>CGSB&nbsp;# / NRCAN&nbsp;#</th>
      <th class="num">Hours</th><th class="num">OT</th><th class="num">KM</th>
    </tr></thead>
    <tbody>
      ${(d.crew || []).length
        ? d.crew.map(c => `<tr>
            <td>${dash(c.name)}</td>
            <td>${dash(c.level)}</td>
            <td>${dash(c.certNo)}</td>
            <td class="num">${qty(c.straight || 0)}</td>
            <td class="num">${qty(c.ot || 0)}</td>
            <td class="num">${qty(c.mileage || 0)}</td>
          </tr>`).join("")
        : `<tr><td colspan="6" class="mute">No crew recorded on this ticket.</td></tr>`}
    </tbody>
  </table></div>
  <div class="note">${esc(d.levelLegend)}</div>
  <div class="note">Charged at the crew rate for the unit &mdash; a second hand on the same truck does not double it.</div>

  <table><tr class="band"><td>Charges</td></tr></table>
  <div class="two">
    <div class="wrap"><table>
      <thead><tr><th>Labour, equipment &amp; materials</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Total</th></tr></thead>
      <tbody>${rows(charges)}</tbody>
    </table></div>
    <div class="wrap"><table>
      <thead><tr><th>Weld / dia</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Total</th></tr></thead>
      <tbody>${rows(welds)}</tbody>
    </table></div>
  </div>

  ${d.ticket.delays ? `
  <table style="margin-top:10px"><tr class="band"><td>Job delays</td></tr></table>
  <table><tr><td>${esc(d.ticket.delays).replace(/\n/g, "<br>")}</td></tr></table>` : ""}

  <table class="totals">
    <tr><td class="k">Subtotal</td><td class="v">${moneyCents(total.subtotal)}</td></tr>
    <tr><td class="k">${esc(gstLabelOf(d))}</td><td class="v">${moneyCents(total.gst)}</td></tr>
    <tr class="grand"><td>Total due</td><td class="v">${moneyCents(total.grand)}</td></tr>
  </table>

  ${terms || remitTo ? `
  <div class="pay">
    ${terms ? `<div><span class="k">Terms:</span> ${esc(terms)}</div>` : ""}
    ${remitTo ? `<div class="remit"><span class="k">Remit to</span><br>${esc(remitTo).replace(/\n/g, "<br>")}</div>` : ""}
  </div>` : ""}

  ${signed ? `
  <div class="stamp">${sigImage(d.ticket.approved_signature)}<strong>Approved</strong><br>
    Signed by ${esc(d.ticket.approved_by_email || "")}${d.ticket.approved_at
      ? " on " + esc(edmontonStamp(d.ticket.approved_at)) : ""}${d.ticket.approval_sent_to
      ? `<br><span class="mute">Approval link sent to ${esc(d.ticket.approval_sent_to)}</span>` : ""}
  </div>` : `
  <div class="wrap"><table style="margin-top:14px">
    <thead><tr><th>Client representative</th><th>Signature</th><th>Date</th></tr></thead>
    <tbody><tr class="sig"><td>${dash(nameOnly(d.contact))}</td><td></td><td></td></tr></tbody>
  </table></div>`}

</div>`;
}

// The whole document, for the page and for the emailed copy.
export const invoicePage = (d: InvoiceData, extra = "") => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Field invoice ${esc(d.ticket.id)} &middot; VagaboNDE</title>
<style>${invoiceCss}</style></head>
<body>${renderInvoice(d)}${extra}</body></html>`;
