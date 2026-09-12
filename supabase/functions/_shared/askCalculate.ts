// Request-local arithmetic over snapshots captured by the authorized read runner.
// Historical browser context and model-supplied rows must never enter this store.
export interface CalculationSource {
  id: string;
  rows: Record<string, unknown>[];
  complete: boolean;
  period?: string;
  units?: Record<string, string>;
}

export function createCalculationStore() {
  const sources = new Map<string, CalculationSource>();
  const safe = (n: number) => Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER;
  return {
    capture(source: CalculationSource): boolean {
      if (!source.id || sources.has(source.id) || sources.size >= 32 || !Array.isArray(source.rows) || source.rows.length > 2000) return false;
      const seen = new Set<string | number>();
      for (const row of source.rows) {
        if (!row || typeof row !== "object" || Array.isArray(row)) return false;
        const id = row.id;
        if (typeof id === "string" || typeof id === "number") {
          if (seen.has(id)) return false;
          seen.add(id);
        }
      }
      // Only direct scalar fields are available; no paths or executable expressions.
      const rows = source.rows.map(row => Object.fromEntries(Object.entries(row).filter(([, value]) => value === null || typeof value === "number" || typeof value === "string")));
      sources.set(source.id, { ...source, rows, units: { ...source.units } });
      return true;
    },
    calculate(input: Record<string, unknown>): Record<string, unknown> {
      const fail = (error: string) => ({ error });
      const allowed = ["operation", "source_id", "field", "compare_source_id"];
      if (Object.keys(input).some(key => !allowed.includes(key))) return fail("Only captured source references and a numeric field are accepted.");
      const { operation, source_id, field, compare_source_id } = input;
      if (!["sum", "average", "difference", "percent_change"].includes(String(operation)) || typeof source_id !== "string" || typeof field !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(field) || ["constructor", "prototype", "__proto__"].includes(field)) return fail("Invalid calculation arguments.");
      const comparison = operation === "difference" || operation === "percent_change";
      if (comparison ? typeof compare_source_id !== "string" : compare_source_id !== undefined) return fail("Comparisons require a baseline source; other operations accept one source only.");
      const ids = comparison ? [source_id, compare_source_id as string] : [source_id];
      const selected: CalculationSource[] = [];
      const totals: number[] = [];
      for (const id of ids) {
        const source = sources.get(id);
        if (!source) return fail("Source unavailable. Read the records again through an authorized tool.");
        if (source.complete !== true) return fail("Source coverage is incomplete or unknown. Narrow the read to a complete result before calculating.");
        if (!source.rows.length) return fail("No numeric records were returned; an empty result is not treated as zero.");
        let sum = 0;
        let compensation = 0;
        for (const row of source.rows) {
          const value = Object.hasOwn(row, field) ? row[field] : undefined;
          if (typeof value !== "number" || !safe(value)) return fail("The field includes missing, restricted, non-numeric, or unsafe values; no total was calculated.");
          const adjusted = value - compensation;
          const next = sum + adjusted;
          compensation = (next - sum) - adjusted;
          sum = next;
          if (!safe(sum)) return fail("Calculation exceeds the safe numeric range.");
        }
        selected.push(source);
        totals.push(sum);
      }
      const unit = selected[0].units?.[field] ?? null;
      if (comparison && unit !== (selected[1].units?.[field] ?? null)) return fail("Sources have different units and cannot be compared.");
      if (operation === "percent_change" && totals[1] === 0) return fail("Percent change is undefined for a zero baseline.");
      const value = operation === "sum" ? totals[0] : operation === "average" ? totals[0] / selected[0].rows.length : operation === "difference" ? totals[0] - totals[1] : ((totals[0] - totals[1]) / Math.abs(totals[1])) * 100;
      if (!safe(value)) return fail("Calculation exceeds the safe numeric range.");
      return { operation, field, value, unit: operation === "percent_change" ? "%" : unit, sources: selected.map(source => ({ source_id: source.id, count: source.rows.length, complete: true, period: source.period ?? null })) };
    }
  };
}
