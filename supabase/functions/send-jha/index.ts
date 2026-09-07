// send-jha — emails a hazard assessment to whoever needs it on file.
//
// Same shape as send-report: the PDF goes both ways — attached (site reps
// file it straight into the day's package) and as a secure link (survives
// size limits and a forwarded thread that drops the attachment).
//
// Runs server-side because it holds the Resend key and needs the
// service-role key to read a private storage object. The caller's own JWT is
// checked first, so this can't be used as an open relay.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendMail, base64, corsHeaders, wrapEmail, esc, MAX_ATTACHMENT_BYTES,
         recipients, optionalRecipients } from "../_shared/mail.ts";

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
    const [{ data: jha, error: jErr }, { data: caller }] = await Promise.all([
      asUser
        .from("jhas")
        .select("id, signed_by, pdf_key, template, work_date, status, site_rep, profiles(name), jobs(job_number, project, clients(name))")
        .eq("id", jhaId).single(),
      asUser.from("profiles").select("role").eq("id", user.id).single()
    ]);
    if (jErr || !jha) throw new Error("Assessment not found, or you don't have access to it");
    if (!jha.pdf_key) throw new Error("This assessment has no PDF yet — render it first");

    // Reading an assessment (jhas read includes the 'job' tab, which
    // Helpers hold) is not leave to mail its PDF anywhere: a JHA carries
    // worker names, cert numbers, dosimetry and signatures, and the send
    // signs a 14-day URL with the service role. The tech who filed it may
    // send it; otherwise it takes a Technician, Coordinator or Admin.
    const mayEmailJha = (jha as any).signed_by === user.id
      || ["Admin", "Coordinator", "Technician"].includes(caller?.role ?? "");
    if (!mayEmailJha) {
      return new Response(JSON.stringify({ error: "Only the technician who filed this assessment, or a Technician, Coordinator or Admin, can email it." }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const job = jha.jobs as any;
    const filename = jha.pdf_key.split("/").pop() ?? "jha.pdf";
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 2. A link that outlives the email being forwarded around a bit, but not
    // forever — 14 days, same as a report.
    let link = "";
    let attachments = undefined;
    let attachmentNote = "";

    // The link and the bytes are independent storage calls; together.
    const [{ data: signed }, { data: blob }] = await Promise.all([
      admin.storage.from("jhas").createSignedUrl(jha.pdf_key, 60 * 60 * 24 * 14),
      admin.storage.from("jhas").download(jha.pdf_key)
    ]);
    link = signed?.signedUrl ?? "";

    if (blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length <= MAX_ATTACHMENT_BYTES) {
        attachments = [{
          Name: filename,
          Content: base64(bytes),
          ContentType: "application/pdf"
        }];
      } else {
        attachmentNote =
          "<p style=\"color:#6b6d6e\">The file was too large to attach — use the link above to download it.</p>";
      }
    }

    // Both storage calls are individually best-effort, but an email with
    // neither the attachment nor a working link delivers nothing while the
    // row records it as sent. If no path to the document survived, this is
    // a failed send and has to say so.
    if (!link && !attachments) {
      throw new Error("Couldn't read the assessment's PDF from storage — nothing was sent. Try again, or re-render the PDF first.");
    }

    const subject = `${job.job_number} · ${job.project} — hazard assessment${jha.work_date ? " (" + jha.work_date + ")" : ""}`;
    const note = (message || "").trim();
    const signer = (jha.profiles as any)?.name ?? "";

    const html = wrapEmail(`
      <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#5980a6;margin-bottom:6px">Hazard assessment</div>
      <div style="font-size:22px;font-weight:600;margin-bottom:4px">${esc(job.project)}</div>
      <div style="color:#6b6d6e;margin-bottom:18px">${esc(job.job_number)} · ${esc(job.clients?.name)}</div>
      ${note ? `<p>${esc(note).replace(/\n/g, "<br>")}</p>` : ""}
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid rgba(29,31,32,.2);margin:18px 0 0">
        <tr><td style="padding:8px 0;color:#6b6d6e;width:120px">File</td><td style="padding:8px 0">${esc(filename)}</td></tr>
        ${jha.work_date ? `<tr><td style="padding:8px 0;color:#6b6d6e">Work date</td><td style="padding:8px 0">${esc(jha.work_date)}</td></tr>` : ""}
        ${jha.template ? `<tr><td style="padding:8px 0;color:#6b6d6e">Template</td><td style="padding:8px 0">${esc(jha.template)}</td></tr>` : ""}
        ${signer ? `<tr><td style="padding:8px 0;color:#6b6d6e">Signed by</td><td style="padding:8px 0">${esc(signer)}</td></tr>` : ""}
        ${jha.status ? `<tr><td style="padding:8px 0;color:#6b6d6e">Status</td><td style="padding:8px 0">${esc(jha.status)}</td></tr>` : ""}
      </table>
      ${link ? `<p style="margin-top:22px"><a href="${link}" style="display:inline-block;background:#5980a6;color:#f2f2f3;text-decoration:none;padding:11px 20px;font-weight:600">Download the assessment</a></p>
      <p style="font-size:11px;color:#6b6d6e">The assessment is attached, and this link works for 14 days.</p>` : ""}
      ${attachmentNote}
    `);

    const text = [
      `${job.job_number} — ${job.project}`,
      job.clients?.name ?? "",
      "",
      note,
      "",
      `File: ${filename}`,
      jha.work_date ? `Work date: ${jha.work_date}` : "",
      signer ? `Signed by: ${signer}` : "",
      link ? `\nDownload (14 days): ${link}` : ""
    ].filter(Boolean).join("\n");

    await sendMail({
      from: "reports",
      to: toList, cc: ccList, subject, htmlBody: html, textBody: text,
      attachments, tag: "jha"
    });

    // 3. Record that it went, so the job detail can say so. A failure here
    // is said, not swallowed (see send-report).
    const { error: markErr } = await admin.from("jhas").update({
      sent_at: new Date().toISOString(), sent_to: toList
    }).eq("id", jhaId);
    if (markErr) {
      throw new Error(`The assessment went out, but it couldn't be marked as sent — it may still show as unsent; don't send it again. (${markErr.message})`);
    }

    return new Response(JSON.stringify({ ok: true, attached: !!attachments }), {
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
