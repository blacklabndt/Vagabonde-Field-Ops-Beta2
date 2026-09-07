// The aging buckets and the by-client rollup.
//
// Run with: node --test src/ticketAging.test.mjs
//
// Two things are worth pinning here (the bucket edges are the database's,
// in ticket_aging(), and nothing client-side re-derives them). Null money: a role that cannot see
// prices gets null totals from the database, and a rollup that turns those
// into 0 prints "$0.00" against a client who is owed thousands. And the sort
// order, which is what makes the table answer "who owes me the most".

import test from "node:test";
import assert from "node:assert/strict";
import { rollUpAging, isMissingTicketAging, AGING_KEYS, NO_CLIENT } from "./ticketAging.js";

const row = (client, bucket, count, total, clientId) =>
  ({ clientId: clientId || (client ? client.toLowerCase() : null), client, bucket, count, total });

test("rows roll up into the four tiles and the whole outstanding position", () => {
  const out = rollUpAging([
    row("Acme", "current", 2, 1000),
    row("Acme", "90", 1, 250.5),
    row("Borden", "current", 3, 99.25)
  ]);
  assert.equal(out.count, 6);
  assert.equal(out.total, 1349.75);
  assert.deepEqual(out.buckets.current, { count: 5, total: 1099.25 });
  assert.deepEqual(out.buckets["30"], { count: 0, total: null });
  assert.deepEqual(out.buckets["90"], { count: 1, total: 250.5 });
});

test("money adds in cents, so a run of awkward figures lands exactly", () => {
  const out = rollUpAging([
    row("Acme", "current", 1, 0.1),
    row("Acme", "30", 1, 0.2)
  ]);
  assert.equal(out.total, 0.3);
  assert.equal(out.clients[0].total, 0.3);
});

test("null totals stay null — a role without prices never sees $0.00", () => {
  const out = rollUpAging([
    row("Acme", "current", 2, null),
    row("Acme", "60", 1, null)
  ]);
  assert.equal(out.total, null);
  assert.equal(out.buckets.current.total, null);
  assert.equal(out.buckets.current.count, 2);
  assert.equal(out.clients[0].total, null);
  assert.equal(out.clients[0].count, 3);
});

test("a bucket with nothing in it is zero and null, not missing", () => {
  const out = rollUpAging([]);
  // Sorted, because three of the four keys read as integers and a JS object
  // puts those first in numeric order however they were inserted. The order
  // shown on screen is AGING_BUCKETS', never the object's.
  assert.deepEqual(Object.keys(out.buckets).sort(), [...AGING_KEYS].sort());
  for (const k of AGING_KEYS) assert.deepEqual(out.buckets[k], { count: 0, total: null });
  assert.deepEqual(out.clients, []);
  assert.equal(out.total, null);
});

test("clients come back biggest first", () => {
  const out = rollUpAging([
    row("Small", "current", 1, 10),
    row("Big", "current", 1, 900),
    row("Middle", "90", 1, 500)
  ]);
  assert.deepEqual(out.clients.map(c => c.name), ["Big", "Middle", "Small"]);
});

test("with no prices to sort by, the busiest client leads and ties go by name", () => {
  const out = rollUpAging([
    row("Zed", "current", 1, null),
    row("Acme", "current", 1, null),
    row("Busy", "current", 4, null)
  ]);
  assert.deepEqual(out.clients.map(c => c.name), ["Busy", "Acme", "Zed"]);
});

test("two clients with the same name stay two rows; a job with no client is its own", () => {
  const out = rollUpAging([
    { clientId: "a", client: "Ridge", bucket: "current", count: 1, total: 100 },
    { clientId: "b", client: "Ridge", bucket: "current", count: 1, total: 300 },
    { clientId: null, client: null, bucket: "current", count: 2, total: 50 }
  ]);
  assert.equal(out.clients.length, 3);
  assert.deepEqual(out.clients.map(c => c.name), ["Ridge", "Ridge", NO_CLIENT]);
  assert.deepEqual(out.clients.map(c => c.total), [300, 100, 50]);
  assert.equal(out.clients[2].clientId, null);
});

test("a bucket name this build doesn't know is left out of both the tiles and the total", () => {
  const out = rollUpAging([
    row("Acme", "current", 1, 100),
    row("Acme", "120", 1, 999)
  ]);
  assert.equal(out.count, 1);
  assert.equal(out.total, 100);
  assert.equal(out.clients[0].count, 1);
});

test("only a missing routine reads as missing — a refusal is a refusal", () => {
  assert.equal(isMissingTicketAging({ code: "PGRST202", message: "anything at all" }), true);
  assert.equal(isMissingTicketAging({ message: "Could not find the function public.ticket_aging" }), true);
  assert.equal(isMissingTicketAging({ code: "42501", message: "permission denied for function ticket_aging" }), false);
  assert.equal(isMissingTicketAging({ code: "57014", message: "canceling statement due to statement timeout" }), false);
  assert.equal(isMissingTicketAging(null), false);
});
