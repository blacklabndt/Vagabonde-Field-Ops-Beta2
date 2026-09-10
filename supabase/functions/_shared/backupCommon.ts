// The plumbing the three backup functions share: CORS, a JSON reply, the
// service-role client, the error log, the door a caller has to come
// through, the connected drive, and the kick one slice gives the next.
//
// Deno-only, deliberately. This is the one backup module that imports
// supabase-js and reads the environment — the others (drive.ts,
// backupTables.ts, backupManifest.ts, backupOauth.ts, backupSchedule.ts,
// backupRun.ts, gzip.ts) are imported straight into the node test suite and
// must stay import-free, so nothing here may ever move into them.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { makeDrive, refreshAccessToken } from "./drive.ts";
import type { DriveClient } from "./drive.ts";
import { BACKUP_ROOT_NAME, MANIFEST_NAME } from "./backupManifest.ts";
import { FILES_INDEX_NAME, RETRIES, parseFileIndex, retryDelayMs, worthAnotherGo } from "./backupRun.ts";
import type { FileRecord } from "./backupRun.ts";
import { gunzip } from "./gzip.ts";
import { secretsMatch } from "./constantTime.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret"
};

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" }
  });

// The service role. Everything the backup does to app_settings — the tokens,
// the nonce, the connection's own columns — is written with this, because no
// signed-in account has a grant on any of it.
export const adminClient = (): SupabaseClient => createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Who is asking, answered before anything is read from them. The parse of a
// request body throws on malformed input and the catch that follows writes
// to function_errors — a log an anonymous POST must not be able to fill.
//
// Returns a Response when the caller is refused, and the caller's id when
// they are not. Checked against their own profile through RLS, the way
// delete-user does it, so a non-admin JWT cannot claim a rank.
export async function requireAdmin(
  req: Request, refusal = "Only an Admin can set up the backup"
): Promise<{ userId: string } | Response> {
  const asUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } }
  );
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "Not signed in" }, 401);

  const { data: profile } = await asUser.from("profiles").select("role").eq("id", user.id).single();
  if (!profile || profile.role !== "Admin") {
    return json({ error: refusal }, 403);
  }
  return { userId: user.id };
}

// The value the database signs its own calls with. It lives in
// private.internal_config and is readable only through this accessor, which
// is the service role's — chat-retention reads it the same way, and the
// self-kick between slices presents the very same string, so there is no
// second secret to rotate.
export async function internalSecret(db: SupabaseClient): Promise<string> {
  const { data, error } = await db.rpc("internal_secret");
  if (error) throw error;
  return String(data ?? "");
}

export interface Caller { internal: boolean; userId: string; secret: string }

// Who is asking, answered before a byte of their body is read.
//
// Two callers are legitimate and neither can be vouched for by the gateway:
// the pg_cron tick, which pg_net sends with no Authorization header at all
// and signs with x-internal-secret, and an Admin pressing a button. A
// request presenting the header is judged on the header alone — a wrong one
// is a refusal, not a fall-through to the Admin door, because a caller who
// knows to send that header and gets it wrong is not somebody's browser.
//
// Nothing here is written to function_errors: this endpoint answers to
// anyone with the publishable key, and a log a stranger can fill is not a
// log. Returns a Response when the caller is refused.
export async function backupDoor(
  db: SupabaseClient, req: Request, refusal: string
): Promise<Caller | Response> {
  const presented = req.headers.get("x-internal-secret");
  if (presented) {
    const expected = await internalSecret(db);
    // Constant time, never `===`: a compare that stops at the first byte
    // that differs times out how much of the secret the caller has right.
    if (!secretsMatch(presented, expected)) return json({ error: "Not authorized" }, 401);
    return { internal: true, userId: "", secret: expected };
  }
  const who = await requireAdmin(req, refusal);
  if (who instanceof Response) return who;
  return { internal: false, userId: who.userId, secret: "" };
}

// The next slice, started by this one and then abandoned. The request has
// left the moment the timeout fires; the callee runs its own budget
// regardless. Failures are ignored on purpose — the five-minute cron is the
// safety net, and a run whose chain breaks here still finishes, only slower.
//
// The handler returns as soon as this is fired, and an isolate with nothing
// left to answer can be reaped before the request has actually gone out.
// Deno's edge runtime holds the isolate open for a promise handed to
// EdgeRuntime.waitUntil, so the kick is handed over where that global
// exists; anywhere it does not, the promise is abandoned exactly as before.
// Either way the five-minute cron is the backstop — a kick that never left
// costs the chain a link, not the run.
interface EdgeRuntimeLike { waitUntil?: (promise: Promise<unknown>) => void }

export function kick(functionName: string, body: unknown, secret: string): void {
  if (!secret) return;
  const sent = fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/${functionName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      "x-internal-secret": secret
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(1500)
  }).then(r => r.body?.cancel()).catch(() => { /* the cron will pick it up */ });

  const edge = (globalThis as unknown as { EdgeRuntime?: EdgeRuntimeLike }).EdgeRuntime;
  if (edge && typeof edge.waitUntil === "function") edge.waitUntil(sent);
}

// ── The connected drive ──────────────────────────────────────────────────

export interface Connection {
  drive: DriveClient;
  provider: string;
  rootFolderId: string;
  account: string;
  keep: number;
}

// Every other network call in a slice goes through backup-run's withRetry;
// this one is the exception that used to be, and it is the first call of
// every slice — so a token endpoint having a bad second failed a restore
// between the wipe and the load, which is the worst moment in the feature
// to fail at. Same three goes, same widening gaps, and the same discipline
// about what is worth repeating: a 5xx or a reply that never came, never an
// invalid_grant. A refusal still ends up in backup_connection_error, only
// after the drive has had its three chances instead of one.
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

