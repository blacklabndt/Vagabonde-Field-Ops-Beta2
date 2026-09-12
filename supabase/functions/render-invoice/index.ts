// render-invoice — the field invoice as the office sees it.
//
// The same document a client is sent, rendered for someone signed in. Job
// detail shows this when a ticket is opened to be read, so what the office
// looks at and what the client signed are one document rather than two
// descriptions of one.
//
// Read as the caller, not with the service role: row-level security decides
// which tickets a person can see, and this must not be a way around that.
// Unlike approve-ticket, there is no token — the JWT is the credential, so
// this one is deployed with JWT verification left on.
//
// Returns HTML, which Supabase serves from the shared functions domain as
// text/plain with a sandbox CSP. That does not matter here: the app fetches
// this and puts it in an iframe rather than navigating to it, so the browser
// never has to be persuaded to render the response itself.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/mail.ts";
import { invoicePage } from "../_shared/invoice.ts";
import { loadInvoice } from "../_shared/ticketInvoice.ts";
import { refuse, publicWords, loggedWords } from "../_shared/publicError.ts";

const TROUBLE = "The invoice could not be built. Try again, and tell the office if it keeps happening.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Who is asking comes before anything is read from them: the parse below
  // throws on a malformed body, and the catch at the bottom writes that to
  // function_errors — a log an anonymous POST must not be able to fill.
  const asUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } }
  );
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "Not signed in" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  try {
    const { ticketId } = await req.json();
    if (!ticketId) throw refuse("This request didn't say which ticket to render. Reload the app and try again.");

    const { data, error } = await loadInvoice(asUser, ticketId);
    if (error || !data) throw refuse("Ticket not found, or you don't have access to it.", error ?? "no invoice row");

    return new Response(JSON.stringify({ html: invoicePage(data) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (e) {
    // The office reads everything; the person reads only what was written
    // for them. See _shared/publicError.ts for why the default is masking.
    await logError("render-invoice", loggedWords(e));
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
