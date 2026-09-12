// report-error — the browser's half of the error log.
//
// Every Edge Function writes its failures to public.function_errors. The
// browser wrote none: ErrorBoundary called console.error on a phone nobody
// was looking at. This is the endpoint that closes that half, and it is
// deliberately the narrowest one in the project.
//
// What it will not do, and why:
//
//   * The browser never writes a table. A direct grant would mean any
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
//
// The judgement itself is handler.ts, which has no network and no database
// in it, so crashReport.test.mjs runs these paths instead of reading them.
// This file is the wiring: two clients and a port.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/mail.ts";
import { handleReport } from "./handler.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const result = await handleReport(req, {
    getUser: async (authHeader) => {
      const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } }
      });
      const { data: { user } } = await asUser.auth.getUser();
      return user ? { id: user.id } : null;
    },
    insertCrash: async (row) => (await admin.from("browser_crashes").insert(row)).error,
    insertLog: async (row) => (await admin.from("function_errors").insert(row)).error,
    now: () => new Date()
  });

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
});
