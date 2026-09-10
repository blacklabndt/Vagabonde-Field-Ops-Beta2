// The one body that emails a hazard assessment's PDF — a live press of
// Job detail's "Send to…" (send-jha, after its own door and gate) and a
// scheduled send (scheduled-sends, after fireGate) both come through here,
// so there is one email, one storage read and one sent stamp, never two
// copies free to drift.
//
// Who may send and who receives is settled BEFORE this is called: the
// caller has read the row under the authority it holds and checked the
// gate, and `to`/`cc` are what mail.ts's recipients() returned. This
// module trusts its arguments and does the sending.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendMail, base64, wrapEmail, esc, MAX_ATTACHMENT_BYTES, type Attachment } from "./mail.ts";

// The assessment as the callers' reads return it. supabase-js types an
// embed as a list without database types, so the row is named here and
// cast by the caller.
export interface JobEmbed { job_number?: string | null; project?: string | null; clients?: { name?: string | null } | null }
export interface JhaMailRow {
  id: string; signed_by: string | null; pdf_key: string | null; template: string | null;
  work_date: string | null; status: string | null; site_rep: string | null;
  profiles: { name?: string | null } | null; jobs: JobEmbed | null;
}
export const JHA_MAIL_SELECT = "id, signed_by, pdf_key, template, work_date, status, site_rep, profiles(name), jobs(job_number, project, clients(name))";

export async function mailJha(admin: SupabaseClient, jha: JhaMailRow, to: string, cc: string | undefined, message: string): Promise<{ ok: true; attached: boolean }> {
  if (!jha.pdf_key) throw new Error("This assessment has no PDF yet — render it first");
  const job: JobEmbed = jha.jobs ?? {};
  const filename = jha.pdf_key.split("/").pop() ?? "jha.pdf";

  // A link that outlives the email being forwarded around a bit, but not
  // forever — 14 days, same as a report.
  let link = "";
  let attachments: Attachment[] | undefined;
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
  const signer = jha.profiles?.name ?? "";

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
    to, cc, subject, htmlBody: html, textBody: text,
    attachments, tag: "jha"
  });

  // Record that it went, so the job detail can say so. A failure here is
  // said, not swallowed (see send-report).
  const { error: markErr } = await admin.from("jhas").update({
    sent_at: new Date().toISOString(), sent_to: to
  }).eq("id", jha.id);
  if (markErr) {
    throw new Error(`The assessment went out, but it couldn't be marked as sent — it may still show as unsent; don't send it again. (${markErr.message})`);
  }
  return { ok: true, attached: !!attachments };
}
