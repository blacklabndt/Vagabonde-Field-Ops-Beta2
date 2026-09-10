# Ask drafts (job, ticket, JHA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant can propose a new job, a ticket for a job or a JHA for a job; the card offers one tap that opens the app's own form filled in; the person saves.

**Architecture:** Three read tools and three draft tools join `askTools.ts`; the draft runners shape a seed with `askDrafts.ts` (pure) and put an `action` on the function's response beside the answer. The card shows the action with Open the form / Not now; App turns it into a seeded form (job dialog lifted to App, JHA builder and ticket editor taking a seed). No function writes.

**Tech Stack:** as the first slice.

**Spec:** `docs/superpowers/specs/2026-09-10-ask-drafts-design.md`

## Global Constraints

- Draft tools write nothing. The only writes are the forms' own saves.
- Tool gates: `find_client`, `find_job`, `draft_job` → tab `board`; `job_record`, `draft_jha` → `jha`/`job` as listed; `draft_ticket` → tab `ticket` AND role Admin or Technician.
- `JHA_TEMPLATES` and the twelve hazard names live in askTools.ts AND data.js; a test reads data.js and fails on drift.
- `askDrafts.ts` and `askTools.ts` stay import-free (guard list).
- Every commit passes `npm --prefix vite-app test`.

---

### Task 1: askTools.ts — the six tools, roles, templates and hazard names

**Files:** modify `supabase/functions/_shared/askTools.ts`; test `vite-app/src/askTools.test.mjs`.

- [ ] Add to `AskTool`: `roles?: string[]`. Add exports:

```ts
export const JHA_TEMPLATES = [
  "RT — Pipeline tie-in v4", "RT — Facility / plant piping v2",
  "RT — Shop radiography v1", "RT — Sour service (H₂S) v3"
];
export const HAZARD_NAMES = [
  "Driving", "Entanglement", "Environmental", "Hazardous materials (WHMIS)", "Heavy equipment",
  "Housekeeping", "Manual lifting", "Pinch points", "Radiation (inc. NORM)", "Slips / trips / falls",
  "Tools", "Weather related"
];
export const PRICE_ROLES = ["Admin", "Technician"];
```

- [ ] Append six tools to `ASK_TOOLS` (after the tracker three):

