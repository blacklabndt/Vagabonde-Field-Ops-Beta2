// send-report — emails a radiographic report to the contractor.
//
// Sends the PDF BOTH ways: attached (what contractors expect and can file
// straight into their turnover package) and as a secure link (survives size
// limits, and can be re-opened if the attachment gets lost in a thread).
//
// Runs server-side because it holds the Resend key and needs the
// service-role key to read a private storage object. The caller's own JWT is
// checked first, so this can't be used as an open relay.
//
// This file is the door and the gate; the send itself is
// _shared/mailReport.ts, which a scheduled send (scheduled-sends) comes
// through as well, after a gate of its own — one email body, one sent stamp.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, recipients, optionalRecipients } from "../_shared/mail.ts";
import { mailReport, REPORT_MAIL_SELECT, type ReportMailRow } from "../_shared/mailReport.ts";

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
    const { reportId, to, cc, message } = await req.json();
    // A guard against a client bug, so it should never fire — but whoever
    // reads it pressed a button, and a variable name tells them nothing.
    if (!reportId) throw new Error("This request didn't say which report to send. Reload the app and try again.");
    // The caller check above proves who is asking, not who receives — the
    // link this email carries opens a private PDF for 14 days.
    const toList = recipients(to, "to");
    const ccList = optionalRecipients(cc, "cc");

    // Seeing a report is not the same as being allowed to mail it off the
    // premises: reports_select includes the 'job' tab, which Helpers hold,
    // so a Helper can read every report in the database. The send below
    // signs a 14-day URL and attaches the raw PDF with the service role —
    // a private-data exfiltration path from vagabonde.ca's own domain.
    // Emailing a report is a Technician-or-office job; Helpers cannot.
    // The caller's role and the report are two reads under the caller's own
    // RLS that need nothing from each other, so they go out together; the
    // checks keep their order below. (RLS still applies to the report read,
    // so a user who can't see the report can't email it either.)
    const [{ data: caller }, { data: reportRead, error: rErr }] = await Promise.all([
      asUser.from("profiles").select("role").eq("id", user.id).single(),
      asUser.from("reports").select(REPORT_MAIL_SELECT).eq("id", reportId).single()
    ]);
    const report = reportRead as unknown as ReportMailRow | null;
    if (!["Admin", "Coordinator", "Technician"].includes(caller?.role ?? "")) {
      return new Response(JSON.stringify({ error: "Only a Technician, Coordinator or Admin can email a report." }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    if (rErr || !report) throw new Error("Report not found, or you don't have access to it");
    // Without a PDF there is no attachment and no link — the contractor gets
    // an email carrying nothing while the row is stamped as sent, which is
    // how a report quietly never goes out. Same guard as send-jha.
    if (!report.pdf_key) throw new Error("This report has no PDF on file — nothing was sent. Upload it first.");

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const result = await mailReport(admin, report, toList, ccList, message);
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (e) {
    await logError("send-report", (e as Error).message);
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
