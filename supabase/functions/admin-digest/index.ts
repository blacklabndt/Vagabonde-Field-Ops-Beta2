// admin-digest — the office is told, instead of having to look.
//
// A failed backup, a drive whose consent has lapsed, a schedule nothing is
// picking up and a run of background errors are all written down the moment
// they happen, and all four are then only visible to somebody who opens the
// Admin screen. Home's attention strip says them to an Admin who is already
// in the app; this says them to an Admin who is not. Once a morning, and
// only when there is something to say — a digest that arrives every day
// saying "all well" is a digest nobody opens on the day it does not.
//
// The reading of the records is vite-app/src/attention.js's, repeated here
// in TypeScript because the two run in different places: the strip asks the
// database as the Admin looking at it, this asks as the service role at
// seven in the morning. Kept deliberately small, and the wording kept
// identical on purpose — the email and the strip say the same sentence
// about the same fact.
//
// A failure here is logged to function_errors like every other function's,
// which means tomorrow's digest reports it. That is the intended shape and
// not a loop: a digest that cannot send is a background error the office
// should hear about, and it is said once a day at most.
//
// The gateway can't vouch for the caller: the pg_cron job holds no user
// JWT, so verify_jwt is off and the door is chat-retention's exactly — the
// database signs its call with x-internal-secret, minted in
// private.internal_config and read only through the service-role accessor,
// and a request without it is not the database.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendMail, appSettings, corsHeaders, wrapEmail, esc } from "../_shared/mail.ts";
import { secretsMatch } from "../_shared/constantTime.ts";

const SUBJECT = "VagaboNDE Field Ops — needs attention";

// attention.js's two windows, and the same reasons: a day, so the error
// count means the same thing at every hour; six hours of lateness before
// lateness is news, because the tick moves next_run_at the moment a run
// starts and a due date still in the past hours later means nothing picked
// it up at all.
const ERRORS_WINDOW_MS = 24 * 60 * 60 * 1000;
const OVERDUE_GRACE_MS = 6 * 60 * 60 * 1000;

// Enough of a bad night to count exactly; a cap so a database having a very
// bad week does not pull ten thousand rows into an email that only wants a
// number. PostgREST would cap it at 1,000 regardless.
const ERROR_SCAN = 1000;

const KIND_WORDS: Record<string, string> = {
  backup: "backup",
  before_restore: "safety backup",
  restore_all: "restore",
  restore_jobs: "job restore",
  // The fortnightly file check. attention.js holds the same five words and
  // the two must move together — the strip and this email read one row;
  // attention.test.mjs reads this block back and fails on drift.
  verify: "file check"
};

