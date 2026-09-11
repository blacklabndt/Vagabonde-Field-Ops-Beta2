import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as data from "./data.js";
import * as accepts from "./numberInput.js";

// Exercise the actual save-boundary transformation without browser/network imports.
const source = readFileSync(new URL("./db.js", import.meta.url), "utf8");
const start = source.indexOf("const cleanLine =");
const end = source.indexOf(";", start) + 1;
const clean = new Function(...Object.keys(data), `${source.slice(start, end)}; return cleanLine;`)(...Object.values(data));

test("crew hours and dose are stored at the precision their columns hold", () => {
  // numeric(6,2) hours, numeric(8,2) dose, numeric(8,1) mileage: Postgres
  // rounds a longer figure on the way in, so the app writes what will be
  // kept rather than showing a third digit the database dropped.
  assert.equal(data.storedNumber(1.234, 2), 1.23);
  assert.equal(data.storedNumber(1.236, 2), 1.24);
  assert.equal(data.storedNumber(12.34, 1), 12.3);
  // The quarter hour, which is what this is all for, is untouched.
  assert.equal(data.storedNumber(2.25, 2), 2.25);
  assert.equal(data.storedNumber(8, 2), 8);
  // Still floored at zero, like nonNegative: hours are never negative.
  assert.equal(data.storedNumber(-3, 2), 0);
  assert.equal(data.storedNumber("", 2), 0);
  // Rounded, never refused — a queued replay carrying somebody's pay from
  // before the boxes capped their decimals has to land.
  assert.doesNotThrow(() => data.storedNumber(1.2345, 2));
});

// Read back, because the boxes refusing a third digit is only the courtesy:
// a recovery copy, a queued replay or a paste reaches this write without
// passing a box at all, and nonNegative here would store a figure the
// database silently rounds to something else.
test("the crew write names the precision of every column it fills", () => {
  const crew = source.slice(source.indexOf("async saveCrewForTicket"), source.indexOf("onConflict: \"ticket_id,profile_id\""));
  for (const column of ["straight_hours", "ot_hours", "solo_hours", "solo_ot_hours", "dose_mr"]) {
    assert.match(crew, new RegExp(`${column}: storedNumber\\([^)]*, 2\\)`), column);
  }
  assert.match(crew, /mileage_km: storedNumber\([^)]*, 1\)/);
});

test("the crew boxes and the billing boxes ask for different precision", () => {
  const { acceptsNumberText } = accepts;
  // Hours: two places, and the quarter hour still types.
  assert.equal(acceptsNumberText("2.25", 0.5, 2), true);
  assert.equal(acceptsNumberText("1.234", 0.5, 2), false);
  // A billing quantity keeps its three, which is what lineTotal is built on.
  assert.equal(acceptsNumberText("1.234", 0.5), true);
});

test("ticket writes preserve legacy quantity/rate precision and price the stored values", () => {
  const line = { kind: "expense", label: "Travel", unit: "h" };
  for (const [quantity, unit_rate, total] of [[1.2345, 100, 123.45], [100, 1.234, 123.4]]) {
    const saved = clean({ ...line, quantity, unit_rate });
    assert.deepEqual(saved, { ...line, quantity, unit_rate });
    assert.equal(data.lineTotal(saved.quantity, saved.unit_rate), total);
  }
  assert.deepEqual(clean({ ...line, quantity: 1.5, unit_rate: 60.05 }), { ...line, quantity: 1.5, unit_rate: 60.05 });
  assert.equal(data.lineTotal(1.5, 60.05), 90.08);
});
