// What Ask may read, and the tab each read sits behind. Definitions only:
// the function holds the runners, so this file has no imports and the
// node suite can hold the list against TABS. Erasable TypeScript, nothing
// read from the world (backupShared.test.mjs guards that).
//
// A tool is offered to the model only when the caller holds its tab, and
// every runner reads as the caller, so RLS would refuse anyway; the list
// keeps the model from trying and being told no.

export interface AskTool {
  name: string;
  tab: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export const TRACKER_STATUSES = ["All", "Draft", "Awaiting approval", "Approved", "Invoiced", "Over 7 days"];

const DATE = "a date as YYYY-MM-DD";

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
  }
];

export function toolsFor(tabs: readonly string[] | null | undefined): AskTool[] {
  const held = new Set(tabs || []);
  return ASK_TOOLS.filter(t => held.has(t.tab));
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

// A line for the panel: what was read, in words, never the JSON.
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
  return `read ${name}`;
}