```ts
  {
    name: "find_client", tab: "board",
    description: "Clients in the directory whose name contains the words given. Use it before drafting a job: a job's client must be one of these, by its exact name. Answers up to ten, each with how many contacts are on file.",
    input_schema: { type: "object", properties: { q: { type: "string", description: "part of the client's name" } }, required: ["q"], additionalProperties: false }
  },
  {
    name: "find_job", tab: "board",
    description: "Jobs whose number, project, LSD, client or contractor contains the words given: id, job number, project, client, contractor, LSD, AFE and status (Active or Complete). Up to ten, most recently active first. Use it to find which job a ticket or a JHA is for.",
    input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false }
  },
  {
    name: "job_record", tab: "job",
    description: "One job by its exact job number: the row, the client and contractor names, and every contact on file for both organisations (primary first) with email and phone. Use it to name reps or to check a job exists and is Active before drafting against it.",
    input_schema: { type: "object", properties: { job_number: { type: "string" } }, required: ["job_number"], additionalProperties: false }
  },
  {
    name: "draft_job", tab: "board",
    description: "Propose a new job: opens the app's New job form filled in for the person to check and save. Nothing is created until they save. client_name must be a client find_client returned. project and lsd are required by the form; ask for them if the person did not say. To start a JHA on the job once it is saved, pass then_jha with the JHA's details.",
    input_schema: {
      type: "object",
      properties: {
        project: { type: "string", description: "what the job is, e.g. 'RT on the 12-inch tie-in'" },
        client_name: { type: "string" },
        lsd: { type: "string", description: "the legal subdivision / site location, e.g. 03-12-071-06W6" },
        afe: { type: "string", description: "the client's AFE or PO number, if given" },
        contractor_name: { type: "string" },
        client_rep: { type: "string", description: "the client rep's name, if given" },
        contractor_rep: { type: "string", description: "the contractor rep's name, if given" },
        job_number: { type: "string", description: "only if the person said one; otherwise the app suggests the next" },
        then_jha: {
          type: "object", description: "a JHA to open on the new job once it is saved",
          properties: {
            template_words: { type: "string", description: "the kind of work: tie-in, facility/plant, shop, sour/H2S" },
            work_date: { type: "string", description: "YYYY-MM-DD; today if omitted" },
            helper_name: { type: "string" },
            hazards: { type: "array", items: { type: "string", enum: HAZARD_NAMES }, description: "hazards to suggest; the person ticks them" },
            site: { type: "object", properties: { weather: { type: "string" }, temperature: { type: "string" }, communication: { type: "string" }, muster: { type: "string" }, hospital: { type: "string" }, firstAid: { type: "string", enum: ["Yes", "No"] } }, additionalProperties: false }
          },
          additionalProperties: false
        }
      },
      required: ["project", "client_name", "lsd"],
      additionalProperties: false
    }
  },
  {
    name: "draft_ticket", tab: "ticket", roles: PRICE_ROLES,
    description: "Propose a billing ticket on an Active job: opens the ticket editor for that job with the work date and any lines given. Lines are matched to the client's rate card by label; one the card lacks is dropped and named. The crew and totals are the editor's. Nothing is saved until the person saves.",
    input_schema: {
      type: "object",
      properties: {
        job_number: { type: "string" },
        work_date: { type: "string", description: "YYYY-MM-DD; today if omitted" },
        lines: { type: "array", items: { type: "object", properties: { label: { type: "string", description: "the rate-card label, e.g. 'Standby' or 'Mileage'" }, quantity: { type: "number" } }, required: ["label", "quantity"], additionalProperties: false } }
      },
      required: ["job_number"], additionalProperties: false
    }
  },
  {
    name: "draft_jha", tab: "jha",
    description: "Propose a hazard assessment (JHA) on an Active job: opens the JHA builder for that job with the template, work date, helper, site details and suggested hazards filled in. Hazards are suggestions only; the person ticks them. Nothing is filed until the person files it.",
    input_schema: {
      type: "object",
      properties: {
        job_number: { type: "string" },
        template_words: { type: "string", description: "the kind of work: tie-in, facility/plant, shop, sour/H2S" },
        work_date: { type: "string", description: "YYYY-MM-DD; today if omitted" },
        helper_name: { type: "string" },
        hazards: { type: "array", items: { type: "string", enum: HAZARD_NAMES } },
        site: { type: "object", properties: { weather: { type: "string" }, temperature: { type: "string" }, communication: { type: "string" }, muster: { type: "string" }, hospital: { type: "string" }, firstAid: { type: "string", enum: ["Yes", "No"] } }, additionalProperties: false }
      },
      required: ["job_number"], additionalProperties: false
    }
  }
```

- [ ] `toolsFor(tabs, role)`:

```ts
export function toolsFor(tabs: readonly string[] | null | undefined, role?: string | null): AskTool[] {
  const held = new Set(tabs || []);
  return ASK_TOOLS.filter(t => held.has(t.tab) && (!t.roles || t.roles.includes(role || "")));
}
```

- [ ] `traceLine` gains: `find_client` → `looked up client "${q}"`; `find_job` → `looked up job "${q}"`; `job_record` → `read job ${job_number}'s record`; `draft_job` → `drafted a job for ${client_name}`; `draft_ticket` → `drafted a ticket on ${job_number}`; `draft_jha` → `drafted a JHA on ${job_number}`.

- [ ] Tests (replace the toolsFor test, add two):

