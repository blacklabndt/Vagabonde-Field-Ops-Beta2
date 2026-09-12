import { createCalculationStore } from "./askCalculate.ts";
import { readContext, type ReadContext } from "./askContext.ts";
import { searchArgs } from "./askTools.ts";

// The caller supplies the existing authorized runner. Neither browser history
// nor model arguments can populate the calculation store directly.
export function createInvestigation(read: (name: string, input: Record<string, unknown>) => Promise<unknown>, allowed?: string[]) {
  const store = createCalculationStore();
  const history: ReadContext[] = [];
  let sequence = 0;
  return {
    followUp: () => {
      const kept: ReadContext[] = [];
      for (const entry of history.slice(-8).reverse()) {
        if (JSON.stringify([entry, ...kept]).length <= 5500) kept.unshift(entry);
      }
      return kept;
    },
    async runTool(name: string, input: Record<string, unknown>): Promise<unknown> {
      if (allowed && !allowed.includes(name)) return { error: "This tool is not available on the tabs and role you hold." };
      if (name === "calculate") return store.calculate(input);
      if (name === "search_tickets") {
        const query = searchArgs(input);
        input = { status: query.status_filter, q: query.q, date_from: query.date_from, date_to: query.date_to, page: query.page_num, page_size: query.page_size };
      }
      const result = await read(name, input);
      const context = readContext(name, input, result);
      if (context) history.push(context);
      if ((name === "search_tickets" || name === "list_tickets") && Array.isArray(result) && context) {
        const id = `read-${++sequence}`;
        const period = name === "search_tickets"
          ? `${context.filters.date_from || "unbounded start"} to ${context.filters.date_to || "unbounded end"}`
          : `all returned work dates for job ${context.filters.job_number || "unspecified"}`;
        // Only the supported financial field is captured. Counts, IDs and other
        // numeric-looking metadata cannot accidentally become money.
        const captured = store.capture({ id, rows: result.map(row => ({ id: row?.id, total: row?.total })), complete: context.coverage === "complete", period, units: { total: "billing dollars" } });
        return { records: result, calculation: captured ? { source_id: id, fields: ["total"], period, units: { total: "billing dollars" }, coverage: context.coverage } : { error: "The read could not be captured for calculation." } };
      }
      return result;
    }
  };
}
