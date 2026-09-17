// chat-retention — what the app forgets, on schedule.
//
// Two things, one nightly run: the team chat (below) and the photos people
// paste or drop onto Ask's card. Both are the same act — an ordinary,
// fixed retention policy enforced by the service role after the fact — and
// both are idempotent, so an extra run deletes nothing not already due.
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
import { ATTACH_ROOT, ATTACH_KEEP_DAYS, expiredAttachMonths } from "../_shared/askAttachments.ts";
import { publicWords, loggedWords } from "../_shared/publicError.ts";
// The one sentence anything unmarked comes back as. A refusal of ours says
// what to do and is shown as written; a message from Postgres, Auth, Resend
// or a drive names columns, constraints and accounts, so it is logged and not
// shown. Deny by default: the cost of forgetting is silence.
const TROUBLE = "The nightly clean-up failed.";

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

    // Ask's attachments. The month is in the key (askAttachments.ts), so a
    // whole folder goes at once and nothing here reads an object's clock —
    // a folder is due only once its LAST day is ATTACH_KEEP_DAYS behind, so
    // nothing is thrown away early and nothing lives much past that.
    //
    // Only under Ask/attachments: a file the person MOVED into the shared
    // drive proper is theirs, and the sweep must never find it. A month
    // whose objects run past one run's passes is finished by the next.
    let attachments = 0;
    const { data: monthRows, error: monthErr } = await admin.storage
      .from("shared").list(ATTACH_ROOT, { limit: 1000, sortBy: { column: "name", order: "asc" } });
    if (monthErr) throw monthErr;
    const months = expiredAttachMonths((monthRows || []).filter((r) => !r.id).map((r) => r.name), Date.now());
    for (const month of months) {
      const folder = `${ATTACH_ROOT}/${month}`;
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const { data: objects, error: listErr } = await admin.storage
          .from("shared").list(folder, { limit: 100 });
        if (listErr) throw listErr;
        // A prefix row has no id and is not an object to remove; there are
        // no folders under a month, but a stray one must not be mistaken
        // for a file and silently counted as deleted.
        const keys = (objects || []).filter((o) => o.id).map((o) => `${folder}/${o.name}`);
        if (!keys.length) break;
        const { error: rmErr } = await admin.storage.from("shared").remove(keys);
        if (rmErr) throw rmErr;
        attachments += keys.length;
        if (keys.length < 100) break;
      }
    }

    return new Response(JSON.stringify({ ok: true, deleted, pictures, attachments, attachmentMonths: months, keepDays: ATTACH_KEEP_DAYS, cutoff }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    await logError("chat-retention", loggedWords(e));
    return new Response(JSON.stringify({ error: publicWords(e, TROUBLE) }), {
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