```js
test("toolsFor offers exactly the tools behind the tabs held, and the price roles for a ticket", () => {
  assert.deepEqual(toolsFor(["tracker"]).map(t => t.name), ["tracker_stats", "ticket_aging", "search_tickets"]);
  assert.deepEqual(toolsFor(["board", "job", "jha", "ticket"], "Helper").map(t => t.name),
    ["find_client", "find_job", "job_record", "draft_job", "draft_jha"]);
  assert.ok(toolsFor(["ticket"], "Technician").some(t => t.name === "draft_ticket"));
  assert.ok(!toolsFor(["ticket"], "Coordinator").some(t => t.name === "draft_ticket"));
  assert.deepEqual(toolsFor(["board", "chat"]), toolsFor(["board", "chat"], "Admin").filter(t => !t.roles));
  assert.deepEqual(toolsFor(null), []);
});

test("the templates and hazard names are data.js's, word for word", () => {
  assert.deepEqual(JHA_TEMPLATES, DATA_TEMPLATES);
  assert.deepEqual(HAZARD_NAMES, SEED_HAZARDS.map(h => h.name));
});
```
with `import { TABS, JHA_TEMPLATES as DATA_TEMPLATES, SEED_HAZARDS } from "./data.js";`.

- [ ] Gate, commit "Ask's six new tools: three reads, three drafts".

---

### Task 2: askDrafts.ts — the shapers, pure

**Files:** create `supabase/functions/_shared/askDrafts.ts`; test `vite-app/src/askDrafts.test.mjs`; add `"askDrafts.ts"` to the guard list in `backupShared.test.mjs`.

```ts
// The shape of what a draft tool hands the card: a seed the app's own form
// opens with, and a sentence. Pure and import-free: the function resolves
// the client or the job first (as the caller) and hands the row in; the
// templates and hazard names come in too, since this file may import
// nothing. Every refusal names the field the form would refuse without,
// so the model asks the person instead of guessing.

export interface ClientHit { id: string; name: string }
export interface JobHit { id: string; job_number: string; project?: string | null; client_name?: string | null; status?: string | null }
export interface JobSeed { project: string; jobNumber: string; client: string; lsd: string; afe: string; contractor: string; clientRepName: string; contractorRepName: string }
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
  const missing = [!project && "a project name", !lsd && "the LSD (site location)"].filter(Boolean);
  if (missing.length) throw new Error(`The job form needs ${missing.join(" and ")} — ask the person.`);
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
```

- [ ] Tests (`askDrafts.test.mjs`): pickTemplate for each word set and unknown; shapeJobDraft refuses without project / lsd naming both; a full job seed and summary; shapeTicketDraft cleans lines (bad quantity dropped, label trimmed) and dates; shapeJhaDraft keeps only listed hazards (case-insensitive), site strings only, template from words, summary mentions suggestions.

- [ ] Gate, commit "Ask's draft shapers, pure".

---

### Task 3: the function — read runners, draft runners, the action

**Files:** modify `supabase/functions/ask/index.ts`, `supabase/functions/_shared/askLoop.ts` (system prompt lines).

- [ ] Prompt: add to `systemPrompt`:

```
"Drafting: when asked to create a job, a ticket or a JHA, look the client or job up first (find_client, find_job, job_record), then call the draft tool once. Ask for anything the form requires that was not said; never invent a client, an LSD, a rep or a figure. A draft opens the app's own form for the person to check and save — say so in one sentence, and do not repeat the form's contents. Hazards on a JHA are suggestions; the person ticks them.",
```

- [ ] Function: `toolsFor(me.tab_access, me.role)`; `let action: unknown = null;` runners:

