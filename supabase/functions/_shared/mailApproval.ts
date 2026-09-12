// The one body that emails a client rep a link to sign a daily ticket — a
// live press (send-ticket-approval, after its own door and gate; the
// tracker's chase is thousands of those) and a scheduled send
// (scheduled-sends, after fireGate) both come through here.
//
// mailJha.ts's shape: who may send is settled BEFORE this is called, and
// `to`/`cc` are recipients()'s answers. `sentBy` is the account the send
// is recorded against — the caller for a live press, the person who
// scheduled it for a timer — because a signed ticket then says which
// inbox was asked and by whom, the only thing that separates a genuine
// approval from one a technician mailed to themselves.
//
// The link carries a token — no account, no password, which is the whole
// point: a client rep signs from their phone. It is not single-use: the
// token survives the signing so the rep keeps a way back to the copy they
// put their name to, and re-signing is refused by approve-ticket's
// already-approved branch rather than by burning the token. What ends a
// link is a resend (which mints a new hash over the old one), a
// withdrawal, or the 30-day expiry, which only stops it SIGNING. Only the
// sha256 hash is stored (approvalToken.ts); the raw token exists in this
// email and nowhere else.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendMail, wrapEmail, esc, type AppSettings } from "./mail.ts";
import { invoicePage, gstLabelOf, invoiceTotals, lineCents } from "./invoice.ts";
import type { InvoiceLine } from "./invoice.ts";
import { loadInvoice } from "./ticketInvoice.ts";
import { hashToken } from "./approvalToken.ts";
import { refuse } from "./publicError.ts";

