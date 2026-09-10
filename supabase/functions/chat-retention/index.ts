// chat-retention — the team chat forgets, on schedule.
//
// Messages older than 30 days are deleted unless they are pinned; a
// pinned message stays for as long as its pin does, and starts its 30
// days over from wherever it is when the pin comes down. Runs nightly
// from pg_cron (see the chat_messages_expire migration), and is safe to
// run at any moment beyond that: it enforces a fixed policy, so an
// extra run deletes nothing that was not already due.
//
// The gateway can't vouch for the caller — the cron job holds no user
// JWT — so this checks its own door: the database signs its calls with
// x-internal-secret (a value minted in private.internal_config,
// readable only through the service-role-only accessor), and a request
// without it is not the database.
//
// Pictures come down from the chat-media bucket before their rows go,
// in that order deliberately: a row that briefly outlives its picture
// is healed by the next run, but a picture whose row is already gone is
// referenced by nothing and would sit invisible in the bucket forever.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { secretsMatch } from "../_shared/constantTime.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RETENTION_DAYS = 30;
// PostgREST answers at most 1,000 rows per request, silently — the same
// cap the app pages around. Loop until the predicate finds nothing.
const PAGE = 1000;
const MAX_PASSES = 20;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: expected, error: secretErr } = await admin.rpc("internal_secret");
    if (secretErr) throw secretErr;
    // Constant time, never `===`: a compare that stops at the first byte
    // that differs times out how much of the secret the caller has right.
    if (!secretsMatch(req.headers.get("x-internal-secret"), expected)) {
      return new Response(JSON.stringify({ error: "Not authorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();

    let deleted = 0;
    let pictures = 0;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const { data: expired, error } = await admin
        .from("chat_messages")
        .select("id, image_key, audio_key")
        .is("pinned_at", null)
        .lt("created_at", cutoff)
        .limit(PAGE);
      if (error) throw error;
      if (!expired || expired.length === 0) break;

      const keys = expired
        .flatMap((r) => [r.image_key, r.audio_key])
        .filter(Boolean) as string[];
      for (let i = 0; i < keys.length; i += 100) {
        const batch = keys.slice(i, i + 100);
        const { error: rmErr } = await admin.storage.from("chat-media").remove(batch);
        if (rmErr) throw rmErr;
        pictures += batch.length;
      }

      const ids = expired.map((r) => r.id);
      // Pinned again since the select, while the media pass was running:
      // the picture has gone, but the row is somebody's deliberate pin and
      // stays — retention never touches a pin.
      const { data: went, error: delErr } = await admin
        .from("chat_messages").delete().is("pinned_at", null).in("id", ids).select("id");
      if (delErr) throw delErr;
      deleted += (went || []).length;
      // A kept row's picture is already gone, and no later run will select
      // a pinned row to heal it: take the dead keys off it here, so the pin
      // shows as words rather than a broken picture for ever.
      const wentIds = new Set((went || []).map((r) => r.id));
      const kept = ids.filter((id) => !wentIds.has(id));
      if (kept.length) {
        // A row must still say or show something (chat_messages_says_or_shows:
        // words, a picture, a GIF, a voice note or a file link), so a
        // picture-only pin gets words where the picture was, rather than a
        // violation that fails the whole run every night after.
        const { data: left, error: readErr } = await admin.from("chat_messages")
          .select("id, body, gif_url, file_key, image_key").in("id", kept);
        if (readErr) throw readErr;
        for (const row of left || []) {
          const shows = (row.body || "").trim() || row.gif_url || row.file_key;
          const patch: Record<string, unknown> = { image_key: null, audio_key: null };
          // Name what actually came down: a wordless pinned voice note must
          // not be told a picture went, when there never was one.
          if (!shows) patch.body = row.image_key
            ? "(the picture came down after 30 days)"
            : "(the voice note came down after 30 days)";
          const { error: healErr } = await admin.from("chat_messages").update(patch).eq("id", row.id);
          if (healErr) throw healErr;
        }
      }

      if (expired.length < PAGE) break;
    }

    return new Response(JSON.stringify({ ok: true, deleted, pictures, cutoff }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    await logError("chat-retention", (e as Error).message);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function logError(functionName: string, message: string, context: Record<string, unknown> = {}) {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort; never let it mask the real error */ }
}
