# Moving pdf.js off a version with a known execution flaw

*11 Sept 2026 — proposal, nothing applied. Written for Codex's sign-off
after `2026-09-11-cdn-pins.md` recorded the pin and the two doors holding
its flaw shut.*

Codex's position, accepted: text-only use and a policy with no
`'unsafe-eval'` REDUCE the exposure of `pdfjs-dist@3.11.174`. They are not
a fix, and the review record already says so in its own words. This is the
fix.

## What is actually wrong with the version we ship

Queried OSV for the whole package, not just the one advisory we knew:

| advisory | introduced | fixed | 3.11.174 |
|---|---|---|---|
| CVE-2024-4367 — arbitrary JS on opening a PDF | 0 | **4.2.67** | **affected** |
| CVE-2026-16633 — arbitrary JS on opening a PDF | 5.6.83 | **6.2.108** | not affected |
| CVE-2018-5158 | 0 | 1.10.100 | not affected |

Two things follow, and the second is the one that would have been missed
by "just take the latest":

1. Any target **≥ 4.2.67** closes the flaw we have.
2. The band **5.6.83 – 6.2.107** carries a *second* arbitrary-execution
   flaw of the same shape. A jump to "whatever npm calls latest" was right
   today (6.3.289 > 6.2.108) and would have been wrong for most of the
   last release cycle.

Safe today: `>= 4.2.67 < 5.6.83` or `>= 6.2.108`.

## What 4.x changed, measured rather than assumed

Read off the published packages (jsDelivr's file index and the bundles
themselves), because every one of these decides part of the design:

- **There is no UMD build after 3.11.174.** `build/pdf.min.js` exists in
  3.11.174 and in no later version — including `legacy/`. Every 4.x, 5.x
  and 6.x build is `*.mjs`. The comment in `jobDetail.jsx` was right.
  **A `<script>` tag can no longer be the loader.**
- **Each build is one file: zero static imports.** So one hash still
  covers the whole library, whatever the transport.
- **The legacy build is the one to take.** Every build from 4.2.67 on
  calls `Promise.withResolvers` (Chrome 119 / Safari 17.4 / Firefox 121).
  `legacy/build/` bundles core-js and defines it; `build/` does not. On a
  tablet a season behind, `build/` is a blank dialog and `legacy/` is not.
- **The CDN worker wrapper survives, in a new form.** 3.11.174 wraps a
  cross-origin `workerSrc` in a blob doing `importScripts("<url>")`; 4.x
  and 5.x wrap it in a blob *module* doing `await import("<url>")`. Both
  are blob workers, so `worker-src 'self' blob:` still covers it and the
  blob inherits this page's `script-src`, which already names the host.
  **No CSP change either way.**

## What the app's own code does on each version

`pdfText()` in `jobDetail.jsx` run verbatim — same body, same
`getDocument({ data })`, `numPages`, `getPage(i).getTextContent()`,
`items.map(it => it.str)`, `doc.destroy()` — over a two-page PDF built for
the probe, each version in its own process (loaded together, 3.x's global
fake worker is picked up by 4.x and the API/worker versions disagree):

| version | text extracted | `doc.destroy()` |
|---|---|---|
| 3.11.174 (shipped) | `"RT Report Welds 101, 102, 103\nContinued Weld 104\n"` | present |
| 4.2.67 | identical | present |
| 5.4.149 | identical | present |
| 6.3.289 | identical | **gone** |

So text extraction is unchanged across four majors — and **6.x removes
`PDFDocumentProxy.destroy()`**. `pdfText()` calls it inside a `finally`,
so on 6.x the text is read correctly and then thrown away by a `TypeError`
raised on the way out: the dialog would report that it could not read the
file, having read it. `loadingTask.destroy()` exists on 4, 5 and 6 and is
the forward-compatible spelling.

Probe kept at `docs/reviews/pdfjs-version-probe.mjs`.

