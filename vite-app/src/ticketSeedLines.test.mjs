import test from "node:test";
import assert from "node:assert/strict";
import { seedLinesToForm } from "./ticketSeedLines.js";

const CATALOG = {
  welds: [{ key: "weld:6-inch · RT film", label: "6-inch · RT film" }, { key: "weld:12-inch — per weld", label: "12-inch — per weld" }],
  others: [{ key: "service:Standby", label: "Standby" }, { key: "service:Mileage", label: "Mileage" }]
};

test("labels match the card exactly or by their plain words, welds and services apart", () => {
  const r = seedLinesToForm([
    { label: "standby", quantity: 2 }, { label: "12-inch", quantity: 7 }, { label: "6-inch · RT film", quantity: 3 }
  ], CATALOG);
  assert.deepEqual(r.welds, [{ key: "weld:12-inch — per weld", qty: 7 }, { key: "weld:6-inch · RT film", qty: 3 }]);
  assert.deepEqual(r.others, [{ key: "service:Standby", qty: 2 }]);
  assert.deepEqual(r.unmatched, []);
});

test("what the card lacks is named, and bad quantities are skipped", () => {
  const r = seedLinesToForm([
    { label: "Helicopter", quantity: 1 }, { label: "Mileage", quantity: 0 }, { label: "Mileage", quantity: "x" }, null, { label: "", quantity: 2 }
  ], CATALOG);
  assert.deepEqual(r, { welds: [], others: [], unmatched: ["Helicopter"] });
  assert.deepEqual(seedLinesToForm(null, CATALOG), { welds: [], others: [], unmatched: [] });
  assert.deepEqual(seedLinesToForm([{ label: "Standby", quantity: 1 }], {}), { welds: [], others: [], unmatched: ["Standby"] });
});