```ts
      if (name === "find_client") {
        const { data, error } = await asUser.rpc("search_org_directory", { q: String(input.q ?? ""), scope: "Clients", page_num: 0, page_size: 10 });
        if (error) throw new Error(error.message);
        return ((data ?? []) as { org_id: string; name: string; contact_count: number }[]).map(r => ({ id: r.org_id, name: r.name, contact_count: r.contact_count }));
      }
      if (name === "find_job") {
        const { data, error } = await asUser.rpc("search_jobs", { q: String(input.q ?? ""), status_filter: "All", search_field: "any", page_num: 0, page_size: 10 });
        if (error) throw new Error(error.message);
        return ((data ?? []) as JobRow[]).map(j => ({ id: j.id, job_number: j.job_number, project: j.project, client_name: j.client_name, contractor_name: j.contractor_name, lsd: j.lsd, afe: j.afe, status: j.status }));
      }
      if (name === "job_record") return jobRecord(String(input.job_number ?? ""));
      if (name === "draft_job") {
        const client = await resolveClient(String(input.client_name ?? ""));
        const d = shapeJobDraft(input, client);
        const then = input.then_jha && typeof input.then_jha === "object"
          ? shapeJhaDraft(input.then_jha as Record<string, unknown>, { id: "", job_number: "the new job" }, JHA_TEMPLATES, HAZARD_NAMES) : null;
        action = { kind: "draft_job", summary: d.summary, seed: d.seed, ...(then ? { next: { kind: "draft_jha", summary: then.summary, seed: then.seed } } : {}) };
        return { ready: true, summary: d.summary, then: then ? then.summary : null };
      }
      if (name === "draft_ticket" || name === "draft_jha") {
        const job = await activeJob(String(input.job_number ?? ""));
        const d = name === "draft_ticket" ? shapeTicketDraft(input, job) : shapeJhaDraft(input, job, JHA_TEMPLATES, HAZARD_NAMES);
        action = { kind: name, summary: d.summary, seed: d.seed, job: { id: job.id, job_number: job.job_number } };
        return { ready: true, summary: d.summary };
      }
```
with helpers (all through `asUser`):

```ts
    const resolveClient = async (name: string) => {
      if (!name) throw new Error("Which client? Ask the person.");
      const { data, error } = await asUser.rpc("search_org_directory", { q: name, scope: "Clients", page_num: 0, page_size: 10 });
      if (error) throw new Error(error.message);
      const hits = ((data ?? []) as { org_id: string; name: string }[]).map(r => ({ id: r.org_id, name: r.name }));
      const exact = hits.filter(h => h.name.toLowerCase() === name.toLowerCase());
      if (exact.length === 1) return exact[0];
      if (hits.length === 1) return hits[0];
      if (!hits.length) throw new Error(`No client called "${name}" is in the directory. Ask the person which client it is; a new client is added on Home's New job form.`);
      throw new Error(`More than one client matches "${name}": ${hits.map(h => h.name).join(", ")}. Ask the person which.`);
    };
    const activeJob = async (number: string) => {
      if (!number) throw new Error("Which job? Ask the person for the job number.");
      const { data, error } = await asUser.from("jobs").select("id, job_number, project, status, clients(name)").eq("job_number", number).maybeSingle();
      if (error) throw new Error(error.message);
      const j = data as unknown as { id: string; job_number: string; project: string | null; status: string | null; clients: { name: string } | null } | null;
      if (!j) throw new Error(`No job numbered ${number}. Use find_job to look it up.`);
      if (j.status === "Complete") throw new Error(`Job ${number} is complete; nothing new can be raised on it.`);
      return { id: j.id, job_number: j.job_number, project: j.project, client_name: j.clients?.name ?? null, status: j.status };
    };
    const jobRecord = async (number: string) => {
      const { data, error } = await asUser.from("jobs")
        .select("id, job_number, project, lsd, afe, status, client_id, contractor_id, client_contact_id, contractor_contact_id, clients(name), contractors(name)")
        .eq("job_number", number).maybeSingle();
      if (error) throw new Error(error.message);
      const j = data as unknown as JobRecordRow | null;
      if (!j) throw new Error(`No job numbered ${number}.`);
      const orgs = [j.client_id, j.contractor_id].filter((x): x is string => !!x);
      const { data: people, error: cErr } = orgs.length
        ? await asUser.from("contacts").select("id, org_type, org_id, name, email, phone, is_primary").in("org_id", orgs).order("is_primary", { ascending: false }).order("name")
        : { data: [], error: null };
      if (cErr) throw new Error(cErr.message);
      const list = (people ?? []) as ContactRow[];
      const named = (id: string | null) => list.find(c => c.id === id) ?? null;
      return {
        job: { id: j.id, job_number: j.job_number, project: j.project, lsd: j.lsd, afe: j.afe, status: j.status, client: j.clients?.name ?? null, contractor: j.contractors?.name ?? null },
        client_rep: named(j.client_contact_id) ?? list.find(c => c.org_type === "client" && c.is_primary) ?? null,
        contractor_rep: named(j.contractor_contact_id) ?? list.find(c => c.org_type === "contractor" && c.is_primary) ?? null,
        contacts: { client: list.filter(c => c.org_type === "client"), contractor: list.filter(c => c.org_type === "contractor") }
      };
    };