interface Item { key: string; text: string; where: string }

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function agoPhrase(ms: number): string {
  const d = Math.max(0, Number(ms) || 0);
  if (d < 3600000) return "less than an hour ago";
  if (d < 86400000) {
    const hours = Math.floor(d / 3600000);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(d / 86400000);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function byFunction(rows: { function_name?: string | null }[]): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const name = String(r.function_name || "unknown");
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${name} (${n})`);
}

interface BackupFacts {
  connected: boolean;
  connectionError: string;
  nextRunAt: string | null;
  lastRun: { kind?: string | null; status?: string | null; error?: string | null; finished_at?: string | null; started_at?: string | null } | null;
}

function attentionItems(
  backup: BackupFacts, errors: { function_name?: string | null; created_at?: string | null }[], at: number
): Item[] {
  const items: Item[] = [];

  // First, because it is the one that stops everything else.
  if (backup.connectionError) {
    items.push({
      key: "connection",
      text: `The backup drive needs reconnecting — ${backup.connectionError}`,
      where: "Open the Admin screen, Automatic backup, and connect the drive again. Backups are not running until you do."
    });
  }

  const last = backup.lastRun;
  if (last && last.status === "failed") {
    const word = KIND_WORDS[String(last.kind ?? "")] ?? "backup";
    const finished = Date.parse(last.finished_at || last.started_at || "");
    const ago = Number.isFinite(finished) ? ` ${agoPhrase(at - finished)}` : "";
    const why = String(last.error ?? "").trim();
    items.push({
      key: "failed-run",
      text: `Last ${word} failed${ago}${why ? ` — ${why}` : ""}`,
      // A file check has no button: the tick is its only door, and the clock
      // moved a fortnight on when this run started.
      where: String(last.kind ?? "") === "verify"
        ? "Open the Admin screen, Recent background errors, to see what went wrong. The next file check is a fortnight off; tonight's backup does not repeat it."
        : "Open the Admin screen, Automatic backup, to read what it says and start another."
    });
  }

  // Only worth saying when a drive is connected and answering: with no
  // connection there is no schedule to be late for, and with a lapsed one
  // the line above is already the cause and the fix.
  const due = Date.parse(backup.nextRunAt || "");
  if (backup.connected && !backup.connectionError && Number.isFinite(due) && at - due > OVERDUE_GRACE_MS) {
    items.push({
      key: "overdue",
      text: `A backup was due ${agoPhrase(at - due)} and has not started`,
      where: "Open the Admin screen, Automatic backup, and press Back up now."
    });
  }

  if (errors.length) {
    items.push({
      key: "errors",
      text: `${errors.length} background error${errors.length === 1 ? "" : "s"} since yesterday — ${byFunction(errors).join(", ")}`,
      where: "Open the Admin screen, Recent background errors."
    });
  }

  return items;
}

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

    // backup_state() is the panel's read and is gated on the caller's own
    // Admin profile, which the service role does not have — so the same
    // three facts are read from the columns directly. The refresh token is
    // read for its existence alone and never leaves this isolate.
    // Three independent reads, started together. The most recently finished
    // run, backup or restore, is ordered by finished_at with nulls last: a
    // run in either of these two states has one, and a row that somehow does
    // not must not sort above the run that actually finished last. Only the
    // function names are read off the errors — the window is the filter.
    const [
      { data: s, error: sErr },
      { data: runs, error: rErr },
      { data: errorRows, error: eErr }
    ] = await Promise.all([
      admin.from("app_settings")
        .select("backup_refresh_token, backup_connection_error, backup_next_run_at")
        .maybeSingle(),
      admin.from("backup_runs")
        .select("kind, status, error, started_at, finished_at")
        .in("status", ["complete", "failed"])
        .order("finished_at", { ascending: false, nullsFirst: false })
        .limit(1),
      admin.from("function_errors")
        .select("function_name")
        .gte("created_at", new Date(now - ERRORS_WINDOW_MS).toISOString())
        .limit(ERROR_SCAN)
    ]);
    if (sErr) throw sErr;
    if (rErr) throw rErr;
    if (eErr) throw eErr;

    const items = attentionItems({
      connected: !!(s && s.backup_refresh_token),
      connectionError: String((s && s.backup_connection_error) || "").trim(),
      nextRunAt: (s && s.backup_next_run_at) || null,
      lastRun: (runs && runs[0]) || null
    }, errorRows ?? [], now);

    // Nothing wrong: no email. The silence is the message.
    if (!items.length) return json({ ok: true, sent: 0, items: 0 });

    const to = await adminAddresses(admin);
    if (!to.length) {
      // Worth recording rather than returning quietly: an install with no
      // reachable Admin has nobody to tell, which is itself the problem.
      throw new Error("There is nothing wrong with the digest, but no active Admin has an email address to send it to.");
    }

    const html = wrapEmail(`
<h2 style="margin:0 0 4px;font-size:18px">Needs attention</h2>
<p style="margin:0 0 16px;color:#555">What the app recorded overnight, and what to do about each.</p>
${items.map(i => `
<div style="margin:0 0 14px">
  <div><strong>${esc(i.text)}</strong></div>
  <div style="color:#555">${esc(i.where)}</div>
</div>`).join("")}
<p style="margin:16px 0 0;color:#555">This only arrives on a morning when something needs doing.</p>`);

    const text = `Needs attention\n\n${
      items.map(i => `${i.text}\n  ${i.where}`).join("\n\n")
    }\n\nThis only arrives on a morning when something needs doing.\n`;

    // A handful of recipients at most, so a plain loop rather than the
    // browser's send pool: that exists for the thousands of approval emails
    // the chase sends, and its rate-limit dance is not what four addresses
    // need. One refused address must not cost the others their copy, so
    // each is tried on its own and the refusals are named in the answer.
    let sent = 0;
    const refused: string[] = [];
    // One settings read for every copy, not one per Admin.
    const settings = await appSettings();
    for (const address of to) {
      try {
        await sendMail({
          settings,
          from: "reports",
          to: address,
          subject: SUBJECT,
          htmlBody: html,
          textBody: text,
          tag: "admin-digest"
        });
        sent++;
      } catch (e) {
        refused.push(`${address}: ${(e as Error).message}`);
      }
    }

    if (!sent) throw new Error(`The digest reached nobody. ${refused.join(" · ")}`);
    if (refused.length) await logError("admin-digest", `Some Admins did not get the digest. ${refused.join(" · ")}`);

    return json({ ok: true, sent, items: items.length, refused: refused.length });
  } catch (e) {
    await logError("admin-digest", (e as Error).message);
    return json({ error: (e as Error).message }, 400);
  }
});

// Every Admin who can still sign in. profiles holds the rank; Auth holds
// the addresses, so the two are read separately and joined by id — the same
// join the backup makes for auth_email, for the same reason.
async function adminAddresses(admin: SupabaseClient): Promise<string[]> {
  const { data: profiles, error } = await admin.from("profiles")
    .select("id")
    .eq("role", "Admin")
    .is("deactivated_at", null);
  if (error) throw error;
  const wanted = new Set((profiles ?? []).map(p => String(p.id)));
  if (!wanted.size) return [];

  const found: string[] = [];
  for (let page = 1; page <= 20; page++) {
    const { data, error: uErr } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (uErr) throw uErr;
    const users = data?.users ?? [];
    for (const u of users) {
      if (wanted.has(u.id) && u.email) found.push(u.email);
    }
    // An empty page is the end of the list. Stopping on a short one would
    // trust the gateway to honour perPage, which it does not have to.
    if (!users.length) break;
  }
  return found;
}

async function logError(functionName: string, message: string, context: Record<string, unknown> = {}) {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort; never let it mask the real error */ }
}
