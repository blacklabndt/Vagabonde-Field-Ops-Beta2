// scheduled-sends — a send that waited for its time goes out.
//
// The cron job `scheduled-sends-tick` calls this every five minutes with
// x-internal-secret (admin-digest's shape: the database signs the call
// with the value in private.internal_config at the moment it fires, and
// `secretsMatch` compares it in constant time). Nobody is signed in when
// it runs, which is the whole point — the person who scheduled the send
// may have their phone off — so the authority is the two halves the spec
// names: the row was inserted through RLS as that person (the policy
// looked the record up under their own read policies), and `fireGate`
// here re-applies the send function's own gate against their CURRENT
// profile and the record's CURRENT state. Anything changed since —
// the account locked, the PDF gone, the ticket signed meanwhile — fails
// the row with the reason, and nothing goes.
//
// The send itself is the same module the live button uses (mailJha,
// mailReport, mailApproval), so there is one email body and one sent
// stamp. An approval is recorded as sent by the person who scheduled it.
//
// No retry. A row is claimed with a conditional UPDATE (queued → sending),
// so two ticks over the same row send once; a row still `sending` fifteen
// minutes on died mid-send and is failed with words that say to check
// before sending again — the email may well have gone, and twice is worse
// than once too few. Every failure also goes to function_errors, where the
// digest and Home's strip read it.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { appSettings, corsHeaders, recipients, type AppSettings } from "../_shared/mail.ts";
import { secretsMatch } from "../_shared/constantTime.ts";
import { mailJha, JHA_MAIL_SELECT, type JhaMailRow } from "../_shared/mailJha.ts";
import { mailReport, REPORT_MAIL_SELECT, type ReportMailRow } from "../_shared/mailReport.ts";
import { mailApproval } from "../_shared/mailApproval.ts";
import { fireGate, isKind, resultPushWords, STUCK_MS, STUCK_WORDS, NO_DEVICE_WORDS, NO_DEVICE_TOOK_IT, type Person } from "../_shared/scheduledSends.ts";
import { sendPush, type PushSub } from "../_shared/webPush.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// Rows a tick takes on; the next tick takes the rest.
const BATCH = 20;

interface Row {
  id: string; kind: string; record_id: string; job_id: string | null; label: string; to_list: string; message: string;
  run_at: string; set_by: string; status: string; fired_at: string | null; jobs: { job_number: string } | null;
}
interface TicketRow { id: string; status: string | null; total: number | string | null; technician_id: string | null }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: expected, error: secretErr } = await admin.rpc("internal_secret");
    if (secretErr) throw secretErr;
    // Constant time, never `===`: a compare that stops at the first byte
    // that differs times out how much of the secret the caller has right.
    if (!secretsMatch(req.headers.get("x-internal-secret"), expected)) {
      return json({ error: "Not authorized" }, 401);
    }

    const now = Date.now();

    // 1. Rows that never reported back.
    const { data: stuckRows, error: stuckErr } = await admin.from("scheduled_sends")
      .update({ status: "failed", error: STUCK_WORDS })
      .eq("status", "sending").lt("fired_at", new Date(now - STUCK_MS).toISOString())
      .select("id, label, job_id");
    if (stuckErr) throw new Error(stuckErr.message);
    for (const s of (stuckRows ?? []) as { id: string; label: string; job_id: string | null }[]) {
      await logError("scheduled-sends", `${s.label}: ${STUCK_WORDS}`, { id: s.id, job_id: s.job_id });
    }

    // 2. Rows that are due, oldest first.
    const { data: due, error: dueErr } = await admin.from("scheduled_sends")
      .select("id, kind, record_id, job_id, label, to_list, message, run_at, set_by, status, fired_at, jobs(job_number)")
      .eq("status", "queued").lte("run_at", new Date(now).toISOString())
      .order("run_at").limit(BATCH);
    if (dueErr) throw new Error(dueErr.message);

    let fired = 0;
    let failed = 0;
    // The settings row, read once per tick and only when an approval needs it.
    let settings: AppSettings | null = null;
    const settingsOnce = async () => { settings ??= await appSettings(); return settings; };

    for (const row of (due ?? []) as unknown as Row[]) {
      // The claim: a tick that reads a row another tick has just taken gets
      // zero rows back and leaves it alone.
      const { data: claimed, error: cErr } = await admin.from("scheduled_sends")
        .update({ status: "sending", fired_at: new Date().toISOString() })
        .eq("id", row.id).eq("status", "queued").select("id");
      if (cErr) throw new Error(cErr.message);
      if (!claimed || !claimed.length) continue;
      try {
        await fire(admin, row, settingsOnce);
        await admin.from("scheduled_sends").update({ status: "sent" }).eq("id", row.id);
        fired++;
        // A reminder's push was the firing itself; a second "Sent" would
        // be noise on the same devices.
        if (row.kind !== "reminder") await tellScheduler(admin, row, null);
      } catch (e) {
        const message = (e as Error).message;
        await admin.from("scheduled_sends").update({ status: "failed", error: message }).eq("id", row.id);
        await logError("scheduled-sends", `${row.label} was not sent: ${message}`,
          { id: row.id, kind: row.kind, record_id: row.record_id, job_id: row.job_id, set_by: row.set_by });
        failed++;
        await tellScheduler(admin, row, message);
      }
    }
    return json({ ok: true, fired, failed, stuck: stuckRows?.length ?? 0 });
  } catch (e) {
    const message = (e as Error).message;
    await logError("scheduled-sends", message);
    return json({ error: message }, 500);
  }
});

