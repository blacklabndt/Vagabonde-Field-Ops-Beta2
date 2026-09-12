// feature-request — the drawer's "Feature request" button.
//
// Anyone signed in can fill the form; the function mails it to the owner
// with the sender's name at the top and their words underneath, through
// the same Resend path every report and approval takes. The recipient is
// fixed here and not taken from the request: a staff account gets to talk
// to the owner, not to use the company's sending domain as a relay.
//
// The reply-to is the sender's own address, so an answer from the inbox
// goes straight back to the person who asked.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendMail, corsHeaders, wrapEmail, esc } from "../_shared/mail.ts";
import { publicWords, loggedWords } from "../_shared/publicError.ts";

const FEATURE_REQUEST_TO = "blacklabndt@gmail.com";
// A subject line's worth, and a page's worth. A limit is what stops a
// pasted log file from becoming the email nobody can open on a phone.
const MAX_TITLE = 120;
const MAX_DETAILS = 4000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const TROUBLE = "The request could not be sent. Try again, and tell the office if it keeps happening.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") ?? "";
  const asUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "Not signed in" }, 401);

  try {
    const body = await req.json().catch(() => ({}));
    const title = String(body?.title ?? "").trim();
    const details = String(body?.details ?? "").trim();
    if (!title) return json({ error: "Give the request a title." }, 400);
    if (!details) return json({ error: "Say what you would like." }, 400);
    if (title.length > MAX_TITLE) return json({ error: `The title is over ${MAX_TITLE} characters.` }, 400);
    if (details.length > MAX_DETAILS) return json({ error: `The details are over ${MAX_DETAILS} characters.` }, 400);

    // Own row: the profiles read policy lets every account see itself, and a
    // locked account (no tabs) reads nothing, which is the refusal below.
    const { data: profile } = await asUser.from("profiles").select("name, role").eq("id", user.id).maybeSingle();
    if (!profile) return json({ error: "This account cannot send a feature request." }, 403);

    const name = profile.name || user.email || "Someone";
    const email = user.email || "";
    const role = profile.role || "";
    const who = `${name}${role ? ` · ${role}` : ""}${email ? ` · ${email}` : ""}`;

    const html = wrapEmail(`
<h2 style="margin:0 0 4px;font-size:18px">Feature request</h2>
<p style="margin:0 0 16px;color:#555">From <strong>${esc(name)}</strong>${role ? ` (${esc(role)})` : ""}${email ? ` — ${esc(email)}` : ""}</p>
<h3 style="margin:0 0 6px;font-size:15px">${esc(title)}</h3>
<p style="white-space:pre-wrap;margin:0">${esc(details)}</p>`);

    const text = `Feature request\nFrom: ${who}\n\n${title}\n\n${details}\n`;

    await sendMail({
      from: "reports",
      to: FEATURE_REQUEST_TO,
      subject: `Feature request from ${name}: ${title}`,
      htmlBody: html,
      textBody: text,
      replyTo: email || undefined,
      tag: "feature-request"
    });

    return json({ ok: true });
  } catch (e) {
    // The office reads everything; the person reads only what was written
    // for them. See _shared/publicError.ts for why the default is masking.
    await logError("feature-request", loggedWords(e));
    return json({ error: publicWords(e, TROUBLE) }, 400);
  }
});

// Masking without logging would only move the blindness: the office would
// lose what the browser stopped being told. Logged with a throwaway
// service-role client, best effort, never masking the real error.
async function logError(functionName: string, message: string) {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("function_errors").insert({ function_name: functionName, message });
  } catch { /* logging is best-effort */ }
}

