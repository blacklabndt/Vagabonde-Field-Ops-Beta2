// Does the vendored pdf.js read a report IN A BROWSER, under this app's own
// Content-Security-Policy, with a REAL worker?
//
// pdfjs-version-probe.mjs beside this one answers a different question: does
// a given build still extract the same text. It runs in Node, where there is
// no `Worker` at all — pdf.js quietly falls back to running its worker code
// on the main thread, so a passing Node probe says nothing about the two
// things that actually changed when pdf.js moved off the CDN:
//
//   1. the worker is now same-origin and built directly, not through the
//      blob: wrapper pdf.js mints for a cross-origin workerSrc, and
//   2. `worker-src` in worker/csp.mjs no longer allows blob: at all.
//
// If (1) were wrong, (2) would refuse the worker — and pdf.js would fall
// back to the main thread and still return the right text, silently, on
// every tablet. The text is not the test. The Worker constructor is.
//
// Not part of `npm test`: it needs a built dist/ and a browser.
//
//   npm --prefix vite-app run build
//   node docs/reviews/pdfjs-browser-probe.mjs
//
// Exits 0 on pass, 1 on any failed check.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appPolicy } from "../../worker/csp.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const DIST = join(here, "..", "..", "vite-app", "dist");

// Playwright is vite-app's dev dependency and this file lives in docs/, where
// there is no node_modules — and a bare specifier in import() resolves
// against the MODULE, not against where you are standing, so `@playwright/
// test` is simply not found however you invoke this. Resolve it from
// vite-app's own package instead, which is where it actually is.
const fromApp = createRequire(join(here, "..", "..", "vite-app", "package.json"));
// CommonJS, so import() hands it back under `default` and the named export
// is undefined — which fails a line later, at .launch(), naming neither.
const pw = await import(pathToFileURL(fromApp.resolve("@playwright/test")).href);
const chromium = pw.chromium ?? pw.default?.chromium;
if (!chromium) { console.error("playwright is installed but exports no chromium"); process.exit(2); }

// The same two-page report pdfjs-version-probe.mjs uses, so a disagreement
// between the two probes is about the browser and never about the file.
function makePdf() {
  const content = t => `BT /F1 12 Tf 72 720 Td (${t}) Tj ET`;
  const streams = [content("RT Report  Welds 101, 102, 103"), content("Continued  Weld 104")];
  const objs = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>";
  objs[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>";
  objs[4] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>";
  objs[5] = `<< /Length ${streams[0].length} >>\nstream\n${streams[0]}\nendstream`;
  objs[6] = `<< /Length ${streams[1].length} >>\nstream\n${streams[1]}\nendstream`;
  objs[7] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let out = "%PDF-1.4\n";
  const at = [];
  for (let i = 1; i <= 7; i++) { at[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = out.length;
  out += "xref\n0 8\n0000000000 65535 f \n";
  for (let i = 1; i <= 7; i++) out += String(at[i]).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html" };

// The Worker's own document headers, from the Worker's own module — so the
// policy under test is the one that ships, not a copy of it. A page served
// with a looser header would let a blob: worker through and the probe would
// pass on a build the app refuses.
const CSP = appPolicy();

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/") {
    res.writeHead(200, { "content-type": "text/html", "content-security-policy": CSP });
    res.end("<!doctype html><meta charset=utf-8><title>pdf.js probe</title>");
    return;
  }
  // normalize() first, so a `..` in the request cannot walk out of dist/.
  const file = join(DIST, normalize(path).replace(/^([/\\])+/, ""));
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();

const violations = [];
const consoleErrors = [];
page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });
await page.addInitScript(() => {
  window.__cspViolations = [];
  document.addEventListener("securitypolicyviolation", e =>
    window.__cspViolations.push(`${e.violatedDirective} <- ${e.blockedURI}`));
  // Every Worker this page successfully makes, recorded before pdf.js can
  // make one. A fake-worker fallback makes none, which is the failure this
  // probe exists to catch — and it is invisible from the extracted text.
  //
  // `alive` is the load-bearing field, and it has to be a REPLY: a Worker
  // the policy refuses does not throw out of the constructor — Chromium
  // blocks it asynchronously, so `new Worker(blocked)` hands back a normal
  // object that simply never loads. Two earlier drafts of this probe both
  // reported a worker on a page whose policy had refused one, because they
  // asked whether the constructor was reached rather than whether anything
  // answered. pdf.js then runs its worker code on the main thread and the
  // right text comes back regardless, which is the silent fallback this
  // whole file exists to catch. A worker that posts a message is running.
  window.__workers = [];
  const Real = window.Worker;
  window.Worker = class extends Real {
    constructor(url, opts) {
      super(url, opts);
      const rec = { url: String(url), type: opts?.type ?? "classic", alive: false };
      window.__workers.push(rec);
      this.addEventListener("message", () => { rec.alive = true; }, { once: true });
      this.addEventListener("error", e => { rec.failed = String(e.message || "did not load"); });
    }
  };
});
await page.goto(`${origin}/`);

const pdf = makePdf().toString("base64");
const result = await page.evaluate(async b64 => {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const out = { err: null };
  try {
    // jobDetail.jsx's loadPdfjs() and pdfText(), body for body.
    const mod = await import("/pdfjs/pdf.min.js");
    const pdfjs = mod.getDocument ? mod : mod.default;
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.js";
    out.version = pdfjs.version ?? null;

    const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false });
    const doc = await task.promise;
    let text = "";
    const n = Math.min(doc.numPages, 40);
    for (let i = 1; i <= n; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      text += content.items.map(it => it.str).join(" ") + "\n";
    }
    out.text = text;
    out.pages = doc.numPages;
    out.docDestroy = typeof doc.destroy;
    try { await task.destroy(); out.destroyed = true; }
    catch (e) { out.destroyed = false; out.destroyError = String(e); }
  } catch (e) { out.err = String(e && e.stack || e); }
  // Read after the work, so a worker made during it is counted.
  out.workers = window.__workers;
  out.violations = window.__cspViolations;
  return out;
}, pdf);

