// The libraries that arrive by URL, which `npm audit` cannot see.
//
// Four of this app's dependencies are not in package.json — they are pinned
// jsdelivr URLs fetched when a button needs them, so the dependency scanner
// looks straight past them. This file is what looks at them instead: it
// reads the pins out of the source and holds them to the review record in
// docs/reviews/2026-09-11-cdn-pins.md, and it pins the two invariants that
// keep pdf.js's known arbitrary-execution flaw out of reach — the app never
// draws a PDF page, and the policy has no 'unsafe-eval'. Neither is a fix.
// They are two doors held shut, and this is what notices if one opens.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { appPolicy } from "../../worker/csp.mjs";

const read = p => readFileSync(new URL("../../" + p, import.meta.url), "utf8");

// Every file that names the CDN. A new one has to be added here, which is
// the point: workerCsp.test.mjs reads the same two for the host.
const LOADERS = ["vite-app/src/cdnLibs.js", "vite-app/src/components/jobDetail.jsx"];
const REVIEW = "docs/reviews/2026-09-11-cdn-pins.md";

// The whole path, not just the package: the file at the end is what says
// whether pdf.js's main script or its worker is being named.
const PIN = /cdn\.jsdelivr\.net\/npm\/([a-z0-9-]+)@([0-9][0-9.]*)\/([\w./-]+)/g;

const pinsIn = text => [...text.matchAll(PIN)].map(m => ({ pkg: m[1], version: m[2], url: m[0] }));
const allPins = () => LOADERS.flatMap(p => pinsIn(read(p)));

test("every CDN library is pinned to an exact version", () => {
  const pins = allPins();
  assert.ok(pins.length >= 5, "expected the app's CDN pins to be found at all");
  for (const { pkg, version } of pins) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${pkg} is not pinned to an exact version`);
  }
  // A range or a moving tag would defeat the SRI hash beside it.
  for (const p of LOADERS) {
    assert.doesNotMatch(read(p), /jsdelivr\.net\/npm\/[a-z0-9-]+(@latest|@\^|@~|\/)/,
      `${p} names the CDN without pinning a version`);
  }
});

test("every CDN script we load ourselves carries an SRI hash", () => {
  // pdf.js fetches its own worker, so no integrity attribute of ours is on
  // that request. It is the one exception, named rather than left to be
  // noticed — and the reason is in the review record.
  const ours = allPins().filter(p => !/pdf\.worker/.test(p.url));
  const hashes = LOADERS.flatMap(p => read(p).match(/sha384-[A-Za-z0-9+/=]+/g) || []);
  assert.equal(hashes.length, ours.length,
    "a CDN script was added or removed without its integrity hash");
  for (const h of hashes) {
    assert.equal(h.length, "sha384-".length + 64, `${h} is not a sha384 of 48 bytes`);
  }
  const workers = allPins().filter(p => /pdf\.worker/.test(p.url));
  assert.equal(workers.length, 1, "the SRI exception list is one worker and no more");
});

test("the review record names every pin", () => {
  const record = read(REVIEW);
  for (const { pkg, version } of allPins()) {
    assert.ok(record.includes(pkg), `${pkg} is pinned but not in ${REVIEW}`);
    assert.ok(record.includes(version), `${pkg} ${version} is not the version ${REVIEW} reviewed`);
  }
});

// The two doors. CVE-2024-4367 reaches a function constructor through a
// crafted font while a page is being DRAWN; 3.11.174 is before the fix.
// getPage(...).render(...) — or any canvas hand-off — puts the flaw's own
// sink back on the path. React's root.render in main.jsx is not this file.
// Deliberately blunt — any .render( in this file at all, plus the words a
// canvas hand-off needs. An anchored "getPage(...).render(" missed the
// commoner two-statement form and would have passed a real preview; the
// samples below are what caught that.
const DRAWS = /\.render\(|renderTextLayer|canvasContext|getViewport\(/;

test("pdf.js reads text and never draws a page", () => {
  const src = read("vite-app/src/components/jobDetail.jsx");
  assert.ok(src.includes("getTextContent()"), "pdf.js is no longer used for text extraction");
  assert.doesNotMatch(src, DRAWS,
    "a PDF page is being drawn: pdf.js must be moved past 4.2.67 first");
  // The guard has to be able to bite. These are what a preview would look
  // like; a regex that stopped matching them would pass for ever in silence.
  for (const bad of [
    "await (await doc.getPage(1)).render({ canvasContext: ctx, viewport }).promise",
    "const page = await doc.getPage(i)\npage.render({ viewport })",
    "pdfjs.renderTextLayer({ textContent, container })",
  ]) assert.match(bad, DRAWS, "the draw guard no longer recognises a render call");
});

test("the app's policy refuses a function built from a string", () => {
  const policy = appPolicy(["'sha256-x'"]);
  assert.ok(!policy.includes("unsafe-eval"),
    "'unsafe-eval' would arm pdf.js's known execution flaw in this origin");
});

// SheetJS's advisories are in its reader, and it is frozen at 0.18.5 because
// the project left npm. Writing is all this app asks of it.
test("SheetJS is never asked to parse a workbook", () => {
  for (const p of ["vite-app/src/askFiles.js", "vite-app/src/components/timesheets.jsx"]) {
    assert.doesNotMatch(read(p), /XLSX\.read\b|XLSX\.readFile\b/,
      `${p} parses a workbook: SheetJS 0.18.5 will never be patched for that`);
  }
});
