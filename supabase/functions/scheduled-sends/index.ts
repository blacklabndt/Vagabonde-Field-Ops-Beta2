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
import { fireGate, isKind, resultPushWords, runRow, dbWhy, markStatus, STUCK_MS, STUCK_WORDS, NO_DEVICE_WORDS, NO_DEVICE_TOOK_IT, type Person, type SendRow } from "../_shared/scheduledSends.ts";
import { loggedWords } from "../_shared/publicError.ts";
import { sendPush, type PushSub } from "../_shared/webPush.ts";
import { futureJwtRetrying } from "../_shared/jwtRetry.ts";

// Every database request this tick makes goes through the clock retry.
//
// Nobody is signed in at 03:55; a PGRST303 here is a tick that did nothing
// and said 500, and the next one is five minutes away. It sits at the fetch
// boundary of the client and nowhere else, which means it covers the reads,
// the claim and the status writes — and cannot touch the send itself, since
// mail and push do not go through this client. A refused request never
// reached a transaction, so asking again cannot send anything twice.
const adminClient = () => createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { global: { fetch: futureJwtRetrying((input, init) => fetch(input, init), Deno.env.get("SUPABASE_URL")!) } }
);

// A database failure with the stage it came from; `dbWhy` (shared, and
// tested there) adds the code PostgREST gave it.

const dbFail = (stage: string, error: { message?: string; code?: string | null }) =>
  new Error(`${stage}: ${dbWhy(error)}`);

// One row's final status, through the tick's own (wrapped) client: the
// write is handed to the shared markStatus, which never throws.
const settleWith = (admin: SupabaseClient) => (id: string, patch: Record<string, string>) =>
  markStatus(async p => {
    const { error } = await admin.from("scheduled_sends").update(p).eq("id", id);
    return { error };
  }, patch);

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
    const admin = adminClient();
    const settle = settleWith(admin);
    const { data: expected, error: secretErr } = await admin.rpc("internal_secret");
    // The first request of the tick, and the one an overnight PGRST303 was
    // most likely to meet: it threw the bare PostgREST error, so the row in
    // function_errors said "JWT issued at future" and nothing about where.
    if (secretErr) throw dbFail("the authorization check", secretErr);
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
    if (stuckErr) throw dbFail("the stale sweep", stuckErr);
    for (const s of (stuckRows ?? []) as { id: string; label: string; job_id: string | null }[]) {
      await logError("scheduled-sends", `${s.label}: ${STUCK_WORDS}`, { id: s.id, job_id: s.job_id });
    }

    // 2. Rows that are due, oldest first.
    const { data: due, error: dueErr } = await admin.from("scheduled_sends")
      .select("id, kind, record_id, job_id, label, to_list, message, run_at, set_by, status, fired_at, jobs(job_number)")
      .eq("status", "queued").lte("run_at", new Date(now).toISOString())
      .order("run_at").limit(BATCH);
    if (dueErr) throw dbFail("the due read", dueErr);

    let fired = 0;
    let failed = 0;
    // Rows whose send is settled and whose ROW is not: the email went (or
    // did not) and the status could not be written. They are counted apart
    // because `fired` and `failed` are about the send, and a tick that
    // answered ok with nothing else to say hid a row left `sending` for the
    // stale sweep to call ambiguous fifteen minutes later.
    let unrecorded = 0;
    // The settings row, read once per tick and only when an approval needs it.
    let settings: AppSettings | null = null;
    // Through the tick's own client, so the last read before an email
    // leaves has the same clock retry behind it as the claim that took the
    // row. A refusal here would otherwise fail a send already claimed.
    const settingsOnce = async () => { settings ??= await appSettings(admin); return settings; };

    // The claim: a tick that reads a row another tick has just taken gets
    // zero rows back and leaves it alone. A refusal is not an answer about
    // the row, so it throws and the tick ends.
    const claim = async (id: string) => {
      const { data, error } = await admin.from("scheduled_sends")
        .update({ status: "sending", fired_at: new Date().toISOString() })
        .eq("id", id).eq("status", "queued").select("id");
      if (error) throw dbFail("the claim", error);
      return !!(data && data.length);
    };

    for (const row of (due ?? []) as unknown as Row[]) {
      // The order — claim, send, settle, log, push — is the shared module's,
      // so the node suite drives this exact sequence with the transports
      // counted: a database refused at any point in it sends nothing twice.
      const tally = await runRow(row as unknown as SendRow, {
        claim,
        fire: () => fire(admin, row, settingsOnce),
        settle,
        log: (message, context) => logError("scheduled-sends", message, context),
        notify: (_r, error) => tellScheduler(admin, row, error),
        logged: loggedWords
      });
      fired += tally.fired;
      failed += tally.failed;
      unrecorded += tally.unrecorded;
    }
    // `ok` is about the tick, not about every row: a send whose row could
    // not be written is named here as well as in function_errors, so the
    // answer never reads as "all settled" when a row was left behind.
    return json({ ok: unrecorded === 0, fired, failed, unrecorded, stuck: stuckRows?.length ?? 0 });
  } catch (e) {
    // Whatever reached here keeps its code: an error thrown before dbFail
    // could name it — or by a library that never does — used to arrive as a
    // bare sentence, which is how eight identical rows were all this
    // function had to say for itself.
    const message = dbWhy(e as { message?: string; code?: string });
    // The log takes the detail as well — a marked refusal's public sentence
    // says nothing about which request met what.
    await logError("scheduled-sends", dbWhy({ message: loggedWords(e), code: (e as { code?: string }).code }));
    return json({ error: message }, 500);
  }
});


// One row: the person as they are now, the record as it is now, the gate,
// the addresses checked again, and the same send the live button makes.
async function fire(admin: SupabaseClient, row: Row, settingsOnce: () => Promise<AppSettings>): Promise<void> {
  if (!isKind(row.kind)) throw new Error(`Nothing sends a "${row.kind}".`);
  const { data: p, error: pErr } = await admin.from("profiles")
    .select("id, role, tab_access, deactivated_at").eq("id", row.set_by).maybeSingle();
  if (pErr) throw dbFail("the scheduler read", pErr);
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
    if (error) throw dbFail("the assessment read", error);
    const jha = data as unknown as JhaMailRow | null;
    if (!jha) throw new Error("The assessment has been deleted since this was scheduled.");
    fireGate("jha", person, jha as unknown as Record<string, unknown>);
    await mailJha(admin, jha, to, undefined, row.message);
  } else if (row.kind === "report") {
    const { data, error } = await admin.from("reports").select(REPORT_MAIL_SELECT).eq("id", row.record_id).maybeSingle();
    if (error) throw dbFail("the report read", error);
    const report = data as unknown as ReportMailRow | null;
    if (!report) throw new Error("The report has been deleted since this was scheduled.");
    fireGate("report", person, report as unknown as Record<string, unknown>);
    await mailReport(admin, report, to, undefined, row.message);
  } else {
    const { data, error } = await admin.from("tickets").select("id, status, total, technician_id").eq("id", row.record_id).maybeSingle();
    if (error) throw dbFail("the ticket read", error);
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
  if (error) throw dbFail("the device read", error);
  return (data ?? []) as unknown as PushSub[];
}

async function logError(functionName: string, message: string, context: Record<string, unknown> = {}) {
  try {
    const admin = adminClient();
    await admin.from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort; never let it mask the real error */ }
}
