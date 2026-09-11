// mail-test — the Email setup screen's "Send test email" button.
//
// Sends one plain proof-of-pipework email through exactly the same path
// the real reports and approvals use, so a delivered test means the
// configuration is genuinely done. Admin-gated the same way create-user
// is: the settings it exercises include a credential only Admins manage.
//
// While the sender is still Resend's onboarding address (no domain
// verified yet), Resend only delivers to the Resend account owner's own
// email — the response says which sender was used so the screen can
// explain that.

import { sendMail, appSettings, corsHeaders, wrapEmail, esc, recipients } from "../_shared/mail.ts";
import { requireActiveAdmin } from "../_shared/adminGate.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Who is asking comes before anything is read from them — the address check
  // below answers a stranger with a description of what it wanted, and this
  // family of functions all settles the caller first.
  // The whole question is adminGate's: signed in, a profile that is there,
  // unlocked, holding a tab, and an Admin. The rank alone let a locked
  // account through for as long as Auth still accepted its session.
  const who = await requireActiveAdmin(req, "Only an Admin can send a test email");
  if (who instanceof Response) return who;

  try {
    const { to } = await req.json();
    const toList = recipients(to, "to");

    // Only the name, and only for the sentence in the email — the gate has
    // already decided whether this call happens at all. A name that could
    // not be read is not a reason to refuse a test email.
    const { data: me } = await who.asUser.from("profiles")
      .select("name").eq("id", who.userId).maybeSingle();
    const sentBy = (me as { name?: string | null } | null)?.name ?? "an Admin";

    const settings = await appSettings();
    const html = wrapEmail(`
<h2 style="margin:0 0 10px;font-size:18px">Email is working</h2>
<p>This is a test from VagaboNDE Field Ops, sent by ${esc(sentBy)} from the Admin screen.</p>
<p>It went out from <strong>${esc(settings.fromReports)}</strong> — if that is still Resend's onboarding address, the sending domain isn't verified yet and real recipients can't receive mail; once the domain is verified in Resend and the addresses are set, tests and real sends go anywhere.</p>`);

    await sendMail({
      from: "reports",
      to: toList,
      subject: "VagaboNDE Field Ops — test email",
      htmlBody: html,
      textBody: `Email is working. Sent from ${settings.fromReports} via the Admin screen.`,
      tag: "test"
    });

    return json({ ok: true, from: settings.fromReports });
  } catch (e) {
    return json({ error: (e as Error).message || "The test send failed." }, 400);
  }
});
