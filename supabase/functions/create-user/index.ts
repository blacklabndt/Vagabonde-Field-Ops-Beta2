// create-user — provisions a staff account, Admin-to-Admin.
//
// Account creation used to go through the public signUp endpoint with the
// role riding in client metadata — which meant the rank was ultimately the
// client's claim, on an endpoint that answers to anyone holding the
// publishable key. The provisioning trigger now caps metadata roles to the
// field ones (see migration 20260826035549), and this function is where a
// real rank gets written: verify the caller is a signed-in Admin, create
// the auth user with the service role, then set the profile's role and
// tabs directly. With the app calling this instead of signUp, public
// sign-ups can be switched off in the dashboard entirely.
//
// Accounts arrive email-confirmed: the admin standing there creating it is
// the confirmation, and the new tech can sign in immediately.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendSetPasswordLink } from "../_shared/setPassword.ts";
import { requireActiveAdmin } from "../_shared/adminGate.ts";
import { refuse, publicWords, loggedWords } from "../_shared/publicError.ts";

// The one sentence anything unmarked comes back as. Our own refusals above
// say what to do and are shown as they are written; a message from Postgres,
// Auth or Resend names columns, constraints and accounts, so it is logged and
// not shown. Deny by default: the cost of forgetting is silence.
const TROUBLE = "The account could not be created. Try again, and tell the office if it keeps happening.";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// The same four ranks as the profiles_role_check constraint and
// ROLE_PRESETS in vite-app/src/data.js.
const VALID_ROLES = ["Admin", "Coordinator", "Technician", "Helper"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Who is asking comes before anything is read from them: the parse and the
  // checks below throw on junk, and the catch at the bottom writes that to
  // function_errors — a log an anonymous POST must not be able to fill.
  // The whole question is adminGate's: signed in, a profile that is there,
  // unlocked, holding a tab, and an Admin. The rank alone let a locked
  // account through for as long as Auth still accepted its session.
  const who = await requireActiveAdmin(req, "Only an Admin can create an account");
  if (who instanceof Response) return who;

  try {
    const { email, password, name, role, cert, invite } = await req.json();
    // These three guard against a client that sent the wrong shape, so they
    // should never fire — but if one does, it is read by whoever pressed
    // Create account, not by whoever wrote the call.
    if (!email) throw refuse("No email address came through for the new account. Fill in the Email box and press Create account again.");
    // An invited account gets a password nobody knows; the person chooses
    // their own from the set-password link mailed below.
    const secret = invite ? crypto.randomUUID() + crypto.randomUUID() : password;
    if (!secret) throw refuse("No password came through, and this account wasn't set to be emailed a set-password link. Type a temporary password, or tick “Email them a link to set their own password”.");
    if (!VALID_ROLES.includes(role)) throw refuse("That isn't a role this app knows. Pick one of: " + VALID_ROLES.join(", ") + ".");

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email, password: secret, email_confirm: true,
      user_metadata: { name, role, cert }
    });
    if (cErr) throw cErr;
    const userId = created.user!.id;

    // The trigger has already provisioned a profile off the metadata, but
    // it deliberately caps metadata roles to the field ones — the real
    // rank is written here, by the path that proved its caller is an
    // Admin. tabs_for_role keeps the tab set in step with the rank.
    //
    // Neither of these is a failed account: the Auth user and the trigger's
    // profile both exist by now, at the trigger's capped rank. Both used to
    // throw, which came back as a 400 — the dialog stayed open, the list was
    // never reloaded, and pressing Create again answered "email already
    // registered" about an account nobody could see. They travel the same
    // way the invitation's failure does: the account, and a warning that
    // names what to put right on it.
    let warning = "";
    const { data: tabs, error: tErr } = await admin.rpc("tabs_for_role", { _role: role });
    if (tErr) {
      await logError("create-user", tErr.message);
      warning = `The account was created, but the sections a ${role} should see couldn't be worked out, so it has the ones a new account starts with. Open the account in the list and set its role again.`;
    } else {
      const { error: pErr } = await admin.from("profiles")
        .update({ role, tab_access: tabs }).eq("id", userId);
      if (pErr) {
        await logError("create-user", pErr.message);
        warning = `The account was created, but its role couldn't be set to ${role}, so it is still the rank a new account starts at. Open the account in the list and change the role there.`;
      }
    }

    // The invitation. A mail failure is not a failed account either — so it
    // joins whatever is already outstanding rather than replacing it.
    if (invite) {
      try {
        await sendSetPasswordLink(admin, email, name, "invite");
      } catch (e) {
        await logError("create-user", loggedWords(e));
        const why = `the invitation email didn't go out (${publicWords(e, "the mail provider refused it")})`;
        const howToFix = `Open the account in the list and press "Email a set-password link".`;
        warning = warning
          ? `${warning} Also, ${why}. ${howToFix}`
          : `The account was created, but ${why}. ${howToFix}`;
      }
    }

    return json({ ok: true, user: { id: userId, email }, invited: !!invite, ...(warning ? { warning } : {}) });
  } catch (e) {
    await logError("create-user", loggedWords(e));
    return json({ error: publicWords(e, TROUBLE) }, 400);
  }
});

async function logError(functionName: string, message: string, context: Record<string, unknown> = {}) {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort; never let it mask the real error */ }
}
