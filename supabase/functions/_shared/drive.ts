// One drive, three vendors, and a fake to test against.
//
// Everything a provider does differently lives inside its own class:
// Google's resumable sessions, Graph's upload sessions and its 320 KiB
// chunk arithmetic, Dropbox's paths-instead-of-ids and its arguments in an
// HTTP header. Above them the app has five verbs and two questions, and
// never asks which vendor it is talking to.
//
// Erasable TypeScript only, and no imports at all — not supabase-js, not
// the runtime's environment object: vite-app/src/backupShared.test.mjs
// imports this file directly and node strips the types. Credentials arrive
// as arguments; nothing here reads the environment.

export const PROVIDERS: string[] = ["google", "microsoft", "dropbox"];

export const SCOPES: Record<string, string> = {
  google: "https://www.googleapis.com/auth/drive.file",
  microsoft: "Files.ReadWrite offline_access",
  dropbox: "files.content.write files.content.read files.metadata.read"
};

// Above this, an upload goes through the provider's resumable/session API.
// Below it, one request. Five megabytes is both a sensible cut-off and a
// whole number of Graph's mandatory 320 KiB chunks.
export const RESUMABLE_BYTES = 5 * 1024 * 1024;

export interface DriveFolder { id: string; name: string }
export interface DriveEntry { id: string; name: string; size: number }

export interface DriveClient {
  rootId(): string;
  accountName(): Promise<string>;
  listFolders(parentId: string): Promise<DriveFolder[]>;
  listFiles(parentId: string): Promise<DriveEntry[]>;
  createFolder(parentId: string, name: string): Promise<string>;
  upload(folderId: string, name: string, body: Uint8Array, contentType: string): Promise<string>;
  download(fileId: string): Promise<Uint8Array>;
  delete(id: string): Promise<void>;
}

// A refusal worth retrying carries `retryable`; backup-run's withRetry asks
// the flag, never the prose. 429 and 5xx are the drive being busy; a 401 is
// a token to refresh; a 403 or a 404 is an answer.
export interface DriveError extends Error { status: number; retryable: boolean }

async function ok(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  const body = await res.text().catch(() => "");
  const e = new Error(`${what} failed (${res.status}): ${body.slice(0, 400)}`) as DriveError;
  e.status = res.status;
  e.retryable = res.status === 429 || res.status >= 500;
  throw e;
}


const utf8 = (s: string) => new TextEncoder().encode(s);

// ── Consent, exchange, refresh ───────────────────────────────────────────

const AUTHORIZE: Record<string, string> = {
  google: "https://accounts.google.com/o/oauth2/v2/auth",
  microsoft: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  dropbox: "https://www.dropbox.com/oauth2/authorize"
};

const TOKEN: Record<string, string> = {
  google: "https://oauth2.googleapis.com/token",
  microsoft: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  dropbox: "https://api.dropboxapi.com/oauth2/token"
};

function assertProvider(provider: string): void {
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`"${provider}" is not a drive provider this app knows — it is one of ${PROVIDERS.join(", ")}.`);
  }
}

// The consent page to send the Admin to. `state` is the nonce minted in
// app_settings; the callback compares it and will not act without it.
export function authorizeUrl(provider: string, clientId: string, redirectUri: string, state: string): string {
  assertProvider(provider);
  const u = new URL(AUTHORIZE[provider]);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPES[provider]);
  u.searchParams.set("state", state);
  if (provider === "google") {
    // Without both of these Google hands back an access token and no
    // refresh token on the second and every later consent, and the
    // connection dies silently an hour later.
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
  }
  if (provider === "microsoft") u.searchParams.set("response_mode", "query");
  if (provider === "dropbox") u.searchParams.set("token_access_type", "offline");
  return u.toString();
}

async function postForm(url: string, form: Record<string, string>, what: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString()
  });
  return await (await ok(res, what)).json();
}

