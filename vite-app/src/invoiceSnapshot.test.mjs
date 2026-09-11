import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const read = name => readFileSync(new URL(`../../supabase/functions/_shared/${name}`, import.meta.url), "utf8");
const source = read("invoice.ts").split("export const invoiceCss")[0].replace(/^import .*;\r?\n/gm, "");
const invoice = await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(source)).toString("base64"));

function bill(snapshot, current = 5) {
  return { ticket: { id: "TEST", gst_rate: snapshot, work_date: "2026-09-11" }, job: { project: "Test", clients: { gst_rate: current } }, lines: [{ quantity: 1, unit_rate: 1000 }], crew: [] };
}

test("invoice and approval totals retain the stamped rate when the client's rate changes", () => {
  assert.equal(invoice.invoiceTotals(bill(5, 0)).grand, 105000);
  assert.equal(invoice.invoiceTotals(bill(0, 5)).grand, 100000);
  assert.equal(invoice.gstLabelOf(bill(0, 5)), "GST exempt");
});

test("legacy invoices without a snapshot keep their existing fallback behavior", () => {
  assert.equal(invoice.invoiceTotals(bill(null, 0)).grand, 100000);
  assert.equal(invoice.invoiceTotals(bill(undefined, 5)).grand, 105000);
});

test("the real invoice loader fetches the snapshot before rendering the approved copy", async () => {
  const loaderSource = stripTypeScriptTypes(read("ticketInvoice.ts").replace(/^import .*;\r?\n/gm, "")).replace(/export /g, "");
  const load = new Function("LEVEL_LEGEND", `${loaderSource}; return loadInvoice;`)("");
  const fixture = { id: "TEST", status: "Approved", work_date: "2026-09-11", total: 1000, gst_rate: 5,
    jobs: { clients: { gst_rate: 0 } }, ticket_lines: [{ quantity: 1, unit_rate: 1000 }] };
  const db = { from(table) {
    let selected = "";
    const result = () => {
      // Project only the requested top-level columns, as the API does.
      let fields = selected;
      while (fields.includes("(")) fields = fields.replace(/\([^()]*\)/g, "");
      const keys = fields.split(",").map(s => s.trim());
      return { data: table === "tickets" ? Object.fromEntries(keys.map(k => [k, fixture[k]])) : [], error: null };
    };
    return {
      select(s) { selected = s; return this; }, order() { return this; }, eq() { return this; },
      maybeSingle: async () => result(),
      // biome-ignore lint/suspicious/noThenProperty: models the awaited PostgREST query builder.
      then(resolve) { resolve(result()); }
    };
  } };
  const result = await load(db, "TEST", "", {});
  assert.equal(result.error, null);
  assert.equal(invoice.invoiceTotals(result.data).grand, 105000);
});

const approval = stripTypeScriptTypes(read("mailApproval.ts").replace(/^import .*;\r?\n/gm, "")).replace(/export /g, "");
const makeApproval = new Function("sendMail", "wrapEmail", "esc", "invoicePage", "gstLabelOf", "invoiceTotals", "lineCents", "loadInvoice", "hashToken", `${approval}; return mailApproval;`);

function approvalHarness({ failSnapshot = false, failMail = false, snapshot = null } = {}) {
  let current = 5;
  let frozen = snapshot;
  let sent = 0;
  let tokenWrites = 0;
  const admin = {
    async rpc(name, args) {
      assert.equal(name, "freeze_ticket_gst");
      assert.deepEqual(args, { p_ticket_id: "TEST" });
      if (failSnapshot) return { data: null, error: { message: "snapshot failed" } };
      frozen ??= current;
      return { data: frozen, error: null };
    },
    from() { return { update() { tokenWrites++; return { eq: async () => ({ error: null }) }; } }; }
  };
  const send = makeApproval(async () => {
    if (failMail) throw new Error("mail failed");
    sent++;
    current = 0; // Client changes after receiving the email.
  }, x => x, String, () => "invoice", invoice.gstLabelOf, invoice.invoiceTotals, invoice.lineCents,
  async () => ({ data: bill(frozen, current), error: null }), async () => "hashed");
  return {
    run: () => send(admin, "TEST", "rep@example.com", undefined, "person", { approvalBaseUrl: "https://example.com", invoice: {} }),
    state: () => ({ frozen, sent, tokenWrites, total: invoice.invoiceTotals(bill(frozen, current)).grand })
  };
}

test("approval freezes the rate before sending so the subsequent page cannot change its total", async () => {
  const h = approvalHarness();
  await h.run();
  assert.deepEqual(h.state(), { frozen: 5, sent: 1, tokenWrites: 1, total: 105000 });
});

test("a snapshot failure stops the email and token write", async () => {
  const h = approvalHarness({ failSnapshot: true });
  await assert.rejects(h.run(), /snapshot failed/);
  assert.equal(h.state().sent, 0);
  assert.equal(h.state().tokenWrites, 0);
});

test("resending retains an existing exempt rate", async () => {
  const h = approvalHarness({ snapshot: 0 });
  await h.run();
  assert.equal(h.state().frozen, 0);
  assert.equal(h.state().total, 100000);
});

test("mail failure does not mark approval sent, but retains the reserved rate for retry", async () => {
  const h = approvalHarness({ failMail: true });
  await assert.rejects(h.run(), /mail failed/);
  assert.equal(h.state().tokenWrites, 0);
  assert.equal(h.state().frozen, 5);
});
