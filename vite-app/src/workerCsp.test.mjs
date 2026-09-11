// The Content-Security-Policy the Worker sets on every HTML document, and
// the things it has to keep allowing.
//
// worker/csp.mjs is read straight out of the repo. The screens that load a
// library from a CDN or call an API by hand are read back as text, so a host
// added to one of them without being added to the policy fails here rather
// than in the field as a blank PDF viewer or a GIF picker that never fills.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  SUPABASE_ORIGIN, SUPABASE_REALTIME, SCRIPT_CDN, GIF_SEARCH,
  inlineScriptHashes, appPolicy, approvalPolicy, errorPagePolicy, secured
} from "../../worker/csp.mjs";

const read = p => readFileSync(new URL("../../" + p, import.meta.url), "utf8");
const sha = text => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
const directive = (policy, name) => {
  const part = policy.split(";").map(s => s.trim()).find(s => s.startsWith(name + " ") || s === name);
  assert.ok(part, `${name} is in the policy`);
  return part.slice(name.length).trim().split(/\s+/).filter(Boolean);
};

test("every inline script block is named by the hash of its text as the parser reads it", async () => {
  const html = `<html><head><script>\r\n  alert(1);\r\n</script><script src="/a.js"></script>` +
    `<script type="module">import "x";</script><script></script></head></html>`;
  // Whitespace is part of the text, but line endings are the parser's: it
  // reads CR LF and a lone CR as LF before the script engine sees a byte,
  // so the hash is taken over the normalised text. index.html is CRLF on a
  // Windows checkout, and the raw-bytes hash matched nothing in Chrome.
  assert.deepEqual(await inlineScriptHashes(html), [sha("\n  alert(1);\n"), sha('import "x";')]);
  assert.equal((await inlineScriptHashes("<script>alert(1)\n</script>"))[0], (await inlineScriptHashes("<script>alert(1)\r\n</script>"))[0]);
  assert.equal((await inlineScriptHashes("<script>alert(1)\n</script>"))[0], (await inlineScriptHashes("<script>alert(1)\r</script>"))[0]);
  assert.notEqual((await inlineScriptHashes("<script>alert(1)\n</script>"))[0], (await inlineScriptHashes("<script>alert(1)</script>"))[0], "a newline itself still counts");
  assert.deepEqual(await inlineScriptHashes(""), []);
  assert.deepEqual(await inlineScriptHashes(null), []);
});

test("index.html's one inline script is the theme, and it is hashed rather than let through wholesale", async () => {
  const html = read("vite-app/index.html");
  const hashes = await inlineScriptHashes(html);
  assert.equal(hashes.length, 1, "one inline block: the theme and motion preferences");
  const policy = appPolicy(hashes);
  const script = directive(policy, "script-src");
  assert.ok(script.includes(hashes[0]));
  assert.ok(!script.includes("'unsafe-inline'"), "scripts are never let through inline");
  assert.ok(!script.includes("'unsafe-eval'"));
  // The two static pages carry no script at all.
  for (const p of ["vite-app/public/privacy.html", "vite-app/public/terms.html"]) {
    assert.deepEqual(await inlineScriptHashes(read(p)), [], `${p} has no inline script`);
  }
});

test("the app's policy allows what the screens load and nothing looser", () => {
  const policy = appPolicy([]);
  assert.deepEqual(directive(policy, "object-src"), ["'none'"]);
  assert.deepEqual(directive(policy, "base-uri"), ["'self'"]);
  assert.deepEqual(directive(policy, "form-action"), ["'self'"]);
  assert.deepEqual(directive(policy, "frame-ancestors"), ["'self'"]);
  assert.deepEqual(directive(policy, "default-src"), ["'self'"]);
  const connect = directive(policy, "connect-src");
  for (const host of [SUPABASE_ORIGIN, SUPABASE_REALTIME, GIF_SEARCH]) assert.ok(connect.includes(host), `connect-src allows ${host}`);
  assert.ok(!connect.includes("https:") && !connect.includes("*"), "connect-src names its hosts");
  assert.ok(directive(policy, "worker-src").includes("blob:"), "pdf.js runs its worker through a blob: wrapper");
  assert.ok(directive(policy, "media-src").includes(SUPABASE_ORIGIN), "voice notes play from storage links");
  assert.ok(directive(policy, "img-src").includes("data:"), "the signature inside the invoice viewer is a data: picture");
  // The project the app talks to is the one the policy names.
  assert.ok(read("vite-app/src/config.js").includes(SUPABASE_ORIGIN), "config.js names the same Supabase origin");
  assert.equal(SUPABASE_REALTIME, SUPABASE_ORIGIN.replace(/^https:/, "wss:"));
});

