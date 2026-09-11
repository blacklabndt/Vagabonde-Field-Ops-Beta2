// A line's charge is one formula, and it lives twice: in the app, where the
// ticket screen adds the foot bar up and db.js checks the total before it
// writes, and in the invoice, which is what the client is actually sent.
// They are in different runtimes and cannot import each other, so this file
// holds the two halves together — the block as TEXT, and the arithmetic
// against the figures Postgres itself produces.
//
// The audit that put this here: `Math.round(unitRate * 100)` scaled the
// rate to whole cents before multiplying, which is right only while every
// rate has two decimals. ticket_lines.unit_rate is a bare `numeric`, so a
// rate filed at 0.575 was billed at 0.57 — a 1,000-unit line five dollars
// under the round(quantity * unit_rate, 2) the trigger had already stored
// in tickets.total. The app said $570.00 and the database said $575.00.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { lineTotal, storedNumber, exactRound, exactPercentCents, gstOn } from "./data.js";
import { gstCentsOn } from "./accountingExport.js";

// invoice.ts imports mail.ts, which reads Deno.env, so the arithmetic is
// sliced off and stripped rather than imported — the way archive.test.mjs
// and invoiceSnapshot.test.mjs load it.
const invoice = await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(
  readFileSync(new URL("../../supabase/functions/_shared/invoice.ts", import.meta.url), "utf8")
    .split("export const invoiceCss")[0].replace(/^import .*;\r?\n/gm, "")
)).toString("base64"));

// ── The mirror ───────────────────────────────────────────────────────────
// Both files carry the same block between the same markers. The function's
// copy is annotated, because Deno's checker reads it, so it is compared
// with the types stripped and every run of whitespace folded — the shape
// backupSchedule.test.mjs uses for nextRunAt.

const CORE = /\/\/ ═══ shared core[^\n]*\n([\s\S]*?)\/\/ ═══ end shared core ═══/;

const coreOf = path => {
  const m = CORE.exec(readFileSync(new URL(path, import.meta.url), "utf8"));
  assert.ok(m, `${path} has no shared-core block`);
  return m[1];
};

const shapeOf = code => code.split("\n")
  .map(l => l.replace(/\s+/g, " ").replace(/ (?=[),;])/g, "").trim())
  .filter(Boolean).join("\n");

test("the app's line arithmetic and the invoice's are the same code", () => {
  const js = coreOf("./data.js");
  const ts = coreOf("../../supabase/functions/_shared/invoice.ts");
  assert.ok(js.includes("const exactCents"), "the core must hold exactCents itself");
  assert.ok(js.includes("const exactPercentCents"), "and the tax line's arithmetic");
  assert.ok(/mantissa: bigint/.test(ts), "the function's copy is the typed one");
  assert.equal(shapeOf(stripTypeScriptTypes(ts)), shapeOf(js));
});

// ── Parity with the database ─────────────────────────────────────────────
// Every pair below is `round(quantity * unit_rate, 2)` worked out in exact
// decimal — what numeric does, and what the sync_ticket_total trigger
// therefore stores. The probe beside this
// (supabase/handover/probes-round3-decimal-parity.sql) asks the live
// database the same questions.

const PARITY = [
  // [quantity, rate, cents] — the rows the audit turned up first.
  [1000, 0.575, 57500],   // was 570.00: the rate itself was flattened to 0.57
  [1.2345, 100, 12345],   // was 123.50
  [100, 1.234, 12340],    // was 123.00
  [2, 1.005, 201],        // was 2.00 — 1.005 is a hair under the half in a double
  [2, 9.255, 1851],
  // The pairs the old formula already got right, kept so a "fix" that
  // breaks them is caught: these are the cases it was written for.
  [1.5, 60.05, 9008],     // 90.075 rounds up, half away from zero
  [0.5, 9.25, 463],       // 4.625 likewise
  [3, 45, 13500],
  [0.1, 0.1, 1],
  [0, 99.99, 0],
  // Exponent notation: String() writes a small enough number this way, and
  // reading the digits alone would drop the exponent entirely.
  ["1e3", 0.575, 57500],
  [1e-3, 1000, 100]
];

test("a line's charge is what the database would compute, at any scale", () => {
  for (const [quantity, rate, cents] of PARITY) {
    assert.equal(
      invoice.lineCents({ quantity, unit_rate: rate }), cents,
      `the invoice prices ${quantity} × ${rate}`
    );
    assert.equal(
      lineTotal(quantity, rate), cents / 100,
      `the app prices ${quantity} × ${rate}`
    );
  }
});

test("a rate the rate card no longer offers is still billed at what it was filed at", () => {
  // An orphan line: linesToForm hands it back verbatim and buildLines writes
  // it back, so its rate reaches the arithmetic whatever precision it has.
  // Flattening it to cents is how the app came to disagree with the bill.
  assert.equal(lineTotal(1000, 0.575), 575);
  assert.notEqual(lineTotal(1000, 0.575), 570);
});

test("the invoice's subtotal is the sum of its own printed lines", () => {
  const lines = [
    { kind: "weld", label: "a", unit: "ea", quantity: 1000, unit_rate: 0.575 },
    { kind: "h", label: "b", unit: "h", quantity: 1.5, unit_rate: 60.05 },
    { kind: "km", label: "c", unit: "km", quantity: 0.5, unit_rate: 9.25 }
  ];
  const totals = invoice.invoiceTotals({ ticket: { gst_rate: 5 }, job: {}, lines });
  assert.equal(totals.subtotal, 57500 + 9008 + 463);
  assert.equal(totals.subtotal, lines.reduce((s, l) => s + invoice.lineCents(l), 0));
  // And the app's own sum of the same lines, to the cent.
  assert.equal(
    Math.round(lines.reduce((s, l) => s + lineTotal(l.quantity, l.unit_rate), 0) * 100),
    totals.subtotal
  );
});

