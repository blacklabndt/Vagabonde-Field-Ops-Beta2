// backup-oauth — connecting one drive account, and letting go of it.
//
// Two doors in one function, because the provider redirects a browser back
// to a fixed address and that browser carries no JWT:
//
//   POST {action:"start"|"disconnect"}   a signed-in Admin, checked here
//   GET  /backup-oauth/<provider>?code=  the provider's redirect, no JWT
//
// The callback's credential is the nonce: `start` mints one into
// app_settings, the callback must present it, and it is spent the moment it
// is read — so a replayed callback URL does nothing. Ten minutes is longer
// than any consent screen takes and shorter than a link left in a history.
//
// Verification is off for this function (pinned in supabase/config.toml,
// not passed at deploy time) because the callback has no bearer token. Off
// does not mean open: POST checks the caller's own profile the way
// delete-user does, before it reads a byte of their body, and GET acts only
// on a nonce this function minted.
//
// The client secret never leaves the server, and the refresh token never
// reaches the browser: the panel learns "connected, as <account>" through
// backup_state() and nothing else.

import { authorizeUrl, exchangeCode, makeDrive, PROVIDERS } from "../_shared/drive.ts";
import { BACKUP_ROOT_NAME } from "../_shared/backupManifest.ts";
import { nextRunAt } from "../_shared/backupSchedule.ts";
import { callbackUri, credentialsFrom, nonceRefusal, providerInPath, providerRefusal } from "../_shared/backupOauth.ts";
import { adminClient, corsHeaders, json, logError, requireAdmin } from "../_shared/backupCommon.ts";
import { refuse, publicWords, loggedWords } from "../_shared/publicError.ts";
// The one sentence anything unmarked comes back as. A refusal of ours says
// what to do and is shown as written; a message from Postgres, Auth, Resend
// or a drive names columns, constraints and accounts, so it is logged and not
// shown. Deny by default: the cost of forgetting is silence.
const TROUBLE = "The drive connection could not be set up. Try again, and tell the office if it keeps happening.";

// What the provider's redirect answers a stranger with. No Admin is
// necessarily reading it, so it names the one thing an Admin could fix
// and nothing about this project.
const ANON_TROUBLE = "The drive could not be connected. An Admin can check the App address on the Admin screen and try connecting again.";

// Everything the two doors read out of the one settings row. Selected by
// name rather than with * so it is visible here exactly which columns this
// function touches — and so the refresh token, which it has no reason to
// read, is not among them.
const SETTINGS_COLUMNS = [
  "approval_base_url",
  "backup_oauth_state", "backup_oauth_state_at",
  "backup_frequency", "backup_weekday", "backup_hour",
  "backup_client_id_google", "backup_client_secret_google",
  "backup_client_id_microsoft", "backup_client_secret_microsoft",
  "backup_client_id_dropbox", "backup_client_secret_dropbox"
].join(", ");

type Settings = Record<string, string | number | null>;

async function readSettings(db: ReturnType<typeof adminClient>): Promise<Settings> {
  const { data, error } = await db.from("app_settings").select(SETTINGS_COLUMNS).maybeSingle();
  if (error) throw error;
  return (data ?? {}) as Settings;
}

// The app's own public address, resolved the way the rest of the app
// resolves it: the Admin screen's column first, the old APPROVAL_BASE_URL
// secret as the fallback (see _shared/mail.ts). Reading the column alone
// refused to start a connection on a project where the column has never
// been filled in and the secret has been carrying the approval links for
// months — which is the state the live project is in.
const appBaseUrl = (settings: Settings): string =>
  String(settings.approval_base_url ?? "").trim() || Deno.env.get("APPROVAL_BASE_URL") || "";

// Everything the callback refuses *before* the nonce is honoured is refused
// to a stranger — anyone at all can open /backup/oauth/google, and a crawler
// following a link out of somebody's history will. Those refusals are said
// to the browser and not written down, or function_errors becomes a log
// anybody can fill. Past the nonce the caller is this app's own Admin coming
// back from a consent screen, and everything they hit is worth a line.
const quiet = (message: string): Error => Object.assign(new Error(message), { quiet: true });
const isQuiet = (e: unknown): boolean => !!(e as { quiet?: boolean })?.quiet;

