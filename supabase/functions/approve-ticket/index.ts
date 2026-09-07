// approve-ticket — the public page a client rep lands on from the email.
//
// No account, no login: the token in the URL is the credential. The page is
// rendered here rather than served as a static file because the ticket has to
// be read with the service role — an anonymous browser has no RLS grant to
// see it, and shouldn't.
//
// GET  ?t=token  → the ticket, read-only, with an Approve button
// POST ?t=token  → records the approval
//
// The token outlives the signing. It used to be burned on success, which
// meant a rep who refreshed, pressed back, or opened the link again a week
// later was told their link had been used up — and a resend refuses an
// approved ticket, so there was no way back to the copy they had signed.
// The link is now the rep's own receipt, and once the ticket is signed it
// keeps working past the 30 days — expiry is only there to stop an old link
// SIGNING something, and re-signing is impossible either way (the
// already-approved branch returns before both the expiry check and the POST
// handler, and the update is conditional on approved_at being null).
//
// The row holds a hash of the token, never the token (see
// _shared/approvalToken.ts): the tickets table is readable by every staff
// account, and a raw token there was a way for anyone signed in to sign a
// colleague's ticket as the client.
//
// Runs without JWT verification — the rep has no bearer token, only the
// link — pinned by [functions.approve-ticket] in supabase/config.toml so a
// deploy can't quietly turn verification back on and 401 every approval.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { esc, sendMail, appSettings, wrapEmail } from "../_shared/mail.ts";
import { renderInvoice, invoiceCss, invoiceTotals, moneyCents, edmontonStamp, gstPercentOf } from "../_shared/invoice.ts";
import type { InvoiceData } from "../_shared/invoice.ts";
import { loadInvoice } from "../_shared/ticketInvoice.ts";
import { hashToken, invoiceFingerprint } from "../_shared/approvalToken.ts";

// A signature is a typed name and, optionally, a small PNG. Anything bigger
// than this is not a form a person filled in, and formData() would buffer
// the lot before anything here could object.
const MAX_BODY_BYTES = 1_000_000;
const MAX_NAME_CHARS = 120;
const MAX_QUERY_CHARS = 2000;

// How long after a query the office is left in peace before another one
// mails them. Every query is recorded whatever this says; only the mail
// waits. A rep with a second thing to say a quarter of an hour later is a
// real person; a hundred posts in a minute is a forwarded link, a double
// tap, or worse.
const QUERY_COOLDOWN_MS = 15 * 60 * 1000;