violations.push(...(result.violations || []));

const EXPECT = "RT Report Welds 101, 102, 103\nContinued Weld 104\n";
const real = (result.workers || []).filter(w => new URL(w.url, origin).pathname === "/pdfjs/pdf.worker.min.js");
const blobs = (result.workers || []).filter(w => w.url.startsWith("blob:"));

const checks = [
  ["the module loads and getDocument is exported", !result.err, result.err],
  ["the version is the reviewed build", result.version === "6.3.289", result.version],
  ["the text is what the Upload dialog reads", result.text === EXPECT, JSON.stringify(result.text)],
  ["both pages are read", result.pages === 2, result.pages],
  ["one worker was made, from this origin", real.length === 1, JSON.stringify(result.workers)],
  ["it ANSWERED — the read was not the main-thread fallback", real[0]?.alive === true, JSON.stringify(result.workers)],
  ["no blob: worker was minted", blobs.length === 0, JSON.stringify(blobs)],
  ["the worker is a module worker", real[0]?.type === "module", real[0]?.type],
  ["the policy refused nothing", violations.length === 0, JSON.stringify(violations)],
  ["nothing was logged as an error", consoleErrors.length === 0, JSON.stringify(consoleErrors)],
  // 6.x removed PDFDocumentProxy.destroy(). The dialog destroys the LOADING
  // TASK for exactly that reason; this asserts both halves of the reason.
  ["PDFDocumentProxy.destroy is gone, as the comment says", result.docDestroy === "undefined", result.docDestroy],
  ["task.destroy() does not throw on the way out", result.destroyed === true, result.destroyError]
];

let bad = 0;
for (const [name, ok, saw] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? "  ok" : "FAIL"}  ${name}${ok ? "" : `\n        saw: ${saw}`}`);
}
console.log(`\npolicy under test: ${CSP.split("; ").find(d => d.startsWith("worker-src"))}`);
console.log(`${checks.length - bad}/${checks.length} checks passed`);

await browser.close();
server.close();
process.exit(bad ? 1 : 0);
