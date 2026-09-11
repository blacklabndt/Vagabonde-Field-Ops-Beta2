// Ask: a question in words, answered from what THIS caller may read — and,
// since the second slice, a draft: the app's own form proposed, filled in,
// for the person to save or not.
//
// The door is the caller's JWT (render-invoice's shape) and then the
// caller's own profile row for the tabs they hold and their role; the
// model is offered only the tools behind those (askTools.ts), and every
// tool runs through the caller's client, so RLS and the price rule decide
// what comes back — a Coordinator's question meets the same null money the
// Coordinator's tracker does. The service role is used for one read: the
// Anthropic key from app_settings (appSettings(), env fallback).
//
// Nothing here writes, and nothing here sends. A draft tool resolves the
// client or the job as the caller, shapes a seed (askDrafts.ts, pure) and
// puts an `action` on the response beside the answer; the card offers it,
// App opens the form, and the form's own save path — validation,
// idempotency key, offline queue — does what it always does. A send tool
// (third slice) reads the record as the caller, applies the gate the
// screen's function applies, resolves the recipients under askSends.ts's
// rule — a contact on file by name, or an address the person typed — and
// puts a send action on the response; the card asks the person, and App
// calls the same Db method Job detail's button calls. One action per
// answer: a later call replaces an earlier one.
//
// The loop itself is _shared/askLoop.ts, pure and node-tested; this file
// is the door, the runners and the log line.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { appSettings, corsHeaders } from "../_shared/mail.ts";
import { toolsFor, toolDefinitions, traceLine, searchArgs, JHA_TEMPLATES, HAZARD_NAMES, PRICE_ROLES, EQUIPMENT_FILTERS, OPEN_KINDS } from "../_shared/askTools.ts";
import { ticketCheck } from "../_shared/ticketCheck.ts";
import { attentionItems, type BackupState, type ErrorRow } from "../_shared/attention.ts";
import { planChase, chaseWords } from "../_shared/chasePlan.ts";
import { emailIn } from "../_shared/emailIn.ts";
import { dayCheck, type DayJob } from "../_shared/dayCheck.ts";
import { todayIn, isDay, payPeriodFor, quarterFor, periodFrom, periodWords, sumHours, type CrewRow } from "../_shared/hoursDose.ts";
import { shapeJobDraft, shapeTicketDraft, shapeJhaDraft } from "../_shared/askDrafts.ts";
import { resolveRecipients, jhaSendGate, ticketSendGate, ticketApprovalAddress, jhaFileName, sendJhaWords, sendTicketWords, JHA_MESSAGE, REPORT_MESSAGE } from "../_shared/askSends.ts";
import { isKind, localToUtc, checkRunAt, whenWords, labelFor, scheduleWords, cancelWords, rescheduleWords, splitList, reminderText, reminderWords, REPORT_SEND_ROLES } from "../_shared/scheduledSends.ts";
import { askLoop, systemPrompt, windowTurns, API_URL, API_VERSION } from "../_shared/askLoop.ts";
import { learnPrompt, parseLearned, roomFor, learnedLines, forgetWords, LEARN_MODEL, LEARN_MAX_TOKENS, MAX_LEARNED, type LearnedRow } from "../_shared/askLearn.ts";
import { knowledgeText, cleanContext, whereLines } from "../_shared/askKnowledge.ts";
import { checkFile, fileWords, fileChars, MAX_FILES, type AskFile } from "../_shared/askFiles.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

