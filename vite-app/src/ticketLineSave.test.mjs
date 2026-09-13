import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ticketStatusWriteRefusal } from "./data.js";

const source = readFileSync(new URL("./db.js", import.meta.url), "utf8");
const method = source.slice(source.indexOf("  async updateTicket("), source.indexOf("  // ── Rates (read-only"));

function harness({ status = "Draft", prices = true, error = null, total = "42.75" } = {}) {
  const calls = [], remembered = [];
  const sbClient = {
    from(table) {
      assert.notEqual(table, "ticket_lines", "line replacement must use a single RPC");
      return {
        select() { return this; }, eq() { return this; },
        update(patch) { calls.push({ patch }); return this; },
        maybeSingle: async () => ({ data: { status, jobs: { status: "Active" } } }),
        // biome-ignore lint/suspicious/noThenProperty: models an awaited PostgREST builder.
        then(resolve) { resolve({ data: [{ id: "T1" }] }); }
      };
    },
    async rpc(name, args) { calls.push({ name, args }); return { data: total, error }; }
  };
  const deps = { sbClient, assertJobRowOpen() {}, assertSessionAlive() {}, ticketStatusWriteRefusal,
    plainError: (message, flags) => Object.assign(new Error(message), flags),
    cleanLine: l => ({ kind: l.kind, label: l.label, unit: l.unit, quantity: Number(l.quantity), unit_rate: Number(l.unit_rate) }),
    totalOf: () => 1, assertBillable() {}, startPriceRoleLookup: () => prices,
    priceRoleAnswer: async p => p, friendlyLineError: e => e,
    rememberTicketPart: (...args) => remembered.push(args) };
  const db = new Function(...Object.keys(deps), `return {${method}};`)(...Object.values(deps));
  return { save: lines => db.updateTicket({ ticketId: "T1", status: "Draft", lines }), calls, remembered };
}

test("editor and replay save ordered, cleaned lines through one RPC and use its total", async () => {
  const h = harness();
  const lines = ["Second", "First"].map(label => ({ kind: "charge", label, unit: "ea", quantity: "2", unit_rate: "3", ticket_id: "wrong" }));
  assert.deepEqual(await h.save(lines), { id: "T1", total: 42.75 });
  assert.deepEqual(h.calls[1], { name: "replace_ticket_lines", args: { _ticket_id: "T1", _lines: lines.map(({ ticket_id: _unused, ...l }) => ({ ...l, quantity: 2, unit_rate: 3 })) } });
  assert.equal(h.remembered.length, 1);
});

test("empty billing is sent as an empty replacement", async () => {
  const h = harness({ total: 0 });
  assert.deepEqual(await h.save([]), { id: "T1", total: 0 });
  assert.deepEqual(h.calls[1].args._lines, []);
});

test("RPC failures preserve the failure and do not advance the remembered save", async () => {
  for (const error of [{ code: "42501", message: "Approved" }, new TypeError("Failed to fetch")]) {
    const h = harness({ error });
    await assert.rejects(h.save([]), e => e === error);
    assert.equal(h.remembered.length, 0);
  }
});

test("a role without prices saves metadata without replacing billing", async () => {
  const h = harness({ prices: false });
  assert.deepEqual(await h.save([]), { id: "T1", total: null });
  assert.equal(h.calls.length, 1);
});

test("awaiting approval retains the outbox's crew-only refusal flag", async () => {
  const h = harness({ status: "Awaiting approval" });
  await assert.rejects(h.save([]), e => e.sentForApproval === true);
  assert.equal(h.calls.length, 0);
});
