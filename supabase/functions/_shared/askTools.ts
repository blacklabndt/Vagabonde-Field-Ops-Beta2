// What Ask may read or draft, and the tab each sits behind. Definitions
// only: the function holds the runners, so this file has no imports and
// the node suite can hold the list against TABS. Erasable TypeScript,
// nothing read from the world (backupShared.test.mjs guards that).
//
// A tool is offered to the model only when the caller holds its tab (and
// its role, where the tool names roles), and every runner reads as the
// caller, so RLS would refuse anyway; the list keeps the model from trying
// and being told no. A draft tool writes nothing: it shapes the seed the
// app's own form opens with, and the person saves or does not.

export interface AskTool {
  name: string;
  tab: string;
  roles?: string[];
  description: string;
  input_schema: Record<string, unknown>;
}

export const TRACKER_STATUSES = ["All", "Draft", "Awaiting approval", "Approved", "Invoiced", "Over 7 days"];

// Twins of data.js's JHA_TEMPLATES and SEED_HAZARDS names; askTools.test.mjs
// reads data.js and fails on drift (the KIND_WORDS pattern).
export const JHA_TEMPLATES = [
  "RT — Pipeline tie-in v4", "RT — Facility / plant piping v2",
  "RT — Shop radiography v1", "RT — Sour service (H₂S) v3"
];
export const HAZARD_NAMES = [
  "Driving", "Entanglement", "Environmental", "Hazardous materials (WHMIS)", "Heavy equipment",
  "Housekeeping", "Manual lifting", "Pinch points", "Radiation (inc. NORM)", "Slips / trips / falls",
  "Tools", "Weather related"
];
// Who may see money, and so draft a ticket (seesPrices in data.js).
export const PRICE_ROLES = ["Admin", "Technician"];

const DATE = "a date as YYYY-MM-DD";

const JHA_FIELDS = {
  template_words: { type: "string", description: "the kind of work: tie-in, facility/plant, shop, sour/H2S" },
  work_date: { type: "string", description: `${DATE}; today if omitted` },
  helper_name: { type: "string", description: "the helper on site with the technician, by name" },
  hazards: { type: "array", items: { type: "string", enum: HAZARD_NAMES }, description: "hazards to suggest; the person ticks them" },
  site: {
    type: "object",
    properties: {
      weather: { type: "string" }, temperature: { type: "string" }, communication: { type: "string" },
      muster: { type: "string", description: "the muster point" }, hospital: { type: "string", description: "the nearest hospital" },
      firstAid: { type: "string", enum: ["Yes", "No"], description: "whether first aid is on site" }
    },
    additionalProperties: false
  }
};

export const ASK_TOOLS: AskTool[] = [
  {
    name: "tracker_stats", tab: "tracker",
    description: "Totals across every billing ticket: how many are unsigned (awaiting the client's approval), how many of those are over seven days old, how many are approved and how many invoiced, each with its dollar total. A null total means this person may not see money.",
    input_schema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "ticket_aging", tab: "tracker",
    description: "How old the money is, by client: for each client and age bucket (current, 30, 60, 90 days past the work date) the count of tickets awaiting approval, approved or invoiced and their total. A null total means this person may not see money.",
    input_schema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "search_tickets", tab: "tracker",
    description: "A page of billing tickets, newest first, with job number, project, client, technician, status, work date, total, when the client was last chased, when it was invoiced, and any query the client rep typed. Filter by status, search by words (ticket number, job number, client, project, technician) and bound by work date. total_count on each row is the size of the whole result. Up to 50 a page.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: TRACKER_STATUSES, description: "Over 7 days means awaiting approval for more than seven days" },
        q: { type: "string", description: "words to search for" },
        date_from: { type: "string", description: `earliest work date, ${DATE}` },
        date_to: { type: "string", description: `latest work date, ${DATE}` },
        page: { type: "integer", minimum: 0, description: "0 is the first page" },
        page_size: { type: "integer", minimum: 1, maximum: 50 }
      },
      additionalProperties: false
    }
  },
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
        then_jha: { type: "object", description: "a JHA to open on the new job once it is saved", properties: JHA_FIELDS, additionalProperties: false }
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
        work_date: { type: "string", description: `${DATE}; today if omitted` },
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "the rate-card label, e.g. 'Standby' or 'Mileage'" },
              quantity: { type: "number" }
            },
            required: ["label", "quantity"], additionalProperties: false
          }
        }
      },
      required: ["job_number"], additionalProperties: false
    }
  },
  {
    name: "draft_jha", tab: "jha",
    description: "Propose a hazard assessment (JHA) on an Active job: opens the JHA builder for that job with the template, work date, helper, site details and suggested hazards filled in. Hazards are suggestions only; the person ticks them. Nothing is filed until the person files it.",
    input_schema: {
      type: "object",
      properties: { job_number: { type: "string" }, ...JHA_FIELDS },
      required: ["job_number"], additionalProperties: false
    }
  }
];

export function toolsFor(tabs: readonly string[] | null | undefined, role?: string | null): AskTool[] {
  const held = new Set(tabs || []);
  return ASK_TOOLS.filter(t => held.has(t.tab) && (!t.roles || t.roles.includes(role || "")));
}

// The shape the Messages API takes: name, description, input_schema.
export function toolDefinitions(tools: AskTool[]): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  return tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown): string => typeof v === "string" ? v.trim() : "";
const day = (v: unknown): string | null => DAY.test(str(v)) ? str(v) : null;

export interface SearchArgs {
  status_filter: string; q: string; date_from: string | null; date_to: string | null; page_num: number; page_size: number;
}

// search_tickets' arguments as the RPC takes them, whatever the model sent.
export function searchArgs(input: Record<string, unknown>): SearchArgs {
  const status = str(input.status);
  const page = Number(input.page);
  const size = Number(input.page_size);
  return {
    status_filter: TRACKER_STATUSES.includes(status) ? status : "All",
    q: str(input.q),
    date_from: day(input.date_from),
    date_to: day(input.date_to),
    page_num: Number.isInteger(page) && page > 0 ? page : 0,
    page_size: Number.isInteger(size) && size > 0 ? Math.min(50, size) : 25
  };
}

// A line for the panel: what was read or drafted, in words, never the JSON.
export function traceLine(name: string, input: Record<string, unknown>): string {
  if (name === "tracker_stats") return "read the tracker's totals";
  if (name === "ticket_aging") return "read how old the money is, by client";
  if (name === "search_tickets") {
    const a = searchArgs(input);
    const bits = [a.status_filter];
    if (a.q) bits.push(`"${a.q}"`);
    if (a.date_from) bits.push(`from ${a.date_from}`);
    if (a.date_to) bits.push(`to ${a.date_to}`);
    if (a.page_num) bits.push(`page ${a.page_num + 1}`);
    return `searched tickets: ${bits.join(", ")}`;
  }
  if (name === "find_client") return `looked up client "${str(input.q)}"`;
  if (name === "find_job") return `looked up job "${str(input.q)}"`;
  if (name === "job_record") return `read job ${str(input.job_number)}'s record`;
  if (name === "draft_job") return `drafted a job for ${str(input.client_name)}`;
  if (name === "draft_ticket") return `drafted a ticket on ${str(input.job_number)}`;
  if (name === "draft_jha") return `drafted a JHA on ${str(input.job_number)}`;
  return `read ${name}`;
}
