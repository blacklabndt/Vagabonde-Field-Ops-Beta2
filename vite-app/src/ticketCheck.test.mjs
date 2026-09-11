// "Check my ticket": every finding the editor would have raised one at a
// time, asked at once; a clean draft has none; the ceilings are data.js's.

import test from "node:test";
import assert from "node:assert/strict";
import { ticketCheck, saneQuantityCeiling, SANE_QUANTITY_PER_UNIT, SANE_QUANTITY_DEFAULT, SANE_CREW_HOURS } from "../../supabase/functions/_shared/ticketCheck.ts";
import { SANE_QUANTITY_PER_UNIT as DATA_PER_UNIT, SANE_QUANTITY_DEFAULT as DATA_DEFAULT, SANE_CREW_HOURS as DATA_CREW } from "./data.js";

const clean = (over = {}) => ({
  ticket: { id: "T-10231", status: "Draft", work_date: "2026-09-10", client_contact: "Dana Reyes <dana@acme.ca>" },
  lines: [
    { kind: "weld", label: '6" · RT film', unit: null, quantity: "24", unit_rate: "18.50" },
    { kind: "charge", label: "Mileage", unit: "km", quantity: 120.5, unit_rate: 1.25 }
  ],
  crew: [{ name: "Kyle Keith", straight_hours: 8, ot_hours: 2, solo_hours: 0, solo_ot_hours: 0 }],
  jhaCount: 1,
  today: "2026-09-10",
  ...over
});

test("the ceilings are data.js's, word for word", () => {
  assert.deepEqual(SANE_QUANTITY_PER_UNIT, DATA_PER_UNIT);
  assert.equal(SANE_QUANTITY_DEFAULT, DATA_DEFAULT);
  assert.equal(SANE_CREW_HOURS, DATA_CREW);
  assert.equal(saneQuantityCeiling("km"), 2000);
  assert.equal(saneQuantityCeiling("bogus"), 200);
  assert.equal(saneQuantityCeiling(null), 200);
});

test("a clean draft has nothing to say", () => {
  const c = ticketCheck(clean());
  assert.deepEqual(c, { ticket_id: "T-10231", findings: [], ok: true });
});

test("each gap is its own phrase", () => {
  assert.deepEqual(ticketCheck(clean({ ticket: { ...clean().ticket, client_contact: "" } })).findings, ["no client rep on the ticket — the approval has nowhere to go"]);
  assert.deepEqual(ticketCheck(clean({ lines: [] })).findings, ["no charges on the ticket"]);
  assert.deepEqual(ticketCheck(clean({ lines: [{ kind: "charge", label: "Standby", unit: "h", quantity: 0, unit_rate: 95 }] })).findings,
    ["Standby: quantity is zero", "the total is $0 — the client would be sent a $0.00 approval"]);
  assert.deepEqual(ticketCheck(clean({ lines: [{ kind: "charge", label: "Standby", unit: "h", quantity: 30, unit_rate: 95 }] })).findings,
    ["Standby: 30 h is above the editor's ceiling of 24 — a typo?"]);
  assert.deepEqual(ticketCheck(clean({ lines: [{ kind: "weld", label: '6" · RT film', unit: null, quantity: 240, unit_rate: 18.5 }] })).findings,
    ['6" · RT film: 240 weld is above the editor\'s ceiling of 200 — a typo?']);
  assert.deepEqual(ticketCheck(clean({ lines: [{ kind: "charge", label: "Callout", unit: "ea", quantity: 1, unit_rate: 0 }] })).findings,
    ["Callout is priced at $0", "the total is $0 — the client would be sent a $0.00 approval"]);
  assert.deepEqual(ticketCheck(clean({ crew: [] })).findings, ["no crew on the ticket — your own hours go here"]);
  assert.deepEqual(ticketCheck(clean({ crew: [{ name: "Kyle Keith", straight_hours: 0, ot_hours: 0, solo_hours: 0, solo_ot_hours: 0 }] })).findings, ["no hours entered for the crew"]);
  assert.deepEqual(ticketCheck(clean({ crew: [{ name: "Kyle Keith", straight_hours: 20, ot_hours: 5, solo_hours: 0, solo_ot_hours: 0 }] })).findings, ["Kyle Keith: 25 hours on one day — a typo?"]);
  assert.deepEqual(ticketCheck(clean({ jhaCount: 0 })).findings, ["no JHA filed on the job for 2026-09-10"]);
  assert.deepEqual(ticketCheck(clean({ ticket: { ...clean().ticket, work_date: "2026-09-12" } })).findings, ["the work date 2026-09-12 is in the future"]);
});

test("a ticket with everything wrong lists it all, in the editor's order", () => {
  const c = ticketCheck({
    ticket: { id: "T-1", status: "Draft", work_date: "2026-09-12", client_contact: null },
    lines: [{ kind: "charge", label: "Standby", unit: "h", quantity: 0, unit_rate: 0 }],
    crew: [], jhaCount: 0, today: "2026-09-10"
  });
  assert.equal(c.ok, false);
  assert.deepEqual(c.findings, [
    "no client rep on the ticket — the approval has nowhere to go",
    "Standby: quantity is zero",
    "Standby is priced at $0",
    "the total is $0 — the client would be sent a $0.00 approval",
    "no crew on the ticket — your own hours go here",
    "no JHA filed on the job for 2026-09-12",
    "the work date 2026-09-12 is in the future"
  ]);
});