// The invoice supplies its own .sheet and its own table styling, so this adds
// only what sits around it: the sign form, notices, and the stamp. The old
// shell defined .sheet and td itself and would have fought the document it is
// now wrapping.
const page = (inner: string) => new Response(
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Field invoice · VagaboNDE</title>
<style>
${invoiceCss}
  .plain { width:min(560px,100%); margin:0 auto; background:var(--paper);
           border:1px solid var(--hard); padding:26px 24px }
  .kicker { font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:var(--accent) }
  h1 { font-size:26px; margin:6px 0 4px; font-weight:600 }
  .meta { color:var(--mute); margin-bottom:20px; font-size:13px }
  /* Reads as the foot of the invoice rather than as something floating below
     it: same width, same paper, butted straight onto the sheet above. */
  .actions { width:min(940px,100%); margin:0 auto; background:var(--paper);
             border:1px solid var(--hard); border-top:0; padding:16px 22px 20px }
  /* The ask, above the bill that justifies it. Same sheet width, butted onto
     the TOP of the invoice the way .actions is butted onto the bottom, so
     the three read as one document rather than as a banner over a page. */
  .ask { width:min(940px,100%); margin:0 auto; background:var(--paper);
         border:1px solid var(--hard); border-bottom:0; padding:13px 22px;
         display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 16px }
  .ask .tkt { font-size:15px; font-weight:600 }
  .ask .due { font-size:15px; font-variant-numeric:tabular-nums }
  /* margin-left:auto parks the link at the right on a wide screen and, once
     the strip wraps on a phone, on its own line under the amount. */
  .ask .jump { margin-left:auto; font-size:15px; font-weight:600; color:var(--accent) }
  /* display:block on the input and a margin on the button. Without both the
     button painted over the name box — the input is inline by default, so it
     did not reserve its own line, and the button had no gap above it. */
  /* Not .sig — invoiceCss uses that for the invoice's signature table row
     and pins it to height:40px. Sharing the name clamped this label, the
     input overflowed it, and the button laid out over the top of the box
     the client types their name into. */
  label.signbox { display:block; font-size:12px; color:var(--mute) }
  input { display:block; width:100%; margin-top:6px; padding:11px 12px;
          border:1px solid var(--hard); background:#fff; color:var(--ink);
          font-size:15px; font-family:inherit }
  input:focus { outline:2px solid var(--accent); outline-offset:-2px }
  button { display:block; width:100%; min-height:52px; margin-top:14px; border:0;
           background:var(--accent); color:#fff; font-size:16px; font-weight:600;
           cursor:pointer }
  button:hover { background:#4a6d90 }
  button:disabled { opacity:.5; cursor:default }
  /* Every note this page speaks in its own voice: the receipt lines and the
     legal line under Approve. Deliberately NOT the invoice's .note, which is
     9.5px fine print for a legend — what a rep is told they are agreeing to
     has to be readable on the phone they are agreeing on. */
  .signnote { font-size:12px; color:var(--mute); margin-top:12px }
  /* The signing surface. touch-action:none or the page scrolls instead of
     inking on the one device most reps sign from. */
  .sigpad { display:block; width:100%; height:150px; margin-top:6px;
            border:1px dashed var(--hard); background:#fff;
            touch-action:none; cursor:crosshair }
  .sigrow { display:flex; gap:10px; margin-top:8px; align-items:center; flex-wrap:wrap }
  .sigrow .ghost { display:inline-block; width:auto; min-height:0; margin:0; padding:9px 13px;
                   background:none; border:1px solid var(--hard); color:var(--ink);
                   font-size:13px; font-weight:400; cursor:pointer }
  .sigrow .ghost:hover { background:var(--band) }
  .sigrow input[type=file] { display:none }
  button.dl { background:none; border:1px solid var(--accent); color:var(--accent) }
  button.dl:hover { background:var(--band); color:var(--accent) }
  /* Printing (or Save as PDF) keeps the bill and drops the buttons — the
     invoice's own print rules already strip the grey backdrop. The ask goes
     with them: "Sign at the bottom" means nothing on paper. */
  @media print { .actions, .ask { display:none } }
</style></head><body>${inner}</body></html>`,
  { headers: { "Content-Type": "text/html; charset=utf-8" } }
);

const notice = (title: string, body: string) =>
  page(`<div class="plain"><div class="kicker">Ticket approval</div><h1>${esc(title)}</h1><p class="meta">${esc(body)}</p></div>`);

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    await logError("approve-ticket", (e as Error).message);
    return notice("Something went wrong", "This approval link couldn't be processed right now. Please try again shortly, or ask VagaboNDE to resend it.");
  }
});

// The request body, read to the cap and no further: null past it.
async function readBounded(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

// Tells the people who sent the ticket that it came back signed: the
// account that pressed "Email for approval" (approval_sent_by — its address
// is the auth user's), plus the configured reply-to as the office copy.
// Nothing to send to is not an error; it is an install with no addresses.
// deno-lint-ignore no-explicit-any
async function officeRecipients(admin: any, row: any) {
  const settings = await appSettings();
  let to = "";
  if (row?.approval_sent_by) {
    const { data } = await admin.auth.admin.getUserById(row.approval_sent_by);
    to = data?.user?.email ?? "";
  }
  const office = settings.replyTo && settings.replyTo !== to ? settings.replyTo : "";
  // The settings go back with the addresses so the send does not read them
  // a second time.
  return { to, office, settings };
}

// The rep pressed "Query this ticket": the same people who hear about an
// approval hear what was asked, with the way forward spelled out.
// deno-lint-ignore no-explicit-any
async function notifyQuery(admin: any, row: any, who: string, text: string) {
  const { to, office, settings } = await officeRecipients(admin, row);
  if (!to && !office) return;
  const job = row?.jobs ?? {};
  const lines = [
    `${who} has a query on ticket ${row.id} instead of signing it:`,
    text,
    job.job_number ? `Job ${job.job_number}${job.project ? ` · ${job.project}` : ""}${job.clients?.name ? ` · ${job.clients.name}` : ""}` : "",
    "The ticket shows as Queried in the billing tracker. Put right what needs it and email it for approval again — a resend clears the query and sends a fresh link — or reply to the rep directly."
  ].filter(Boolean);
  await sendMail({
    settings,
    from: "billing",
    to: to || office,
    cc: to && office ? office : undefined,
    subject: `Ticket ${row.id} queried by ${who}`,
    htmlBody: wrapEmail(lines.map(l => `<p>${esc(l)}</p>`).join("")),
    textBody: lines.join("\n\n"),
    tag: "approval-query"
  });
}

// deno-lint-ignore no-explicit-any
async function notifyApproval(admin: any, row: any, d: InvoiceData, signer: string, approvedAt: string) {
  const { to, office, settings } = await officeRecipients(admin, row);
  if (!to && !office) return;
  const job = row?.jobs ?? {};
  const totals = invoiceTotals(d);
  const when = edmontonStamp(approvedAt);
  const subject = `Ticket ${row.id} approved by ${signer}`;
  const lines = [
    `Ticket ${row.id} was approved by ${signer} on ${when}.`,
    job.job_number ? `Job ${job.job_number}${job.project ? ` · ${job.project}` : ""}${job.clients?.name ? ` · ${job.clients.name}` : ""}` : "",
    `Total ${moneyCents(totals.grand)}${gstPercentOf(d) === 0 ? " (GST exempt)" : " including GST"}.`,
    "It is locked now and sits under Approved in the billing tracker, ready to invoice."
  ].filter(Boolean);
  await sendMail({
    settings,
    from: "billing",
    to: to || office,
    cc: to && office ? office : undefined,
    subject,
    htmlBody: wrapEmail(lines.map(l => `<p>${esc(l)}</p>`).join("")),
    textBody: lines.join("\n\n"),
    tag: "approval-notice"
  });
}

async function logError(functionName: string, message: string, context: Record<string, unknown> = {}) {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort; never let it mask the real error */ }
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("t");
  if (!token) return notice("Link incomplete", "This approval link is missing its token. Please use the link exactly as it appeared in the email.");

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Cast because the select list is built at runtime: supabase-js can only
  // infer a row type from a literal, and falls back to an error type when the
  // string is concatenated. Only the token columns are read off this — the
  // invoice itself is loaded through loadInvoice below.
  const { data: row, error: readErr } = await admin
    .from("tickets")
    // queried_at is deliberately NOT read here any more: the mail gate below
    // is a conditional update, and a copy of that timestamp taken at the top
    // of the request is the stale read the gate was once decided from.
    // Only what the token check and the office notices read: the bill —
    // lines, job and client — is loadInvoice's read below, and taking it
    // here as well pulled every line of the ticket twice per page load.
    .select("id, status, approved_at, approval_expires_at, approval_sent_by, jobs(job_number, project, clients(name))")
    .eq("approval_token", await hashToken(token)).maybeSingle();
  // deno-lint-ignore no-explicit-any
  const ticket = row as any;

  // A failed lookup is not an unknown token, and telling a rep their link is
  // dead when the database merely hiccuped sends them chasing the wrong thing.
  if (readErr) throw readErr;

  // A signed ticket keeps its token, so this is no longer "you already used
  // it": the only ways to reach here are a link that was superseded by a
  // resend, one whose approval was withdrawn, or a token no row ever held.
  if (!ticket) {
    return notice("This link is no longer valid",
      "A newer approval email may have replaced it — check for a more recent one from VagaboNDE. Otherwise, ask them to send a fresh approval link.");
  }
  // Loaded through the shared reader, so this page, the emailed copy and the
  // office view cannot drift apart in what they print. Service role here: the
  // person following the link has no account, which is the whole point.
  const { data: invoiceData } = await loadInvoice(admin, ticket.id as string);
  const invoice = () => renderInvoice(invoiceData!);
  const header = invoice();

  // Checked before the POST branch, not after it. A ticket that still carries
  // a token but is already signed — an approval link re-sent by mistake, say —
  // used to fall straight through into the POST handler and be re-signed,
  // overwriting the original signature, time and IP on a finished record.
  //
  // And checked before the expiry below, not after it. Expiry is what stops
  // an old link being SIGNED; a signed ticket cannot be signed again in any
  // case. Refusing it on day 31 took away nothing but the rep's own copy of
  // what they put their name to — and a resend refuses an approved ticket, so
  // there was no other way back to it. Signed is permanent; the expiry that
  // follows is for tickets still waiting for a signature.
  if (ticket.status === "Approved" || ticket.approved_at) {
    // renderInvoice prints the approval stamp itself once the ticket is
    // signed — including the drawn signature, which rides the select.
    return page(header + `<div class="actions">${downloadButton()}</div>`);
  }

  if (ticket.approval_expires_at && new Date(ticket.approval_expires_at) < new Date()) {
    return notice("This link has expired",
      "Approval links are good for 30 days. Ask VagaboNDE to send a new one.");
  }

  // What this page is asking the rep to sign for, as of right now.
  const fingerprint = await invoiceFingerprint(invoiceData!);

  // The one-line ask that rides above the sheet. Built once, here, so it
  // reaches every rendering that still wants a signature — the first view
  // and each re-ask after a refused submit — and none of the ones that
  // don't: the already-approved page returns above this, and the thank-you
  // and race-lost pages below it are receipts, with nothing left to ask for.
  const ask = askStrip(invoiceData!);

  if (req.method === "POST") {
    const tooLarge = () =>
      page(ask + header + `<div class="actions"><p style="color:#8a3b3b;font-size:13px">That signature image is too large — try a smaller photo, or just type your name.</p></div>` + signForm(fingerprint));
    if (Number(req.headers.get("content-length") || 0) > MAX_BODY_BYTES) return tooLarge();
    // The header is a claim; the bytes are the fact. A chunked POST has no
    // Content-Length, and formData() would have buffered all of it.
    const raw = await readBounded(req, MAX_BODY_BYTES);
    if (raw === null) return tooLarge();
    const form = await new Request(req.url, { method: "POST", headers: req.headers, body: raw }).formData();
    // "Query this ticket" instead of signing: what the rep said goes onto
    // the ticket for the tracker to show, the office is told, and the
    // link stays live — once the ticket is put right the rep signs here,
    // or a resend brings a fresh link and clears the query.
    if (String(form.get("action") ?? "") === "query") {
      const who = String(form.get("name") ?? "").trim().slice(0, MAX_NAME_CHARS);
      const text = String(form.get("query") ?? "").trim().slice(0, MAX_QUERY_CHARS);
      if (!who || !text) {
        return page(ask + header + `<div class="actions"><p style="color:#8a3b3b;font-size:13px">Please give your name and say what needs looking at.</p></div>` + signForm(fingerprint) + queryForm(fingerprint, who, text));
      }
      // The rep's words always land, and they land FIRST — before anything
      // is spent. The cooldown used to ride on this update's own filter,
      // which meant a second — different — query inside the window wrote
      // nothing while the page still told the rep it had been sent: whatever
      // they came back to say was simply lost. The write is unconditional
      // now, bar approved_at, because a signed ticket takes no query.
      //
      // The order matters as much as the condition. The gate below spends a
      // quarter of an hour of the office's peace by moving a timestamp; when
      // it moved first and this write then failed, the window had been spent
      // on a ticket carrying nothing new for anyone to read — a rep silenced
      // by a hiccup. Words on the record, then the window.
      //
      // Note what this no longer writes: queried_at. Setting it here on every
      // post slid the window forward each time, so the throttle lifted only
      // after fifteen minutes of complete silence rather than fifteen minutes
      // after the last mail — a rep with something to add every ten minutes
      // was never mailed about again.
      const { error: qErr } = await admin.from("tickets")
        .update({ query_text: text, query_by: who })
        .eq("id", ticket.id).is("approved_at", null);
      if (qErr) throw qErr;

      // Then the mail gate, which is what the limit was ever for: this link
      // is the whole credential and it travels — forwarded round a client's
      // office, or double-tapped on a slow phone — and a mail per request is
      // an inbox flood and the Resend quota that every other mail in this app
      // draws on spent by one rep.
      //
      // queried_at is the office's timestamp now, not the rep's: it means
      // "when we last told them". This conditional UPDATE is the only writer
      // of it, so a burst moves it exactly once and mails exactly once.
      // Deciding that from the queried_at that came back with the ticket was
      // no gate at all: that read happens at the top of handle(), before any
      // of the racing requests has written anything, so every one of them
      // sees the same stale null and every one of them mails — the flood the
      // limit exists to stop, arriving by the one door it was watching. The
      // database decides instead, and .select() is what makes a zero-row
      // update — the requests that lost — tell itself apart from the winner.
      //
      // The tracker and the archive print queried_at as when the query came
      // in, which for a second query inside the window is a few minutes early
      // against the fresher words beside it. They show Queried either way and
      // a resend clears the lot, so nothing downstream is misled by the gap.
      const cooledSince = new Date(Date.now() - QUERY_COOLDOWN_MS).toISOString();
      const { data: won, error: gateErr } = await admin.from("tickets")
        .update({ queried_at: new Date().toISOString() })
        .eq("id", ticket.id).is("approved_at", null)
        .or(`queried_at.is.null,queried_at.lt."${cooledSince}"`)
        .select("id");
      if (gateErr) throw gateErr;
      const mayMail = (won?.length ?? 0) > 0;
      if (mayMail) {
        // A send that throws still spends the window, deliberately. Putting
        // queried_at back would say the office had not been told when the
        // telling was attempted, to buy a retry nobody has asked for. The
        // failure is on the error log below and the query is on the tracker
        // either way.
        try { await notifyQuery(admin, row, who, text); }
        catch (e) { await logError("approve-ticket", "Queried, but the office wasn't told: " + (e as Error).message, { ticket: ticket.id }); }
      }
      // The same receipt whether the office was mailed or the cooldown held
      // the mail back. A page that said "you've already queried this" would
      // teach anyone holding the link exactly what the limit is and when it
      // lifts, and a rep who sent one query legitimately has nothing to learn
      // from the difference anyway — their words are on the ticket either way.
      return page(ask + header + `
        <div class="actions"><p class="signnote">Thank you — your query has been sent to VagaboNDE. This link stays live:
        once the ticket has been looked at, you can come back here and sign it, or you'll be sent a fresh one.</p></div>`);
    }
    // The page the rep is submitting from showed a particular set of charges.
    // If the ticket has been edited since — or the page predates this check —
    // show the current bill and ask again, rather than recording a signature
    // against figures the rep never saw.
    if (String(form.get("fp") ?? "") !== fingerprint) {
      return page(ask + header + `<div class="actions"><p style="color:#8a3b3b;font-size:13px">This ticket has changed since this page was opened. Please look over the charges above and sign again below.</p></div>` + signForm(fingerprint));
    }
    const name = String(form.get("name") ?? "").trim().slice(0, MAX_NAME_CHARS);
    if (!name) {
      return page(ask + header + `<div class="actions"><p style="color:#8a3b3b;font-size:13px">Please type your name to sign.</p></div>` + signForm(fingerprint));
    }
    // The drawn/uploaded signature, if one came along. Validated to exactly
    // a small PNG data URL — anything else (oversized, wrong type, not a
    // data URL at all) is dropped rather than argued with: the typed name
    // above is the signature of record either way.
    const rawSig = String(form.get("signature") ?? "");
    const signature =
      rawSig && rawSig.length <= 400000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(rawSig)
        ? rawSig : null;
    // Best-effort client IP; behind Supabase's edge this is the forwarded header.
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null;
    // Conditional on the ticket still being unsigned, so two taps on a slow
    // phone connection cannot both land and record the second as the
    // signature. The read above narrows the window; this closes it.
    const approvedAt = new Date().toISOString();
    // .select() so we learn whether THIS request is the one that signed.
    // Without it a zero-row update (the ticket already signed by a
    // concurrent submit — the same link forwarded to a colleague, both
    // signing at once) returns {data:null, error:null}, indistinguishable
    // from success; the loser would then be handed a receipt stamped with
    // their own name for a ticket the record attributes to someone else.
    const { data: signedRows, error: signErr } = await admin.from("tickets").update({
      status: "Approved",
      approved_at: approvedAt,
      approved_by_email: name,
      approved_ip: ip,
      // Always written, even as null: the signature column must only ever
      // hold what THIS approval carried, never something staged earlier.
      approved_signature: signature
      // The token is deliberately left alone — see the note at the top of
      // this file. It is the rep's way back to the copy they signed.
    }).eq("id", ticket.id).is("approved_at", null).select("approved_by_email, approved_at, approved_signature");
    if (signErr) throw signErr;

    if (!signedRows || signedRows.length === 0) {
      // Someone else's submit won the race and signed it first. Show the
      // approval that actually persisted, not this request's attempt.
      const { data: fresh } = await admin.from("tickets")
        .select("approved_by_email, approved_at, approved_signature").eq("id", ticket.id).maybeSingle();
      invoiceData!.ticket.status = "Approved";
      invoiceData!.ticket.approved_at = fresh?.approved_at ?? approvedAt;
      invoiceData!.ticket.approved_by_email = fresh?.approved_by_email ?? "";
      invoiceData!.ticket.approved_signature = fresh?.approved_signature ?? null;
      return page(invoice() + `
        <div class="actions"><p class="signnote">This ticket was already approved. The signature on record is shown above.</p>
        ${downloadButton()}</div>`);
    }

    // Re-render so the signed document itself carries the stamp, rather than
    // a stamp being tacked under a copy that still shows a blank signature
    // line — the rep keeps this page, and it should read as signed. The
    // loaded invoice data predates the update, so the stamp fields go onto
    // it from the row we just wrote.
    invoiceData!.ticket.status = "Approved";
    invoiceData!.ticket.approved_at = signedRows[0].approved_at ?? approvedAt;
    invoiceData!.ticket.approved_by_email = signedRows[0].approved_by_email ?? name;
    invoiceData!.ticket.approved_signature = signedRows[0].approved_signature ?? null;
    // The line below says VagaboNDE has been notified; this is what makes
    // it true. The account that sent the approval hears back by email, with
    // the office address copied when one is configured. Best effort: a mail
    // failure is logged and never stands between the rep and their receipt.
    try {
      await notifyApproval(admin, row, invoiceData!, name, signedRows[0].approved_at ?? approvedAt);
    } catch (e) {
      await logError("approve-ticket", "Approved, but the office wasn't told: " + (e as Error).message, { ticket: ticket.id });
    }
    return page(invoice() + `
      <div class="actions"><p class="signnote">Thank you. VagaboNDE has been notified and this ticket is now
      locked.</p>
      ${downloadButton()}</div>`);
  }

  return page(ask + header + signForm(fingerprint) + queryForm(fingerprint));
}

