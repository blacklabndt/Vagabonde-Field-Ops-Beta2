// The rows behind the Billing tracker's two exports.
//
// The tracker's CSV used to carry one money column — the before-GST total —
// with no tax, no grand total, no invoice number and nothing about what the
// ticket was made of. Every reconciliation therefore started by re-keying it:
// somebody worked out 5% of each line of the spreadsheet by hand, which is a
// calculation the app has already done exactly, to the cent, twice (the
// printed invoice and the client's approval email).
//
// So there are two exports now. The ticket export is one row per ticket with
// Subtotal, GST and Total spelled out; the line export is one row per charge,
// for the reconciliation that asks "what is this $4,812 made of?".
//
// Deliberately free of React and db.js: it takes rows and returns the array of
// arrays the tracker's downloadCsv writes. That helper does the quoting — a
// client called "Smith, Jones & Co" or a label with a line break in it is its
// problem, not this module's — and this module's job is to hand it the text
// unaltered, which the tests pin.

import { gstRateOf, GST_RATE_DEFAULT, lineTotal, exactPercentCents } from "./data.js";

export const TICKET_COLUMNS = [
  "Client", "Client id", "Job", "Project", "Work date", "Ticket", "Status",
  "Invoice number", "Invoiced on", "Subtotal", "GST", "Total"
];

export const LINE_COLUMNS = [
  "Ticket", "Client", "Job", "Work date", "Invoice number",
  "Line", "Kind", "Unit", "Quantity", "Rate", "Line total"
];

// GST in whole cents, from a subtotal already in whole cents.
//
// This is the inner half of data.js's gstOn, kept in cents rather than turned
// back into dollars and rounded again: `Math.round(subtotal * 0.05 * 100)`
// lands a cent low at 408 of the whole-cent subtotals under $5,000 — $0.70 is
// the first, where the exact 3.5 cents arrives as 3.4999999999999996 and
// rounds down to $0.03 — and every one of those is the company covering the
// difference. gstOn rounds the subtotal to cents first for exactly that
// reason; starting from cents is the same arithmetic with the first rounding
// already done. accountingExport.test.mjs sweeps the two against each other.
//
// The rate is a percent off the client's own row, and gstRateOf decides what
// an absent one means (5%, never 0 — guessing exempt is the guess that
// undercharges).
export const gstCentsOn = (subtotalCents, ratePercent = GST_RATE_DEFAULT) =>
  exactPercentCents(subtotalCents, gstRateOf(ratePercent));

// Cents as an accounting package reads them: 4 becomes "0.04", and nothing at
// all stays an empty cell. Null is not zero here — search_tickets hands a role
// that may not see prices a null total, and "0.00" against a real ticket is a
// figure somebody would reconcile against.
const moneyCell = cents => cents == null ? "" : (cents / 100).toFixed(2);

// Dollars off a row as whole cents. Integer cents is the house rule for money
// that is summed or taxed; a float subtotal taxed directly is the bug above.
const centsOf = amount => amount == null || amount === "" ? null : Math.round(Number(amount) * 100);

// The tracker maps its rows to camelCase and the batched ticket read hands
// back the database's own column names, so both spellings are answered here.
// A field neither of them carries is simply absent — a blank cell, never an
// invented one.
const pick = (row, camel, snake) => {
  if (row == null) return null;
  if (row[camel] != null && row[camel] !== "") return row[camel];
  if (row[snake] != null && row[snake] !== "") return row[snake];
  return null;
};

// The ISO work date, because a package parses 2026-03-14 and cannot parse
// "14 Mar". The tracker's own `date` is the short form it prints on screen,
// and is the fallback only for a row that somehow arrived without the real one.
const workDateOf = t => t.workDate || t.work_date || t.date || "";

const dayOf = iso => iso ? String(iso).slice(0, 10) : "";

// What one ticket costs, in cents, with the tax worked out at the client's own
// rate. Null subtotal stays null the whole way down, so a role without prices
// gets three blank cells rather than a row of zeros.
export function ticketMoney(t) {
  const subtotal = centsOf(t.amount);
  if (subtotal == null) return { subtotal: null, gst: null, total: null };
  // gstRateOf reads an absent rate as the ordinary 5%, so a row from before
  // clients had their own rate is billed the way it always was.
  const gst = gstCentsOn(subtotal, pick(t, "gstRate", "gst_rate"));
  return { subtotal, gst, total: subtotal + gst };
}

// One row per ticket. `invoices` is id → { number, invoicedAt } from the
// batched read; a ticket missing from it — or a whole database whose
// invoice_number column has not arrived yet — leaves that cell blank rather
// than holding the export back.
export function ticketExportRows(tickets, { caption, exportedOn, invoices = {}, invoiceNumbers = true } = {}) {
  const list = tickets || [];
  const head = [
    [caption || ""],
    [`Exported ${exportedOn || ""} · ${list.length} ticket${list.length === 1 ? "" : "s"}`]
  ];
  // Said in the file, because a blank column reads as "nothing was invoiced"
  // and that is a different fact from "this app cannot number invoices yet".
  if (!invoiceNumbers) head.push(["Invoice numbers are not on this database yet — that column is blank."]);
  head.push([]);
  head.push(TICKET_COLUMNS);

  return head.concat(list.map(t => {
    const invoice = invoices[t.id] || null;
    const { subtotal, gst, total } = ticketMoney(t);
    return [
      t.client || "",
      pick(t, "clientId", "client_id") || "",
      t.job || "",
      t.project || "",
      workDateOf(t),
      t.id || "",
      t.status || "",
      invoice && invoice.number != null ? String(invoice.number) : "",
      dayOf((invoice && invoice.invoicedAt) || t.invoicedAt),
      moneyCell(subtotal),
      moneyCell(gst),
      moneyCell(total)
    ];
  }));
}

// One row per charge, in the export's ticket order with each ticket's lines in
// the order the printed invoice prints them (line_order — the read hands them
// over already sorted). No tax column: a line has no GST of its own, the
// ticket does, and a tax column repeated down twenty lines is the sort of
// thing that gets summed by mistake.
export function lineExportRows(tickets, { caption, exportedOn, invoices = {}, lines = {} } = {}) {
  const list = tickets || [];
  const body = [];
  let ticketsWithLines = 0;
  for (const t of list) {
    const mine = lines[t.id] || [];
    if (!mine.length) continue;
    ticketsWithLines++;
    const invoice = invoices[t.id] || null;
    for (const l of mine) {
      const quantity = Number(l.quantity || 0);
      const rate = Number(l.unit_rate == null ? l.unitRate : l.unit_rate) || 0;
      body.push([
        t.id || "",
        t.client || "",
        t.job || "",
        workDateOf(t),
        invoice && invoice.number != null ? String(invoice.number) : "",
        l.label == null ? "" : String(l.label),
        l.kind || "",
        l.unit || "",
        String(quantity),
        moneyCell(Math.round(rate * 100)),
        moneyCell(Math.round(lineTotal(quantity, rate) * 100))
      ]);
    }
  }
  return [
    [caption || ""],
    [`Exported ${exportedOn || ""} · ${body.length} line${body.length === 1 ? "" : "s"} on ${ticketsWithLines} of ${list.length} ticket${list.length === 1 ? "" : "s"}`],
    ["Line detail, before tax — there is no GST on a line. The GST is on the ticket export."],
    [],
    LINE_COLUMNS,
    ...body
  ];
}
