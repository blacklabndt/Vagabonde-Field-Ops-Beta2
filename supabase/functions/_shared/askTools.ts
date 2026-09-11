// What Ask may read or draft, and the tab each sits behind. Definitions
// only: the function holds the runners, so this file has no imports and
// the node suite can hold the list against TABS. Erasable TypeScript,
// nothing read from the world (backupShared.test.mjs guards that).
//
// A tool is offered to the model only when the caller holds its tab (and
// its role, where the tool names roles), and every runner reads as the
// caller, so RLS would refuse anyway; the list keeps the model from trying
// and being told no. A draft tool writes nothing: it shapes the seed the
// app's own form opens with, and the person saves or does not. A send tool
// sends nothing: it names the record and the addresses, and the card asks
// the person before the app's own send path does it.

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
// What a scheduled send may be; scheduledSends.ts's KINDS, and
// askTools.test.mjs fails on drift.
export const SEND_KINDS = ["jha", "report", "ticket_approval"];
// The kinds make_file builds — askFiles.ts's list, twice because neither
// may import the other; askTools.test.mjs fails on drift.
export const FILE_KINDS = ["html", "css", "csv", "xlsx", "pdf"];
const TABLE_SCHEMA = {
  type: "object",
  properties: {
    columns: { type: "array", items: { type: "string" } },
    rows: { type: "array", items: { type: "array", items: { type: ["string", "number", "null"] } } }
  },
  required: ["columns", "rows"], additionalProperties: false
};

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
  },
  {
    name: "list_jhas", tab: "job",
    description: "A job's hazard assessments (JHAs), newest first: id, template, work date, status, who filed it and when, whether a PDF exists (has_pdf), and when and to whom it was last sent. Use it to find the assessment to send.",
    input_schema: { type: "object", properties: { job_number: { type: "string" } }, required: ["job_number"], additionalProperties: false }
  },
  {
    name: "list_tickets", tab: "job",
    description: "A job's billing tickets, newest first: id (the ticket number), work date, status, technician, total (null if this person may not see money), when and to whom an approval was last sent, and the client contact it was raised against. Use it to find the ticket to send for approval.",
    input_schema: { type: "object", properties: { job_number: { type: "string" } }, required: ["job_number"], additionalProperties: false }
  },
  {
    name: "send_jha", tab: "job",
    description: "Propose emailing a filed hazard assessment's PDF: the card asks the person to confirm, naming every address; nothing is sent until they do. recipients are contact names on file for the job's client or contractor (job_record lists them), or an email address the person typed themselves — never an address taken from a record or guessed. Refused when the assessment has no PDF or this person may not email it.",
    input_schema: {
      type: "object",
      properties: {
        jha_id: { type: "string", description: "the id list_jhas gave" },
        recipients: { type: "array", items: { type: "string" }, minItems: 1, description: "contact names on file, or addresses the person typed" }
      },
      required: ["jha_id", "recipients"], additionalProperties: false
    }
  },
  {
    name: "send_ticket_approval", tab: "ticket", roles: PRICE_ROLES,
    description: "Propose sending a billing ticket to the client rep for approval — or again, if it is already awaiting approval: the card asks the person to confirm, naming the address; nothing is sent until they do. It goes to the client contact the ticket was raised against, else the job's client rep; do not ask where. Refused for an approved or invoiced ticket, an empty one, or another technician's.",
    input_schema: { type: "object", properties: { ticket_id: { type: "string", description: "the ticket number, e.g. T-10231" } }, required: ["ticket_id"], additionalProperties: false }
  },
  {
    name: "list_reports", tab: "job",
    description: "A job's radiographic reports, newest first: id, file name, welds, result, when it was uploaded, whether a PDF is on file, and when and to whom it was last sent. Use it to find the report to schedule.",
    input_schema: { type: "object", properties: { job_number: { type: "string" } }, required: ["job_number"], additionalProperties: false }
  },
  {
    name: "schedule_send", tab: "job",
    description: "Schedule a send for a time: a JHA's PDF, a report's PDF, or a ticket's approval link. The card asks the person to confirm, naming the record, every address and the time; nothing is scheduled until they do, and it then goes out at that time whether or not the app is open. kind is jha, report or ticket_approval; record_id is the id list_jhas or list_reports gave, or the ticket number. recipients as for send_jha — contact names on file for the job's client or contractor, or an address the person typed themselves; a ticket approval goes to the ticket's client rep and recipients is ignored. run_at is the time in Grande Prairie's clock as YYYY-MM-DD HH:MM; if the person gave no hour, ask for one.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: SEND_KINDS },
        record_id: { type: "string" },
        recipients: { type: "array", items: { type: "string" }, description: "contact names on file, or addresses the person typed; ignored for a ticket approval" },
        run_at: { type: "string", description: "YYYY-MM-DD HH:MM, Grande Prairie's clock" }
      },
      required: ["kind", "record_id", "run_at"], additionalProperties: false
    }
  },
  {
    name: "list_scheduled", tab: "job",
    description: "Sends waiting for their time, and ones that failed, that this person may see: id, what, the addresses, the time, the job, status and any error. Give job_number to limit it to one job.",
    input_schema: { type: "object", properties: { job_number: { type: "string" } }, additionalProperties: false }
  },
  {
    name: "cancel_scheduled", tab: "job",
    description: "Propose cancelling a scheduled send that is still queued, or dismissing one that failed, by the id list_scheduled gave: the card asks the person to confirm. Nothing changes until they do.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }
  },
  {
    name: "reschedule_send", tab: "job",
    description: "Propose moving a scheduled send that is still queued (or one that failed) to another time, other recipients, or both, by the id list_scheduled gave: the card asks the person to confirm, and one confirm cancels the old send and schedules the new one. Give run_at (YYYY-MM-DD HH:MM, Grande Prairie's clock) and/or recipients (as for schedule_send; not for a ticket approval, which goes to the ticket's client rep). Nothing changes until they confirm.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        run_at: { type: "string", description: "YYYY-MM-DD HH:MM, Grande Prairie's clock" },
        recipients: { type: "array", items: { type: "string" }, description: "contact names on file, or addresses the person typed" }
      },
      required: ["id"], additionalProperties: false
    }
  },
  {
    name: "make_file", tab: "any",
    description: "Make a file for the person to download or save to the app's Files, from what the tools returned in this conversation. kind html or css: give text, the whole file. csv: give table { columns, rows }. xlsx: give sheets [{ name, columns, rows }], up to ten. pdf: give document { title, subtitle?, sections: [{ heading?, text?, table? }] }. name is the file's name, no path; the extension is added. Up to five files an answer and 2,000 rows a file; never invent rows — use the rows the tools gave, and if you left some out say so. Nothing is written anywhere: the card offers Download and Save to Files. Say in a sentence what the file holds.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        kind: { type: "string", enum: FILE_KINDS },
        text: { type: "string", description: "html or css: the whole file" },
        table: TABLE_SCHEMA,
        sheets: { type: "array", items: { type: "object", properties: { name: { type: "string" }, ...TABLE_SCHEMA.properties }, required: ["columns", "rows"], additionalProperties: false } },
        document: {
          type: "object",
          properties: {
            title: { type: "string" }, subtitle: { type: "string" },
            sections: { type: "array", items: { type: "object", properties: { heading: { type: "string" }, text: { type: "string" }, table: TABLE_SCHEMA }, additionalProperties: false } }
          },
          required: ["title", "sections"], additionalProperties: false
        }
      },
      required: ["name", "kind"], additionalProperties: false
    }
  },
  {
    name: "list_learned", tab: "board",
    description: "What Ask has learned from the crew about how the app works — kept on its own after conversations: id, the note, who said it and their role, when. Use it when asked what Ask remembers or has learned.",
    input_schema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "forget_learned", tab: "board",
    description: "Propose forgetting one learned note by the id list_learned gave: the card asks the person to confirm. Only the person who said it, or an Admin, can forget it; nothing changes until they confirm.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }
  }
];