interface Me { name: string | null; role: string | null; tab_access: string[] | null; deactivated_at: string | null }
// What the learning pass kept, and what it could not. `trouble` is words for
// the card: the answer is never failed for a note, but a note the database
// refused must not look like one that landed.
interface LearnResult { added: { id: string; note: string }[]; trouble: string | null }
interface OrgHit { org_id: string; name: string; contact_count: number }
interface JobRow {
  id: string; job_number: string; project: string | null; client_name: string | null; contractor_name: string | null;
  lsd: string | null; afe: string | null; status: string | null;
}
interface JobRecordRow {
  id: string; job_number: string; project: string | null; lsd: string | null; afe: string | null; status: string | null;
  client_id: string | null; contractor_id: string | null; client_contact_id: string | null; contractor_contact_id: string | null;
  clients: { name: string } | null; contractors: { name: string } | null;
}
interface ContactRow { id: string; org_type: string; org_id: string; name: string; email: string | null; phone: string | null; is_primary: boolean }
interface ActiveJob { id: string; job_number: string; project: string | null; status: string | null; clients: { name: string } | null }
interface JhaListRow {
  id: string; template: string | null; work_date: string | null; status: string | null; signed_at: string | null;
  pdf_key: string | null; sent_at: string | null; sent_to: string | null; profiles: { name: string | null } | null;
}
interface TicketListRow {
  id: string; work_date: string | null; status: string | null; total: number | string | null; technician_id: string | null;
  approval_sent_at: string | null; approval_sent_to: string | null; client_contact: { name?: string | null } | null;
  profiles: { name: string | null } | null;
}
interface JhaSendRow {
  id: string; job_id: string; signed_by: string | null; pdf_key: string | null; template: string | null; work_date: string | null;
  sent_at: string | null; jobs: { id: string; job_number: string; client_id: string | null; contractor_id: string | null } | null;
}
interface TicketSendRow {
  id: string; status: string | null; total: number | string | null; technician_id: string | null; client_contact: { name?: string | null } | null;
  jobs: { id: string; job_number: string; client_id: string | null; client_contact_id: string | null } | null;
}
interface ReportListRow {
  id: string; filename: string | null; welds: string | null; result: string | null; uploaded_at: string | null;
  pdf_key: string | null; sent_at: string | null; sent_to: string | null;
}
interface ReportSendRow {
  id: string; job_id: string; filename: string | null; pdf_key: string | null;
  jobs: { id: string; job_number: string; client_id: string | null; contractor_id: string | null } | null;
}
interface ScheduledRow {
  id: string; kind: string; label: string; to_list: string; run_at: string; status: string; error: string | null;
  job_id: string; jobs: { job_number: string } | null;
}
interface RescheduleRow {
  id: string; kind: string; record_id: string; label: string; to_list: string; message: string; run_at: string; status: string;
  jobs: { id: string; job_number: string } | null;
}
interface UnsignedRow {
  id: string; client_contact: { name?: string | null } | null; chased_at: string | null; queried_at: string | null;
  approval_sent_at: string | null; work_date: string | null; jobs: { job_number: string; clients: { name: string } | null } | null;
}
interface DirHit { org_type: string; org_id: string; name: string; contact_count: number }
interface PersonRow { id: string; name: string | null; first_name: string | null; last_name: string | null }
interface DirContactRow { id: string; org_type: string; org_id: string; name: string; title: string | null; email: string | null; phone: string | null; is_primary: boolean }
interface DayJhaRow { id: string; job_id: string; sent_at: string | null }
interface DayTicketRow { id: string; job_id: string; status: string | null; approval_sent_at: string | null }
interface DayReportRow { id: string; job_id: string; sent_at: string | null }
interface HoursRow {
  id: string;
  straight_hours: unknown; ot_hours: unknown; solo_hours: unknown; solo_ot_hours: unknown; mileage_km: unknown;
  tickets: { work_date: string; jobs: { job_number: string } | null } | null;
}
// What my_hours will read before it stops and says so. The period is
// whatever was asked for — "my hours since 2020" is a question somebody
// will ask — and walking a whole career inside one invocation is how a
// function times out with nothing to show.
//
// TWO budgets, because either one alone is unbounded in the other's
// direction. Rows alone: a gateway capping pages at one hands back 25,000
// single-row requests, and the invocation dies long before it can say it
// was partial — the warning is the whole point of stopping, so a stop
// nobody hears is not a stop. Requests alone: a page of ten thousand would
// blow the row budget by a factor of ten. Whichever is reached first ends
// the walk, and both end it the same way.
//
// 25,000 crew rows is years of a busy technician's work; 40 requests is
// more than the row budget needs at a full page (25) and few enough that a
// server handing back short pages runs out of TURNS rather than out of
// time. It bounds the number of round trips and nothing else — a slow
// server can still spend the invocation inside forty of them, and no
// count here is a promise about the clock.
const HOURS_PAGE_ROWS = 1000;
const HOURS_MAX_ROWS = 25000;
const HOURS_MAX_REQUESTS = 40;
interface DoseRow { profile_id: string; name: string | null; days: number | string; total_mr: number | string; q1: number | string; q2: number | string; q3: number | string; q4: number | string }
interface EquipmentRow {
  id: string; type: string; serial_number: string | null; calibration_due: string | null; status: string; assigned_name: string | null; total_count: number | string;
}
interface OpenTicketRow { id: string; status: string | null; technician_id: string | null; jobs: { id: string; job_number: string } | null }
interface OpenRecordRow { id: string; jobs: { id: string; job_number: string } | null }
interface CheckTicketRow {
  id: string; status: string | null; technician_id: string | null; work_date: string | null; approved_at?: string | null;
  client_contact: { name?: string | null } | null; jobs: { id: string; job_number: string } | null;
}
interface CheckLineRow { kind: string; label: string; unit: string | null; quantity: unknown; unit_rate: unknown }
interface CheckCrewRow { straight_hours: unknown; ot_hours: unknown; solo_hours: unknown; solo_ot_hours: unknown; profiles: { name: string | null } | null }
interface ScheduleRow { id: string; follows_default: boolean | null; published_at: string | null }
interface RateLineRow { kind: string; label: string; unit: string | null; rate: number | string }
const RT_WORDS: Record<string, string> = { rt_film: "film", rt_cr: "CR", rt_dr: "DR", custom_weld: "per weld" };
// Home's strip reads this many of the newest errors (home.jsx's ERROR_SCAN).
const ERROR_SCAN = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Unsigned tickets a chase reads at most — the tracker walks every page;
// Ask reads one and says when there were more.
const CHASE_READ_CAP = 1000;
// A short text from the model, cut to size.
const given = (v: unknown, max = 200): string => String(v ?? "").trim().slice(0, max);
// Words safe inside a PostgREST or() filter: the characters it reads as
// syntax, and LIKE's own wildcards, become spaces.
const likeSafe = (v: string): string => v.replace(/[%_,()\\]/g, " ").replace(/\s+/g, " ").trim();
const later = (a: string | null, b: string | null): string | null => (!a ? (b || null) : !b ? a : (Date.parse(a) >= Date.parse(b) ? a : b));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  let userId = "";
  let tool = "";
  try {
    const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "Not signed in" }, 401);
    userId = user.id;

    const { data: profile, error: pErr } = await asUser.from("profiles")
      .select("name, role, tab_access, deactivated_at").eq("id", user.id).maybeSingle();
    if (pErr) throw new Error(pErr.message);
    const me = profile as Me | null;
    if (!me || me.deactivated_at) return json({ error: "This account is locked" }, 403);

    const tools = toolsFor(me.tab_access, me.role);
    if (!tools.length) return json({ answer: "Ask can't reach anything on the tabs you hold yet.", trace: [] });

    const body = (await req.json().catch(() => null)) as { thread?: unknown; context?: unknown } | null;
    const thread = body?.thread;
    if (!Array.isArray(thread) || !thread.length) return json({ error: "Ask needs a question" }, 400);
    // Where the person is — the screen, the open job and ticket, the
    // screen's own help — checked and cut to size like the thread; it
    // answers "this job" and "what is this screen for" without a question back.
    const where = whereLines(cleanContext(body?.context));
    // What the crew has taught Ask about the app, read as the caller (every
    // staff account may): into the prompt after the built-in knowledge,
    // graded by the speaker's role as it is now.
    // NEWEST first, then reversed for the prompt, so the window holds the
    // most recent notes and not the oldest: an oldest-first read hands the
    // whole window to whoever wrote earliest, and a caller who could stamp
    // `created_at` — which they could, until the grant was narrowed — owned
    // it outright. `id` breaks the tie because `created_at` alone does not:
    // notes written in one pass share an instant to the microsecond, which
    // is true of every row in the live table today.
    const { data: learnedData, error: learnedErr } = await asUser.from("ask_learned")
      .select("id, note, created_at, profiles(name, role)")
      .order("created_at", { ascending: false }).order("id", { ascending: false })
      .limit(MAX_LEARNED);
    if (learnedErr) throw new Error(learnedErr.message);
    const learnedRows = ((learnedData ?? []) as unknown as LearnedRow[]).reverse();

    const key = (await appSettings()).anthropicApiKey;
    if (!key) return json({ error: "Ask isn't set up yet — an Admin can add the Anthropic key on the Admin screen." }, 400);

    // ── Reads, all as the caller ─────────────────────────────────────────
    const findClients = async (q: string): Promise<OrgHit[]> => {
      const { data, error } = await asUser.rpc("search_org_directory", { q, scope: "Clients", page_num: 0, page_size: 10 });
      if (error) throw new Error(error.message);
      return (data ?? []) as OrgHit[];
    };
    // A draft needs one client: an exact name first, else the one hit, else
    // the model is told what to ask.
    const resolveClient = async (name: string) => {
      if (!name) throw new Error("Which client? Ask the person.");
      const hits = (await findClients(name)).map(r => ({ id: r.org_id, name: r.name }));
      const exact = hits.filter(h => h.name.toLowerCase() === name.toLowerCase());
      if (exact.length === 1) return exact[0];
      if (hits.length === 1) return hits[0];
      if (!hits.length) throw new Error(`No client called "${name}" is in the directory. Ask the person which client it is; a new client is added on Home's New job form.`);
      throw new Error(`More than one client matches "${name}": ${hits.map(h => h.name).join(", ")}. Ask the person which.`);
    };
    // A job by number; a draft wants an Active one, a listing any.
    const jobNumbered = async (number: string, activeOnly: boolean) => {
      if (!number) throw new Error("Which job? Ask the person for the job number.");
      const { data, error } = await asUser.from("jobs").select("id, job_number, project, status, clients(name)").eq("job_number", number).maybeSingle();
      if (error) throw new Error(error.message);
      const j = data as unknown as ActiveJob | null;
      if (!j) throw new Error(`No job numbered ${number}. Use find_job to look it up.`);
      if (activeOnly && j.status === "Complete") throw new Error(`Job ${number} is complete; nothing new can be raised on it.`);
      return { id: j.id, job_number: j.job_number, project: j.project, client_name: j.clients?.name ?? null, status: j.status };
    };
    const activeJob = (number: string) => jobNumbered(number, true);
    // An organisation of either kind, the way a client is resolved: an
    // exact name, else the one hit, else the model is told what to ask.
    const findOrgs = async (q: string, scope = "All"): Promise<DirHit[]> => {
      const { data, error } = await asUser.rpc("search_org_directory", { q, scope, page_num: 0, page_size: 10 });
      if (error) throw new Error(error.message);
      return (data ?? []) as DirHit[];
    };
    const resolveOrg = async (name: string) => {
      if (!name) throw new Error("Which organisation? Ask the person.");
      const hits = (await findOrgs(name)).map(r => ({ type: r.org_type, id: r.org_id, name: r.name }));
      const exact = hits.filter(h => h.name.toLowerCase() === name.toLowerCase());
      if (exact.length === 1) return exact[0];
      if (hits.length === 1) return hits[0];
      if (!hits.length) throw new Error(`No client or contractor called "${name}" is in the directory. Ask the person which it is, or propose it with draft_organisation.`);
      throw new Error(`More than one organisation matches "${name}": ${hits.map(h => `${h.name} (${h.type})`).join(", ")}. Ask the person which.`);
    };
    // Another crew member by name — an Admin's question alone, checked by
    // the caller; the read is the profiles list every staff account has.
    const findPerson = async (name: string) => {
      const pat = likeSafe(name);
      if (!pat) throw new Error("Which person? Ask for a name.");
      const { data, error } = await asUser.from("profiles").select("id, name, first_name, last_name")
        .is("deactivated_at", null)
        .or(`name.ilike.%${pat}%,first_name.ilike.%${pat}%,last_name.ilike.%${pat}%`).order("name").limit(10);
      if (error) throw new Error(error.message);
      const hits = ((data ?? []) as PersonRow[]).map(p => ({ id: p.id, name: p.name || [p.first_name, p.last_name].filter(Boolean).join(" ") || "(no name)" }));
      const exact = hits.filter(h => h.name.toLowerCase() === name.toLowerCase());
      if (exact.length === 1) return exact[0];
      if (hits.length === 1) return hits[0];
      if (!hits.length) throw new Error(`Nobody on the crew is called "${name}". Ask the person who they mean.`);
      throw new Error(`More than one person matches "${name}": ${hits.map(h => h.name).join(", ")}. Ask which.`);
    };
    // Whose hours or dose: the caller's own, or — for an Admin — a named person's.
    const whose = async (person: unknown) => {
      const name = given(person);
      if (!name) return { id: user.id, name: me.name || "you", own: true };
      if (me.role !== "Admin") throw new Error("Only an Admin can ask about someone else's hours or dose — this person may ask about their own.");
      return { ...(await findPerson(name)), own: false };
    };
    // The contacts on file for these organisations, primary first.
    const contactsFor = async (orgIds: (string | null)[]): Promise<ContactRow[]> => {
      const orgs = orgIds.filter((x): x is string => !!x);
      if (!orgs.length) return [];
      const { data, error } = await asUser.from("contacts")
        .select("id, org_type, org_id, name, email, phone, is_primary").in("org_id", orgs)
        .order("is_primary", { ascending: false }).order("name");
      if (error) throw new Error(error.message);
      return (data ?? []) as ContactRow[];
    };
    const jobRecord = async (number: string) => {
      if (!number) throw new Error("Which job? Ask the person for the job number.");
      const { data, error } = await asUser.from("jobs")
        .select("id, job_number, project, lsd, afe, status, client_id, contractor_id, client_contact_id, contractor_contact_id, clients(name), contractors(name)")
        .eq("job_number", number).maybeSingle();
      if (error) throw new Error(error.message);
      const j = data as unknown as JobRecordRow | null;
      if (!j) throw new Error(`No job numbered ${number}.`);
      const list = await contactsFor([j.client_id, j.contractor_id]);
      const named = (id: string | null) => list.find(c => c.id === id) ?? null;
      return {
        job: {
          id: j.id, job_number: j.job_number, project: j.project, lsd: j.lsd, afe: j.afe, status: j.status,
          client: j.clients?.name ?? null, contractor: j.contractors?.name ?? null
        },
        client_rep: named(j.client_contact_id) ?? list.find(c => c.org_type === "client" && c.is_primary) ?? null,
        contractor_rep: named(j.contractor_contact_id) ?? list.find(c => c.org_type === "contractor" && c.is_primary) ?? null,
        contacts: { client: list.filter(c => c.org_type === "client"), contractor: list.filter(c => c.org_type === "contractor") }
      };
    };

    // A record read as the caller, gated as the screen's function gates it,
    // with its recipients resolved — for a send now and for a scheduled one.
    // Recipients null: the caller keeps addresses it already holds (a
    // reschedule that moves only the time), and nothing is resolved.
    const jhaForSend = async (jhaId: string, recipients: unknown) => {
      const { data, error } = await asUser.from("jhas")
        .select("id, job_id, signed_by, pdf_key, template, work_date, sent_at, jobs(id, job_number, client_id, contractor_id)")
        .eq("id", jhaId).maybeSingle();
      if (error) throw new Error(error.message);
      const row = data as unknown as JhaSendRow | null;
      if (!row || !row.jobs) throw new Error("No assessment with that id — use list_jhas to find it.");
      jhaSendGate(row, who);
      const to = recipients === null ? [] : resolveRecipients(recipients, await contactsFor([row.jobs.client_id, row.jobs.contractor_id]), saidByPerson());
      return { row, job: { id: row.jobs.id, job_number: row.jobs.job_number }, to };
    };
    const reportForSend = async (reportId: string, recipients: unknown) => {
      const { data, error } = await asUser.from("reports")
        .select("id, job_id, filename, pdf_key, jobs(id, job_number, client_id, contractor_id)")
        .eq("id", reportId).maybeSingle();
      if (error) throw new Error(error.message);
      const row = data as unknown as ReportSendRow | null;
      if (!row || !row.jobs) throw new Error("No report with that id — use list_reports to find it.");
      // send-report's gate.
      if (!row.pdf_key) throw new Error("This report has no PDF on file — upload it first.");
      if (!REPORT_SEND_ROLES.includes(who.role)) throw new Error("Only a Technician, Coordinator or Admin can email a report.");
      const to = recipients === null ? [] : resolveRecipients(recipients, await contactsFor([row.jobs.client_id, row.jobs.contractor_id]), saidByPerson());
      return { row, job: { id: row.jobs.id, job_number: row.jobs.job_number }, to };
    };
    const ticketForSend = async (ticketId: string) => {
      const { data, error } = await asUser.from("tickets")
        .select("id, status, total, technician_id, client_contact, jobs(id, job_number, client_id, client_contact_id)")
        .eq("id", ticketId.trim().toUpperCase()).maybeSingle();
      if (error) throw new Error(error.message);
      const row = data as unknown as TicketSendRow | null;
      if (!row || !row.jobs) throw new Error("No ticket with that number — use list_tickets to find it.");
      ticketSendGate(row, who);
      // The job's current client rep, the way the job record names one.
      const people = await contactsFor([row.jobs.client_id]);
      const rep = people.find(c => c.id === row.jobs?.client_contact_id) ?? people.find(c => c.org_type === "client" && c.is_primary) ?? null;
      const to = [ticketApprovalAddress(row.client_contact?.name, rep?.email)];
      return { row, job: { id: row.jobs.id, job_number: row.jobs.job_number }, to };
    };

    // The form a draft proposes, or the send a send tool proposes, if one
    // did; the last call wins.
    let action: Record<string, unknown> | null = null;
    // The files make_file proposed this answer — checked shapes only; the
    // device builds the bytes and nothing is written here.
    const files: AskFile[] = [];
    // The person's own words, for the one place an address may come from
    // that is not a contact on file. Computed once, and lazily: most
    // questions never send.
    let said: string | null = null;
    const saidByPerson = () => {
      if (said === null) said = windowTurns(thread).filter(t => t.role === "user").map(t => t.text).join("\n");
      return said;
    };
    const seesMoney = PRICE_ROLES.includes(me.role ?? "");
    const who = { id: user.id, role: me.role ?? "" };

    const runTool = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
      tool = name;
      let out: unknown;
      if (name === "tracker_stats" || name === "ticket_aging" || name === "search_tickets") {
        const call = name === "tracker_stats" ? asUser.rpc("ticket_tracker_stats")
          : name === "ticket_aging" ? asUser.rpc("ticket_aging")
          : asUser.rpc("search_tickets", searchArgs(input));
        const { data, error } = await call;
        if (error) throw new Error(error.message);
        out = data;
      } else if (name === "find_client") {
        out = (await findClients(String(input.q ?? ""))).map(r => ({ id: r.org_id, name: r.name, contact_count: r.contact_count }));
      } else if (name === "find_job") {
        const { data, error } = await asUser.rpc("search_jobs", { q: String(input.q ?? ""), status_filter: "All", search_field: "any", page_num: 0, page_size: 10 });
        if (error) throw new Error(error.message);
        out = ((data ?? []) as JobRow[]).map(j => ({
          id: j.id, job_number: j.job_number, project: j.project, client_name: j.client_name, contractor_name: j.contractor_name,
          lsd: j.lsd, afe: j.afe, status: j.status
        }));
      } else if (name === "job_record") {
        out = await jobRecord(String(input.job_number ?? ""));
      } else if (name === "draft_job") {
        const client = await resolveClient(String(input.client_name ?? ""));
        const d = shapeJobDraft(input, client);
        const thenIn = input.then_jha && typeof input.then_jha === "object" ? input.then_jha as Record<string, unknown> : null;
        const then = thenIn ? shapeJhaDraft(thenIn, { id: "", job_number: "the new job" }, JHA_TEMPLATES, HAZARD_NAMES) : null;
        action = {
          kind: "draft_job", summary: d.summary, seed: d.seed,
          ...(then ? { next: { kind: "draft_jha", summary: then.summary, seed: then.seed } } : {})
        };
        out = { ready: true, summary: d.summary, next: then ? then.summary : null };
      } else if (name === "draft_ticket" || name === "draft_jha") {
        const job = await activeJob(String(input.job_number ?? ""));
        const d = name === "draft_ticket" ? shapeTicketDraft(input, job) : shapeJhaDraft(input, job, JHA_TEMPLATES, HAZARD_NAMES);
        action = { kind: name, summary: d.summary, seed: d.seed, job: { id: job.id, job_number: job.job_number } };
        out = { ready: true, summary: d.summary };
      } else if (name === "list_jhas") {
        const job = await jobNumbered(String(input.job_number ?? ""), false);
        const { data, error } = await asUser.from("jhas")
          .select("id, template, work_date, status, signed_at, pdf_key, sent_at, sent_to, profiles(name)")
          .eq("job_id", job.id).order("signed_at", { ascending: false }).limit(50);
        if (error) throw new Error(error.message);
        out = ((data ?? []) as unknown as JhaListRow[]).map(r => ({
          id: r.id, template: r.template, work_date: r.work_date, status: r.status,
          filed_by: r.profiles?.name ?? null, filed_at: r.signed_at, has_pdf: !!r.pdf_key, sent_at: r.sent_at, sent_to: r.sent_to
        }));
      } else if (name === "list_tickets") {
        const job = await jobNumbered(String(input.job_number ?? ""), false);
        const { data, error } = await asUser.from("tickets")
          .select("id, work_date, status, total, technician_id, approval_sent_at, approval_sent_to, client_contact, profiles(name)")
          .eq("job_id", job.id).order("created_at", { ascending: false }).limit(50);
        if (error) throw new Error(error.message);
        out = ((data ?? []) as unknown as TicketListRow[]).map(r => ({
          id: r.id, work_date: r.work_date, status: r.status, technician: r.profiles?.name ?? null,
          total: seesMoney && r.total !== null ? Number(r.total) : null,
          approval_sent_at: r.approval_sent_at, approval_sent_to: r.approval_sent_to, client_contact: r.client_contact?.name ?? null
        }));
      } else if (name === "send_jha") {
        const { row, job, to } = await jhaForSend(String(input.jha_id ?? ""), input.recipients);
        const words = sendJhaWords(row, job, to);
        action = {
          kind: "send_jha", summary: words.summary, done: words.done, to, message: JHA_MESSAGE,
          jha: { id: row.id, file: jhaFileName(row.pdf_key, row.template) }, job
        };
        out = { ready: true, summary: words.summary, to };
      } else if (name === "send_ticket_approval") {
        const { row, job, to } = await ticketForSend(String(input.ticket_id ?? ""));
        const words = sendTicketWords(row, job, to);
        action = {
          kind: "send_ticket_approval", summary: words.summary, done: words.done, to, ticket: { id: row.id }, job,
          // A resend is a chase; App stamps chased_at the way the tracker does.
          resend: row.status === "Awaiting approval"
        };
        out = { ready: true, summary: words.summary, to };
      } else if (name === "list_reports") {
        const job = await jobNumbered(String(input.job_number ?? ""), false);
        const { data, error } = await asUser.from("reports")
          .select("id, filename, welds, result, uploaded_at, pdf_key, sent_at, sent_to")
          .eq("job_id", job.id).order("uploaded_at", { ascending: false }).limit(50);
        if (error) throw new Error(error.message);
        out = ((data ?? []) as ReportListRow[]).map(r => ({
          id: r.id, file: r.filename, welds: r.welds, result: r.result, uploaded_at: r.uploaded_at,
          has_pdf: !!r.pdf_key, sent_at: r.sent_at, sent_to: r.sent_to
        }));
      } else if (name === "schedule_send") {
        // The same gate and the same recipients a send now would have, plus
        // the time; the row is inserted by App through RLS once the person
        // presses Schedule, and gated again when it fires.
        const kind = input.kind;
        if (!isKind(kind) || kind === "reminder") throw new Error("kind must be jha, report or ticket_approval; a reminder is set_reminder's.");
        const runAt = localToUtc(input.run_at);
        checkRunAt(runAt, Date.now());
        const recordId = String(input.record_id ?? "").trim();
        let job: { id: string; job_number: string };
        let label: string;
        let to: string[];
        let message = "";
        if (kind === "jha") {
          const found = await jhaForSend(recordId, input.recipients);
          job = found.job; to = found.to; label = labelFor("jha", found.row); message = JHA_MESSAGE;
        } else if (kind === "report") {
          const found = await reportForSend(recordId, input.recipients);
          job = found.job; to = found.to; label = labelFor("report", found.row); message = REPORT_MESSAGE;
        } else {
          if (!seesMoney) throw new Error("Only an Admin or a Technician can send a ticket for approval from here.");
          const found = await ticketForSend(recordId);
          job = found.job; to = found.to; label = labelFor("ticket_approval", found.row);
        }
        const words = scheduleWords(kind, label, job, to, runAt);
        action = {
          kind: "schedule_send", summary: words.summary, done: words.done, to, send_kind: kind,
          record_id: kind === "ticket_approval" ? recordId.trim().toUpperCase() : recordId, label, message,
          run_at: new Date(runAt).toISOString(), job
        };
        out = { ready: true, summary: words.summary, to, run_at: new Date(runAt).toISOString() };
      } else if (name === "list_scheduled") {
        const query = asUser.from("scheduled_sends")
          .select("id, kind, label, to_list, run_at, status, error, job_id, jobs(job_number)")
          .in("status", ["queued", "failed"]).order("run_at").limit(50);
        const number = String(input.job_number ?? "").trim();
        if (number) query.eq("job_id", (await jobNumbered(number, false)).id);
        const { data, error } = await query;
        if (error) throw new Error(error.message);
        out = ((data ?? []) as unknown as ScheduledRow[]).map(r => ({
          id: r.id, kind: r.kind, label: r.label, to: r.to_list, run_at: r.run_at, when: whenWords(Date.parse(r.run_at)),
          status: r.status, error: r.error, job_number: r.jobs?.job_number ?? null
        }));
      } else if (name === "cancel_scheduled") {
        const { data, error } = await asUser.from("scheduled_sends")
          .select("id, kind, label, run_at, status").eq("id", String(input.id ?? "").trim()).maybeSingle();
        if (error) throw new Error(error.message);
        const row = data as { id: string; kind: string; label: string; run_at: string; status: string } | null;
        if (!row) throw new Error("No scheduled send with that id — use list_scheduled to find it.");
        if (row.status !== "queued" && row.status !== "failed") throw new Error(`That send is already ${row.status}; there is nothing to cancel.`);
        const words = cancelWords(row.label, Date.parse(row.run_at), row.kind);
        action = { kind: "cancel_scheduled", summary: words.summary, done: words.done, id: row.id };
        out = { ready: true, summary: words.summary };
      } else if (name === "make_file") {
        if (files.length >= MAX_FILES) throw new Error(`Five files is the most in one answer.`);
        const file = checkFile(input);
        files.push(file);
        out = { ready: true, file: fileWords(file), approx_chars: fileChars(file), note: "The card offers Download and Save to Files; nothing more to do." };
      } else if (name === "list_learned") {
        out = learnedRows.map(r => ({
          id: r.id, note: r.note, said_by: r.profiles?.name ?? "(account removed)", role: r.profiles?.role ?? null, when: r.created_at
        }));
      } else if (name === "forget_learned") {
        const id = String(input.id ?? "").trim();
        const row = learnedRows.find(r => r.id === id);
        if (!row) throw new Error("No learned note with that id — use list_learned to find it.");
        const words = forgetWords(row.note);
        action = { kind: "forget_learned", summary: words.summary, done: words.done, id: row.id };
        out = { ready: true, summary: words.summary };
      } else if (name === "reschedule_send") {
        // The row as the caller may read it (own, or the office), then the
        // record again through the helper schedule_send uses — the screen's
        // gate applied again — and the parts that change. One confirm on
        // the card cancels the old row and inserts the new one, in App.
        const { data, error } = await asUser.from("scheduled_sends")
          .select("id, kind, record_id, label, to_list, message, run_at, status, jobs(id, job_number)")
          .eq("id", String(input.id ?? "").trim()).maybeSingle();
        if (error) throw new Error(error.message);
        const row = data as unknown as RescheduleRow | null;
        if (!row) throw new Error("No scheduled send with that id — use list_scheduled to find it.");
        if (row.kind === "reminder") throw new Error("A reminder cannot be moved — cancel it (cancel_scheduled) and set a new one (set_reminder).");
        if (!row.jobs) throw new Error("No scheduled send with that id — use list_scheduled to find it.");
        if (row.status !== "queued" && row.status !== "failed") throw new Error(`That send is already ${row.status}; there is nothing to move.`);
        if (!isKind(row.kind)) throw new Error(`Nothing sends a "${row.kind}".`);
        const wantsTime = String(input.run_at ?? "").trim() !== "";
        const wantsTo = Array.isArray(input.recipients) && input.recipients.length > 0;
        if (!wantsTime && !wantsTo) throw new Error("Give a new time, new recipients, or both — nothing was changed.");
        if (wantsTo && row.kind === "ticket_approval") throw new Error("A ticket approval goes to the ticket's client rep; only its time can be moved.");
        const oldRunAt = Date.parse(row.run_at);
        const runAt = wantsTime ? localToUtc(input.run_at) : oldRunAt;
        // The EFFECTIVE time, new or kept: moving yesterday's failed send to
        // another address keeps yesterday's time, which the insert policy
        // refuses — and App cancels the old row before it inserts, so the
        // refusal would land after the only copy was gone.
        checkRunAt(runAt, Date.now());
        let to: string[];
        if (row.kind === "jha") to = (await jhaForSend(row.record_id, wantsTo ? input.recipients : null)).to;
        else if (row.kind === "report") to = (await reportForSend(row.record_id, wantsTo ? input.recipients : null)).to;
        else {
          if (!seesMoney) throw new Error("Only an Admin or a Technician can send a ticket for approval from here.");
          await ticketForSend(row.record_id);
          to = [];
        }
        if (!wantsTo) to = splitList(row.to_list);
        if (!wantsTo && runAt === oldRunAt) throw new Error(`That send is already set for ${whenWords(oldRunAt)} — nothing was changed.`);
        const job = { id: row.jobs.id, job_number: row.jobs.job_number };
        const words = rescheduleWords(row.kind, row.label, job, to, oldRunAt, runAt, wantsTo);
        action = {
          kind: "reschedule_send", summary: words.summary, done: words.done, id: row.id, to, send_kind: row.kind,
          record_id: row.record_id, label: row.label, message: row.message, run_at: new Date(runAt).toISOString(), job
        };
        out = { ready: true, summary: words.summary, to, run_at: new Date(runAt).toISOString() };
      } else if (name === "chase_unsigned") {
        // The tracker's read (listUnsignedTicketContacts' select) as the
        // caller, narrowed as asked, its plan (chasePlan.ts, the tracker's
        // twin) and its words; the card's Chase runs the tracker's own
        // pool in App, one send and one chased stamp per ticket.
        const clientQ = given(input.client);
        const daysRaw = Number(input.older_than_days);
        const older = Number.isInteger(daysRaw) && daysRaw > 0 ? daysRaw : 0;
        const { data, error } = await asUser.from("tickets")
          .select("id, client_contact, chased_at, queried_at, approval_sent_at, work_date, jobs(job_number, clients(name))")
          .eq("status", "Awaiting approval").order("id").limit(CHASE_READ_CAP);
        if (error) throw new Error(error.message);
        const all = (data ?? []) as unknown as UnsignedRow[];
        // Older than N days: a work date before today less N, in Grande
        // Prairie's calendar — the tracker's own way of counting an age.
        const cutoff = older ? todayIn(Date.now() - older * 86_400_000) : "";
        const rows = all
          .filter(r => !clientQ || (r.jobs?.clients?.name ?? "").toLowerCase().includes(clientQ.toLowerCase()))
          .filter(r => !older || ((r.work_date ?? "") !== "" && (r.work_date ?? "") < cutoff));
        const plan = planChase(rows.map(r => ({
          id: r.id, contactLabel: r.client_contact?.name ?? "",
          chasedAt: later(r.chased_at, r.approval_sent_at), queriedAt: r.queried_at
        })), { emailIn });
        const scope = `${clientQ ? ` for ${clientQ}` : ""}${older ? ` older than ${older} days` : ""}`;
        const words = chaseWords(plan, scope);
        action = { kind: "chase", summary: words.summary, done: words.done, tickets: plan.due, skipped: words.skipped };
        out = {
          ready: true, summary: words.summary, due: plan.due.map(d => d.id), queried: plan.queried, recent: plan.recent, no_email: plan.noEmail,
          ...(all.length >= CHASE_READ_CAP ? { note: `Only the first ${CHASE_READ_CAP} unsigned tickets were read; the tracker's Chase all unsigned reads every one.` } : {})
        };
      } else if (name === "draft_contact") {
        const org = await resolveOrg(given(input.organisation));
        const seed = { name: given(input.name), title: given(input.title), email: given(input.email), phone: given(input.phone), notes: given(input.notes, 1000) };
        if (!seed.name) throw new Error("A contact needs a name. Ask the person.");
        const summary = `Add ${seed.name}${seed.title ? ` (${seed.title})` : ""} to ${org.name}'s contacts${seed.email ? `, ${seed.email}` : ""}${seed.phone ? `, ${seed.phone}` : ""}? The Contacts screen's form opens filled in for you to save.`;
        action = { kind: "draft_contact", summary, org, seed };
        out = { ready: true, summary, organisation: org };
      } else if (name === "draft_organisation") {
        const orgName = given(input.name);
        const type = input.type === "contractor" ? "contractor" : input.type === "client" ? "client" : "";
        if (!orgName) throw new Error("An organisation needs a name. Ask the person.");
        if (!type) throw new Error("type must be client or contractor.");
        const dup = (await findOrgs(orgName)).find(h => h.name.toLowerCase() === orgName.toLowerCase());
        if (dup) throw new Error(`${dup.name} is already on file as a ${dup.org_type}; add people to it with draft_contact.`);
        const summary = `Add ${orgName} as a new ${type}? The Contacts screen's New organisation dialog opens with it filled in for you to add.`;
        action = { kind: "draft_organisation", summary, seed: { name: orgName, type } };
        out = { ready: true, summary };
      } else if (name === "find_contact") {
        const pat = likeSafe(given(input.q));
        if (!pat) throw new Error("Give part of a name, title, email or phone.");
        let query = asUser.from("contacts").select("id, org_type, org_id, name, title, email, phone, is_primary")
          .or(`name.ilike.%${pat}%,title.ilike.%${pat}%,email.ilike.%${pat}%,phone.ilike.%${pat}%`)
          .order("name").limit(20);
        const orgQ = given(input.organisation);
        if (orgQ) { const org = await resolveOrg(orgQ); query = query.eq("org_type", org.type).eq("org_id", org.id); }
        const { data, error } = await query;
        if (error) throw new Error(error.message);
        const people = (data ?? []) as DirContactRow[];
        const orgNames = new Map<string, string>();
        for (const kind of ["client", "contractor"] as const) {
          const ids = [...new Set(people.filter(p => p.org_type === kind).map(p => p.org_id))];
          if (!ids.length) continue;
          const { data: orgs, error: oErr } = await asUser.from(kind === "client" ? "clients" : "contractors").select("id, name").in("id", ids);
          if (oErr) throw new Error(oErr.message);
          for (const o of (orgs ?? []) as { id: string; name: string }[]) orgNames.set(`${kind}:${o.id}`, o.name);
        }
        out = people.map(p => ({
          id: p.id, name: p.name, title: p.title, email: p.email, phone: p.phone, primary: p.is_primary,
          organisation: { type: p.org_type, name: orgNames.get(`${p.org_type}:${p.org_id}`) ?? "" }
        }));
      } else if (name === "day_check") {
        const wanted = given(input.date);
        if (wanted && !isDay(wanted)) throw new Error("date must be YYYY-MM-DD.");
        const day = wanted || todayIn(Date.now());
        // The jobs the person worked that day: a JHA they filed, a ticket
        // they raised, a ticket they were crew on — each read as them.
        const [jhaMine, ticketMine, crewMine] = await Promise.all([
          asUser.from("jhas").select("job_id").eq("signed_by", user.id).eq("work_date", day),
          asUser.from("tickets").select("job_id").eq("technician_id", user.id).eq("work_date", day),
          asUser.from("ticket_crew").select("ticket_id, tickets!inner(job_id, work_date)").eq("profile_id", user.id).eq("tickets.work_date", day)
        ]);
        for (const r of [jhaMine, ticketMine, crewMine]) if (r.error) throw new Error(r.error.message);
        const jobIds = new Set<string>([
          ...((jhaMine.data ?? []) as { job_id: string }[]).map(r => r.job_id),
          ...((ticketMine.data ?? []) as { job_id: string }[]).map(r => r.job_id),
          ...((crewMine.data ?? []) as unknown as { tickets: { job_id: string } | null }[]).map(r => r.tickets?.job_id ?? "").filter(Boolean)
        ]);
        if (!jobIds.size) {
          out = { date: day, jobs: [], note: "No JHA, ticket or crew entry of this person's is on file for that date." };
        } else {
          const ids = [...jobIds];
          const dayStart = new Date(localToUtc(`${day} 00:00`)).toISOString();
          const [jobsRes, jhasRes, ticketsRes, reportsRes] = await Promise.all([
            asUser.from("jobs").select("id, job_number").in("id", ids),
            asUser.from("jhas").select("id, job_id, sent_at").in("job_id", ids).eq("work_date", day),
            asUser.from("tickets").select("id, job_id, status, approval_sent_at").in("job_id", ids).eq("work_date", day),
            asUser.from("reports").select("id, job_id, sent_at").in("job_id", ids).gte("uploaded_at", dayStart)
          ]);
          for (const r of [jobsRes, jhasRes, ticketsRes, reportsRes]) if (r.error) throw new Error(r.error.message);
          const tickets = (ticketsRes.data ?? []) as DayTicketRow[];
          const helpers = new Set<string>();
          if (tickets.length) {
            const { data: crew, error: cErr } = await asUser.from("ticket_crew").select("ticket_id, crew_role")
              .in("ticket_id", tickets.map(t => t.id)).eq("crew_role", "Helper");
            if (cErr) throw new Error(cErr.message);
            for (const c of (crew ?? []) as { ticket_id: string }[]) helpers.add(c.ticket_id);
          }
          const jobs = (jobsRes.data ?? []) as { id: string; job_number: string }[];
          const checks = jobs.map(j => {
            const dayJob: DayJob = {
              job_number: j.job_number,
              jhas: ((jhasRes.data ?? []) as DayJhaRow[]).filter(r => r.job_id === j.id).map(r => ({ sent_at: r.sent_at })),
              tickets: tickets.filter(t => t.job_id === j.id).map(t => ({ id: t.id, status: t.status, approval_sent_at: t.approval_sent_at, helper: helpers.has(t.id) })),
              reports: ((reportsRes.data ?? []) as DayReportRow[]).filter(r => r.job_id === j.id).map(r => ({ sent_at: r.sent_at }))
            };
            return dayCheck(dayJob);
          });
          out = { date: day, jobs: checks, done: checks.every(c => c.done) };
        }
      } else if (name === "set_reminder") {
        const label = reminderText(input.text);
        const runAt = localToUtc(input.run_at);
        checkRunAt(runAt, Date.now());
        const number = given(input.job_number);
        const found = number ? await jobNumbered(number, false) : null;
        const job = found ? { id: found.id, job_number: found.job_number } : null;
        const words = reminderWords(label, job, runAt);
        action = { kind: "set_reminder", summary: words.summary, done: words.done, label, run_at: new Date(runAt).toISOString(), job };
        out = { ready: true, summary: words.summary, run_at: new Date(runAt).toISOString() };
      } else if (name === "my_hours") {
        const who = await whose(input.person);
        const period = periodFrom(input.start, input.end, payPeriodFor(todayIn(Date.now())));
        const rows: CrewRow[] = [];
        let after: string | null = null;
        let partial = false;
        // Exhaust by key, not by a guessed server cap: a short response
        // may be PostgREST's max-rows setting rather than the end of a year.
        // Bounded all the same, and the bound is why the answer below is
        // labelled rather than trimmed: the walk is ordered by id, which is
        // a uuid, so what a stopped walk holds is SOME of the period and
        // not its first weeks. Handing that back as a period total would be
        // a figure somebody checks their pay against.
        for (let request = 1; ; request++) {
          // Asked for no more than the budget has left, so the last page
          // cannot carry the total past it: a server capping at 300 read
          // 25,200 rows where the ceiling said 25,000, because the check
          // came after the push and the page was whatever the server felt
          // like sending.
          let query = asUser.from("ticket_crew")
            .select("id, straight_hours, ot_hours, solo_hours, solo_ot_hours, mileage_km, tickets!inner(work_date, jobs(job_number))")
            .eq("profile_id", who.id).gte("tickets.work_date", period.start).lte("tickets.work_date", period.end)
            .order("id").limit(Math.min(HOURS_PAGE_ROWS, HOURS_MAX_ROWS - rows.length));
          if (after !== null) query = query.gt("id", after);
          const { data, error } = await query;
          if (error) throw new Error(error.message);
          const page = (data ?? []) as unknown as HoursRow[];
          if (!page.length) break;
          rows.push(...page.map(r => ({
            job_number: r.tickets?.jobs?.job_number ?? "(job unknown)", work_date: r.tickets?.work_date ?? "",
            straight_hours: r.straight_hours, ot_hours: r.ot_hours, solo_hours: r.solo_hours, solo_ot_hours: r.solo_ot_hours, mileage_km: r.mileage_km
          })));
          after = page[page.length - 1].id;
          if (rows.length >= HOURS_MAX_ROWS || request >= HOURS_MAX_REQUESTS) { partial = true; break; }
        }
        const hoursNote = "Hours in whole numbers and hundredths; solo hours are timesheet-only and never billed.";
        out = {
          person: who.name, period: periodWords(period), ...sumHours(rows),
          rows_read: rows.length, partial,
          note: partial
            ? `PARTIAL — this stopped after ${rows.length} crew rows, so the figures cover only part of ${periodWords(period)} and are NOT a total for it. The rows were read in id order, which is not the order the days fall in, so this is not the first part of the period either. Say so, and ask for a shorter period. ${hoursNote}`
            : hoursNote
        };
      } else if (name === "my_dose") {
        const who = await whose(input.person);
        const period = periodFrom(input.start, input.end, quarterFor(todayIn(Date.now())));
        const { data, error } = await asUser.rpc("dose_totals", { p_start: period.start, p_end: period.end });
        if (error) throw new Error(error.message);
        const row = ((data ?? []) as DoseRow[]).find(r => r.profile_id === who.id) ?? null;
        out = {
          person: who.name, period: periodWords(period),
          days_with_dose: row ? Number(row.days) : 0, total_mr: row ? Number(row.total_mr) : 0,
          quarters_mr: { q1: row ? Number(row.q1) : 0, q2: row ? Number(row.q2) : 0, q3: row ? Number(row.q3) : 0, q4: row ? Number(row.q4) : 0 },
          note: "mR from the crew entries on billing tickets in the period; the quarters are the calendar quarters the days fall in."
        };
      } else if (name === "open_record") {
        // The record as the caller may read it, and its job; App does the
        // opening with what it already has (openJobByNumber, openTicket).
        const kind = String(input.kind ?? "");
        const id = given(input.id);
        if (!OPEN_KINDS.includes(kind)) throw new Error("kind must be job, ticket, jha or report.");
        if (!id) throw new Error("Which one? Give the job number, the ticket number or the id.");
        let job: { id: string; job_number: string };
        let summary: string;
        let status: string | null = null;
        let editor = false;
        let recId = id;
        if (kind === "job") {
          const j = await jobNumbered(id, false);
          job = { id: j.id, job_number: j.job_number };
          summary = `Open ${j.job_number}?`;
        } else if (kind === "ticket") {
          const { data, error } = await asUser.from("tickets").select("id, status, technician_id, jobs(id, job_number)").eq("id", id.toUpperCase()).maybeSingle();
          if (error) throw new Error(error.message);
          const row = data as unknown as OpenTicketRow | null;
          if (!row || !row.jobs) throw new Error("No ticket with that number — use list_tickets to find it.");
          job = row.jobs; status = row.status; recId = row.id;
          editor = row.status === "Draft" && (row.technician_id === user.id || me.role === "Admin");
          summary = editor ? `Open ${row.id} in the ticket editor?` : `Open ${row.jobs.job_number}, where ${row.id} is?`;
        } else {
          if (!UUID.test(id)) throw new Error(`That is not an id — use ${kind === "jha" ? "list_jhas" : "list_reports"} to find it.`);
          const { data, error } = await asUser.from(kind === "jha" ? "jhas" : "reports").select("id, jobs(id, job_number)").eq("id", id).maybeSingle();
          if (error) throw new Error(error.message);
          const row = data as unknown as OpenRecordRow | null;
          if (!row || !row.jobs) throw new Error(`No ${kind === "jha" ? "assessment" : "report"} with that id — use ${kind === "jha" ? "list_jhas" : "list_reports"} to find it.`);
          job = row.jobs;
          summary = `Open ${row.jobs.job_number}, where the ${kind === "jha" ? "JHA" : "report"} is?`;
        }
        action = { kind: "open", record: kind, id: recId, status, editor, job, summary };
        out = { ready: true, summary };
      } else if (name === "check_ticket") {
        const id = given(input.ticket_id).toUpperCase();
        const { data, error } = await asUser.from("tickets")
          .select("id, status, technician_id, work_date, client_contact, jobs(id, job_number)").eq("id", id).maybeSingle();
        if (error) throw new Error(error.message);
        const row = data as unknown as CheckTicketRow | null;
        if (!row || !row.jobs) throw new Error("No ticket with that number — use list_tickets to find it.");
        if (row.status !== "Draft") {
          throw new Error(`${row.id} is ${row.status} — ${row.status === "Awaiting approval" ? "cancel the approval (cancel_approval) to change it" : "it can no longer be changed"}.`);
        }
        // The editor's own rule: one technician never edits another's ticket.
        if (row.technician_id !== user.id && me.role !== "Admin") throw new Error(`${row.id} is another technician's ticket — only its technician or an Admin can check or edit it.`);
        const linesRes = await asUser.from("ticket_lines").select("kind, label, unit, quantity, unit_rate").eq("ticket_id", row.id);
        if (linesRes.error) throw new Error(linesRes.error.message);
        const crewRes = await asUser.from("ticket_crew").select("straight_hours, ot_hours, solo_hours, solo_ot_hours, profiles(name)").eq("ticket_id", row.id);
        if (crewRes.error) throw new Error(crewRes.error.message);
        let jhaCount = 0;
        if (row.work_date) {
          const jhaRes = await asUser.from("jhas").select("id").eq("job_id", row.jobs.id).eq("work_date", row.work_date).limit(1);
          if (jhaRes.error) throw new Error(jhaRes.error.message);
          jhaCount = (jhaRes.data ?? []).length;
        }
        const check = ticketCheck({
          ticket: { id: row.id, status: row.status, work_date: row.work_date, client_contact: row.client_contact?.name ?? null },
          lines: (linesRes.data ?? []) as CheckLineRow[],
          crew: ((crewRes.data ?? []) as unknown as CheckCrewRow[]).map(c => ({
            name: c.profiles?.name ?? "(name unknown)",
            straight_hours: c.straight_hours, ot_hours: c.ot_hours, solo_hours: c.solo_hours, solo_ot_hours: c.solo_ot_hours
          })),
          jhaCount,
          today: todayIn(Date.now())
        });
        out = { ...check, job_number: row.jobs.job_number };
      } else if (name === "rate_card") {
        const client = await resolveClient(given(input.client));
        // _fetchPublishedRates' choice of schedule, made as the caller: the
        // newest schedule; the house card when it follows the default; else
        // the newest published one.
        const { data: latestD, error: sErr } = await asUser.from("rate_schedules").select("id, follows_default, published_at")
          .eq("client_id", client.id).order("effective_from", { ascending: false }).limit(1).maybeSingle();
        if (sErr) throw new Error(sErr.message);
        const latest = latestD as ScheduleRow | null;
        let schedule: { id: string } | null = null;
        let card = "its own card";
        if (latest?.follows_default) {
          const { data, error } = await asUser.from("rate_schedules").select("id").is("client_id", null)
            .not("published_at", "is", null).order("effective_from", { ascending: false }).limit(1).maybeSingle();
          if (error) throw new Error(error.message);
          schedule = data as { id: string } | null;
          card = "the house card";
        } else if (latest?.published_at) {
          schedule = { id: latest.id };
        } else {
          const { data, error } = await asUser.from("rate_schedules").select("id").eq("client_id", client.id)
            .not("published_at", "is", null).order("effective_from", { ascending: false }).limit(1).maybeSingle();
          if (error) throw new Error(error.message);
          schedule = data as { id: string } | null;
        }
        if (!schedule) throw new Error(`${client.name} has no published rate schedule — Rate admin is where one is published.`);
        const { data: linesD, error: lErr } = await asUser.from("rate_lines").select("kind, label, unit, rate").eq("schedule_id", schedule.id)
          .order("position", { ascending: true, nullsFirst: false }).order("label");
        if (lErr) throw new Error(lErr.message);
        const q = given(input.search).toLowerCase();
        const lines = ((linesD ?? []) as RateLineRow[]).filter(l => !q || l.label.toLowerCase().includes(q));
        const of = (kinds: string[]) => lines.filter(l => kinds.includes(l.kind));
        out = {
          client: client.name, card,
          welds: of(["rt_film", "rt_cr", "rt_dr", "custom_weld"]).map(l => ({ size: l.label, kind: RT_WORDS[l.kind] ?? l.kind, rate_per_weld: Number(l.rate) })),
          methods: of(["method", "custom_method"]).map(l => ({ label: l.label, rate_per_weld: Number(l.rate) })),
          charges: of(["expense", "custom_expense"]).map(l => ({ label: l.label, unit: l.unit || "ea", rate: Number(l.rate) })),
          note: q && !lines.length ? `Nothing on the card matches "${q}".` : "Dollars; a size's three rates are film, CR and DR per weld."
        };
      } else if (name === "needs_attention") {
        // Home's two reads, as the caller (an Admin's), through the strip's
        // own questions (attention.ts, attention.js's twin).
        const stateRes = await asUser.rpc("backup_state");
        if (stateRes.error) throw new Error(stateRes.error.message);
        const errRes = await asUser.from("function_errors").select("function_name, created_at").order("created_at", { ascending: false }).limit(ERROR_SCAN);
        if (errRes.error) throw new Error(errRes.error.message);
        const items = attentionItems(stateRes.data as BackupState | null, (errRes.data ?? []) as ErrorRow[], Date.now());
        out = { items: items.map(i => ({ what: i.text, where: i.where })), nothing: items.length === 0 };
      } else if (name === "cancel_approval") {
        const id = given(input.ticket_id).toUpperCase();
        const { data, error } = await asUser.from("tickets")
          .select("id, status, technician_id, approved_at, jobs(id, job_number)").eq("id", id).maybeSingle();
        if (error) throw new Error(error.message);
        const row = data as unknown as CheckTicketRow | null;
        if (!row || !row.jobs) throw new Error("No ticket with that number — use list_tickets to find it.");
        // The RPC's own rule, applied before proposing; the RPC applies it
        // again when App calls it.
        if (row.status !== "Awaiting approval" || row.approved_at) throw new Error(`${row.id} is ${row.status} — only a ticket awaiting approval can have its approval cancelled.`);
        if (row.technician_id !== user.id && !["Admin", "Coordinator"].includes(me.role ?? "")) throw new Error(`${row.id} is another technician's ticket — its technician, an Admin or a Coordinator can cancel the approval.`);
        const summary = `Cancel ${row.id}'s approval? The rep's link stops working and the ticket goes back to a draft on ${row.jobs.job_number}.`;
        const done = `Cancelled: ${row.id} is a draft again on ${row.jobs.job_number}. A new send makes a new link.`;
        action = { kind: "cancel_approval", summary, done, ticket: { id: row.id }, job: { id: row.jobs.id, job_number: row.jobs.job_number } };
        out = { ready: true, summary };
      } else if (name === "find_equipment") {
        const filter = EQUIPMENT_FILTERS.includes(given(input.filter)) ? given(input.filter) : "All";
        const { data, error } = await asUser.rpc("search_equipment", { filter_key: filter, page_num: 0, page_size: 50, search: given(input.search) });
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as EquipmentRow[];
        out = {
          total: rows.length ? Number(rows[0].total_count) : 0, filter,
          equipment: rows.map(e => ({ id: e.id, type: e.type, serial: e.serial_number, calibration_due: e.calibration_due, status: e.status, held_by: e.assigned_name || null }))
        };
      } else {
        throw new Error(`no tool named ${name}`);
      }
      tool = "";
      return out;
    };

    const result = await askLoop(thread, toolDefinitions(tools),
      systemPrompt({ name: me.name ?? "", role: me.role ?? "" }, Date.now(), { knowledge: knowledgeText(), where }), key,
      { fetch: (url, init) => fetch(url, init), runTool, trace: traceLine, now: Date.now },
      // The crew's notes, as data in the conversation and never in the
      // system message. The fence is minted per request: a note written
      // yesterday cannot contain a word invented a moment ago, so it cannot
      // close the block it sits in. That is a cost, not a boundary — the
      // boundary is that nothing here can act. Tools run as the caller under
      // RLS and every write waits for the person's confirm on the card.
      learnedLines(learnedRows, crypto.randomUUID().slice(0, 8)));
    // Then it learns: one small call over the conversation's own text (never
    // a tool result) and the notes it has, and the rows it decides on are
    // written AS THE CALLER through RLS — a replace of someone else's note
    // by a non-Admin is refused by the delete policy and the new note lands
    // beside the old one, where the Admin's list shows both. Best effort:
    // nothing here can fail the answer, and a missed note is not an error.
    const kept = await learn(asUser, thread, result.answer, learnedRows, key, user.id)
      .catch(() => ({ added: [], trouble: null }) as LearnResult);
    return json({
      ...result, learned: kept.added,
      ...(kept.trouble ? { learnTrouble: kept.trouble } : {}),
      ...(action ? { action } : {}),
      ...(files.length ? { files: files.map(f => ({ ...f, words: fileWords(f) })) } : {})
    });
  } catch (e) {
    const message = (e as Error).message;
    await logError("ask", message, { user: userId, tool });
    return json({ error: message }, 400);
  }
});

