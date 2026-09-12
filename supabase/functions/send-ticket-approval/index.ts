// send-ticket-approval — emails the client rep a link to sign a daily ticket.
//
// Attaches a PDF-style summary of the ticket as well as linking to the live
// approval page, so the rep has something to file even before they click.
// The link carries a token — see _shared/mailApproval.ts, which is the send
// itself: a scheduled send (scheduled-sends) comes through the same module
// after a gate of its own, so there is one email and one token write. This
// file is the door and the gate for a live press — the editor's Send for
// approval, the viewer's, the tracker's resend and its chase.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { appSettings, corsHeaders, recipients, optionalRecipients } from "../_shared/mail.ts";
import { mailApproval } from "../_shared/mailApproval.ts";
import { refuse, publicWords, loggedWords } from "../_shared/publicError.ts";

const TROUBLE = "The approval could not be sent. Try again, and tell the office if it keeps happening.";

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
    if (!ticketId) throw refuse("This request didn't say which ticket to send. Reload the app and try again.");
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
      // come from loadInvoice's own read inside the send.
      asUser
        .from("tickets")
        .select("id, technician_id, status")
        .eq("id", ticketId).single(),
      asUser.from("profiles").select("role").eq("id", user.id).single()
    ]);
    // The three columns the two gates read, named rather than inferred.
    const ticket = ticketRead as { id: string; technician_id: string | null; status: string | null } | null;
    if (tErr || !ticket) throw refuse("Ticket not found, or you don't have access to it");
    if (ticket.status === "Approved" || ticket.status === "Invoiced") {
      throw refuse("That ticket is already approved — nothing to send.");
    }

    // Being able to SEE the ticket is not being allowed to send it out for
    // signing: tickets_select is is_staff(), so every signed-in account —
    // Helpers included — can read any ticket. The mint inside the send runs
    // with the service role and so bypasses tickets_update's owner-or-Admin
    // gate; this restores it. Without it, anyone could send a co-worker's
    // ticket to an inbox they control and self-approve a fabricated
    // signature.
    const privileged = caller?.role === "Admin" || caller?.role === "Coordinator";
    if (ticket.technician_id !== user.id && !privileged) {
      return new Response(JSON.stringify({ error: "Only the ticket's technician, or an Admin or Coordinator, can send it for approval." }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const settings = await settingsRead;
    const result = await mailApproval(admin, ticketId, toList, ccList, user.id, settings);
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (e) {
    // The office reads everything; the person reads only what was written
    // for them. See _shared/publicError.ts for why the default is masking.
    await logError("send-ticket-approval", loggedWords(e));
    return new Response(JSON.stringify({ error: publicWords(e, TROUBLE) }), {
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