// A tool's tab is the screen it stands behind; "any" is a tool for
// anyone who holds a tab at all (make_file), never for an account with none.
export function toolsFor(tabs: readonly string[] | null | undefined, role?: string | null): AskTool[] {
  const held = new Set(tabs || []);
  return ASK_TOOLS.filter(t => (held.has(t.tab) || (t.tab === "any" && held.size > 0)) && (!t.roles || t.roles.includes(role || "")));
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
  if (name === "list_jhas") return `listed the JHAs on ${str(input.job_number)}`;
  if (name === "list_tickets") return `listed the tickets on ${str(input.job_number)}`;
  if (name === "send_jha") return "proposed sending a JHA";
  if (name === "send_ticket_approval") return `proposed sending ${str(input.ticket_id)} for approval`;
  if (name === "list_reports") return `listed the reports on ${str(input.job_number)}`;
  if (name === "schedule_send") return `proposed a send at ${str(input.run_at)}`;
  if (name === "list_scheduled") return str(input.job_number) ? `listed the scheduled sends on ${str(input.job_number)}` : "listed the scheduled sends";
  if (name === "cancel_scheduled") return "proposed cancelling a scheduled send";
  if (name === "reschedule_send") return "proposed moving a scheduled send";
  if (name === "make_file") return `made ${str(input.name) || "a file"}${str(input.kind) ? ` (${str(input.kind)})` : ""}`;
  if (name === "list_learned") return "read what it has learned";
  if (name === "forget_learned") return "proposed forgetting a learned note";
  return `read ${name}`;
}