export async function exchangeCode(
  provider: string, clientId: string, clientSecret: string, code: string, redirectUri: string
): Promise<{ accessToken: string; refreshToken: string; accountId: string }> {
  assertProvider(provider);
  const body = await postForm(TOKEN[provider], {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret
  }, `${provider} token exchange`);
  const refreshToken = String(body.refresh_token ?? "");
  if (!refreshToken) {
    throw new Error(
      `${provider} sent an access token but no refresh token, so the connection would stop working within the hour. ` +
      `Remove the app's access in the provider's account settings and connect again.`
    );
  }
  return {
    accessToken: String(body.access_token ?? ""),
    refreshToken,
    accountId: String(body.account_id ?? "")
  };
}

export async function refreshAccessToken(
  provider: string, clientId: string, clientSecret: string, refreshToken: string
): Promise<string> {
  assertProvider(provider);
  const body = await postForm(TOKEN[provider], {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    ...(provider === "microsoft" ? { scope: SCOPES.microsoft } : {})
  }, `${provider} token refresh`);
  const token = String(body.access_token ?? "");
  if (!token) throw new Error(`${provider} refused to refresh the connection. Reconnect the drive on the Admin screen.`);
  return token;
}

export function makeDrive(provider: string, accessToken: string): DriveClient {
  assertProvider(provider);
  if (provider === "google") return new GoogleDrive(accessToken);
  if (provider === "microsoft") return new OneDrive(accessToken);
  return new Dropbox(accessToken);
}

// ── Google Drive ─────────────────────────────────────────────────────────
// Chunks must be a multiple of 256 KiB; 8 MiB is 32 of them.

const GOOGLE_CHUNK = 8 * 1024 * 1024;
const FOLDER_MIME = "application/vnd.google-apps.folder";

