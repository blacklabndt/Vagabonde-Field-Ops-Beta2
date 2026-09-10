// send-jha — emails a hazard assessment to whoever needs it on file.
//
// Same shape as send-report: the PDF goes both ways — attached (site reps
// file it straight into the day's package) and as a secure link (survives
// size limits and a forwarded thread that drops the attachment).
//
// Runs server-side because it holds the Resend key and needs the
// service-role key to read a private storage object. The caller's own JWT is
// checked first, so this can't be used as an open relay.
//
// This file is the door and the gate; the send itself is _shared/mailJha.ts,
// which a scheduled send (scheduled-sends) comes through as well, after a
// gate of its own — one email body, one sent stamp.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, recipients, optionalRecipients } from "../_shared/mail.ts";
import { mailJha, JHA_MAIL_SELECT, type JhaMailRow } from "../_shared/mailJha.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // 1. Who's asking? Reject anything without a valid session — before the
  // body is even parsed. The parse and the recipient checks below throw on
  // junk, and the catch at the bottom writes that to function_errors: an
  // anonymous POST must not be able to fill the error log.
  const authHeader = req.headers.get("Authorization") ?? "";
  const asUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return new Response(JSON.stringify({ error: "Not signed in" }), {
    status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
  });

  try {
    const { jhaId, to, cc, message } = await req.json();
    // A guard against a client bug, so it should never fire — but whoever
    // reads it pressed a button, and a variable name tells them nothing.
    if (!jhaId) throw new Error("This request didn't say which hazard assessment to send. Reload the app and try again.");
    // The caller check above proves who is asking, not who receives — the
    // link this email carries opens a private PDF for 14 days.
    const toList = recipients(to, "to");
    const ccList = optionalRecipients(cc, "cc");

    // RLS still applies to this read, so a user who can't see the assessment
    // can't email it either.
    // The assessment and the caller's role, two reads under the caller's own
    // RLS that need nothing from each other, go out together; the checks
    // keep their order.
    const [{ data: jhaRead, error: jErr }, { data: caller }] = await Promise.all([
      asUser.from("jhas").select(JHA_MAIL_SELECT).eq("id", jhaId).single(),
      asUser.from("profiles").select("role").eq("id", user.id).single()
    ]);
    const jha = jhaRead as unknown as JhaMailRow | null;
    if (jErr || !jha) throw new Error("Assessment not found, or you don't have access to it");
    if (!jha.pdf_key) throw new Error("This assessment has no PDF yet — render it first");

    // Reading an assessment (jhas read includes the 'job' tab, which
    // Helpers hold) is not leave to mail its PDF anywhere: a JHA carries
    // worker names, cert numbers, dosimetry and signatures, and the send
    // signs a 14-day URL with the service role. The tech who filed it may
    // send it; otherwise it takes a Technician, Coordinator or Admin.
    const mayEmailJha = jha.signed_by === user.id
      || ["Admin", "Coordinator", "Technician"].includes(caller?.role ?? "");
    if (!mayEmailJha) {
      return new Response(JSON.stringify({ error: "Only the technician who filed this assessment, or a Technician, Coordinator or Admin, can email it." }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const result = await mailJha(admin, jha, toList, ccList, message);
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (e) {
    await logError("send-jha", (e as Error).message);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});

// Logged with a throwaway service-role client rather than trying to reuse
// `admin` from above, since a failure early in the handler (before `admin`
// exists) still needs somewhere to log to.
async function logError(functionName: string, message: string, context: Record<string, unknown> = {}) {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort; never let it mask the real error */ }
}
