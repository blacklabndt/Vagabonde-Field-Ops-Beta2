// delete-user — actually deletes a Supabase Auth account, not just its
// profiles row.
//
// Users & access's "Remove account" used to only delete the profiles row —
// the app treats that as removed (no profile, no sign-in), but the real
// auth.users account was left behind. Deleting an auth user needs the
// service-role key, which must never reach the browser, so this runs
// server-side: verify the caller is a signed-in Admin, then delete both the
// profile and the underlying auth account.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireActiveAdmin } from "../_shared/adminGate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Who is asking comes before anything is read from them: the parse below
  // throws on a malformed body, and the catch at the bottom writes that to
  // function_errors — a log an anonymous POST must not be able to fill. The
  // whole question is adminGate's: signed in, a profile that is there,
  // unlocked, holding a tab, and an Admin. The rank alone let a locked
  // account through for as long as Auth still accepted its session.
  const who = await requireActiveAdmin(req, "Only an Admin can remove an account");
  if (who instanceof Response) return who;
  const { userId: callerId } = who;

  try {
    const { userId } = await req.json();
    // A guard against a client bug, so it should never fire — but whoever
    // reads it pressed a button, and a variable name tells them nothing.
    if (!userId) throw new Error("This request didn't say which account to remove. Reload the app and try again.");

    if (userId === callerId) {
      return new Response(JSON.stringify({ error: "You can't remove your own account" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // The profile row first — if the auth delete below fails partway, the
    // person still can't sign in (no profile behind their session), rather
    // than the reverse order leaving an orphaned profile with no account.
    const { error: profErr } = await admin.from("profiles").delete().eq("id", userId);
    if (profErr) {
      // 23503: something on file still names this person — tickets they
      // raised, crew rows, JHAs, jobs, rate history. Those foreign keys are
      // RESTRICT/NO ACTION on purpose: the records keep their names. So the
      // account is locked instead of deleted — banned in Auth (no sign-in,
      // no token refresh), every tab off, and stamped deactivated so Users &
      // access and the crew pickers know. Reversing it is a Supabase
      // dashboard action (Authentication → Users → unban).
      if (profErr.code !== "23503") throw profErr;
      const { data: who } = await admin.from("profiles").select("name").eq("id", userId).maybeSingle();
      // The profile first, then the ban: half of this can land, and no tabs
      // plus a stamp is the half that reads as locked everywhere — a ban
      // alone leaves a live token writing with every tab for the rest of
      // its hour, and the users screen calling the account ordinary.
      const { error: lockErr } = await admin.from("profiles")
        .update({ tab_access: [], deactivated_at: new Date().toISOString() })
        .eq("id", userId);
      if (lockErr) throw lockErr;
      const { error: banErr } = await admin.auth.admin.updateUserById(userId, { ban_duration: "876000h" });
      // The lock landed and the ban did not. That is still a lock — no tabs
      // and a stamp is what every table and the token hook read — and saying
      // so is what puts the row right in the list; a thrown 400 told the
      // Admin nothing had happened and left them looking at stale tabs.
      if (banErr) {
        await logError("delete-user", `Locked ${userId}, but the Auth ban failed: ${banErr.message}`);
        return new Response(JSON.stringify({
          ok: true, deactivated: true, banFailed: true,
          message: `${who?.name ?? "This person"} has tickets, JHAs or jobs on file, so the account was locked instead of deleted: every tab is off and the app refuses it. Auth would not take the sign-in ban (${banErr.message}) — press Remove account again to finish that half.`
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        ok: true, deactivated: true,
        message: `${who?.name ?? "This person"} has tickets, JHAs or jobs on file, so the account was locked instead of deleted: they can no longer sign in, and every tab is off. Their name stays on the records.`
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const { error: authErr } = await admin.auth.admin.deleteUser(userId);
    if (authErr) throw authErr;

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (e) {
    await logError("delete-user", (e as Error).message);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});

async function logError(functionName: string, message: string, context: Record<string, unknown> = {}) {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort; never let it mask the real error */ }
}