```
Response: `return json(action ? { ...result, action } : result);`

- [ ] Typecheck, deploy `ask`, probe 401. Commit "The ask function drafts: reads as the caller, proposes, writes nothing".

---

### Task 4: the thread and the card carry the action

**Files:** `vite-app/src/askThread.js` (+ test), `vite-app/src/components/askPanel.jsx`.

- [ ] `pushTurn(role, text, trace, action)`: `if (action) turn.action = action;`. Add `export function dropAction(index) { turns = turns.map((t, i) => i === index && t.action ? { role: t.role, text: t.text, ...(t.trace ? { trace: t.trace } : {}) } : t); }`. Test: an action is kept on the turn, not in `threadForSend`, and `dropAction` removes it.

- [ ] Panel: `AskCard({ onClose, onOpenJob, onAction })`; after `pushTurn("assistant", answer, trace, action)`. Under the LAST answer turn with an action:

```jsx
{i === turns.length - 1 && t.action && (
  <div className="ask-proposal">
    <div>{t.action.summary}</div>
    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
      <Btn variant="primary" onClick={() => { onClose(); onAction(t.action); }}>Open the form</Btn>
      <Btn variant="secondary" onClick={() => { dropAction(i); setTurns(askTurns()); }}>Not now</Btn>
    </div>
  </div>
)}
```
CSS: `.ask-proposal { margin-top: 8px; padding: 10px; border: 1px solid var(--color-accent); }`. `AskLauncher({ onOpenJob, onAction })` passes it through.

- [ ] Gate, commit "The card offers the form a draft proposes".

---

### Task 5: App runs the action; the job dialog takes a seed and opens from App

**Files:** `vite-app/src/App.jsx`, `vite-app/src/components/home.jsx`.

- [ ] home.jsx: `export function NewJobDialog({ currentUser, clients, contractors, contacts, onClose, onCreate, seed = null })`; initial form from the seed:

```js
  const [form, setForm] = useState(() => ({
    project: (seed && seed.project) || "", jobNumber: (seed && seed.jobNumber) || "", client: "", lsd: (seed && seed.lsd) || "", afe: (seed && seed.afe) || "",
    clientRepId: "", clientRepName: "", clientRepEmail: "", clientRepPhone: "",
    contractor: "", contractorRepId: "", contractorRepName: "", contractorRepEmail: "", contractorRepPhone: ""
  }));
```
and, after `pickContractor` is defined, a mount effect applying the seed's client, contractor and reps (by name against the org's contacts; a name not on file is kept as typed):

```js
  // A draft from Ask: the client and contractor go through the same pickers
  // a tap would use (so the primary rep fills in as it would), and a rep
  // named in words is matched to the organisation's people; a name not on
  // file is kept as typed, never filed as a new contact by the assistant.
  // biome-ignore lint/correctness/useExhaustiveDependencies: applied once at mount; the seed is fixed for the dialog's life
  useEffect(() => {
    if (!seed) return;
    const byName = (list, name) => name && list.find(c => String(c.name).toLowerCase() === String(name).toLowerCase());
    if (seed.client && clientList.some(c => c.name === seed.client)) {
      pickClient(seed.client);
      const client = clientList.find(c => c.name === seed.client);
      const rep = byName(contactsForOrg(contacts, "client", client.id), seed.clientRepName);
      if (rep) pickClientRep(rep.id);
      else if (seed.clientRepName) setForm(p => ({ ...p, clientRepId: "", clientRepName: seed.clientRepName, clientRepEmail: "", clientRepPhone: "" }));
    }
    if (seed.contractor) {
      const known = contractorList.find(c => c.name.toLowerCase() === seed.contractor.toLowerCase());
      if (!known) setContractorList(p => [...p, { id: null, name: seed.contractor }].sort((a, b) => a.name.localeCompare(b.name)));
      pickContractor(known ? known.name : seed.contractor);
      const rep = known && byName(contactsForOrg(contacts, "contractor", known.id), seed.contractorRepName);
      if (rep) pickContractorRep(rep.id);
      else if (seed.contractorRepName) setForm(p => ({ ...p, contractorRepId: "", contractorRepName: seed.contractorRepName, contractorRepEmail: "", contractorRepPhone: "" }));
    }
  }, []);