// ── The tax line ─────────────────────────────────────────────────────────
// GST was the last float in the money path: `Math.round(cents * (rate /
// 100))` divides in binary before it multiplies, and rate/100 is inexact
// for most rates, so a product landing on an exact half cent could fall the
// wrong side of it. There is no database figure to disagree with here — the
// tax is computed nowhere but in JavaScript — so the three copies agreed
// with each other and were a cent under the exact answer together.

const GST = [
  // [subtotal cents, rate percent, gst cents]
  [5000, 0.03, 2],      // 1.5 cents exactly. The float said 1.
  [200, 5.75, 12],      // 11.5 exactly; this one the float already got right
  [200, 5, 10],         // the ordinary rate, unchanged
  [12345, 5, 617],      // 617.25 rounds down
  [1000, 0, 0],         // exempt is a fact about the client, not a rounding
  [0, 5, 0],
  [10, 5, 1],           // 0.5 cents exactly, rounds away from zero
  [123456789, 5, 6172839] // 6172839.45
];

test("GST is a percentage of whole cents, rounded half away from zero", () => {
  for (const [cents, rate, gst] of GST) {
    assert.equal(exactPercentCents(cents, rate), gst, `${cents}c at ${rate}%`);
  }
});

test("all three GST call sites answer the same, to the cent", () => {
  for (const [cents, rate, gst] of GST) {
    // accountingExport's, which is already in cents.
    assert.equal(gstCentsOn(cents, rate), gst, `the CSV on ${cents}c at ${rate}%`);
    // data.js's, which takes dollars and gives dollars back.
    assert.equal(gstOn(cents / 100, rate), gst / 100, `the app on ${cents}c at ${rate}%`);
    // And the invoice's, through invoiceTotals, using a single line priced
    // to the subtotal so the document's own arithmetic is what is asked.
    const totals = invoice.invoiceTotals({
      ticket: { gst_rate: rate }, job: {},
      lines: [{ kind: "ea", label: "x", unit: "ea", quantity: cents, unit_rate: "0.01" }]
    });
    assert.equal(totals.subtotal, cents, `the invoice's subtotal on ${cents}c`);
    assert.equal(totals.gst, gst, `the invoice on ${cents}c at ${rate}%`);
    assert.equal(totals.grand, cents + gst);
  }
});

test("a missing GST rate is five percent and never an exemption", () => {
  // gstRateOf's rule, which the exempt case must not be able to reach by
  // accident: a null rate is the ordinary 5%, and only a real 0 is exempt.
  assert.equal(gstCentsOn(10000, null), 500);
  assert.equal(gstCentsOn(10000, undefined), 500);
  assert.equal(gstCentsOn(10000, ""), 500);
  assert.equal(gstCentsOn(10000, 0), 0);
});

// ── What the column would hold ───────────────────────────────────────────

test("storedNumber rounds the way the column rounds, not the way toFixed does", () => {
  // toFixed answers "2.67" here, because the double is a hair under the
  // half. numeric(6,2) answers 2.68.
  assert.equal(storedNumber(2.675, 2), 2.68);
  assert.equal((2.675).toFixed(2), "2.67", "the reason this test exists");
  // numeric(8,1), the mileage column.
  assert.equal(storedNumber(12.35, 1), 12.4);
  assert.equal(storedNumber(1.005, 2), 1.01);
  // And the plain cases the crew boxes actually send.
  assert.equal(storedNumber(1.234, 2), 1.23);
  assert.equal(storedNumber(1.236, 2), 1.24);
  assert.equal(storedNumber(12.34, 1), 12.3);
  assert.equal(storedNumber(8, 2), 8);
  assert.equal(storedNumber(2.25, 2), 2.25);
  // Still floored, and still never a refusal: a queued replay carrying
  // somebody's pay has to land.
  assert.equal(storedNumber(-3, 2), 0);
  assert.equal(storedNumber("", 2), 0);
  assert.doesNotThrow(() => storedNumber(1.2345, 2));
});

test("exactRound is half away from zero, and answers zero for what is not a number", () => {
  assert.equal(exactRound("0.5", 0), 1);
  assert.equal(exactRound("1.5", 0), 2);
  assert.equal(exactRound("2.5", 0), 3);
  assert.equal(exactRound("-0.5", 0), -1);
  assert.equal(exactRound("abc", 2), 0);
  assert.equal(exactRound(null, 2), 0);
});

// ── The save boundary ────────────────────────────────────────────────────

test("saving a ticket preserves a line's precision rather than refusing it", () => {
  const db = readFileSync(new URL("./db.js", import.meta.url), "utf8");
  const clean = /const cleanLine = l => \(\{[\s\S]*?\}\);/.exec(db);
  assert.ok(clean, "cleanLine is where a line crosses into the database");
  assert.doesNotMatch(
    clean[0], /billableNumber/,
    "a line already on a ticket is written back as filed — refusing it makes the ticket unsaveable by anybody"
  );
  assert.match(clean[0], /quantity: nonNegative\(l\.quantity\)/);
  assert.match(clean[0], /unit_rate: nonNegative\(l\.unit_rate\)/);
  // The cap stays where a person types a figure: the rate-card write.
  assert.match(db, /rate: billableNumber\(rate, 2, "Rate"\)/);
});