## Recommendation

**`pdfjs-dist@5.4.149`, `legacy/build/`, vendored into `vite-app/public/pdfjs/`
and served from this origin.** Closes CVE-2024-4367, predates
CVE-2026-16633's introduction entirely, and keeps `doc.destroy()` so the
reading code changes only its loader. (`loadingTask.destroy()` anyway, so
a later move to 6.x is a version bump and not a rewrite.)

Vendoring rather than a fifth CDN pin, for four reasons:

1. **It is the decision this repo already made for fonts.** Barlow lives
   in `public/fonts` precisely because a field device with no signal never
   got the faces. A PDF reader fetched from jsdelivr on the first drop has
   the same failure, on the same tablets, in the same truck.
2. **SRI stops being a problem instead of becoming a harder one.** A
   `<script>` tag with `integrity` cannot load an ES module's exports, and
   every CDN alternative either drops SRI (a bare `import()`), or leans on
   module-map reuse behaviour across browsers that this session cannot
   test — and "curl works ≠ a browser renders it" is a rule in this repo
   because of exactly that kind of confidence.
3. **It closes the SRI exception we already carry.** Same-origin
   `workerSrc` needs no blob wrapper: `new Worker("/pdfjs/pdf.worker.min.mjs",
   { type: "module" })` runs under `worker-src 'self'`. The one pin in
   `cdnPins.test.mjs` that cannot carry a hash disappears.
4. **No CSP change at all**: `script-src 'self'` already allows it.

Cost, stated plainly: **1.5 MB** of vendored minified JavaScript in the
repo (441 KB library + 1,066 KB worker). It is not precached — the
workbox glob is `**/*.{js,css,html,svg,woff2}` and these are `.mjs` — so
install size does not move and the first drop still needs a connection,
as today. Making it work offline is a one-word glob change and a
1.5 MB precache; that is Kyle's call, not ours, and it is not part of
this proposal.

## What would change

- `vite-app/public/pdfjs/pdf.min.mjs`, `pdf.worker.min.mjs` — vendored,
  unedited, from `pdfjs-dist@5.4.149/legacy/build/`.
- `jobDetail.jsx` — `loadPdfjs()` becomes
  `import(/* @vite-ignore */ "/pdfjs/pdf.min.mjs")` with the same
  clear-the-promise-on-failure recovery and the same 30 s timeout;
  `workerSrc` becomes the same-origin path; `pdfText()` keeps the
  loading task and calls `task.destroy()`.
- `cdnPins.test.mjs` — pdf.js leaves the CDN pin list; the vendored
  version is pinned instead, by a stamp read out of the vendored file,
  and the draw guard and the `'unsafe-eval'` guard **stay**. They are
  cheap, and they are what notices if someone adds a preview later.
- `workerCsp.test.mjs` — `assert.ok(hosts.size > 0)` over
  `jobDetail.jsx` stops being true and must become a statement about
  `cdnLibs.js` alone.
- `csp.mjs`'s comment, `docs/reviews/2026-09-11-cdn-pins.md`, `CLAUDE.md`.

## The cheaper alternative, named because it is real

`pdfText()` prefills weld numbers in the Upload report dialog. It fills
an empty field and never owns one. **Deleting it removes the parser
rather than upgrading it** — no vendored megabyte, no fifth pin, no CVE
to track, and the only cost is that the technician types the weld numbers
they are already looking at. Kyle decides whether the prefill earns 1.5 MB
and a dependency with two arbitrary-execution advisories in two years.

---

## What was actually done — and where this proposal was wrong

Kyle kept the prefill, so the alternative above is closed. The move was
made. It differs from the recommendation on three points, and each
difference is a correction to something written above.

**The version is `6.3.289`, not `5.4.149`.** Both are outside both
execution advisories, so either would have closed the flaw. 6.3.289 was
chosen because 5.x is a branch that no longer receives fixes: a third
advisory landing on it would leave the app on a version with no upgrade
path that does not cross the 5.6.83–6.2.107 window. The ranges were
re-read from OSV directly rather than from this document:

