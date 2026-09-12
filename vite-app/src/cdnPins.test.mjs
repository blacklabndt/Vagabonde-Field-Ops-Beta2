// The libraries that `npm audit` cannot see.
//
// Some of this app's dependencies are not in package.json. Three are pinned
// jsdelivr URLs fetched when a button needs them; the fourth, pdf.js, is
// vendored into public/pdfjs and served from this origin. The scanner looks
// straight past all four. This file is what looks at them instead: it reads
// the pins out of the source, holds them to the review record in
// docs/reviews/2026-09-11-cdn-pins.md, and checks the vendored bytes
// themselves — which is the job SRI does for the three that still arrive
// over the wire.
//
// pdf.js was vendored to fix CVE-2024-4367, and the fix is the move: the
// last build that loads by <script> tag is 3.11.174, which predates the
// patch, so the version could not go forward while a tag was the loader.
// Every build since is ESM only and a dynamic import() carries no integrity
// attribute, so same-origin bytes are what stands in for it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { appPolicy } from "../../worker/csp.mjs";

const read = p => readFileSync(new URL("../../" + p, import.meta.url), "utf8");
const bytes = p => readFileSync(new URL("../../" + p, import.meta.url));

// Every file that names the CDN. A new one has to be added here, which is
// the point: workerCsp.test.mjs reads the same file for the host.
const LOADERS = ["vite-app/src/cdnLibs.js"];
const REVIEW = "docs/reviews/2026-09-11-cdn-pins.md";

// The whole path, not just the package: the file at the end is what says
// which build of a package is being named.
const PIN = /cdn\.jsdelivr\.net\/npm\/([a-z0-9-]+)@([0-9][0-9.]*)\/([\w./-]+)/g;

const pinsIn = text => [...text.matchAll(PIN)].map(m => ({ pkg: m[1], version: m[2], url: m[0] }));
const allPins = () => LOADERS.flatMap(p => pinsIn(read(p)));

test("every CDN library is pinned to an exact version", () => {
  const pins = allPins();
  assert.ok(pins.length >= 3, "expected the app's CDN pins to be found at all");
  for (const { pkg, version } of pins) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${pkg} is not pinned to an exact version`);
  }
  // A range or a moving tag would defeat the SRI hash beside it.
  for (const p of LOADERS) {
    assert.doesNotMatch(read(p), /jsdelivr\.net\/npm\/[a-z0-9-]+(@latest|@\^|@~|\/)/,
      `${p} names the CDN without pinning a version`);
  }
});

test("every CDN script carries an SRI hash", () => {
  // No exceptions left. There used to be one — pdf.js fetches its own
  // worker, so no integrity attribute of ours rode on that request — and
  // vendoring pdf.js is what retired it.
  const pins = allPins();
  const hashes = LOADERS.flatMap(p => read(p).match(/sha384-[A-Za-z0-9+/=]+/g) || []);
  assert.equal(hashes.length, pins.length,
    "a CDN script was added or removed without its integrity hash");
  for (const h of hashes) {
    assert.equal(h.length, "sha384-".length + 64, `${h} is not a sha384 of 48 bytes`);
  }
});

test("no pdf.js arrives over the wire any more", () => {
  for (const p of [...LOADERS, "vite-app/src/components/jobDetail.jsx", "vite-app/vite.config.js"]) {
    assert.doesNotMatch(read(p), /cdn\.jsdelivr\.net\/npm\/pdfjs-dist/,
      `${p} loads pdf.js from the CDN: the vendored copy in public/pdfjs is the one that can be patched`);
  }
});

// ---------------------------------------------------------------------------
// The vendored copy. These two files are pdfjs-dist 6.3.289's legacy build,
// taken from the npm tarball, and nothing rebuilds them — so a hash is the
// whole check, exactly as it is for the three that come from the CDN. A
// changed hash means somebody edited or replaced a third-party build in the
// repo, which is a thing to notice however innocent.
const VENDORED = {
  "vite-app/public/pdfjs/pdf.min.js":
    "f401927e692efc7735e0cd528c490d0dd31b7f0972c122b7040df805be45cce4",
  "vite-app/public/pdfjs/pdf.worker.min.js":
    "a33cfe728c584fdba4fcc1fd54bcdc2f9f2f13889ddbb5b2bd1d0f8cbe49b84e",
};
const PDFJS_VERSION = "6.3.289";

test("the vendored pdf.js is the reviewed build, byte for byte", () => {
  for (const [path, want] of Object.entries(VENDORED)) {
    const got = createHash("sha256").update(bytes(path)).digest("hex");
    assert.equal(got, want, `${path} is not the reviewed build`);
  }
  // .gitattributes keeps these out of the line-ending rewrite core.autocrlf
  // would otherwise do on checkout — without it the hashes above pass here
  // and fail on a fresh clone, which is the worst way to learn it.
  assert.match(read(".gitattributes"), /vite-app\/public\/pdfjs\/\*\.js -text/,
    "the vendored build is not pinned against line-ending rewriting");
});

// CVE-2024-4367 (fixed 4.2.67) and CVE-2026-16633 (introduced 5.6.83, fixed
// 6.2.108) both reach a function built from a string. 6.3.289 is outside
// both windows, and it holds no such sink to reach: pdf.js deleted the
// code-generation path, which is why isEvalSupported is no longer an option.
// This reads the shipped bytes rather than trusting the version string,
// because the version string is a comment and the bytes are the program.
test("the vendored pdf.js builds no function from a string", () => {
  for (const path of Object.keys(VENDORED)) {
    const src = bytes(path).toString("latin1");
    assert.doesNotMatch(src, /new Function\s*\(/,
      `${path} can build a function from a string: that is CVE-2024-4367's own sink`);
    // core-js's `Function('return this')` globalThis fallback is the one
    // Function( left in the legacy bundle. It is a constant string and
    // reaches nothing a PDF can influence, so it is named rather than
    // forbidden — but only one, and only that one.
    const calls = [...src.matchAll(/[^.\w]Function\s*\(([^)]{0,40})/g)].map(m => m[1]);
    assert.ok(calls.length <= 1, `${path} calls Function() ${calls.length} times, not once`);
    for (const arg of calls) {
      assert.match(arg, /^["']return this["']/,
        `${path} calls Function() on something other than the globalThis fallback: ${arg}`);
    }
  }
});

