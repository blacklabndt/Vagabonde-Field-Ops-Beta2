// report-error — the browser's half of the error log.
//
// Every Edge Function writes its failures to public.function_errors. The
// browser wrote none: ErrorBoundary called console.error on a phone nobody
// was looking at. This is the endpoint that closes that half, and it is
// deliberately the narrowest one in the project.
//
// What it will not do, and why:
//
//   * The browser never writes the table. A direct grant would mean any
//     signed-in account could write rows the office reads as truth; the
//     service role inserts here and function_errors' own RLS is untouched.
//   * No message, no stack, no URL is accepted. Approval tokens and OAuth
//     codes live in URLs and React puts both messages and stacks within
//     reach of props. See _shared/crashReport.ts for the whole argument.
//   * Nothing the browser sends decides who or when. The account comes from
//     the verified JWT and the minute comes from this server's clock.
//
// The rate limit is one report per account per minute, and it is the insert:
// browser_crashes is keyed on (user_id, minute_bucket), so a second report
// in the same minute collides on the primary key and is swallowed. No count
// first — two tabs crashing together would both read zero and both write.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/mail.ts";
import { validateCrashReport, minuteBucket, MAX_BODY_BYTES } from "../_shared/crashReport.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// Postgres' unique_violation. A second crash in the same minute is the rate
// limit doing its job, not a failure: the browser is told ok and drops it.
const UNIQUE_VIOLATION = "23505";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") ?? "";
  const asUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "Not signed in" }, 401);

  // The byte ceiling is read, not trusted: Content-Length is the caller's
  // word for it, so the bytes themselves are counted before anything parses
  // them. A body over the ceiling is refused unparsed.
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) return json({ error: "Report too large." }, 413);

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return json({ error: "Not a report." }, 400);
  }

  const checked = validateCrashReport(body);
  if ("error" in checked) return json({ error: checked.error }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { error } = await admin.from("browser_crashes").insert({
    ...checked.report,
    user_id: user.id,
    minute_bucket: minuteBucket(new Date())
  });

  if (error && error.code !== UNIQUE_VIOLATION) {
    // The office reads function_errors; a reporting endpoint that fails
    // quietly would be the same blindness one layer further in.
    try {
      await admin.from("function_errors").insert({
        function_name: "report-error",
        message: error.message
      });
    } catch { /* logging is best-effort */ }
    return json({ error: "The report could not be filed." }, 400);
  }

  return json({ ok: true });
});