// A name inside a Drive query is a single-quoted string, and a backslash or
// an apostrophe in it has to be escaped or the query is a syntax error —
// which Google answers with a 400, not with an empty list. Job folders and
// client names carry apostrophes.
function googleQuote(value: string): string {
  return "'" + String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

export class GoogleDrive implements DriveClient {
  token: string;
  constructor(accessToken: string) { this.token = accessToken; }

  head(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  rootId(): string { return "root"; }

  async accountName(): Promise<string> {
    const res = await ok(await fetch(
      "https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)",
      { headers: this.head() }
    ), "Google Drive account");
    const j = await res.json() as { user?: { displayName?: string; emailAddress?: string } };
    return j.user?.emailAddress || j.user?.displayName || "Google Drive";
  }

  async children(parentId: string, foldersOnly: boolean): Promise<DriveEntry[]> {
    const out: DriveEntry[] = [];
    let pageToken = "";
    for (;;) {
      const u = new URL("https://www.googleapis.com/drive/v3/files");
      u.searchParams.set("q",
        `'${parentId}' in parents and trashed = false and mimeType ${foldersOnly ? "=" : "!="} '${FOLDER_MIME}'`);
      u.searchParams.set("fields", "nextPageToken, files(id, name, size)");
      u.searchParams.set("pageSize", "1000");
      if (pageToken) u.searchParams.set("pageToken", pageToken);
      const j = await (await ok(await fetch(u.toString(), { headers: this.head() }), "Google Drive listing")).json() as
        { files?: { id: string; name: string; size?: string }[]; nextPageToken?: string };
      for (const f of j.files ?? []) out.push({ id: f.id, name: f.name, size: Number(f.size ?? 0) });
      pageToken = j.nextPageToken ?? "";
      if (!pageToken) break;
    }
    return out;
  }

  listFolders(parentId: string): Promise<DriveFolder[]> { return this.children(parentId, true); }
  listFiles(parentId: string): Promise<DriveEntry[]> { return this.children(parentId, false); }

  // One request that asks about one name, rather than reading a folder of
  // thousands to find out whether a name is taken. A run folder holds a
  // part file per table slice and an entry per stored object, so listing it
  // before every upload is the whole folder read once per file in it.
  async findByName(parentId: string, name: string, foldersOnly: boolean): Promise<DriveEntry[]> {
    const u = new URL("https://www.googleapis.com/drive/v3/files");
    u.searchParams.set("q",
      `name = ${googleQuote(name)} and ${googleQuote(parentId)} in parents and trashed = false` +
      ` and mimeType ${foldersOnly ? "=" : "!="} ${googleQuote(FOLDER_MIME)}`);
    u.searchParams.set("fields", "files(id, name, size)");
    u.searchParams.set("pageSize", "100");
    const j = await (await ok(await fetch(u.toString(), { headers: this.head() }), "Google Drive lookup")).json() as
      { files?: { id: string; name: string; size?: string }[] };
    return (j.files ?? []).map(f => ({ id: f.id, name: f.name, size: Number(f.size ?? 0) }));
  }

  async createFolder(parentId: string, name: string): Promise<string> {
    // Google makes a second folder of the same name without complaint, so
    // a re-run would write half a backup into each. Find first, create only
    // if it is genuinely not there.
    const already = (await this.findByName(parentId, name, true))[0];
    if (already) return already.id;

    const res = await ok(await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST",
      headers: this.head({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] })
    }), "Google Drive folder");
    return String((await res.json() as { id: string }).id);
  }

  async upload(folderId: string, name: string, body: Uint8Array, contentType: string): Promise<string> {
    // Google is happy to hold two files with the same name in one folder,
    // which is exactly what a retried slice would leave behind.
    for (const clash of await this.findByName(folderId, name, false)) await this.delete(clash.id);

    if (body.byteLength <= RESUMABLE_BYTES) {
      const boundary = "vgb" + crypto.randomUUID().replace(/-/g, "");
      // A Blob over the three parts, not a concatenation: concat copied the
      // whole file into a fresh buffer — a third copy of it in memory, in a
      // function that also holds a table's worth of rows.
      const payload = new Blob([
        utf8(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId] })}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
        body,
        utf8(`\r\n--${boundary}--\r\n`)
      ]);
      const res = await ok(await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
        method: "POST",
        headers: this.head({ "Content-Type": `multipart/related; boundary=${boundary}` }),
        body: payload
      }), "Google Drive upload");
      return String((await res.json() as { id: string }).id);
    }

    const start = await ok(await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id", {
      method: "POST",
      headers: this.head({
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": contentType,
        "X-Upload-Content-Length": String(body.byteLength)
      }),
      body: JSON.stringify({ name, parents: [folderId] })
    }), "Google Drive upload session");
    const session = start.headers.get("Location");
    if (!session) throw new Error("Google Drive opened no upload session.");

    let at = 0;
    let id = "";
    let stalled = false;
    while (at < body.byteLength) {
      const end = Math.min(at + GOOGLE_CHUNK, body.byteLength);
      const res = await fetch(session, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${at}-${end - 1}/${body.byteLength}` },
        body: body.subarray(at, end)
      });
      // 308 is Google saying "send the next one" — and its Range header says
      // how much it actually kept, which can be less than what was sent.
      // Carrying on from `end` regardless would leave a hole in the middle
      // of the part file that nothing downstream ever notices: the upload
      // succeeds, the manifest counts the rows, and the gzip is corrupt.
      // Only a Range Google did not send is a reason to assume the whole
      // chunk landed.
      if (res.status === 308) {
        await res.body?.cancel();
        const stored = /bytes=\d+-(\d+)/.exec(res.headers.get("Range") ?? "");
        const next = stored ? Math.min(Number(stored[1]) + 1, body.byteLength) : end;
        if (next > at) {
          stalled = false;
        } else {
          // None of that chunk was kept. Sending it again is the protocol's
          // own answer, but twice over with nothing stored is a wedged
          // session, and a loop that never ends is worse than a failure.
          if (stalled) {
            const e = new Error("Google Drive kept none of two identical chunks; the upload session is stuck.") as DriveError;
            e.status = 308;
            e.retryable = true;
            throw e;
          }
          stalled = true;
        }
        at = next;
        continue;
      }
      id = String((await (await ok(res, "Google Drive upload")).json() as { id: string }).id);
      at = end;
    }
    return id;
  }

  async download(fileId: string): Promise<Uint8Array> {
    const res = await ok(await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      { headers: this.head() }
    ), "Google Drive download");
    return new Uint8Array(await res.arrayBuffer());
  }

  async delete(id: string): Promise<void> {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`,
      { method: "DELETE", headers: this.head() });
    // Already gone is the outcome asked for.
    if (res.status === 404) { await res.body?.cancel(); return; }
    await ok(res, "Google Drive delete");
    await res.body?.cancel();
  }
}