test("the loader names the version the record reviewed", () => {
  const src = read("vite-app/src/components/jobDetail.jsx");
  assert.ok(src.includes(PDFJS_VERSION), "jobDetail.jsx no longer names the pdf.js version it loads");
  assert.ok(read(REVIEW).includes(PDFJS_VERSION), `${REVIEW} has not reviewed ${PDFJS_VERSION}`);
});

test("the review record names every pin", () => {
  const record = read(REVIEW);
  for (const { pkg, version } of allPins()) {
    assert.ok(record.includes(pkg), `${pkg} is pinned but not in ${REVIEW}`);
    assert.ok(record.includes(version), `${pkg} ${version} is not the version ${REVIEW} reviewed`);
  }
});

// The two doors that held CVE-2024-4367 out of reach while the version
// could not move. 6.3.289 has no sink for them to guard, so neither is
// load-bearing now — they stay because they are what a downgrade would
// walk into, and because the day somebody adds a PDF preview is the day
// the version matters again.
//
// getPage(...).render(...) — or any canvas hand-off — is what puts a font
// on the drawing path. React's root.render in main.jsx is not this file.
// Deliberately blunt: any .render( in this file at all, plus the words a
// canvas hand-off needs. An anchored "getPage(...).render(" missed the
// commoner two-statement form and would have passed a real preview; the
// samples below are what caught that.
const DRAWS = /\.render\(|renderTextLayer|canvasContext|getViewport\(/;

test("pdf.js reads text and never draws a page", () => {
  const src = read("vite-app/src/components/jobDetail.jsx");
  assert.ok(src.includes("getTextContent()"), "pdf.js is no longer used for text extraction");
  assert.doesNotMatch(src, DRAWS, "a PDF page is being drawn: check the version's advisories first");
  // The guard has to be able to bite. These are what a preview would look
  // like; a regex that stopped matching them would pass for ever in silence.
  for (const bad of [
    "await (await doc.getPage(1)).render({ canvasContext: ctx, viewport }).promise",
    "const page = await doc.getPage(i)\npage.render({ viewport })",
    "pdfjs.renderTextLayer({ textContent, container })",
  ]) assert.match(bad, DRAWS, "the draw guard no longer recognises a render call");
});

test("the reader is torn down by its loading task, not by the document", () => {
  const src = read("vite-app/src/components/jobDetail.jsx");
  // 6.x removed PDFDocumentProxy.destroy(). Calling it threw on the way out
  // of a read that had succeeded, so the dialog reported that it could not
  // read a report whose text it was holding — a green result turned red in
  // the finally block. The task's own destroy tears down the document and
  // the worker port together and works on every version from 3.x up.
  assert.doesNotMatch(src, /\bdoc\.destroy\s*\(/,
    "doc.destroy() is not a function in pdf.js 6.x — destroy the loading task instead");
  assert.match(src, /\btask\.destroy\s*\(/, "the loading task is never destroyed");
});

test("the app's policy refuses a function built from a string", () => {
  const policy = appPolicy(["'sha256-x'"]);
  assert.ok(!policy.includes("unsafe-eval"),
    "'unsafe-eval' would arm any execution flaw a PDF reader still had");
});

// SheetJS's advisories are in its reader, and it is frozen at 0.18.5 because
// the project left npm. Writing is all this app asks of it.
test("SheetJS is never asked to parse a workbook", () => {
  for (const p of ["vite-app/src/askFiles.js", "vite-app/src/components/timesheets.jsx"]) {
    assert.doesNotMatch(read(p), /XLSX\.read\b|XLSX\.readFile\b/,
      `${p} parses a workbook: SheetJS 0.18.5 will never be patched for that`);
  }
});
