// password-reset — an Admin sends an account a set-password link.
//
// Until now a reset meant the Supabase dashboard, or the person finding
// "Forgot password" on the sign-in screen themselves. This is the office
// doing it from Users & access: verify the caller is a signed-in Admin (as
// create-user and delete-user do), look the address up from the account
// with the service role, and mail Auth's own recovery link through the
// app's transport (see _shared/setPassword.ts). The link works once and
// lands on the app's set-password screen.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendSetPasswordLink } from "../_shared/setPassword.ts";
import { requireActiveAdmin } from "../_shared/adminGate.ts";
import { refuse, publicWords, loggedWords } from "../_shared/publicError.ts";

// The one sentence anything unmarked comes back as. Our own refusals above
// say what to do and are shown as they are written; a message from Postgres,
// Auth or Resend names columns, constraints and accounts, so it is logged and
// not shown. Deny by default: the cost of forgetting is silence.
const TROUBLE = "The set-password link could not be sent. Try again, and tell the office if it keeps happening.";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Who is asking comes before anything is read from them: the parse below
  // throws on a malformed body, and the catch at the bottom writes that to
  // function_errors — a log an anonymous POST must not be able to fill.
  // The whole question is adminGate's: signed in, a profile that is there,
  // unlocked, holding a tab, and an Admin. The rank alone let a locked
  // account through for as long as Auth still accepted its session — and
  // the deactivation test below is the TARGET's, which never protected
  // against a caller who had been removed.
  const who = await requireActiveAdmin(req, "Only an Admin can send a set-password link");
  if (who instanceof Response) return who;

  try {
    const { userId } = await req.json();
    // A guard against a client bug, so it should never fire — but whoever
    // reads it pressed a button, and a variable name tells them nothing.
    if (!userId) throw refuse("This request didn't say which account to send the link to. Reload the app and try again.");

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: target, error: tErr } = await admin.auth.admin.getUserById(userId);
    if (tErr || !target?.user?.email) throw refuse("That account has no email address on file.");
    const { data: profile } = await admin.from("profiles").select("name, deactivated_at").eq("id", userId).maybeSingle();
    if (profile?.deactivated_at) {
      throw refuse("That account is locked out — it can't sign in until it is unbanned in the Supabase dashboard.");
    }

    await sendSetPasswordLink(admin, target.user.email, profile?.name ?? "", "reset");
    return json({ ok: true, sentTo: target.user.email });
  } catch (e) {
    await logError("password-reset", loggedWords(e));
    return json({ error: publicWords(e, TROUBLE) }, 400);
  }
});

async function logError(functionName: string, message: string, context: Record<string, unknown> = {}) {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort; never let it mask the real error */ }
}