// One extractor call and the writes it asks for, as the caller. Returns the
// notes added, with their ids, for the card's "Learned:" line.
async function learn(asUser: SupabaseClient, thread: unknown, answer: string, existing: LearnedRow[], apiKey: string, userId: string): Promise<LearnResult> {
  const turns = [...windowTurns(thread), { role: "assistant" as const, text: answer }];
  const { system, user } = learnPrompt(turns, existing.map(e => ({ id: e.id, note: e.note })));
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": API_VERSION },
    body: JSON.stringify({ model: LEARN_MODEL, max_tokens: LEARN_MAX_TOKENS, system, messages: [{ role: "user", content: user }] })
  });
  if (!res.ok) return { added: [], trouble: null };
  const reply = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = (reply.content ?? []).filter(b => b.type === "text").map(b => b.text ?? "").join("\n");
  const decided = parseLearned(text, existing.map(e => e.id));
  const added: { id: string; note: string }[] = [];
  let trouble: string | null = null;

  // A correction is ONE act: replace_learned removes the old row and writes
  // the new one in a single transaction, under the caller's own policies. It
  // was a delete and then an insert in two round trips, and a delete that
  // landed with an insert that then did not took the original with it — the
  // person asked for a correction and lost what they had. A refusal here
  // (the note has gone, or it is not this caller's to remove) leaves the old
  // note exactly where it was, which is the right answer to "replace a thing
  // you may not touch" and is why it is not retried as an add.
  for (const r of decided.replace) {
    const { data, error } = await asUser.rpc("replace_learned", { _old: r.id, _note: r.note });
    if (error) {
      trouble ??= learnTrouble(error.message);
      // The card gets a sentence a person can read; the office gets what
      // actually happened. Losing the real words to spare the browser them
      // would only move the blindness, not remove it.
      await logError("ask", `a note could not be corrected: ${error.message}`, { user: userId, note: r.id });
      continue;
    }
    const row = data as { id: string; note: string } | null;
    if (row) added.push({ id: row.id, note: row.note });
  }

  const room = roomFor(existing.length - decided.replace.length, decided.add.length);
  const fresh = decided.add.slice(0, room);
  if (fresh.length) {
    // The insert's answer is READ. It was discarded, so a note the database
    // refused — the per-author cap is the one that will actually fire — was
    // indistinguishable from one that landed: the card said nothing and the
    // note was not there. The answer is never failed for it; the card is
    // told instead.
    const { data, error } = await asUser.from("ask_learned")
      .insert(fresh.map(note => ({ note, said_by: userId }))).select("id, note");
    if (error) {
      trouble ??= learnTrouble(error.message);
      await logError("ask", `a note could not be kept: ${error.message}`, { user: userId });
    }
    added.push(...((data ?? []) as { id: string; note: string }[]));
  }
  return { added, trouble };
}

// What the card says when a note could not be kept.
//
// The cap's sentence is OURS — written in the migration, meant to be read by
// whoever pressed the button, and the one refusal a person can actually do
// something about — so it passes through. Everything else becomes a fixed
// sentence: a raw database message is written for whoever runs the database,
// names columns and constraints, and is the shape that leaks a schema one
// error at a time. The real words still reach the office, through
// function_errors, where the digest and Home's strip read them.
const LEARN_TROUBLE = "Something Ask learned could not be kept. The answer above is unaffected.";

function learnTrouble(message: string): string {
  return /as much as it can hold/i.test(message) ? message : LEARN_TROUBLE;
}

// Best-effort, never masks the real error (admin-digest's shape).
async function logError(functionName: string, message: string, context: Record<string, unknown> = {}) {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort */ }
}
