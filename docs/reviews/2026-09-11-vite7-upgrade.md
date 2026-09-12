# The build tooling is on a version with no known flaw (Vite 5 → 7)

11 Sept 2026. The last chain `npm audit` could see, and the last item of the
dependency work. No application source changed; three devDependencies and one
line of `vite.config.js` did.

## What was wrong

`npm audit` reported three advisories, all reached through one chain
(`vite-plugin-pwa` → `vite` → `esbuild`):

| package | severity | what |
|---|---|---|
| `vite` ≤ 6.4.2 | **high** | path traversal in optimized-deps `.map` handling; `server.fs.deny` bypass on Windows alternate paths; `launch-editor` NTLMv2 hash disclosure via UNC paths on Windows |
| `esbuild` ≤ 0.24.2 | moderate | any website can send requests to the dev server and read the response (GHSA-67mh-4wv8-2f99) |
| `vite-plugin-pwa` 0.7.0–0.21.0 | moderate | depends on the above |

**None of them reaches the deployed app.** Every one is a *dev server*
weakness — they matter while `vite dev` is running on somebody's laptop, not
on the Worker or a crew tablet. Two of the three are Windows-specific, which
is the machine this is developed on, and the NTLMv2 one leaks a credential
hash rather than a file. So: real, worth fixing, never an incident.

## What was done

```
vite               5.4.21 → 7.3.6
vite-plugin-pwa    0.20.5 → 1.3.0
@vitejs/plugin-react 4.x  → 5.2.0
esbuild (transitive) 0.21.5 → 0.28.2
```

`npm audit` now reports **0 vulnerabilities**.

**Vite 7, not Vite 8.** The vulnerable range is `vite <= 6.4.2`, so 7.3.6
clears all three. Vite 8 would drag `@vitejs/plugin-react@6` in with it —
rolldown-based, with `oxc-transform-react` and `@rolldown/plugin-babel` as
peers — which is a toolchain migration, not a patch. `vite-plugin-pwa@1.3.0`
declares `vite ^3 || ^4 || ^5 || ^6 || ^7 || ^8`, so nothing here blocks a
later move to 8 when it is worth making on its own merits.

## The one thing that would have changed silently

Vite 5 defaulted `build.target` to `"modules"`, an alias for

```js
["es2020", "edge88", "firefox78", "chrome87", "safari14"]   // vite@5.4.21 constants.js
```

Vite 7 **removed that alias** (there is no `ESBUILD_MODULES_TARGET` left, and
nothing maps the string any more, so passing `"modules"` would hand esbuild a
target it does not know) and defaults instead to
`"baseline-widely-available"`, which resolves to

```js
["chrome107", "edge107", "firefox104", "safari16"]
```

That is roughly October 2022 — **two years of devices narrower** than what
Beta 1 and Beta 2 have shipped for. A tablet bought in 2021 and still in a
truck would have stopped getting a working build, with nothing in the output
to say so.

Nobody decided that. It would have arrived as a side effect of a security
upgrade. So the old list is now written out verbatim in `vite.config.js`,
with the reasoning beside it, and the rule is in `CLAUDE.md`: a toolchain
bump does not get to choose which devices the crew can still use. Moving the
target is a decision of its own, and a deliberate one when somebody wants the
smaller bundle.

(`build.cssTarget` follows `build.target` when unset, so the stylesheet is
compiled for the same browsers as the code — no second pin needed.)

## Verification

Everything below ran on this tree, in this order.

**The gate** — `npm --prefix vite-app test`: render scan · Biome (199 files)
· Deno typecheck (21 functions, deno@2.9.6) · **829 node tests, 0 failures**.

**The build** — `npm --prefix vite-app run build`, green, PWA generated.

**The build compared against the Vite 5 baseline**, captured from `dist/`
before anything was installed:

| | Vite 5.4.21 | Vite 7.3.6 |
|---|---|---|
| precache entries | 36 | **36** |
| precache list (hashes stripped) | — | **identical** |
| chunk set (hashes stripped) | — | **identical** |
| `sw.js` size | 4,279 B | **4,279 B** |
| `importScripts("push-sw.js")` | yes | yes |
| `clientsClaim` / `cleanupOutdatedCaches` | yes | yes |
| runtime caches | klipy-media, cdn-libraries, pdfjs | **same three** |
| pdf.js precached (must be false) | false | **false** |
| navigate-fallback denylist (`/approve`, privacy/terms, `/backup/oauth/`) | present | present |

The precache byte count is the one number that moved, and it moved the right
way: 1184.57 KiB on Vite 5 → 1181.32 KiB on Vite 7's *default* target →
**1184.57 KiB** once the target was pinned back. That is the pin doing what it
says — the smaller figure was the dropped transpilation, not a smaller app.

**The browser** — `node docs/reviews/pdfjs-browser-probe.mjs`, which serves the
newly built `dist/` under the real `appPolicy()` header and drives Chromium:
**12/12**. The bundle loads, the PDF is read, the worker is made from this
origin and *answers* (not the main-thread fallback), the policy refuses
nothing, nothing is logged as an error.

**The dev server**, since that is what every one of the three advisories was
actually about: started on Vite 7, **6/6** — `index.html`, `src/main.jsx` and
`src/db.js` transformed and served, `public/` served, and both vendored pdf.js
files served whole.

## What did not change

The three runtime dependencies are untouched — `react` 18.3.1, `react-dom`
18.3.1, `@supabase/supabase-js` 2.112.3. Nothing in `src/`, nothing in
`supabase/functions/`, nothing in `worker/`. The deployed bundle differs from
the last one only by what the newer esbuild emits for the same target.

## Still not visible to `npm audit`

The three libraries fetched by URL — `xlsx@0.18.5`, `jspdf@2.5.2`,
`jspdf-autotable@3.8.4` — are not dependencies and never appear in an audit.
They are reviewed by hand in `docs/reviews/2026-09-11-cdn-pins.md` and held
there by `cdnPins.test.mjs`. pdf.js was the fourth and is no longer fetched by
URL at all.
