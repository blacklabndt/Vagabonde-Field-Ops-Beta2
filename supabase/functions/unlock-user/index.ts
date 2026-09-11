// unlock-user — puts back an account that delete-user locked.
//
// An account with tickets, JHAs or jobs on file is never deleted: the
// foreign keys are what keep a name on the history it signed, so
// delete-user bans it in Auth, empties its tabs and stamps
// deactivated_at instead. Until now the only way back was the Supabase
// dashboard (Authentication → Users → unban), which a one-person office
// should not need for a routine act — a tech leaves for the winter and
// comes back in March. This is the mirror of that lock: lift the ban,
// clear the stamp, and give the account the tabs its stored role gets.
//
// Lifting a ban needs the service-role key, which must never reach the
// browser, so this runs server-side and checks the caller is a signed-in
// Admin first — the same door delete-user and create-user use.
//
// The role itself is left exactly as it was. Unlocking is not a promotion:
// the person comes back at the rank they left at, and changing it is the
// Role dropdown's job.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireActiveAdmin } from "../_shared/adminGate.ts";

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
  // account through for as long as Auth still accepted its session, and
  // this is the function where that mattered most — see the self-unlock
  // refusal below.
  const who = await requireActiveAdmin(req, "Only an Admin can unlock an account");
  if (who instanceof Response) return who;
  const { userId: callerId } = who;

  try {
    const { userId } = await req.json();
    // A guard against a client bug, so it should never fire — but whoever
    // reads it pressed a button, and a variable name tells them nothing.
    if (!userId) throw new Error("This request didn't say which account to unlock. Reload the app and try again.");

    // Nobody unlocks themselves. The gate above should already have refused
    // a locked caller, but these are two different failures and either one
    // alone is enough: an unlock is the one act that would UNDO a removal
    // permanently — the ban lifted, the stamp cleared and the tabs written
    // back from the role preset — so it does not rest on a single check.
    // delete-user has refused its own caller from the start; this function
    // went without, and the asymmetry is what hid it.
    if (userId === callerId) {
      return json({ error: "You can't unlock your own account. Ask another Admin to do it." }, 400);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: target, error: readErr } = await admin.from("profiles")
      .select("id, name, role, deactivated_at").eq("id", userId).maybeSingle();
    if (readErr) throw readErr;
    if (!target) throw new Error("That account is no longer in the list — it may have been removed outright. Reload Users & access.");
    // deactivated_at is the app's own record of a lock, written by the same
    // function that set the ban. Nothing to put back if it was never set.
    if (!target.deactivated_at) {
      throw new Error(`${target.name ?? "That account"} isn't locked, so there is nothing to unlock. If they can't sign in, send them a set-password link instead.`);
    }

    // The ban first, then the profile. Half of this landing is possible, and
    // this is the half that reads correctly: the list still shows the account
    // as locked, which is what a second press of Unlock expects. The other
    // order would show it active while Auth still refused the sign-in.
    const { error: banErr } = await admin.auth.admin.updateUserById(userId, { ban_duration: "none" });
    if (banErr) throw banErr;

    // The same source create-user provisions from, so an unlocked account
    // holds exactly what a new one of that rank would.
    let warning = "";
    let tabs: string[] = [];
    const { data: roleTabs, error: tErr } = await admin.rpc("tabs_for_role", { _role: target.role });
    if (tErr) {
      // Not a failed unlock: the ban is already lifted, and leaving the stamp
      // on would say the opposite in the list. The account comes back with no
      // sections, which is a thing to put right on it, not a reason to hide
      // that it can sign in again.
      warning = `The account was unlocked, but the sections a ${target.role} should see couldn't be worked out (${tErr.message}), so it still has none. Press "Reset to role preset" on the account to give them back.`;
    } else {
      tabs = roleTabs ?? [];
    }

    const { error: profErr } = await admin.from("profiles")
      .update({ deactivated_at: null, tab_access: tabs }).eq("id", userId);
    if (profErr) throw profErr;

    return json({
      ok: true,
      user: { id: userId, name: target.name, role: target.role, tab_access: tabs, deactivated_at: null },
      message: `${target.name ?? "This person"} can sign in again, with the password they had and the sections a ${target.role} gets.`,
      ...(warning ? { warning } : {})
    });
  } catch (e) {
    await logError("unlock-user", (e as Error).message);
    return json({ error: (e as Error).message }, 400);
  }
});

async function logError(functionName: string, message: string, context: Record<string, unknown> = {}) {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort; never let it mask the real error */ }
}