// ── OneDrive (Microsoft Graph) ───────────────────────────────────────────
// Graph insists every chunk but the last is a multiple of 320 KiB. 5 MiB is
// exactly 16 of them, which is why RESUMABLE_BYTES doubles as the chunk.

const GRAPH = "https://graph.microsoft.com/v1.0/me/drive";
const GRAPH_CHUNK = RESUMABLE_BYTES;

export class OneDrive implements DriveClient {
  token: string;
  constructor(accessToken: string) { this.token = accessToken; }

  head(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  rootId(): string { return "root"; }

  async accountName(): Promise<string> {
    // /me needs User.Read, which is not in the scopes asked for; the drive
    // itself knows who owns it and Files.ReadWrite is enough to ask.
    const res = await ok(await fetch(GRAPH, { headers: this.head() }), "OneDrive account");
    const j = await res.json() as { owner?: { user?: { displayName?: string; email?: string } } };
    return j.owner?.user?.email || j.owner?.user?.displayName || "OneDrive";
  }

  async children(parentId: string, foldersOnly: boolean): Promise<DriveEntry[]> {
    const out: DriveEntry[] = [];
    let next = `${GRAPH}/items/${encodeURIComponent(parentId)}/children?$select=id,name,size,folder,file&$top=200`;
    while (next) {
      const j = await (await ok(await fetch(next, { headers: this.head() }), "OneDrive listing")).json() as
        { value?: { id: string; name: string; size?: number; folder?: unknown }[]; "@odata.nextLink"?: string };
      for (const item of j.value ?? []) {
        if (foldersOnly === !!item.folder) out.push({ id: item.id, name: item.name, size: Number(item.size ?? 0) });
      }
      next = j["@odata.nextLink"] ?? "";
    }
    return out;
  }

  listFolders(parentId: string): Promise<DriveFolder[]> { return this.children(parentId, true); }
  listFiles(parentId: string): Promise<DriveEntry[]> { return this.children(parentId, false); }

  // One request that asks about one name: Graph addresses a child by the
  // parent's id and a path, and answers 404 when the name is free.
  async childByName(parentId: string, name: string): Promise<{ id: string; folder: boolean } | null> {
    const res = await fetch(
      `${GRAPH}/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(name)}?$select=id,folder`,
      { headers: this.head() });
    if (res.status === 404) { await res.body?.cancel(); return null; }
    const j = await (await ok(res, "OneDrive lookup")).json() as { id: string; folder?: unknown };
    return { id: String(j.id), folder: !!j.folder };
  }

  async createFolder(parentId: string, name: string): Promise<string> {
    // Find first, then create — and "fail" rather than "replace" on the
    // conflict. A conflictBehavior of "replace" on a folder replaces the
    // folder, which on a re-run means deleting the backup already in it.
    const already = await this.childByName(parentId, name);
    if (already && already.folder) return already.id;

    const res = await fetch(`${GRAPH}/items/${encodeURIComponent(parentId)}/children`, {
      method: "POST",
      headers: this.head({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" })
    });
    if (res.status === 409) {
      // Something got there between the two requests. If it is the folder
      // this was going to make, that is the outcome asked for.
      await res.body?.cancel();
      const found = await this.childByName(parentId, name);
      if (found && found.folder) return found.id;
      throw new Error(`OneDrive already holds a file called "${name}" where this backup needs a folder.`);
    }
    return String((await (await ok(res, "OneDrive folder")).json() as { id: string }).id);
  }

  async upload(folderId: string, name: string, body: Uint8Array, contentType: string): Promise<string> {
    const path = `${GRAPH}/items/${encodeURIComponent(folderId)}:/${encodeURIComponent(name)}:`;
    if (body.byteLength <= RESUMABLE_BYTES) {
      const res = await ok(await fetch(`${path}/content`, {
        method: "PUT",
        headers: this.head({ "Content-Type": contentType }),
        body
      }), "OneDrive upload");
      return String((await res.json() as { id: string }).id);
    }

    const session = await ok(await fetch(`${path}/createUploadSession`, {
      method: "POST",
      headers: this.head({ "Content-Type": "application/json" }),
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } })
    }), "OneDrive upload session");
    const uploadUrl = String((await session.json() as { uploadUrl?: string }).uploadUrl ?? "");
    if (!uploadUrl) throw new Error("OneDrive opened no upload session.");

    let at = 0;
    let id = "";
    let stalled = false;
    while (at < body.byteLength) {
      const end = Math.min(at + GRAPH_CHUNK, body.byteLength);
      // The upload URL carries its own credential; an Authorization header
      // on it is refused.
      const res = await ok(await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${at}-${end - 1}/${body.byteLength}` },
        body: body.subarray(at, end)
      }), "OneDrive upload");
      // 202 between chunks carries only the ranges still wanted; the final
      // 200/201 carries the item.
      if (res.status !== 202) {
        id = String((await res.json() as { id: string }).id);
        at = end;
        continue;
      }
      // Graph, like Google, may keep less of a chunk than was sent, and it
      // says so in nextExpectedRanges — "12345-67890" or "12345-", the
      // first byte it still wants. Carrying on from `end` regardless would
      // leave a hole in the middle of the part file that nothing downstream
      // ever notices: the upload succeeds, the manifest counts the rows,
      // and the gzip is corrupt. Only a 202 with no ranges on it at all is
      // a reason to assume the whole chunk landed.
      const j = await res.json().catch(() => ({})) as { nextExpectedRanges?: string[] };
      const want = /^(\d+)/.exec(String(j.nextExpectedRanges?.[0] ?? ""));
      const next = want ? Math.min(Number(want[1]), body.byteLength) : end;
      if (next > at) {
        stalled = false;
      } else {
        // None of that chunk was kept. Sending it again is the protocol's
        // own answer, but twice over with nothing stored is a wedged
        // session, and a loop that never ends is worse than a failure.
        if (stalled) {
          const e = new Error("OneDrive kept none of two identical chunks; the upload session is stuck.") as DriveError;
          e.status = 202;
          e.retryable = true;
          throw e;
        }
        stalled = true;
      }
      at = next;
    }
    return id;
  }

  async download(fileId: string): Promise<Uint8Array> {
    const res = await ok(await fetch(`${GRAPH}/items/${encodeURIComponent(fileId)}/content`,
      { headers: this.head() }), "OneDrive download");
    return new Uint8Array(await res.arrayBuffer());
  }

  async delete(id: string): Promise<void> {
    const res = await fetch(`${GRAPH}/items/${encodeURIComponent(id)}`,
      { method: "DELETE", headers: this.head() });
    if (res.status === 404) { await res.body?.cancel(); return; }
    await ok(res, "OneDrive delete");
    await res.body?.cancel();
  }
}

// ── Dropbox ──────────────────────────────────────────────────────────────
// Dropbox has no file ids in its ordinary API — a path IS the id. So the
// "id" this class hands out and takes back is a path, and the root is the
// empty string, which is what rootId() exists to hide from the caller.

const DROPBOX_CHUNK = 8 * 1024 * 1024;

// Arguments ride in an HTTP header, which may hold only ASCII. A client's
// name with an accent in it would otherwise be rejected by the transport
// rather than by Dropbox.
function dropboxArg(value: unknown): string {
  // The character class is written as escapes on purpose: a literal high
  // character in this source is exactly what a PowerShell round-trip turns
  // into mojibake, and it would stay invisible until a client with an
  // accent in their name broke a backup.
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g,
    c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

export class Dropbox implements DriveClient {
  token: string;
  constructor(accessToken: string) { this.token = accessToken; }

  head(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  rootId(): string { return ""; }

  async rpc(endpoint: string, body: unknown, what: string): Promise<Record<string, unknown>> {
    const res = await ok(await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
      method: "POST",
      headers: this.head(body === null ? {} : { "Content-Type": "application/json" }),
      body: body === null ? undefined : JSON.stringify(body)
    }), what);
    return await res.json() as Record<string, unknown>;
  }

  async accountName(): Promise<string> {
    // account_info.read is not in the scopes the spec asks for, so this is
    // allowed to fail: the account is a label, not a credential.
    try {
      const j = await this.rpc("users/get_current_account", null, "Dropbox account");
      const email = (j as { email?: string }).email;
      const name = (j as { name?: { display_name?: string } }).name?.display_name;
      return email || name || "Dropbox";
    } catch {
      return "Dropbox";
    }
  }

  async entries(parentId: string, foldersOnly: boolean): Promise<DriveEntry[]> {
    const out: DriveEntry[] = [];
    let j = await this.rpc("files/list_folder", { path: parentId, limit: 2000 }, "Dropbox listing");
    for (;;) {
      for (const e of (j.entries as { [".tag"]: string; name: string; path_lower?: string; path_display?: string; size?: number }[]) ?? []) {
        const isFolder = e[".tag"] === "folder";
        if (foldersOnly !== isFolder) continue;
        out.push({ id: String(e.path_display ?? e.path_lower ?? ""), name: e.name, size: Number(e.size ?? 0) });
      }
      if (!j.has_more) break;
      j = await this.rpc("files/list_folder/continue", { cursor: j.cursor }, "Dropbox listing");
    }
    return out;
  }

  listFolders(parentId: string): Promise<DriveFolder[]> { return this.entries(parentId, true); }
  listFiles(parentId: string): Promise<DriveEntry[]> { return this.entries(parentId, false); }

  async createFolder(parentId: string, name: string): Promise<string> {
    const path = `${parentId}/${name}`;
    // Find first, the same shape as the other two: get_metadata answers
    // "path/not_found" for a path that is free, and the folder's own
    // metadata for one that is taken.
    let meta: Record<string, unknown> | null = null;
    try {
      meta = await this.rpc("files/get_metadata", { path }, "Dropbox lookup");
    } catch (e) {
      if (!/not_found/i.test((e as Error).message)) throw e;
    }
    if (meta) {
      if (meta[".tag"] === "folder") return String((meta as { path_display?: string }).path_display ?? path);
      throw new Error(`Dropbox already holds a file at "${path}" where this backup needs a folder.`);
    }

    try {
      const j = await this.rpc("files/create_folder_v2", { path, autorename: false }, "Dropbox folder");
      const made = (j.metadata as { path_display?: string }) ?? {};
      return String(made.path_display ?? path);
    } catch (e) {
      // Something got there between the two requests; "already exists" is
      // the outcome asked for. Every other refusal is still a refusal.
      if (/conflict/i.test((e as Error).message)) return path;
      throw e;
    }
  }

  async upload(folderId: string, name: string, body: Uint8Array, contentType: string): Promise<string> {
    const path = `${folderId}/${name}`;
    if (body.byteLength <= RESUMABLE_BYTES) {
      const res = await ok(await fetch("https://content.dropboxapi.com/2/files/upload", {
        method: "POST",
        headers: this.head({
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": dropboxArg({ path, mode: "overwrite", mute: true })
        }),
        body
      }), "Dropbox upload");
      await res.body?.cancel();
      return path;
    }

    const started = await ok(await fetch("https://content.dropboxapi.com/2/files/upload_session/start", {
      method: "POST",
      headers: this.head({ "Content-Type": "application/octet-stream", "Dropbox-API-Arg": dropboxArg({ close: false }) }),
      body: body.subarray(0, Math.min(DROPBOX_CHUNK, body.byteLength))
    }), "Dropbox upload session");
    const sessionId = String((await started.json() as { session_id: string }).session_id);

    let at = Math.min(DROPBOX_CHUNK, body.byteLength);
    while (at < body.byteLength) {
      const end = Math.min(at + DROPBOX_CHUNK, body.byteLength);
      const res = await ok(await fetch("https://content.dropboxapi.com/2/files/upload_session/append_v2", {
        method: "POST",
        headers: this.head({
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": dropboxArg({ cursor: { session_id: sessionId, offset: at }, close: false })
        }),
        body: body.subarray(at, end)
      }), "Dropbox upload");
      await res.body?.cancel();
      at = end;
    }

    const finished = await ok(await fetch("https://content.dropboxapi.com/2/files/upload_session/finish", {
      method: "POST",
      headers: this.head({
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": dropboxArg({
          cursor: { session_id: sessionId, offset: body.byteLength },
          commit: { path, mode: "overwrite", mute: true }
        })
      })
    }), "Dropbox upload");
    const meta = await finished.json() as { path_display?: string };
    // contentType is Dropbox's own business — it sniffs the bytes — and is
    // named here only so the interface is one signature across the three.
    void contentType;
    return String(meta.path_display ?? path);
  }

  async download(fileId: string): Promise<Uint8Array> {
    const res = await ok(await fetch("https://content.dropboxapi.com/2/files/download", {
      method: "POST",
      headers: this.head({ "Dropbox-API-Arg": dropboxArg({ path: fileId }) })
    }), "Dropbox download");
    return new Uint8Array(await res.arrayBuffer());
  }

  async delete(id: string): Promise<void> {
    try {
      await this.rpc("files/delete_v2", { path: id }, "Dropbox delete");
    } catch (e) {
      if (/not_found/i.test((e as Error).message)) return;
      throw e;
    }
  }
}

// ── The fake ─────────────────────────────────────────────────────────────
// An in-memory tree with the same manners as the three real ones: a name is
// one path segment, a second upload under the same name replaces the first,
// deleting a folder takes what is inside it. failNextUploads makes the next
// N uploads fail with a retryable error, which is how the retry loop is
// tested without a network.

interface FakeNode { id: string; name: string; parent: string; folder: boolean; body: Uint8Array }

export class FakeDrive implements DriveClient {
  nodes: Map<string, FakeNode>;
  failNextUploads: number;
  account: string;
  private seq: number;

  constructor(account = "fake@example.ca") {
    this.nodes = new Map();
    this.failNextUploads = 0;
    this.account = account;
    this.seq = 0;
  }

  private nextId(): string { this.seq += 1; return `fake-${this.seq}`; }

  rootId(): string { return "root"; }

  accountName(): Promise<string> { return Promise.resolve(this.account); }

  private childrenOf(parentId: string, folder: boolean): DriveEntry[] {
    const out: DriveEntry[] = [];
    for (const n of this.nodes.values()) {
      if (n.parent === parentId && n.folder === folder) {
        out.push({ id: n.id, name: n.name, size: n.body.byteLength });
      }
    }
    return out;
  }

  listFolders(parentId: string): Promise<DriveFolder[]> {
    return Promise.resolve(this.childrenOf(parentId, true));
  }

  listFiles(parentId: string): Promise<DriveEntry[]> {
    return Promise.resolve(this.childrenOf(parentId, false));
  }

  createFolder(parentId: string, name: string): Promise<string> {
    const already = this.childrenOf(parentId, true).find(f => f.name === name);
    if (already) return Promise.resolve(already.id);
    const id = this.nextId();
    this.nodes.set(id, { id, name, parent: parentId, folder: true, body: new Uint8Array() });
    return Promise.resolve(id);
  }

  upload(folderId: string, name: string, body: Uint8Array, _contentType: string): Promise<string> {
    if (this.failNextUploads > 0) {
      this.failNextUploads -= 1;
      const e = new Error("The drive is unavailable (503): try again.") as DriveError;
      e.status = 503;
      e.retryable = true;
      return Promise.reject(e);
    }
    const clash = this.childrenOf(folderId, false).find(f => f.name === name);
    if (clash) this.nodes.delete(clash.id);
    const id = this.nextId();
    this.nodes.set(id, { id, name, parent: folderId, folder: false, body: new Uint8Array(body) });
    return Promise.resolve(id);
  }

  download(fileId: string): Promise<Uint8Array> {
    const n = this.nodes.get(fileId);
    if (!n || n.folder) return Promise.reject(new Error(`fake drive: ${fileId} not found`));
    return Promise.resolve(new Uint8Array(n.body));
  }

  delete(id: string): Promise<void> {
    const n = this.nodes.get(id);
    if (!n) return Promise.resolve();
    if (n.folder) {
      for (const child of [...this.nodes.values()]) {
        if (child.parent === id) this.delete(child.id);
      }
    }
    this.nodes.delete(id);
    return Promise.resolve();
  }
}