```
(Note `pickClientRep` on a seeded client: `clientContacts` memo is stale in this effect, so use `contactsForOrg` directly as above and call the setForm shape `pickClientRep` uses — simplest is to inline: `setForm(p => ({ ...p, clientRepId: rep.id, clientRepName: rep.name, clientRepEmail: rep.email || "", clientRepPhone: rep.phone || "" }))`.)

- [ ] App.jsx: state `const [jobSeed, setJobSeed] = useState(null); const [jhaSeed, setJhaSeed] = useState(null);`. `createJob` returns the job it set (`return job;` / `return created;`, `return null` on failure). `startJhaForJob(job, seed = null)` sets `setJhaSeed(seed ? { ...seed, nonce: Date.now() } : null)` before `gotoContext("jha")`. JHA case: `<JhaBuilderScreen key={\`jha-${activeJob ? activeJob.dbId : ""}-${jhaSeed ? jhaSeed.nonce : ""}\`} seed={jhaSeed} …/>`. Then:

```js
  // What Ask proposed: the app's own form, filled in. Nothing is written
  // until that form saves.
  const runAskAction = async action => {
    if (!action) return;
    if (action.kind === "draft_job") { setJobSeed({ ...action.seed, next: action.next || null, nonce: Date.now() }); return; }
    try {
      const job = await Db.getJobByNumber(action.job.job_number);
      if (action.kind === "draft_ticket") await startTicketForJob(job, action.seed);
      else if (action.kind === "draft_jha") await startJhaForJob(job, action.seed);
    } catch (e) {
      Toasts.show(`Couldn't open ${action.job.job_number}: ${e.message || "try again."}`, "error");
    }
  };
```
Mount after the FeatureRequestDialog block:

```jsx
      {jobSeed && (
        <NewJobDialog key={jobSeed.nonce} seed={jobSeed}
          currentUser={currentUser} clients={clients} contractors={contractors} contacts={contacts}
          onClose={() => setJobSeed(null)}
          onCreate={async made => {
            const next = jobSeed.next;
            setJobSeed(null);
            const job = await createJob(made);
            if (!job) return;
            if (next && next.kind === "draft_jha") await startJhaForJob(job, next.seed);
            else openJob(job);
          }} />
      )}
      {currentUser && <AskLauncher onOpenJob={openJobByNumber} onAction={runAskAction} />}
```
Import `NewJobDialog` from home.jsx.

- [ ] Gate (render scan sees the new tag), commit "A drafted job opens the New job form from any screen, and can go on to the JHA".

---

### Task 6: the JHA builder and the ticket editor take the seed

**Files:** `vite-app/src/components/jhaMobile.jsx`, `vite-app/src/components/ticketMobile.jsx`, create `vite-app/src/ticketSeedLines.js` (+ test).

- [ ] jhaMobile.jsx: prop `seed = null`. `const [template] = useState(() => (seed && seed.template) || JHA_TEMPLATES[0]);` used in the payload (`template,` instead of `template: JHA_TEMPLATES[0]`). `useState(() => (seed && seed.workDate) || todayLocal())` for workDate. Site: `const seededSite = seed && seed.site ? { ...BLANK_SITE, ...seed.site } : BLANK_SITE; const [site, setSite] = useState(seededSite);` and `baseline = useRef({ site: seededSite, equip: BLANK_EQUIP })`. Helper by name once `people` land:

```js
  // A helper named by Ask, matched to the crew once the list is here; a
  // name with no match leaves the box on "working alone" for the person.
  useEffect(() => {
    if (!seed || !seed.helperName || helperId || !people.length) return;
    const want = seed.helperName.toLowerCase();
    const hit = people.find(p => String(p.displayName || p.name || "").toLowerCase() === want || String(p.displayName || "").toLowerCase().includes(want));
    if (hit) setHelperId(hit.id);
  }, [seed, people, helperId]);
