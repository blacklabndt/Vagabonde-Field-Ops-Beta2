// A set-password link, mailed through the app's own transport (Resend,
// mail.ts) rather than Supabase's built-in sender: one template, one
// sending address, and the same message whether an Admin is inviting a new
// person or resetting an existing one. The link itself is Auth's own
// recovery link, so it lands on the app's set-password screen exactly as
// "Forgot password" does, and it works once.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendMail, appSettings, wrapEmail, esc } from "./mail.ts";

export async function sendSetPasswordLink(admin: SupabaseClient, email: string, name: string, reason: "invite" | "reset") {
  const settings = await appSettings();
  // Back to the app itself: the approval base URL is the app's own address
  // (the Worker), so its origin is where the link should land. Without one
  // Auth falls back to the project's Site URL.
  let redirectTo: string | undefined;
  try { redirectTo = settings.approvalBaseUrl ? new URL(settings.approvalBaseUrl).origin : undefined; }
  catch { redirectTo = undefined; }

  const { data, error } = await admin.auth.admin.generateLink({
    type: "recovery",
    email,
    ...(redirectTo ? { options: { redirectTo } } : {})
  });
  if (error) throw error;
  const link: string | undefined = data?.properties?.action_link;
  // Read by the Admin who pressed the button, so it says what happened and
  // what to do rather than naming the service that let them down.
  if (!link) throw new Error("No set-password link came back, so nothing could be emailed. Try again in a moment.");

  const first = String(name || "").trim().split(/\s+/)[0] || "";
  const greeting = `Hi${first ? " " + first : ""},`;
  const subject = reason === "invite"
    ? "Your VagaboNDE Field Ops account"
    : "Set a new VagaboNDE Field Ops password";
  const lines = reason === "invite"
    ? [
        greeting,
        "An account has been set up for you on VagaboNDE Field Ops. Open the link below to choose your password, then sign in with this email address.",
        "The link works once. If it has expired, ask the office to send another."
      ]
    : [
        greeting,
        "Here is a link to set a new password for your VagaboNDE Field Ops account. It works once.",
        "If you didn't ask for this, you can ignore it — nothing changes until the link is used."
      ];

  await sendMail({
    settings,
    from: "reports",
    to: email,
    subject,
    htmlBody: wrapEmail(lines.map(l => `<p>${esc(l)}</p>`).join("") + `<p><a href="${esc(link)}">Set your password</a></p>`),
    textBody: lines.join("\n\n") + "\n\n" + link,
    tag: reason === "invite" ? "invite" : "password-reset"
  });
}