const money = (n: number) =>
  "$" + Number(n).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function mailApproval(
  admin: SupabaseClient, ticketId: string, to: string, cc: string | undefined, sentBy: string, settings: AppSettings
): Promise<{ ok: true }> {
  // Reserve once, before rendering or sending. Concurrent sends and retries
  // must use the same rate even if an Admin edits the client meanwhile.
  // A failed email keeps this reservation but never marks approval sent.
  const { error: gstErr } = await admin.rpc("freeze_ticket_gst", { p_ticket_id: ticketId });
  if (gstErr) throw refuse("The ticket's tax rate could not be reserved, so nothing was sent. Try again, and tell the office if it keeps happening.", gstErr.message);

  // 30 days to sign. Long enough to survive a rep's holiday, short enough
  // that a stale forwarded email stops opening a ticket nobody has signed.
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const expires = new Date(Date.now() + 30 * 86400000).toISOString();

  // One read of the money, with the service role, feeding both the summary
  // in the email and the invoice attached to it. Reading the lines as the
  // caller instead is how a Coordinator — allowed to send a ticket, but not
  // to read ticket_lines (Admin and Technician only, migration
  // 20260903010110) — mailed a client a $0.00 summary beside an attachment
  // showing the real bill. The authority check belongs to the caller;
  // only the numbers come from here. One settings read for the whole send:
  // the invoice's terms, the app address the link is built on, and the
  // mail transport.
  const { data: invoiceData, error: invErr } = await loadInvoice(admin, ticketId, to, settings.invoice);
  if (invErr || !invoiceData) throw refuse("That ticket could not be read, so nothing was sent.", invErr ?? "no invoice row");
  // The job and the work date the email names, off the same read the
  // attached bill is printed from.
  const job = invoiceData.job;
  const workDate = invoiceData.ticket.work_date;
  const lines = invoiceData.lines ?? [];

  // Usually absent: a ticket goes out for signing before it is invoiced,
  // and the callers refuse an Approved or Invoiced one. It is here for the
  // ticket that was invoiced, pulled back and re-sent — the number is what
  // the client's accounts department has on file, so the email quotes it
  // rather than making them match the ticket up by hand.
  const invoiceNo = invoiceData.ticket.invoice_number;

  // Summed from the lines, like the invoice does, rather than read off
  // tickets.total — the email and the document it links to must not be
  // able to quote a client two different numbers. invoice.ts's own
  // lineCents, not a copy of it: a float product here once printed the
  // lines a cent under the subtotal three rows below them.
  const lineTotal = (l: InvoiceLine) => lineCents(l) / 100;
  // One formula, shared with the invoice and the approval page — a third
  // hand-rolled copy here was a third number free to disagree.
  const totals = invoiceTotals(invoiceData);
  const subtotal = totals.subtotal / 100;
  const gst = totals.gst / 100;
  const grand = totals.grand / 100;

  // The link goes to the app's own domain, which proxies the approval
  // function and re-serves it as HTML — Supabase forces text/plain on HTML
  // returned from the shared functions domain, so a rep following a link
  // straight there is shown the page's source instead of the page. See
  // worker/index.js.
  //
  // The app address is the Worker's origin, e.g. https://app.vagabonde.ca —
  // set on the Admin screen, or the APPROVAL_BASE_URL secret as fallback.
  // Without it the only link that could go out points at the functions
  // domain, where the page arrives as source code; a rep handed that
  // cannot sign, and the ticket would still sit as "Awaiting approval".
  // Refuse instead, and say what to set.
  const appBase = (settings.approvalBaseUrl ?? "").replace(/\/+$/, "");
  if (!appBase) {
    throw refuse("The app address isn't set, so an approval link can't be built — an Admin can set it on the Admin screen (App address).");
  }
  const link = `${appBase}/approve?t=${token}`;

  const rows = lines.map(l =>
    `<tr><td style="padding:6px 0">${esc(l.label)}</td>
     <td style="padding:6px 0;text-align:right;color:#6b6d6e">${esc(l.quantity)} ${esc(l.unit)}</td>
     <td style="padding:6px 0;text-align:right">${money(lineTotal(l))}</td></tr>`
  ).join("");

  const summary = `
    <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#5980a6;margin-bottom:6px">Daily ticket ${esc(ticketId)}${invoiceNo != null ? ` &middot; Invoice # ${esc(String(invoiceNo))}` : ""}</div>
    <div style="font-size:22px;font-weight:600;margin-bottom:4px">${esc(job.project)}</div>
    <div style="color:#6b6d6e;margin-bottom:18px">${esc(job.job_number)} · ${esc(job.clients?.name)}${job.lsd ? " · " + esc(job.lsd) : ""}${job.afe ? " · AFE " + esc(job.afe) : ""}</div>
    <div style="color:#6b6d6e;margin-bottom:10px">Work performed ${esc(workDate)}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid rgba(29,31,32,.2);border-bottom:1px solid rgba(29,31,32,.2)">
      ${rows}
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-top:10px">
      <tr><td style="color:#6b6d6e">Subtotal</td>
          <td style="text-align:right;color:#6b6d6e">${money(subtotal)}</td></tr>
      <tr><td style="color:#6b6d6e">${esc(gstLabelOf(invoiceData))}</td>
          <td style="text-align:right;color:#6b6d6e">${money(gst)}</td></tr>
      <tr><td style="font-weight:600;padding-top:6px">Total due</td>
          <td style="text-align:right;font-size:20px;font-weight:600;padding-top:6px">${money(grand)}</td></tr>
    </table>`;

  const html = wrapEmail(`
    ${summary}
    <p style="margin-top:24px"><a href="${link}" style="display:inline-block;background:#5980a6;color:#f2f2f3;text-decoration:none;padding:13px 24px;font-weight:600">Review &amp; approve this ticket</a></p>
    <p style="font-size:11px;color:#6b6d6e">A copy is attached for your records. The approval link is good for 30 days to sign; afterwards it stays your way back to the signed copy.</p>
  `);

  const text = [
    `Daily ticket ${ticketId}${invoiceNo != null ? ` · Invoice # ${invoiceNo}` : ""} — ${job.project}`,
    `${job.job_number} · ${job.clients?.name ?? ""}`,
    `Work performed ${workDate}`,
    "",
    ...lines.map(l => `${l.label} — ${l.quantity} ${l.unit ?? ""} — ${money(lineTotal(l))}`),
    "",
    `Subtotal: ${money(subtotal)}`,
    `${gstLabelOf(invoiceData)}: ${money(gst)}`,
    `Total due: ${money(grand)}`,
    "",
    `Approve: ${link}`
  ].join("\n");

  // The attachment is the full field invoice as a standalone HTML file —
  // the same document the approval page renders, so a rep who files the
  // attachment and a rep who clicks the link are looking at one bill. It
  // opens and prints from a browser without needing a PDF renderer here.
  // It renders the same invoiceData the summary above was built from.
  const attachment = invoicePage(invoiceData);
  const encoded = btoa(unescape(encodeURIComponent(attachment)));

  // Send first, record second. The other way round leaves a ticket marked
  // "Awaiting approval" holding a live token when the send throws, so the
  // tracker says it went out and the rep never got it. Resend being
  // unconfigured makes that the *normal* path, not the rare one.
  await sendMail({
    settings,
    from: "billing",
    to, cc,
    subject: `Field invoice ${ticketId} for approval — ${job.project} (${money(grand)})`,
    htmlBody: html, textBody: text,
    attachments: [{
      Name: `Field-invoice-${ticketId}.html`,
      Content: encoded,
      ContentType: "text/html"
    }],
    tag: "ticket-approval"
  });

  // The token exists only in memory until this lands. If the write fails,
  // the emailed link points at a token no row holds — approve-ticket would
  // tell the rep the link is no longer valid — so a failure here has to
  // surface as one, not vanish behind ok:true.
  //
  // Stored hashed (see approvalToken.ts): the row is readable by every
  // staff account, and the raw token is the whole credential.
  const { error: tokenErr } = await admin.from("tickets").update({
    approval_token: await hashToken(token),
    approval_sent_at: new Date().toISOString(),
    approval_expires_at: expires,
    approval_sent_to: to,
    approval_sent_by: sentBy,
    // A resend answers whatever the rep queried last time: the query is
    // cleared with the fresh link, and the tracker stops showing it.
    queried_at: null,
    query_text: null,
    query_by: null,
    status: "Awaiting approval"
  }).eq("id", ticketId);
  if (tokenErr) {
    throw refuse(
      "The email went out, but the approval link could not be saved — resend the ticket.",
      tokenErr.message
    );
  }
  return { ok: true };
}