| advisory | introduced | fixed | 6.3.289 |
|---|---|---|---|
| CVE-2018-5158 | 0 / 2.0.0 | 1.10.100 / 2.0.550 | outside |
| CVE-2024-4367 | 0 | 4.2.67 | outside |
| CVE-2026-16633 | 5.6.83 | 6.2.108 | outside |

The cost of 6.x is the one this document measured: `PDFDocumentProxy`
has no `destroy()`. `pdfText()` destroys the loading task, which it was
going to do anyway, so the cost was already paid.

**It buys more than the version.** On 6.3.289 neither vendored file
contains `new Function(` at all — the code-generation path CVE-2024-4367
reached is gone from the build, rather than held out of reach by how the
app calls it. `isEvalSupported: false` is passed regardless and
`cdnPins.test.mjs` reads the bytes for the sink, because the option is
the seatbelt and the absent sink is the fix.

**"No CSP change at all" was wrong, in the app's favour.** `worker-src`
lost `blob:`. The blob wrapper was pdf.js's own, minted only for a
cross-origin `workerSrc`; same-origin it builds the worker directly, and
nothing else in this app has ever made a Worker of any kind. So the
policy got tighter, not unchanged.

**"It is not precached" was accidentally true and then not.** The
reasoning here rested on the files being `.mjs` and the glob being
`{js,css,html,svg,woff2}`. They were vendored as `.js` — the names
jsdelivr serves — so the glob *would* have swept 1.8 MB into every
device's install. `globIgnores: ["**/pdfjs/**"]` is what actually holds
it out, and `precache 36 entries (1184 KiB)` is unchanged from before
the move. A runtime `CacheFirst` rule on `/pdfjs/` keeps the old
bargain: fetched on the first dropped PDF, offline from then on.

That rule also retires the worst of the two it replaces. From the CDN
the worker was fetched no-cors, so its response was opaque — status 0
whether it was the worker or a hotel wifi sign-in page — and it needed
`NetworkFirst` so a poisoned entry could be corrected. Same-origin the
response is basic and its status is plain: `CacheFirst` on 200 alone,
and a captive portal cannot be filed under the worker's name.

`.gitattributes` marks both files `-text`. `core.autocrlf` is on here,
and a checkout that turned their LFs into CRLFs would change every
pinned hash and fail the test on a fresh clone for no visible reason.

## Verified in a browser, not only in Node

`pdfjs-version-probe.mjs` runs in Node, where there is no `Worker` —
pdf.js falls back to running its worker code on the main thread, so a
passing Node probe says nothing about the two things this change
actually altered: that the worker is same-origin and direct, and that
`worker-src` no longer allows `blob:`.

`pdfjs-browser-probe.mjs` serves the built `dist/` under the real
`appPolicy()` header, drives Chromium, and asserts twelve things — text,
page count, version, a worker that is same-origin, module-type, and
**answered**, no blob worker, no policy violation, no console error, and
`task.destroy()` returning where `doc.destroy` is gone. **12/12.**

Two drafts of that probe passed on a page whose policy had refused the
worker, and the failure is worth recording because it is the shape of
the whole risk:

- Draft 1 recorded the Worker's URL *before* `super()`, expecting a
  refusal to throw.
- Draft 2 moved the record after `super()` — and still passed, because
  Chromium blocks a refused worker **asynchronously**. `new Worker(…)`
  returns an ordinary object that simply never loads.

In both drafts the extracted text was correct, because pdf.js caught the
failure and read the PDF on the main thread. **A silently correct answer
is what this failure looks like from the outside** — which is why the
check is now that the worker *replied*, and why the negative run
(`worker-src 'none'`) is part of the record: 9/12, failing exactly the
three checks that are about the worker and none of the ones about text.