async function refreshWithRetry(
  provider: string, clientId: string, clientSecret: string, refresh: string
): Promise<string> {
  let last: unknown = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try { return await refreshAccessToken(provider, clientId, clientSecret, refresh); }
    catch (e) {
      last = e;
      if (!worthAnotherGo(e) || attempt >= RETRIES) break;
      await pause(retryDelayMs(attempt));
    }
  }
  throw last;
}

// The refresh token is long-lived and the access token is not, so every
// function that touches the drive starts here: read the connection out of
// app_settings with the service role, trade the refresh token for an access
// token, and hand back a DriveClient. A refresh that fails is the one
// failure the Admin has to act on — the drive has revoked us, or the
// registration's secret has been rotated — so it is written to
// backup_connection_error, which is what the panel reads.
export async function connectDrive(db: SupabaseClient): Promise<Connection> {
  const { data, error } = await db.from("app_settings").select(
    "backup_provider, backup_refresh_token, backup_account, backup_root_folder_id, backup_keep, " +
    "backup_connection_error, " +
    "backup_client_id_google, backup_client_secret_google, backup_client_id_microsoft, " +
    "backup_client_secret_microsoft, backup_client_id_dropbox, backup_client_secret_dropbox"
  ).maybeSingle();
  if (error) throw error;

  const row = (data ?? {}) as Record<string, string | number | null>;
  const provider = String(row.backup_provider ?? "");
  const refresh = String(row.backup_refresh_token ?? "");
  if (!provider || !refresh) {
    throw new Error("No drive is connected. Connect one on the Admin screen before a backup can run.");
  }
  const clientId = String(row[`backup_client_id_${provider}`] ?? "");
  const clientSecret = String(row[`backup_client_secret_${provider}`] ?? "");

  let token: string;
  try {
    token = await refreshWithRetry(provider, clientId, clientSecret, refresh);
  } catch (e) {
    const why = (e as Error).message;
    await db.from("app_settings").update({ backup_connection_error: why }).eq("id", true);
    throw new Error(`The drive connection needs renewing: ${why}`);
  }
  // A refresh that worked clears a stale complaint — when there is one.
  // This runs at the top of every slice, and an unconditional write here
  // was one UPDATE of the settings row every hundred seconds for the length
  // of a backup, for a column that was already null.
  if (row.backup_connection_error) {
    await db.from("app_settings").update({ backup_connection_error: null }).eq("id", true);
  }

  const drive = makeDrive(provider, token);
  let rootFolderId = String(row.backup_root_folder_id ?? "");
  if (!rootFolderId) {
    rootFolderId = await ensureFolder(drive, drive.rootId(), BACKUP_ROOT_NAME);
    await db.from("app_settings").update({ backup_root_folder_id: rootFolderId }).eq("id", true);
  }

  return {
    drive, provider, rootFolderId,
    account: String(row.backup_account ?? ""),
    keep: Number(row.backup_keep ?? 14)
  };
}

// Find it or make it. Running the same slice twice must land in the folder
// that is already there, not beside it.
export async function ensureFolder(drive: DriveClient, parentId: string, name: string): Promise<string> {
  const found = (await drive.listFolders(parentId)).find(f => f.name === name);
  return found ? found.id : await drive.createFolder(parentId, name);
}

// Several siblings under one parent from a single listing — a slice used to
// list the run's folder twice, once per child, at its top. Find-then-create
// in that order, one name at a time, for the same reason as above.
export async function ensureFolders(drive: DriveClient, parentId: string, names: string[]): Promise<string[]> {
  const found = await drive.listFolders(parentId);
  const out: string[] = [];
  for (const name of names) {
    const hit = found.find(f => f.name === name);
    out.push(hit ? hit.id : await drive.createFolder(parentId, name));
  }
  return out;
}

// Run `fn` over `items` a few at a time, answering in the input's order.
// Kept small: a provider answers a handful of concurrent reads gladly and
// starts refusing dozens.
export async function mapLimit<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

// One backup's manifest, read out of its own folder. A folder with none is a
// run that never finished, and saying so is the point: the restore has
// nothing to work from and must not pretend otherwise.
// The folder's per-file index (files.json.gz, written by the manifest
// phase): name → what was stored, with the SHA-256 of the bytes. An empty
// map for a folder from before the index existed, or one whose index
// cannot be read — the callers treat "no record" as "nothing to check
// against" for a restore and "read it through" for a carry-over.
export async function readFileIndex(
  drive: DriveClient, folderId: string
): Promise<Map<string, FileRecord>> {
  if (!folderId) return new Map();
  const file = (await drive.listFiles(folderId)).find(f => f.name === FILES_INDEX_NAME);
  if (!file) return new Map();
  return parseFileIndex(new TextDecoder().decode(await gunzip(await drive.download(file.id))));
}

export async function readManifest(
  drive: DriveClient, folderId: string
): Promise<Record<string, unknown>> {
  if (!folderId) throw new Error("folderId is required");
  const file = (await drive.listFiles(folderId)).find(f => f.name === MANIFEST_NAME);
  if (!file) throw new Error("That backup has no manifest — it did not finish, so there is nothing to restore from.");
  return JSON.parse(new TextDecoder().decode(await drive.download(file.id))) as Record<string, unknown>;
}

export async function logError(
  functionName: string, message: string, context: Record<string, unknown> = {}
): Promise<void> {
  try {
    await adminClient().from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort; never let it mask the real error */ }
}