// One row: the person as they are now, the record as it is now, the gate,
// the addresses checked again, and the same send the live button makes.
async function fire(admin: SupabaseClient, row: Row, settingsOnce: () => Promise<AppSettings>): Promise<void> {
  if (!isKind(row.kind)) throw new Error(`Nothing sends a "${row.kind}".`);
  const { data: p, error: pErr } = await admin.from("profiles")
    .select("id, role, tab_access, deactivated_at").eq("id", row.set_by).maybeSingle();
  if (pErr) throw new Error(pErr.message);
  const person = p as Person | null;
  if (!person) throw new Error("The account that scheduled this send no longer exists.");

  // A reminder: no mail, no record — the push to the person's own devices
  // is the whole act, and no device to push to is the failure, in words the
  // strip shows.
  if (row.kind === "reminder") {
    fireGate("reminder", person, {});
    const subs = await devicesOf(admin, row.set_by);
    if (!subs.length) throw new Error(NO_DEVICE_WORDS);
    const { sent } = await sendPush(admin, subs, resultPushWords(row, row.jobs?.job_number ?? "", null));
    if (!sent) throw new Error(NO_DEVICE_TOOK_IT);
    return;
  }
  const to = recipients(row.to_list, "to");

  if (row.kind === "jha") {
    const { data, error } = await admin.from("jhas").select(JHA_MAIL_SELECT).eq("id", row.record_id).maybeSingle();
    if (error) throw new Error(error.message);
    const jha = data as unknown as JhaMailRow | null;
    if (!jha) throw new Error("The assessment has been deleted since this was scheduled.");
    fireGate("jha", person, jha as unknown as Record<string, unknown>);
    await mailJha(admin, jha, to, undefined, row.message);
  } else if (row.kind === "report") {
    const { data, error } = await admin.from("reports").select(REPORT_MAIL_SELECT).eq("id", row.record_id).maybeSingle();
    if (error) throw new Error(error.message);
    const report = data as unknown as ReportMailRow | null;
    if (!report) throw new Error("The report has been deleted since this was scheduled.");
    fireGate("report", person, report as unknown as Record<string, unknown>);
    await mailReport(admin, report, to, undefined, row.message);
  } else {
    const { data, error } = await admin.from("tickets").select("id, status, total, technician_id").eq("id", row.record_id).maybeSingle();
    if (error) throw new Error(error.message);
    const ticket = data as TicketRow | null;
    if (!ticket) throw new Error("The ticket has been deleted since this was scheduled.");
    fireGate("ticket_approval", person, ticket as unknown as Record<string, unknown>);
    const resend = ticket.status === "Awaiting approval";
    await mailApproval(admin, ticket.id, to, undefined, person.id, await settingsOnce());
    // A resend is a chase, recorded the way the tracker's resend records
    // it — after the send and best effort, so a flag that did not save never
    // turns a delivered email into a failed row.
    if (resend) await admin.from("tickets").update({ chased_at: new Date().toISOString() }).eq("id", ticket.id);
  }
}

// The person's own devices hear the result — sent or not — through the
// push the chat uses, after the row's final status is written. Best
// effort in every direction: no subscription, no VAPID or a push service
// down never turns a delivered email into a failed row, and a push that
// could not go is not an error of its own — a failed row already is one.
// Only the scheduler's devices, and only while the account is active.
async function tellScheduler(admin: SupabaseClient, row: Row, error: string | null): Promise<void> {
  try {
    const subs = await devicesOf(admin, row.set_by);
    if (!subs.length) return;
    await sendPush(admin, subs, resultPushWords(row, row.jobs?.job_number ?? "", error));
  } catch { /* best effort: the row's status is the record */ }
}

// The person's subscribed devices, while the account is active.
async function devicesOf(admin: SupabaseClient, profileId: string): Promise<PushSub[]> {
  const { data, error } = await admin.from("push_subscriptions")
    .select("id, endpoint, p256dh, auth, profiles!inner(deactivated_at)")
    .eq("profile_id", profileId).is("profiles.deactivated_at", null);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as PushSub[];
}

async function logError(functionName: string, message: string, context: Record<string, unknown> = {}) {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort; never let it mask the real error */ }
}
