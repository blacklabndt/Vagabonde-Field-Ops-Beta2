import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ticketStatusWriteRefusal } from "./data.js";


const source = readFileSync(new URL("./db.js", import.meta.url), "utf8");
const method = source.slice(source.indexOf("  async updateTicket("), source.indexOf("  // ── Rates (read-only"));

// The mapper itself, read out of db.js and run against the errcodes the
// migration raises. Built like the method above: it is module-private, and a
// second copy written here would be the thing that drifts.
const plainError = (message, extra) => Object.assign(new Error(message), { plain: true, ...extra });
const refusalSource = source.slice(source.indexOf("const RPC_LINE_REFUSALS"), source.indexOf("// 23505 is a unique violation"));
const lineRpcRefusal = new Function("plainError", `${refusalSource}; return lineRpcRefusal;`)(plainError);

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
    plainError,
    cleanLine: l => ({ kind: l.kind, label: l.label, unit: l.unit, quantity: Number(l.quantity), unit_rate: Number(l.unit_rate) }),
    totalOf: () => 1, assertBillable() {}, startPriceRoleLookup: () => prices,
    priceRoleAnswer: async p => p, lineRpcRefusal,
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

test("a lost connection is left as itself, so the outbox still retries it", async () => {
  const error = new TypeError("Failed to fetch");
  const h = harness({ error });
  await assert.rejects(h.save([]), e => e === error);
  assert.equal(h.remembered.length, 0);
});

// The four the function raises after it has the lock: a role change, a
// deactivation, an approval landing, a payload it cannot read. Marked plain,
// so oqFlushOnce stops the item with the reason instead of reading a refusal
// met in a dead spot as "offline", and the editor shows the words bare.
test("the RPC's own refusals come back plain and do not advance the remembered save", async () => {
  const cases = [
    { code: "P0002", message: "Ticket T1 no longer exists — there is nothing to save onto.", gone: true },
    { code: "42501", message: "Ticket T1 belongs to another technician — your account cannot change it." },
    { code: "42501", message: "Your account cannot price tickets, so it cannot change this ticket's charges." },
    { code: "22023", message: "Every charge needs a description." },
    { code: "28000", message: "You are not signed in — sign in again and save the ticket." }
  ];
  for (const error of cases) {
    const h = harness({ error });
    await assert.rejects(h.save([]), e =>
      e.plain === true && e.message === error.message && e.ticketGone === (error.gone || undefined));
    assert.equal(h.remembered.length, 0);
  }
});

test("a figure too large says so in our words, never the column's", async () => {
  const h = harness({ error: { code: "22003", message: "numeric field overflow: a field with precision 12, scale 2" } });
  await assert.rejects(h.save([]), e => e.plain === true && /too large to bill/.test(e.message));
});

// A missing EXECUTE grant is a deployment fault: its words name the function,
// and PGRST202 is an environment without the migration at all. Both stay
// unmarked, so humanizeError answers the first and the outbox keeps the second.
test("a deployment fault is not dressed up as a refusal", async () => {
  for (const error of [
    { code: "42501", message: "permission denied for function replace_ticket_lines" },
    { code: "PGRST202", message: "Could not find the function public.replace_ticket_lines" }
  ]) {
    const h = harness({ error });
    await assert.rejects(h.save([]), e => e === error);
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

// The editor's own end of it. The marked refusals above only read right if
// the catch asks `.plain` before the retry wrapper, and asks it before
// isNetworkError decides the save was merely offline.
test("the editor shows a marked refusal bare, and never queues it", () => {
  const screen = readFileSync(new URL("./components/ticketMobile.jsx", import.meta.url), "utf8");
  const save = screen.slice(screen.indexOf("    } catch (e) {"), screen.indexOf("  // The job record stores the rep"));
  const queued = save.indexOf("!e.plain && OfflineQueue.isNetworkError(e)");
  const gone = save.indexOf("if (e.ticketGone) {");
  const bare = save.indexOf("} else if (e.plain) {");
  const wrapper = save.indexOf("Press Save again");
  assert.ok(queued > -1, "a refusal must be told from a lost connection before it is queued");
  assert.ok(gone > -1 && bare > gone, "the gone branch comes first, then the plain one");
  assert.ok(wrapper > bare, "the retry wrapper must not catch a sentence complete in itself");
});