// What is being asked, in one line, before the document that justifies it.
//
// A phone opens this page on the invoice masthead — which says who is
// billing, not what is wanted — and the Approve button is two or three
// screens below the charge tables. Which ticket, how much, and where to
// sign, before any of that.
//
// The amount comes from invoiceTotals, the same integer-cent arithmetic the
// sheet underneath prints from: a formula of its own here would be a second
// number free to disagree with the one being signed for, and the figure a
// rep reads first is the figure they remember.
function askStrip(d: InvoiceData) {
  return `<div class="ask">
    <span class="tkt">Ticket ${esc(d.ticket.id)}</span>
    <span class="due">${esc(moneyCents(invoiceTotals(d).grand))} due</span>
    <a class="jump" href="#signform">Sign at the bottom &darr;</a>
  </div>`;
}

// The typed name remains the signature of record; the pad adds the rep's
// actual mark to the bill. One canvas is the single source: drawing inks
// it, uploading a picture lands the picture in it (fitted), Clear empties
// it, and whatever it holds at submit rides along as a small PNG.
//
// `fingerprint` is the digest of the charges this page shows; the POST
// handler refuses a submit whose digest no longer matches the ticket.
// The way out for a rep who won't sign: say what is wrong, here, rather
// than letting the ticket age into "over 7 days" with no reason recorded.
function queryForm(fingerprint: string, who = "", text = "") {
  return `<details class="actions" id="queryblock" style="margin-top:10px"${who || text ? " open" : ""}>
    <summary style="cursor:pointer;font-size:13px">Something not right? Query this ticket instead of signing</summary>
    <form method="POST" style="margin-top:10px">
      <input type="hidden" name="fp" value="${esc(fingerprint)}">
      <input type="hidden" name="action" value="query">
      <label class="signbox">Your name
        <input name="name" autocomplete="name" maxlength="${MAX_NAME_CHARS}" required value="${esc(who)}">
      </label>
      <label class="signbox" style="margin-top:10px">What needs looking at
        <textarea name="query" rows="4" maxlength="${MAX_QUERY_CHARS}" required style="width:100%;font:inherit;padding:8px;box-sizing:border-box">${esc(text)}</textarea>
      </label>
      <button type="submit" class="ghost" style="margin-top:10px">Send the query</button>
      <p class="signnote">VagaboNDE is told straight away. This link stays live, so you can sign once it's sorted.</p>
    </form>
  </details>`;
}

