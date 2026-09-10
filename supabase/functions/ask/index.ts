// Ask: a question in words, answered from what THIS caller may read.
//
// The door is the caller's JWT (render-invoice's shape) and then the
// caller's own profile row for the tabs they hold; the model is offered
// only the tools behind those tabs (askTools.ts), and every tool runs
// through the caller's client, so RLS and the price rule decide what comes
// back — a Coordinator's question meets the same null money the
// Coordinator's tracker does. The service role is used for one read: the
// Anthropic key from app_settings (appSettings(), env fallback).
//
// Nothing here writes. A later slice that drafts a job or a JHA proposes,
// and the app's own form and save path do the writing after the person
// confirms.
//
// The loop itself is _shared/askLoop.ts, pure and node-tested; this file
// is the door, the runners and the log line.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { appSettings, corsHeaders } from "../_shared/mail.ts";
import { toolsFor, toolDefinitions, traceLine, searchArgs } from "../_shared/askTools.ts";
import { askLoop, systemPrompt } from "../_shared/askLoop.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

interface Me { name: string | null; role: string | null; tab_access: string[] | null; deactivated_at: string | null }

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

    const tools = toolsFor(me.tab_access);
    if (!tools.length) return json({ answer: "Ask can't reach anything on the tabs you hold yet.", trace: [] });

    const body = (await req.json().catch(() => null)) as { thread?: unknown } | null;
    const thread = body?.thread;
    if (!Array.isArray(thread) || !thread.length) return json({ error: "Ask needs a question" }, 400);

    const key = (await appSettings()).anthropicApiKey;
    if (!key) return json({ error: "Ask isn't set up yet — an Admin can add the Anthropic key on the Admin screen." }, 400);

    // Every runner reads through asUser: the caller's own permissions, and
    // the RPCs' own price rule, decide what the model is shown.
    const runTool = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
      tool = name;
      const call = name === "tracker_stats" ? asUser.rpc("ticket_tracker_stats")
        : name === "ticket_aging" ? asUser.rpc("ticket_aging")
        : name === "search_tickets" ? asUser.rpc("search_tickets", searchArgs(input))
        : null;
      if (!call) throw new Error(`no tool named ${name}`);
      const { data, error } = await call;
      if (error) throw new Error(error.message);
      tool = "";
      return data;
    };

    const result = await askLoop(thread, toolDefinitions(tools),
      systemPrompt({ name: me.name ?? "", role: me.role ?? "" }, Date.now()), key,
      { fetch: (url, init) => fetch(url, init), runTool, trace: traceLine, now: Date.now });
    return json(result);
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
