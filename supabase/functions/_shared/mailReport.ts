// The one body that emails a radiographic report — a live press of Job
// detail's "Send to…" (send-report, after its own door and gate) and a
// scheduled send (scheduled-sends, after fireGate) both come through here.
// mailJha.ts's shape: the caller has read the row under its own authority
// and checked the gate, `to`/`cc` are recipients()'s answers, and this
// trusts its arguments and sends.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendMail, base64, wrapEmail, esc, MAX_ATTACHMENT_BYTES, type Attachment } from "./mail.ts";
import type { JobEmbed } from "./mailJha.ts";
import { refuse } from "./publicError.ts";

export interface ReportMailRow {
  id: string; filename: string; pdf_key: string | null;
  welds: number | string | null; result: string | null; jobs: JobEmbed | null;
}
export const REPORT_MAIL_SELECT = "id, filename, pdf_key, welds, result, jobs(job_number, project, clients(name))";

export async function mailReport(admin: SupabaseClient, report: ReportMailRow, to: string, cc: string | undefined, message: string): Promise<{ ok: true; attached: boolean }> {
  // Without a PDF there is no attachment and no link — the contractor gets
  // an email carrying nothing while the row is stamped as sent, which is
  // how a report quietly never goes out. Same guard as the assessment's.
  if (!report.pdf_key) throw refuse("This report has no PDF on file — nothing was sent. Upload it first.");
  const job: JobEmbed = report.jobs ?? {};

  // A link that outlives the email being forwarded around a bit, but not
  // forever — 14 days is about one turnover cycle.
  let link = "";
  let attachments: Attachment[] | undefined;
  let attachmentNote = "";

  // The link and the bytes are independent storage calls; together.
  const [{ data: signed }, { data: blob }] = await Promise.all([
    admin.storage.from("reports").createSignedUrl(report.pdf_key, 60 * 60 * 24 * 14),
    admin.storage.from("reports").download(report.pdf_key)
  ]);
  link = signed?.signedUrl ?? "";

  if (blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length <= MAX_ATTACHMENT_BYTES) {
      attachments = [{
        Name: report.filename,
        Content: base64(bytes),
        ContentType: "application/pdf"
      }];
    } else {
      attachmentNote =
        "<p style=\"color:#6b6d6e\">The file was too large to attach — use the link above to download it.</p>";
    }
  }
  // Both storage calls are individually best-effort, but an email with
  // neither the attachment nor a working link delivers nothing while
  // the row records it as sent. A report that has a PDF on file must
  // ship at least one way, or the send is a failure and has to say so.
  if (!link && !attachments) {
    throw refuse("Couldn't read the report's PDF from storage — nothing was sent. Try again shortly.");
  }

  const subject = `${job.job_number} · ${job.project} — radiographic report${report.welds ? " (" + report.welds + ")" : ""}`;
  const note = (message || "").trim();

  const html = wrapEmail(`
    <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#5980a6;margin-bottom:6px">Radiographic report</div>
    <div style="font-size:22px;font-weight:600;margin-bottom:4px">${esc(job.project)}</div>
    <div style="color:#6b6d6e;margin-bottom:18px">${esc(job.job_number)} · ${esc(job.clients?.name)}</div>
    ${note ? `<p>${esc(note).replace(/\n/g, "<br>")}</p>` : ""}
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid rgba(29,31,32,.2);margin:18px 0 0">
      <tr><td style="padding:8px 0;color:#6b6d6e;width:120px">File</td><td style="padding:8px 0">${esc(report.filename)}</td></tr>
      ${report.welds ? `<tr><td style="padding:8px 0;color:#6b6d6e">Welds</td><td style="padding:8px 0">${esc(report.welds)}</td></tr>` : ""}
      ${report.result ? `<tr><td style="padding:8px 0;color:#6b6d6e">Result</td><td style="padding:8px 0">${esc(report.result)}</td></tr>` : ""}
    </table>
    ${link ? `<p style="margin-top:22px"><a href="${link}" style="display:inline-block;background:#5980a6;color:#f2f2f3;text-decoration:none;padding:11px 20px;font-weight:600">Download the report</a></p>
    <p style="font-size:11px;color:#6b6d6e">The report is attached, and this link works for 14 days.</p>` : ""}
    ${attachmentNote}
  `);

  const text = [
    `${job.job_number} — ${job.project}`,
    job.clients?.name ?? "",
    "",
    note,
    "",
    `File: ${report.filename}`,
    report.welds ? `Welds: ${report.welds}` : "",
    report.result ? `Result: ${report.result}` : "",
    link ? `\nDownload (14 days): ${link}` : ""
  ].filter(Boolean).join("\n");

  await sendMail({
    from: "reports",
    to, cc, subject, htmlBody: html, textBody: text,
    attachments, tag: "report"
  });

  // Record that it went, so the job detail's "Sent" column is truthful.
  // A failure here is said, not swallowed: the report is in the
  // contractor's inbox either way, and a row still reading "unsent" is
  // how the same private link gets mailed twice.
  const { error: markErr } = await admin.from("reports").update({
    sent_at: new Date().toISOString(), sent_to: to
  }).eq("id", report.id);
  if (markErr) {
    throw refuse("The report went out, but it couldn't be marked as sent — it may still show as pending; don't send it again.", markErr.message);
  }
  return { ok: true, attached: !!attachments };
}