test("every CDN script and hand-called API in the screens is a host the policy allows", () => {
  const policy = appPolicy([]);
  const script = directive(policy, "script-src");
  const connect = directive(policy, "connect-src");
  const hostsIn = source => [...source.matchAll(/["'`](https:\/\/[^/"'`\s]+)\//g)].map(m => m[1]);
  for (const p of ["vite-app/src/components/jobDetail.jsx", "vite-app/src/cdnLibs.js"]) {
    const hosts = new Set(hostsIn(read(p)));
    assert.ok(hosts.size > 0, `${p} loads something from a CDN`);
    for (const h of hosts) assert.ok(script.includes(h), `${p} loads a script from ${h}, which script-src must allow`);
  }
  assert.ok(read("vite-app/src/db.js").includes(GIF_SEARCH + "/"), "db.js searches GIFs at the host connect-src allows");
  assert.ok(connect.includes(GIF_SEARCH));
  assert.ok(script.includes(SCRIPT_CDN));
});

test("the approval page and the error page load nothing from anywhere", async () => {
  const hashes = await inlineScriptHashes("<script>(function(){})()</script>");
  const approval = approvalPolicy(hashes);
  assert.deepEqual(directive(approval, "default-src"), ["'none'"]);
  assert.deepEqual(directive(approval, "script-src"), hashes);
  assert.deepEqual(directive(approval, "frame-ancestors"), ["'none'"]);
  assert.deepEqual(directive(approval, "form-action"), ["'self'"]);
  assert.ok(!approval.includes("https:"), "no host at all");
  assert.deepEqual(directive(approvalPolicy([]), "script-src"), ["'none'"], "a page with no script runs none");
  const error = errorPagePolicy();
  assert.deepEqual(directive(error, "default-src"), ["'none'"]);
  assert.deepEqual(directive(error, "frame-ancestors"), ["'none'"]);
});

test("secured() sends the always-on headers and lets a route tighten one", () => {
  const plain = secured("<p>", { status: 200, headers: { "Content-Type": "text/html" } }, "default-src 'self'");
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get("content-security-policy"), "default-src 'self'");
  assert.equal(plain.headers.get("x-content-type-options"), "nosniff");
  assert.equal(plain.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(plain.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.match(plain.headers.get("strict-transport-security"), /max-age=\d+/);
  const tight = secured("<p>", { status: 502, headers: { "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" } }, "default-src 'none'");
  assert.equal(tight.status, 502);
  assert.equal(tight.headers.get("x-frame-options"), "DENY");
  assert.equal(tight.headers.get("referrer-policy"), "no-referrer");
});

test("the Worker sets the policy on every document, and the approval page has no inline handler", () => {
  const worker = read("worker/index.js");
  assert.match(worker, /from "\.\/csp\.mjs"/);
  assert.match(worker, /const asset = await env\.ASSETS\.fetch\(documentRequest\(request\)\);[\s\S]{0,240}?return asset\.status === 200 && isHtml\(asset\) \? await securedDocument\(asset\) : asset;/, "a whole HTML document leaves through securedDocument");
  assert.match(worker, /headers\.delete\("if-none-match"\);\s*\n\s*headers\.delete\("if-modified-since"\);/, "a document request is answered whole, never 304");
  assert.match(worker, /appPolicy\(await inlineScriptHashes\(html\)\)/);
  assert.match(worker, /approvalPolicy\(await inlineScriptHashes\(body\)\)/);
  assert.match(worker, /const htmlError = message => secured\(/);
  assert.match(worker, /errorPagePolicy\(\)/);
  assert.doesNotMatch(worker, /new Response\(body, \{\s*status: upstream\.status/, "the approval page no longer leaves unsecured");
  // The approval page is served under a policy that names scripts by hash;
  // an attribute handler has no hash to give, so there must be none.
  const approve = read("supabase/functions/approve-ticket/index.ts");
  assert.doesNotMatch(approve, /\son[a-z]+="/i, "no inline event handler in the approval page's HTML");
  assert.match(approve, /addEventListener\("click", function \(\) \{ window\.print\(\); \}\)/, "the print button binds its listener in a script");
});
