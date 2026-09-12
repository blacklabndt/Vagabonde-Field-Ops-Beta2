// The security headers every HTML document on this origin leaves with.
//
// Without a Content-Security-Policy a script that gets into a page — an
// injected tag, an attribute handler, a stray inline block — runs with the
// app's session, and the page can be framed by anyone who wants a click
// misread. The policy below is built from what the app actually loads, and
// it is the Worker's to set because the Worker is what serves the documents:
// index.html and the two static pages from the assets, the approval page
// re-served from the function, and the Worker's own error page.
//
// Inline scripts are named by hash, never by 'unsafe-inline': index.html
// carries one (the theme and motion preferences, applied before the app
// paints so the first frame is not the wrong colour) and the approval page
// carries its signature-pad script and the print button's listener. The
// Worker hashes each <script> block as it serves the document, so the hash
// follows the source through every build and every function deploy, and an
// inline event handler — which has no block to hash — is refused. React's
// style attributes need 'unsafe-inline' for styles; a style cannot run.
//
// Pure, and read by vite-app/src/workerCsp.test.mjs straight out of this
// folder, which is why it is an .mjs with no Cloudflare imports.

// The one Supabase project the app talks to: REST, Auth, Storage, the Edge
// Functions, and Realtime over a websocket. vite-app/src/config.js names
// the same origin; the test holds the two level.
export const SUPABASE_ORIGIN = "https://eielmvxzdwwprmmfamlq.supabase.co";
export const SUPABASE_REALTIME = "wss://eielmvxzdwwprmmfamlq.supabase.co";

// SheetJS and jsPDF (Timesheets' exports and Ask's files), each fetched on
// first use by a <script> tag carrying its SRI hash.
//
// pdf.js used to be the third and is not any more: it is vendored in
// public/pdfjs and loads from this origin, which is why worker-src no
// longer allows blob: — the blob: wrapper was pdf.js's own, minted to
// reach a cross-origin worker, and nothing else in the app has ever made
// a Worker of any kind.
export const SCRIPT_CDN = "https://cdn.jsdelivr.net";

// GIF search: the app fetches api.klipy.com itself with the key gif-search
// hands out. The pictures come from KLIPY's CDN, and chat pictures and
// voice notes from Supabase storage's signed links.
export const GIF_SEARCH = "https://api.klipy.com";

// Sent with every document, whatever its policy. A route that needs a
// stricter one (the approval page's X-Frame-Options: DENY) passes its own
// in the response init, and that wins.
const ALWAYS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000"
};

// 'sha256-…' for every inline <script> block in the document, in order.
// The hash is of the block's text as the browser's parser hands it to the
// script engine, which is every character between the tags with CR LF and
// a lone CR read as LF — the parser normalises line endings before anything
// else sees them, so a document written on Windows hashes the same as one
// written on a Mac, and a hash taken over the raw bytes matched nothing
// (measured: the browser named a different hash for index.html's theme
// script until this normalisation went in). A tag with a src is a fetch
// the host list governs, not a block.
export async function inlineScriptHashes(html) {
  const hashes = [];
  for (const m of String(html ?? "").matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(m[1]) || !m[2]) continue;
    const text = m[2].replace(/\r\n?/g, "\n");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    hashes.push(`'sha256-${base64(new Uint8Array(digest))}'`);
  }
  return hashes;
}

function base64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const sources = (...parts) => parts.filter(Boolean).join(" ");

// The app's documents: index.html and the two static pages.
export function appPolicy(hashes = []) {
  return [
    "default-src 'self'",
    `script-src ${sources("'self'", SCRIPT_CDN, ...hashes)}`,
    "style-src 'self' 'unsafe-inline'",
    // Any https host: KLIPY's CDN serves the GIFs from more than one, the
    // storage links are the project's, and a picture cannot run. data: is
    // the signature inside the invoice viewer; blob: a picture or a GIF
    // about to be sent.
    "img-src 'self' data: blob: https:",
    `media-src ${sources("'self'", "blob:", SUPABASE_ORIGIN)}`,
    "font-src 'self' data:",
    `connect-src ${sources("'self'", SUPABASE_ORIGIN, SUPABASE_REALTIME, GIF_SEARCH, SCRIPT_CDN)}`,
    "worker-src 'self'",
    "frame-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // The invoice viewer is a srcdoc iframe of our own; nobody else frames
    // the app.
    "frame-ancestors 'self'"
  ].join("; ");
}

// The client's approval page, re-served from the function. It loads
// nothing from anywhere: its styles are inline, its scripts are the two
// blocks named by hash, its one picture is the signature as a data: URL,
// and its form posts back here. Never framed.
export function approvalPolicy(hashes = []) {
  return [
    "default-src 'none'",
    `script-src ${hashes.length ? hashes.join(" ") : "'none'"}`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join("; ");
}

// The Worker's own error page: one inline stylesheet and words.
export function errorPagePolicy() {
  return "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
}

// A Response carrying the policy and the headers every document gets. The
// init's own headers win over ALWAYS, so a route can tighten one.
export function secured(body, init, policy) {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(ALWAYS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  headers.set("Content-Security-Policy", policy);
  return new Response(body, { status: init.status, statusText: init.statusText, headers });
}
