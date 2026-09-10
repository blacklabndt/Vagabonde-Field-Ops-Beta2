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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { appSettings, corsHeaders } from "../_shared/mail.ts";
import { toolsFor, toolDefinitions, traceLine, searchArgs, JHA_TEMPLATES, HAZARD_NAMES, PRICE_ROLES } from "../_shared/askTools.ts";
import { shapeJobDraft, shapeTicketDraft, shapeJhaDraft } from "../_shared/askDrafts.ts";
import { resolveRecipients, jhaSendGate, ticketSendGate, ticketApprovalAddress, jhaFileName, sendJhaWords, sendTicketWords, JHA_MESSAGE } from "../_shared/askSends.ts";
import { askLoop, systemPrompt, windowTurns } from "../_shared/askLoop.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

interface Me { name: string | null; role: string | null; tab_access: string[] | null; deactivated_at: string | null }
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

    const body = (await req.json().catch(() => null)) as { thread?: unknown } | null;
    const thread = body?.thread;
    if (!Array.isArray(thread) || !thread.length) return json({ error: "Ask needs a question" }, 400);

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

    // The form a draft proposes, or the send a send tool proposes, if one
    // did; the last call wins.
    let action: Record<string, unknown> | null = null;
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
        const { data, error } = await asUser.from("jhas")
          .select("id, job_id, signed_by, pdf_key, template, work_date, sent_at, jobs(id, job_number, client_id, contractor_id)")
          .eq("id", String(input.jha_id ?? "")).maybeSingle();
        if (error) throw new Error(error.message);
        const row = data as unknown as JhaSendRow | null;
        if (!row || !row.jobs) throw new Error("No assessment with that id — use list_jhas to find it.");
        jhaSendGate(row, who);
        const people = await contactsFor([row.jobs.client_id, row.jobs.contractor_id]);
        const to = resolveRecipients(input.recipients, people, saidByPerson());
        const job = { id: row.jobs.id, job_number: row.jobs.job_number };
        const words = sendJhaWords(row, job, to);
        action = {
          kind: "send_jha", summary: words.summary, done: words.done, to, message: JHA_MESSAGE,
          jha: { id: row.id, file: jhaFileName(row.pdf_key, row.template) }, job
        };
        out = { ready: true, summary: words.summary, to };
      } else if (name === "send_ticket_approval") {
        const { data, error } = await asUser.from("tickets")
          .select("id, status, total, technician_id, client_contact, jobs(id, job_number, client_id, client_contact_id)")
          .eq("id", String(input.ticket_id ?? "").trim().toUpperCase()).maybeSingle();
        if (error) throw new Error(error.message);
        const row = data as unknown as TicketSendRow | null;
        if (!row || !row.jobs) throw new Error("No ticket with that number — use list_tickets to find it.");
        ticketSendGate(row, who);
        // The job's current client rep, the way the job record names one.
        const people = await contactsFor([row.jobs.client_id]);
        const rep = people.find(c => c.id === row.jobs?.client_contact_id) ?? people.find(c => c.org_type === "client" && c.is_primary) ?? null;
        const to = [ticketApprovalAddress(row.client_contact?.name, rep?.email)];
        const job = { id: row.jobs.id, job_number: row.jobs.job_number };
        const words = sendTicketWords(row, job, to);
        action = { kind: "send_ticket_approval", summary: words.summary, done: words.done, to, ticket: { id: row.id }, job };
        out = { ready: true, summary: words.summary, to };
      } else {
        throw new Error(`no tool named ${name}`);
      }
      tool = "";
      return out;
    };

    const result = await askLoop(thread, toolDefinitions(tools),
      systemPrompt({ name: me.name ?? "", role: me.role ?? "" }, Date.now()), key,
      { fetch: (url, init) => fetch(url, init), runTool, trace: traceLine, now: Date.now });
    return json(action ? { ...result, action } : result);
  } catch (e) {
    const message = (e as Error).message;
    await logError("ask", message, { user: userId, tool });
    return json({ error: message }, 400);
  }
});

// Best-effort, never masks the real error (admin-digest's shape).
async function logError(functionName: string, message: string, context: Record<string, unknown> = {}) {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort */ }
}
