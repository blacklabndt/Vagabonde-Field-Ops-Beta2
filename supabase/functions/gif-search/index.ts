// gif-search — hands the team chat's GIF picker its KLIPY app key.
//
// This began life as a Tenor proxy, which died with Tenor's API
// (shut down 2026-06-30). KLIPY — where the GIF ecosystem moved — takes
// the opposite architecture: its integration terms require search and
// media requests to come from the end user's own browser, not through a
// partner server, so there is nothing to proxy. The key itself still
// lives as a Supabase secret rather than in the public bundle or git:
// verify_jwt is on, and the gateway honours the project's publishable
// key, so in practice anyone holding the app can obtain it — the same
// exposure as any client-side GIF key, and KLIPY's intended model. The
// secret buys central rotation, not secrecy.
//
// Until a key is set — on the Admin screen, or as the KLIPY_API_KEY
// secret — the picker shows this function's own explanation instead of
// a grid: the same build-now-configure-later shape as the mail sender.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { appSettings } from "../_shared/mail.ts";
import { refuse, publicWords, loggedWords } from "../_shared/publicError.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TROUBLE = "GIF search is not answering. Try again in a moment.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // A signed-in account, like every other function: the gateway's check
    // is satisfied by the publishable key that ships in the bundle, so
    // without this the key went to any caller on the internet — the same
    // exposure as before, but not one worth handing out for free.
    const asUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } }
    );
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Sign in to search for GIFs." }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    const key = (await appSettings()).klipyApiKey;
    if (!key) {
      throw refuse("GIF search isn't set up yet — an Admin can add the KLIPY key on the Admin screen.");
    }
    return new Response(JSON.stringify({ appKey: key }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    // The office reads everything; the person reads only what was written
    // for them. See _shared/publicError.ts for why the default is masking.
    await logError("gif-search", loggedWords(e));
    return new Response(JSON.stringify({ error: publicWords(e, TROUBLE) }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
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

