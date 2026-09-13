import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./db.js", import.meta.url), "utf8");

test("job tickets load under the live column restrictions", async () => {
  const start = source.indexOf("  async listTicketsForJob(");
  const end = source.indexOf("  async getTicketTrackerStats(", start);
  const columns = source.match(/const JOB_TICKET_COLUMNS = ("[^"]+");/)[1];
  const row = { id: "test-ticket", total: 125 };
  const client = { from(table) {
    return { select() { return this; }, eq() { return this; },
      async order() {
        return table === "tickets_read"
          ? { data: [row], error: null }
          : { data: null, error: new Error("permission denied for table tickets") };
      }
    };
  } };
  const db = new Function("sbClient", "OfflineCache", "shapeJobTicket",
    `const JOB_TICKET_COLUMNS = ${columns}; return { ${source.slice(start, end)} };`)(
    client, { readThrough: (_key, read) => read() }, value => value);
  assert.deepEqual(await db.listTicketsForJob(123), [row]);
});

test("job detail prefetch uses the same price-safe ticket view", () => {
  const prefetch = source.slice(source.indexOf("  async prefetchJobDetails("), source.indexOf('      // Written per job'));
  assert.match(prefetch, /all\("tickets_read", JOB_TICKET_COLUMNS, "created_at"\)/);
});