// Spend the nonce that was actually presented, and only that one.
//
// Nulling it on `id` alone was a door held open by anyone who knew the
// callback address: a crawler, a stranger, a stale link — every GET cleared
// the nonce the Admin's Connect had minted seconds earlier, so the real
// callback arrived to find nothing to compare against and no connection
// could ever be completed while that traffic continued. Matching on the
// value keeps what the unconditional write was for: the second arrival of
// the same callback URL finds the nonce gone and is refused.
async function spendNonce(db: ReturnType<typeof adminClient>, presented: string): Promise<void> {
  // An empty presentation matches nothing — nonceRefusal refuses it anyway —
  // and there is no reason to write the row for it.
  if (!presented) return;
  await db.from("app_settings")
    .update({ backup_oauth_state: null, backup_oauth_state_at: null })
    .eq("id", true).eq("backup_oauth_state", presented);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const provider = providerInPath(url.pathname);

  // The drive sending the Admin home. No token, and none expected. GET
  // alone: the callback spends the nonce, and a HEAD — a link checker, a
  // preview crawler — has no business spending anything.
  if (req.method === "GET" && provider) {
    return await callback(provider, url);
  }

  if (req.method !== "POST") return json({ error: "Not found" }, 404);

  // Who is asking, before anything is read from them.
  const who = await requireAdmin(req);
  if (who instanceof Response) return who;

  try {
    const body = await req.json();
    const db = adminClient();

    if (body.action === "disconnect") {
      // Every column of the connection, together. Letting go of a drive has
      // to leave nothing behind for a tick to pick up — a stale root folder
      // id or a provider without a token would be read as half a connection.
      const { error } = await db.from("app_settings").update({
        backup_provider: null,
        backup_refresh_token: null,
        backup_account: null,
        backup_root_folder_id: null,
        backup_connection_error: null,
        backup_oauth_state: null,
        backup_oauth_state_at: null,
        backup_next_run_at: null,
        updated_at: new Date().toISOString()
      }).eq("id", true);
      if (error) throw error;
      return json({ ok: true });
    }

    if (body.action !== "start") throw refuse("action must be \"start\" or \"disconnect\"");
    const wanted = String(body.provider ?? "");
    if (!PROVIDERS.includes(wanted)) throw refuse(`provider must be one of: ${PROVIDERS.join(", ")}`);

    const settings = await readSettings(db);
    const { id } = credentialsFrom(settings as Record<string, string | null>, wanted);
    const { uri } = callbackUri(appBaseUrl(settings), wanted);

    const state = crypto.randomUUID() + crypto.randomUUID();
    const { error: nErr } = await db.from("app_settings").update({
      backup_oauth_state: state,
      backup_oauth_state_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq("id", true);
    if (nErr) throw nErr;

    return json({ url: authorizeUrl(wanted, id, uri, state) });
  } catch (e) {
    await logError("backup-oauth", loggedWords(e));
    return json({ error: publicWords(e, TROUBLE) }, 400);
  }
});

// ── The provider's redirect ──────────────────────────────────────────────

async function callback(provider: string, url: URL): Promise<Response> {
  const db = adminClient();

  let settings: Settings = {};
  let base = "";
  try {
    settings = await readSettings(db);
    base = callbackUri(appBaseUrl(settings), provider).base;
  } catch (e) {
    // With no app address configured there is nowhere to send them; say so
    // in the one place that can still be read. The Worker re-serves this
    // body as its own error page. Not logged: this is reachable by anyone,
    // and a door anyone can knock on must not be a way to fill the log.
    //
    // Which is also why the words are judged. This is the ONE anonymous
    // path in the backup functions, and readSettings rethrows PostgREST's
    // own error, so a database blink used to answer a stranger with the
    // column list of app_settings. callbackUri's refusal is ours and is
    // shown; anything else is not.
    return new Response(publicWords(e, ANON_TROUBLE), {
      status: 400, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
    });
  }

  const home = (query: string) => new Response(null, {
    status: 302, headers: { Location: `${base}/?${query}`, "Cache-Control": "no-store" }
  });

  try {
    // The Admin pressed Cancel on the consent screen. Not an error to log.
    if (url.searchParams.get("error")) {
      // The Admin's own cancellation carries the state they were sent out
      // with, so it spends that nonce and nothing else.
      await spendNonce(db, url.searchParams.get("state") ?? "");
      return home("backup=denied");
    }

    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (!code || !state) throw quiet("The drive sent us back without an authorisation code.");

    const expected = settings.backup_oauth_state;
    const mintedAt = settings.backup_oauth_state_at
      ? Date.parse(String(settings.backup_oauth_state_at)) : NaN;
    // Spend the nonce before doing anything with it, so a re-opened callback
    // URL — a browser restoring tabs, a link in somebody's history — cannot
    // run the exchange a second time. Only the nonce presented here is spent;
    // a stranger's GET must not clear one minted for somebody else.
    await spendNonce(db, state);
    const refusal = nonceRefusal(expected as string | null, state, mintedAt, Date.now());
    if (refusal) throw quiet(refusal);

    const { id, secret } = credentialsFrom(settings as Record<string, string | null>, provider);
    const { uri } = callbackUri(appBaseUrl(settings), provider);
    const { accessToken, refreshToken } = await exchangeCode(provider, id, secret, code, uri);

    const drive = makeDrive(provider, accessToken);
    const account = await drive.accountName();

    // The app's own folder, made if it is not there. createFolder finds
    // before it creates on all three providers, so connecting the same
    // account a second time reuses the folder that already holds the
    // backups rather than starting a second pile beside it.
    const folderId = await drive.createFolder(drive.rootId(), BACKUP_ROOT_NAME);

    // Connecting a different provider replaces the old one wholesale: every
    // column below is written, so nothing of the previous connection is left
    // behind to be picked up by a tick.
    const { error: uErr } = await db.from("app_settings").update({
      backup_provider: provider,
      backup_refresh_token: refreshToken,
      backup_account: account,
      backup_root_folder_id: folderId,
      backup_connection_error: null,
      // The schedule starts counting from the moment it has somewhere to go.
      backup_next_run_at: nextRunAt({
        frequency: String(settings.backup_frequency ?? "daily"),
        weekday: Number(settings.backup_weekday ?? 0),
        hour: Number(settings.backup_hour ?? 2)
      }, Date.now()),
      updated_at: new Date().toISOString()
    }).eq("id", true);
    if (uErr) throw uErr;

    return home("backup=connected");
  } catch (e) {
    const message = (e as Error).message;
    // function_errors gets the message as it was thrown — the provider's own
    // body and all, which is the whole use of a log.
    if (!isQuiet(e)) await logError("backup-oauth", message, { provider });
    // The reason travels in the query string so the panel can say it, and it
    // is this app's own words: providerRefusal turns a drive's refusal into a
    // written sentence, so the up-to-400 characters of response body that
    // drive.ts's ok() carries never reach an address bar.
    return home(`backup=failed&why=${encodeURIComponent(providerRefusal(message).slice(0, 300))}`);
  }
}
