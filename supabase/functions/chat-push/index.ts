// chat-push — tells the crew's phones a message landed in the team chat.
//
// Fired by the chat_messages insert trigger through pg_net, seconds
// after the message commits. Sends Web Push to every subscribed browser
// except the sender's own — you know what you said — and prunes any
// subscription whose push service answers 404/410, which is how a
// browser says that endpoint is dead for good.
//
// The gateway can't vouch for the caller — the trigger holds no user
// JWT, so verification is off — which means this checks its own door:
// the database signs its calls with x-internal-secret (a value minted
// in private.internal_config, readable only through the
// service-role-only accessor), and a request without it is not the
// database. Belt and braces beyond that: content comes from the
// database, never the request, and a message older than ten minutes is
// a replay — re-buzzing the crew for old news — and is refused.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendPush, type PushSub } from "../_shared/webPush.ts";
import { secretsMatch } from "../_shared/constantTime.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // The door before the body, the way the JWT-checked functions do it.
    // The parse below throws on junk and the catch writes that to
    // function_errors: parsing first let an anonymous POST fill the error
    // log one malformed request at a time.
    const { data: expected, error: secretErr } = await admin.rpc("internal_secret");
    if (secretErr) throw secretErr;
    // Constant time, never `===`: a compare that stops at the first byte
    // that differs times out how much of the secret the caller has right.
    if (!secretsMatch(req.headers.get("x-internal-secret"), expected)) {
      return json({ error: "Not authorized" }, 401);
    }

    const { messageId } = await req.json();
    if (!messageId) throw new Error("messageId is required");

    const { data: msg, error } = await admin
      .from("chat_messages")
      .select("id, profile_id, body, image_key, gif_url, audio_key, file_name, created_at, profiles!profile_id(name, first_name, last_name)")
      .eq("id", messageId)
      .maybeSingle();
    if (error) throw error;
    if (!msg) return json({ ok: true, sent: 0, reason: "no such message" });
    if (Date.now() - new Date(msg.created_at).getTime() > 10 * 60000) {
      return json({ ok: true, sent: 0, reason: "stale" });
    }

    // The sender's embed, typed by hand: supabase-js reads an embed as a
    // list without database types.
    const p = msg.profiles as unknown as { name?: string | null; first_name?: string | null; last_name?: string | null } | null;
    const name = [p?.first_name, p?.last_name].filter(Boolean).join(" ").trim() || p?.name || "Someone";
    const text = (msg.body || "").trim();
    const body = text
      ? (text.length > 120 ? text.slice(0, 117) + "…" : text)
      : msg.gif_url ? "sent a GIF"
      : msg.audio_key ? "sent a voice note"
      : msg.file_name ? `shared a file — ${msg.file_name}`
      : "sent a picture";

    // The inner join carries the permission check: a device whose user has
    // had the chat tab revoked keeps its subscription row (the device may be
    // claimed by the next tech), but message previews must stop reaching it
    // the moment access goes. RLS can't do this here — service role sees
    // every row — so the filter is the policy.
    const { data: subs, error: sErr } = await admin
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth, profiles!inner(tab_access, deactivated_at)")
      .neq("profile_id", msg.profile_id)
      // A locked account is not a recipient, whatever tabs its row still
      // holds — the lock never removed its phone's subscription.
      .is("profiles.deactivated_at", null)
      .contains("profiles.tab_access", ["chat"]);
    if (sErr) throw sErr;
    if (!subs || subs.length === 0) return json({ ok: true, sent: 0 });

    // The loop itself — VAPID, the send, the 404/410 prune — is
    // _shared/webPush.ts, which scheduled-sends uses too.
    const { sent, pruned } = await sendPush(admin, subs as unknown as PushSub[], { title: `${name} — Team chat`, body, url: "/?goto=chat" });
    return json({ ok: true, sent, pruned });
  } catch (e) {
    await logError("chat-push", (e as Error).message);
    return json({ error: (e as Error).message }, 400);
  }
});

async function logError(functionName: string, message: string, context: Record<string, unknown> = {}) {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort; never let it mask the real error */ }
}