function signForm(fingerprint: string) {
  return `<form method="POST" class="actions" id="signform">
    <input type="hidden" name="fp" value="${esc(fingerprint)}">
    <label class="signbox">Your name — typing it here signs this ticket
      <input name="name" autocomplete="name" placeholder="T. Beaudry" maxlength="${MAX_NAME_CHARS}" required>
    </label>
    <label class="signbox" style="margin-top:14px">Your signature (optional) — draw it below with a finger or mouse, or upload a photo of it</label>
    <canvas id="sigpad" class="sigpad"></canvas>
    <div class="sigrow">
      <button type="button" class="ghost" id="sigclear">Clear</button>
      <label class="ghost">Upload signature image<input type="file" id="sigfile" accept="image/*"></label>
    </div>
    <p id="signote" role="alert" style="color:#8a3b3b;font-size:13px;margin:8px 0 0;display:none"></p>
    <input type="hidden" name="signature" id="sigdata">
    <button type="submit">Approve this ticket</button>
    <p class="signnote">Approving records your name, the time, and your IP address as the signature. Questions before you sign? Reply to the email instead.</p>
  </form>
  <script>
  (function () {
    var pad = document.getElementById("sigpad");
    if (!pad || !pad.getContext) return;
    var ctx = pad.getContext("2d");
    var dirty = false;
    var dpr = Math.max(1, window.devicePixelRatio || 1);
    function reset() {
      pad.width = Math.round(pad.clientWidth * dpr);
      pad.height = Math.round(pad.clientHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.strokeStyle = "#1d1f20";
      dirty = false;
    }
    reset();

    // A canvas keeps its pixel buffer when its CSS box changes, so after a
    // rotation the old bitmap is stretched across the new width while the
    // drawing transform still describes the old one — every later stroke
    // lands somewhere the finger isn't. Re-sizing is the only fix.
    //
    // Of the two ways to re-size, this one keeps the ink: the bitmap is
    // copied to an offscreen canvas and redrawn into the new box, rather
    // than cleared with dirty reset. Both leave the pad aligned; only this
    // one leaves a rep who rotated the phone mid-signature still holding
    // their signature. It stretches with the box it was drawn in, which is
    // a mark slightly wider than it was, not a mark in the wrong place.
    //
    // Width only, and debounced. A phone collapsing its URL bar fires resize
    // for a height change alone, and a pad that re-scales itself under a
    // half-drawn signature every time the address bar moves is worse than
    // the bug.
    var lastWidth = pad.clientWidth;
    var resizeTimer = 0;
    function refit() {
      var w = pad.clientWidth;
      if (w <= 0 || w === lastWidth) return;
      lastWidth = w;
      // Ends any stroke caught mid-rotation. Its last point is in the old
      // box's coordinates, and joining it to the next one would draw the one
      // crooked line all of this exists to prevent.
      drawing = false;
      var keep = null;
      if (dirty && pad.width > 0 && pad.height > 0) {
        keep = document.createElement("canvas");
        keep.width = pad.width; keep.height = pad.height;
        keep.getContext("2d").drawImage(pad, 0, 0);
      }
      reset(); // re-sizes, and clears dirty along with the pad
      if (keep) {
        // reset() left the transform in CSS pixels, so the old ink goes back
        // as the full box rather than as device pixels.
        ctx.drawImage(keep, 0, 0, pad.clientWidth, pad.clientHeight);
        dirty = true;
      }
    }
    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(refit, 150);
    }
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);

    var drawing = false, lx = 0, ly = 0;
    function pos(e) { var r = pad.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
    pad.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      // Capture keeps a stroke inked when the finger wanders off the pad;
      // losing the capture is no reason to lose the stroke.
      try { pad.setPointerCapture(e.pointerId); } catch { /* draw anyway */ }
      drawing = true;
      var p = pos(e); lx = p[0]; ly = p[1];
      ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 0.01, ly); ctx.stroke();
      dirty = true;
    });
    pad.addEventListener("pointermove", function (e) {
      if (!drawing) return;
      var p = pos(e);
      ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(p[0], p[1]); ctx.stroke();
      lx = p[0]; ly = p[1];
    });
    ["pointerup", "pointercancel"].forEach(function (t) {
      pad.addEventListener(t, function () { drawing = false; });
    });
    document.getElementById("sigclear").addEventListener("click", reset);
    // Everything else this page refuses is said inline, in the page's own
    // type — a rep on a phone was getting a native OS dialog in the middle
    // of an otherwise careful document.
    var note = document.getElementById("signote");
    function say(text) {
      if (!note) return;
      note.textContent = text || "";
      note.style.display = text ? "block" : "none";
    }
    document.getElementById("sigfile").addEventListener("change", function () {
      var f = this.files && this.files[0];
      this.value = "";
      say("");
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) { say("That image is over 8 MB — use a smaller photo of your signature."); return; }
      var img = new Image();
      img.onload = function () {
        reset();
        var w = pad.clientWidth, h = pad.clientHeight;
        var s = Math.min(w / img.width, h / img.height);
        ctx.drawImage(img, (w - img.width * s) / 2, (h - img.height * s) / 2, img.width * s, img.height * s);
        dirty = true;
        URL.revokeObjectURL(img.src);
      };
      img.onerror = function () { say("That file couldn't be read as an image — try a photo or a screenshot of your signature."); };
      img.src = URL.createObjectURL(f);
    });
    document.getElementById("signform").addEventListener("submit", function () {
      // One tap, one approval: a second tap on a slow connection used to
      // reach the server as a second submit and land the rep on "already
      // approved". The disabled button is left out of the form data, which
      // is fine — it carries no name.
      var go = this.querySelector("button[type=submit]");
      if (go) { go.disabled = true; go.textContent = "Approving…"; }
      if (!dirty) return;
      // Exported small: the bill needs a legible mark, not a photograph.
      var out = document.createElement("canvas");
      out.width = 600; out.height = Math.max(1, Math.round(600 * pad.clientHeight / pad.clientWidth));
      out.getContext("2d").drawImage(pad, 0, 0, out.width, out.height);
      var data = out.toDataURL("image/png");
      if (data.length > 400000) {
        out.width = 300; out.height = Math.max(1, Math.round(out.height / 2));
        out.getContext("2d").drawImage(pad, 0, 0, out.width, out.height);
        data = out.toDataURL("image/png");
      }
      if (data.length <= 400000) document.getElementById("sigdata").value = data;
    });
  })();
  </script>`;
}

// Offered once the document is signed (or was already): the page IS the
// bill, so the device's own print dialog — Save as PDF — hands over a
// pixel-faithful copy. The print rules hide this bar itself.
function downloadButton() {
  return `<button type="button" class="dl" onclick="window.print()">Download PDF</button>
    <p class="signnote">Opens your device's print dialog — choose &ldquo;Save as PDF&rdquo; to keep a copy of this bill.</p>`;
}
