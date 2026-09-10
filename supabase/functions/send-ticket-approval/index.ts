// send-ticket-approval — emails the client rep a link to sign a daily ticket.
//
// Attaches a PDF-style summary of the ticket as well as linking to the live
// approval page, so the rep has something to file even before they click.
// The link carries a token — no account, no password, which is the whole
// point: a client rep signs from their phone. It is not single-use: the
// token survives the signing so the rep keeps a way back to the copy they
// put their name to, and re-signing is refused by approve-ticket's
// already-approved branch rather than by burning the token. What ends a
// link is a resend (which mints a new hash over the old one), a withdrawal,
// or the 30-day expiry, which only stops it SIGNING. Only the sha256 hash
// is stored (_shared/approvalToken.ts); the raw token exists in this email
// and nowhere else.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendMail, appSettings, corsHeaders, wrapEmail, esc, recipients, optionalRecipients } from "../_shared/mail.ts";
import { invoicePage, gstLabelOf, invoiceTotals, lineCents } from "../_shared/invoice.ts";
import type { InvoiceLine } from "../_shared/invoice.ts";
import { loadInvoice } from "../_shared/ticketInvoice.ts";
import { hashToken } from "../_shared/approvalToken.ts";

const money = (n: number) =>
  "$" + Number(n).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Who is calling is settled before a single byte of the body is read. The
  // parse and the recipient checks below throw on junk, and the catch at the
  // bottom writes a function_errors row — so leaving them in front of this
  // meant any anonymous POST could put a line in the error log.
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
    const { ticketId, to, cc } = await req.json();
    // A guard against a client bug, so it should never fire — but whoever
    // reads it pressed a button, and a variable name tells them nothing.
    if (!ticketId) throw new Error("This request didn't say which ticket to send. Reload the app and try again.");
    const toList = recipients(to, "to");
    const ccList = optionalRecipients(cc, "cc");

    // The settings read starts here, beside the authority reads, and is
    // awaited where its answer is first needed. The no-op catch is
    // load-bearing: appSettings throws on a read error, and a request that
    // returns before that await (ticket not found, already approved, the
    // 403) would otherwise leave a rejection nobody awaited — fatal in the
    // Edge runtime, mid-chase. The await below still rethrows the same
    // error in the same place. Not in the Promise.all: a settings failure
    // must not pre-empt "Ticket not found".
    const settingsRead = appSettings();
    settingsRead.catch(() => {});

    // The ticket and the caller's role, two reads under the caller's own RLS
    // that need nothing from each other, go out together — "Chase all
    // unsigned" is thousands of these. The checks keep their order.
    const [{ data: ticketRead, error: tErr }, { data: caller }] = await Promise.all([
      // Only what the two gates read: the bill, its job and the work date
      // come from loadInvoice's own read below, so the three-table embed
      // this once carried was two RLS-checked subqueries per send for
      // nothing.
      asUser
        .from("tickets")
        .select("id, technician_id, status")
        .eq("id", ticketId).single(),
      asUser.from("profiles").select("role").eq("id", user.id).single()
    ]);
    // The three columns the two gates read, named rather than inferred.
    const ticket = ticketRead as { id: string; technician_id: string | null; status: string | null } | null;
    if (tErr || !ticket) throw new Error("Ticket not found, or you don't have access to it");
    if (ticket.status === "Approved" || ticket.status === "Invoiced") {
      throw new Error("That ticket is already approved — nothing to send.");
    }

    // Being able to SEE the ticket is not being allowed to send it out for
    // signing: tickets_select is is_staff(), so every signed-in account —
    // Helpers included — can read any ticket. The mint below runs with the
    // service role and so bypasses tickets_update's owner-or-Admin gate;
    // this restores it. Without it, anyone could send a co-worker's ticket
    // to an inbox they control and self-approve a fabricated signature.
    const privileged = caller?.role === "Admin" || caller?.role === "Coordinator";
    if (ticket.technician_id !== user.id && !privileged) {
      return new Response(JSON.stringify({ error: "Only the ticket's technician, or an Admin or Coordinator, can send it for approval." }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 30 days to sign. Long enough to survive a rep's holiday, short enough
    // that a stale forwarded email stops opening a ticket nobody has signed.
    // Not single-use: approve-ticket leaves the token on the row, so once the
    // ticket is signed this same link is the rep's own way back to the copy
    // they put their name to — expiry or no.
    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const expires = new Date(Date.now() + 30 * 86400000).toISOString();

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // One read of the money, with the service role, feeding both the summary
    // in the email and the invoice attached to it. Reading the lines as the
    // caller instead is how a Coordinator — allowed to send a ticket, but not
    // to read ticket_lines (Admin and Technician only, migration
    // 20260903010110) — mailed a client a $0.00 summary beside an attachment
    // showing the real bill. Sending the authority check still belongs to the
    // caller above; only the numbers come from here.
    // One settings read for the whole send: the invoice's terms, the app
    // address the link is built on, and the mail transport. It throws on a
    // read error the way sendMail's own would have.
    const settings = await settingsRead;
    const { data: invoiceData, error: invErr } = await loadInvoice(admin, ticketId, toList, settings.invoice);
    if (invErr || !invoiceData) throw new Error(invErr ?? "Ticket not found");
    // The job and the work date the email names, off the same read the
    // attached bill is printed from.
    const job = invoiceData.job;
    const workDate = invoiceData.ticket.work_date;
    const lines = invoiceData.lines ?? [];

    // Usually absent: a ticket goes out for signing before it is invoiced,
    // and this function refuses an Approved or Invoiced one above. It is
    // here for the ticket that was invoiced, pulled back and re-sent — the
    // number is what the client's accounts department has on file, so the
    // email quotes it rather than making them match the ticket up by hand.
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

    // The link goes to the app's own domain, which proxies this function and
    // re-serves it as HTML — Supabase forces text/plain on HTML returned from
    // the shared functions domain, so a rep following a link straight here is
    // shown the page's source instead of the page. See worker/index.js.
    //
    // The app address is the Worker's origin, e.g. https://app.vagabonde.ca —
    // set on the Admin screen, or the APPROVAL_BASE_URL secret as fallback.
    // Without it the only link that could go out points at the functions
    // domain, where the page arrives as source code; a rep handed that
    // cannot sign, and the ticket would still sit as "Awaiting approval".
    // Refuse instead, and say what to set.
    const appBase = (settings.approvalBaseUrl ?? "").replace(/\/+$/, "");
    if (!appBase) {
      throw new Error("The app address isn't set, so an approval link can't be built — an Admin can set it on the Admin screen (App address).");
    }
    const link = `${appBase}/approve?t=${token}`;

    const rows = lines.map(l =>
      `<tr><td style="padding:6px 0">${esc(l.label)}</td>
       <td style="padding:6px 0;text-align:right;color:#6b6d6e">${esc(l.quantity)} ${esc(l.unit)}</td>
       <td style="padding:6px 0;text-align:right">${money(lineTotal(l))}</td></tr>`
    ).join("");

    const summary = `
      <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#5980a6;margin-bottom:6px">Daily ticket ${esc(ticket.id)}${invoiceNo != null ? ` &middot; Invoice # ${esc(String(invoiceNo))}` : ""}</div>
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
      `Daily ticket ${ticket.id}${invoiceNo != null ? ` · Invoice # ${invoiceNo}` : ""} — ${job.project}`,
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

    // Send first, record second. The other way round — which this used to do —
    // leaves a ticket marked "Awaiting approval" holding a live token when the
    // send throws, so the tracker says it went out and the rep never got it.
    // Resend being unconfigured makes that the *normal* path, not the rare
    // one. send-report already had this order; now they match.
    await sendMail({
      settings,
      from: "billing",
      to: toList, cc: ccList,
      subject: `Field invoice ${ticket.id} for approval — ${job.project} (${money(grand)})`,
      htmlBody: html, textBody: text,
      attachments: [{
        Name: `Field-invoice-${ticket.id}.html`,
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
    // Stored hashed (see _shared/approvalToken.ts): the row is readable by
    // every staff account, and the raw token is the whole credential. Who it
    // went to and who sent it are recorded beside it — a signed ticket then
    // says which inbox was asked, which is the only thing that separates a
    // genuine approval from one a technician mailed to themselves.
    const { error: tokenErr } = await admin.from("tickets").update({
      approval_token: await hashToken(token),
      approval_sent_at: new Date().toISOString(),
      approval_expires_at: expires,
      approval_sent_to: toList,
      approval_sent_by: user.id,
      // A resend answers whatever the rep queried last time: the query is
      // cleared with the fresh link, and the tracker stops showing it.
      queried_at: null,
      query_text: null,
      query_by: null,
      status: "Awaiting approval"
    }).eq("id", ticketId);
    if (tokenErr) {
      throw new Error(
        `The email went out, but the approval link could not be saved — resend the ticket. (${tokenErr.message})`
      );
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (e) {
    await logError("send-ticket-approval", (e as Error).message);
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