```
Suggestion line, after the "At least one hazard" line:

```jsx
          {seed && seed.suggestedHazards && seed.suggestedHazards.length > 0 && (
            <div style={{ fontSize: 11, marginTop: -2, color: "var(--color-accent)" }}>
              AI suggests: {seed.suggestedHazards.join(", ")}. Tick the ones that apply — nothing is ticked for you.
            </div>
          )}
```
and the template, when seeded, said once above the hazards: `{seed && seed.template && <div style={{ fontSize: 11, marginTop: -2 }}>Template: {seed.template}</div>}`.

- [ ] `ticketSeedLines.js`:

```js
// Lines a draft from Ask asks for, matched to the client's rate card by
// label (case-insensitive, the card's own label or the plain word before
// its " · " / " — " suffix). What matches becomes form lines with their
// quantities; what does not is named, never invented.
export function seedLinesToForm(lines, catalog) {
  const welds = [], others = [], unmatched = [];
  const plain = s => String(s || "").toLowerCase().split(/ · | — /)[0].trim();
  const find = (list, label) => {
    const want = String(label).toLowerCase().trim();
    return list.find(x => String(x.label).toLowerCase() === want) || list.find(x => plain(x.label) === want) || list.find(x => plain(x.label) === plain(label));
  };
  for (const l of lines || []) {
    const qty = Number(l.quantity);
    if (!l.label || !Number.isFinite(qty) || qty <= 0) continue;
    const w = find(catalog.welds || [], l.label);
    if (w) { welds.push({ key: w.key, qty }); continue; }
    const o = find(catalog.others || [], l.label);
    if (o) { others.push({ key: o.key, qty }); continue; }
    unmatched.push(l.label);
  }
  return { welds, others, unmatched };
}
```
Test: exact label, plain-word match against a suffixed label, weld vs service, unmatched named, bad quantities skipped.

- [ ] ticketMobile.jsx: after the rates load and only for a new ticket with `seed.lines`, once, and only when no WIP was restored:

```js
  // Lines Ask drafted, applied once the card is here — and only when no
  // recovery copy took the form first, since that copy is somebody's work.
  const seedLinesApplied = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, when the rates land; the seed is fixed for the editor's life
  useEffect(() => {
    if (ticket || !rates || seedLinesApplied.current || !(seed && seed.lines && seed.lines.length)) return;
    if (!wipReady.current || wipRestored.current) return;
    seedLinesApplied.current = true;
    const { welds, others, unmatched } = seedLinesToForm(seed.lines, rates);
    if (welds.length) setWeldLines(welds);
    if (others.length) setOtherLines(others);
    if (unmatched.length) Toasts.show(`Not on this client's rate card: ${unmatched.join(", ")} — add them by hand if they belong.`, "error", true);
  }, [rates, loadingTicket]);
```
(Check the names `wipReady`, `wipRestored`, `setWeldLines`, `setOtherLines` exist as such in the file; adjust to the real ones.)

- [ ] Gate; preview in the browser is not possible signed out; commit "The JHA builder and the ticket editor open on a draft's seed".

---

### Task 7: docs, deploy, live check

- [ ] CLAUDE.md: the Ask bullet gains the drafting paragraph (tools, the action, the seeds, the precedence rule in the JHA builder, the by-label lines, the templates/hazards twin test). README: `askDrafts.ts`, `ticketSeedLines.js`. Shared-module count → eleven.
- [ ] `npm run build && npx wrangler deploy`; new chunk 200. Redeploy `ask` if `_shared` changed after Task 3.
- [ ] Live, by Kyle: "new job for <client> at <lsd>, RT on the tie-in, and start the JHA"; a ticket with two lines; a JHA with hazards suggested.
- [ ] Commit, push, memory.
