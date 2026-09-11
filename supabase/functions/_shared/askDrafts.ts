// The shape of what a draft tool hands the card: a seed the app's own form
// opens with, and a sentence. Pure and import-free: the function resolves
// the client or the job first (as the caller) and hands the row in; the
// templates and hazard names come in too, since this file may import
// nothing. Every refusal names the field the form would refuse without,
// so the model asks the person instead of guessing.

// A refusal written to be READ by whoever asked — see askSends.ts.
function refuse(words: string): Error {
  const e = new Error(words);
  (e as Error & { plain?: boolean }).plain = true;
  return e;
}

export interface ClientHit { id: string; name: string }
export interface JobHit { id: string; job_number: string; project?: string | null; client_name?: string | null; status?: string | null }
export interface JobSeed {
  project: string; jobNumber: string; client: string; lsd: string; afe: string;
  contractor: string; clientRepName: string; contractorRepName: string;
}
export interface JhaSite { weather?: string; temperature?: string; communication?: string; muster?: string; hospital?: string; firstAid?: string }
export interface JhaSeed { template: string; workDate: string | null; helperName: string; suggestedHazards: string[]; site: JhaSite }
export interface TicketSeed { workDate: string | null; lines: { label: string; quantity: number }[] }
export interface Draft<S> { seed: S; summary: string }

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown): string => typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
const day = (v: unknown): string | null => DAY.test(str(v)) ? str(v) : null;
const rec = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

// "tie-in" → the tie-in template, "facility"/"plant"/"piping" → facility,
// "shop" → shop, "sour"/"h2s" → sour; anything else is the first.
export function pickTemplate(words: unknown, templates: readonly string[]): string {
  const w = str(words).toLowerCase();
  const find = (...keys: string[]) => templates.find(t => keys.some(k => t.toLowerCase().includes(k)));
  if (/sour|h2s|h₂s/.test(w)) return find("sour") || templates[0];
  if (/shop/.test(w)) return find("shop") || templates[0];
  if (/facilit|plant|piping/.test(w)) return find("facility", "plant") || templates[0];
  if (/tie/.test(w)) return find("tie-in") || templates[0];
  return templates[0];
}

export function shapeJobDraft(input: Record<string, unknown>, client: ClientHit): Draft<JobSeed> {
  const project = str(input.project);
  const lsd = str(input.lsd);
  const missing = [!project && "a project name", !lsd && "the LSD (site location)"].filter((m): m is string => !!m);
  if (missing.length) throw refuse(`The job form needs ${missing.join(" and ")} — ask the person.`);
  const seed: JobSeed = {
    project, jobNumber: str(input.job_number), client: client.name, lsd, afe: str(input.afe),
    contractor: str(input.contractor_name), clientRepName: str(input.client_rep), contractorRepName: str(input.contractor_rep)
  };
  const bits = [`New job for ${client.name}: ${project} at ${lsd}`];
  if (seed.afe) bits.push(`AFE ${seed.afe}`);
  if (seed.contractor) bits.push(`contractor ${seed.contractor}`);
  if (seed.clientRepName) bits.push(`client rep ${seed.clientRepName}`);
  if (seed.jobNumber) bits.push(`number ${seed.jobNumber}`);
  return { seed, summary: `${bits.join(", ")}. Open the form to check it and save.` };
}

export function shapeTicketDraft(input: Record<string, unknown>, job: JobHit): Draft<TicketSeed> {
  const lines = (Array.isArray(input.lines) ? input.lines : [])
    .map(l => { const r = rec(l); return { label: str(r.label), quantity: Number(r.quantity) }; })
    .filter(l => l.label && Number.isFinite(l.quantity) && l.quantity > 0);
  const workDate = day(input.work_date);
  const seed: TicketSeed = { workDate, lines };
  const when = workDate ? ` for ${workDate}` : "";
  const what = lines.length ? ` with ${lines.map(l => `${l.quantity} × ${l.label}`).join(", ")}` : "";
  return { seed, summary: `A ticket on ${job.job_number}${job.project ? ` (${job.project})` : ""}${when}${what}. Open the editor to finish it and save.` };
}

export function shapeJhaDraft(input: Record<string, unknown>, job: JobHit, templates: readonly string[], hazardNames: readonly string[]): Draft<JhaSeed> {
  const site = rec(input.site);
  const kept: JhaSite = {};
  for (const k of ["weather", "temperature", "communication", "muster", "hospital", "firstAid"] as const) {
    const v = str(site[k]);
    if (v) kept[k] = v;
  }
  const wanted = Array.isArray(input.hazards) ? input.hazards.map(str) : [];
  const suggested = hazardNames.filter(n => wanted.some(w => w.toLowerCase() === n.toLowerCase()));
  const seed: JhaSeed = {
    template: pickTemplate(input.template_words, templates), workDate: day(input.work_date),
    helperName: str(input.helper_name), suggestedHazards: suggested, site: kept
  };
  const bits = [`A JHA on ${job.job_number}${job.project ? ` (${job.project})` : ""}, ${seed.template}`];
  if (seed.workDate) bits.push(`for ${seed.workDate}`);
  if (seed.helperName) bits.push(`helper ${seed.helperName}`);
  if (suggested.length) bits.push(`suggesting ${suggested.join(", ")}`);
  return { seed, summary: `${bits.join(", ")}. Open the builder, tick the hazards that apply, and file it.` };
}
