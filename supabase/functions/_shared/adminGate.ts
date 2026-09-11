// The Deno half of the Admin door: read the caller's own profile, hand it
// to `adminRefusal` in activeAdmin.ts, and answer.
//
// It is its own module and not part of backupCommon.ts because the five
// account functions need the same door and none of them wants drive.ts,
// gzip.ts and the backup cursor that come with that file. backupCommon's
// `requireAdmin` now calls through to here, so there is ONE answer to "is
// this caller still an Admin" and not six copies drifting apart — which is
// how the rank came to be the only thing any of them asked.
//
// Deliberately outside the import-free guard: it talks to supabase-js. The
// decision it defers to does not, which is why that half is testable.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ADMIN_SELECT, adminRefusal } from "./activeAdmin.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret"
};

export interface ActiveAdmin {
  userId: string;
  /** The caller's own client, so a route that reads on as them need not build a second. */
  asUser: SupabaseClient;
}

// Who is asking, answered before anything is read from them — the parse of
// a request body throws on malformed input, and the catch that follows
// writes to function_errors, a log an anonymous POST must not be able to
// fill.
//
// Returns a Response when the caller is refused. The profile is read
// through RLS as the caller, the way it always was: that part was never the
// problem. What it is judged on is.
export async function requireActiveAdmin(
  req: Request, refusal: string
): Promise<ActiveAdmin | Response> {
  const say = (error: string, status: number) => new Response(
    JSON.stringify({ error }),
    { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );

  const asUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } }
  );

  // getUser() asks Auth itself, which refuses a banned account — that is
  // the half that already worked. The stamp on the profile is the half
  // that did not: a lock whose ban never landed, and a lock that is only
  // ever a lock in this application's own records.
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return say("Not signed in", 401);

  // maybeSingle, not single: `single()` makes a missing row an ERROR, and
  // the old code discarded the error, so no row and a failed read were the
  // same silence. They are different answers and the gate gives different
  // words to each.
  const { data, error } = await asUser.from("profiles")
    .select(ADMIN_SELECT).eq("id", user.id).maybeSingle();

  const no = adminRefusal(data, Boolean(error), refusal);
  if (no) return say(no.error, no.status);
  return { userId: user.id, asUser };
}
