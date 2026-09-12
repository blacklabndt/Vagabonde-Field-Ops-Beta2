import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Stamped into the bundle so the drawer can answer "what version is this
// device on?" without guessing — the named version (package.json), the
// commit that built it, and when. Deploys commit first and build second,
// so the hash names the commit that is actually live.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
let commit = "dev";
try { commit = execSync("git rev-parse --short HEAD").toString().trim(); } catch { /* not a checkout */ }
const APP_VERSION = `${pkg.version} · ${commit} · ${new Date().toISOString().slice(0, 10)}`;

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [
    react(),
    // The offline queue was only ever half the story: it kept a JHA, report or
    // ticket safe on the device, but the app itself was ordinary
    // network-loaded JavaScript, so closing the tab in a truck with no signal
    // and reopening it gave a blank page — with the queued work stranded
    // behind it. This precaches the shell so the app starts with no
    // connection at all, which is the condition it was written for.
    VitePWA({
      // "prompt", not "autoUpdate": a new version downloads and *waits* —
      // the running app keeps serving its own cached chunks (an autoUpdate
      // takeover deletes them, breaking lazy screens under an open page) —
      // until the update banner's restart applies it, or the app is fully
      // closed and reopened. swUpdates.js owns the watching and the banner.
      registerType: "prompt",
      // swUpdates.js registers by hand (it needs the registration object
      // for periodic checks); the auto-injected script would double up.
      injectRegister: false,
      // No `includeAssets`: the workbox glob below already sweeps up
      // everything in public/, and listing the icons again put duplicate
      // entries in the precache manifest.
      manifest: {
        name: "VagaboNDE Field Ops",
        short_name: "Field Ops",
        description: "Hazard assessments, radiographic reports and daily billing for RT weld inspection crews.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        // Both dark, and both the icon's background colour. theme_color is the
        // window chrome the OS paints around an installed app — it was the
        // light background, which is why the taskbar came up white. The splash
        // the launcher shows on cold start uses background_color, so matching
        // them means the app doesn't flash white on the way in either.
        background_color: "#1b1e1f",
        theme_color: "#1b1e1f",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      },
      workbox: {
        // Claim, but never skip waiting: activation still only happens on
        // the update banner's restart (or a full close-and-reopen), and
        // claiming right then means the restart's reload comes up under
        // the new worker's control — without it, that first load ran
        // uncontrolled and the register helper offered the banner again
        // for an update that had just been applied.
        clientsClaim: true,
        // The push handlers ride inside the generated worker — generateSW
        // writes sw.js itself, and importScripts is the seam it leaves
        // for hand-written worker code (public/push-sw.js).
        importScripts: ["push-sw.js"],
        // Every built asset, which matters here because the office screens are
        // lazy chunks: an import() that has never been fetched cannot resolve
        // offline, so a precache that covered only the entry would still leave
        // half the app broken in the field.
        // No `png` here: the plugin already precaches everything the manifest
        // references, and globbing images as well listed each icon twice.
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
        // …except pdf.js, which is 1.8 MB of vendored library that only the
        // Upload dialog ever wants. Precaching it would put it on every
        // device at install and again at every update, over the same field
        // connections the precache exists to spare — so it keeps the
        // bargain it had on the CDN: fetched on the first dropped PDF,
        // cached by the runtime rule below, offline from then on.
        globIgnores: ["**/pdfjs/**"],
        navigateFallback: "index.html",
        // …except the client's approval page, which is not part of this app.
        // /approve is served by the Worker (see worker/index.js), and the
        // navigate fallback above was answering it from the cached app shell
        // before the request ever reached the network — so anyone with the app
        // installed followed an approval link and landed on the sign-in
        // screen. A fetch() of the identical URL returned the invoice, which
        // is what made it look like the route was fine.
        // The two policy pages are documents, not the app: Google reads them
        // when the drive registration is published, and a person with the app
        // installed may follow the link from the consent screen.
        // The drive's OAuth callback is a navigation too — Google sends the
        // browser back to /backup/oauth/<provider>?code=… — and on a device
        // with the app installed the service worker answered it with the
        // app shell: the app opened, looked connected, and the code was
        // never exchanged. It has to reach the Worker, like an approval link.
        navigateFallbackDenylist: [/^\/approve(-ticket)?(\?|$)/, /^\/(privacy|terms)\.html$/, /^\/backup\/oauth\//],
        cleanupOutdatedCaches: true,
        // Supabase calls are deliberately absent from runtimeCaching: a stale
        // ticket or rate served from a cache would be worse than an honest
        // failure, and a failure is what the offline queue is there to catch.
        // The two Google Fonts rules that sat here are gone with the fetch
        // they cached: Barlow ships in public/fonts and the glob above
        // precaches it, so nothing asks googleapis.com or gstatic.com for
        // anything any more.
        runtimeCaching: [
          {
            // KLIPY media is immutable — the URL names the exact file
            // forever — and a GIF in the chat history was re-downloaded
            // every visit. CacheFirst means each one crosses a field
            // connection once per device. (Chat photos and voice notes
            // can't join it: their signed URLs carry a fresh token every
            // mint, so no cache key survives — an accepted trade for the
            // private bucket.)
            urlPattern: /^https:\/\/static\d*\.klipy\.com\//,
            handler: "CacheFirst",
            options: {
              cacheName: "klipy-media",
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 14 },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            // The libraries the app fetches on demand — SheetJS, jsPDF and
            // its autotable plugin — are pinned to an exact version,
            // so the URL names bytes that never change. Without this every
            // timesheet approval and every dropped report needed a live
            // connection, on the two screens most likely to be opened in a
            // truck: the precache holds the app itself but a script tag
            // added at runtime is an ordinary network fetch. CacheFirst
            // means each library crosses a field connection once per device,
            // and after that those buttons work with no signal at all.
            //
            // statuses [200] and nothing else. These three are loaded by
            // script tags carrying crossOrigin="anonymous", so the responses
            // are CORS-typed and their real status is visible here — which
            // means a captive portal's login page or a CDN 502 is seen for
            // what it is and refused. Allowing 0 as well would have let an
            // opaque error response be filed under the library's own URL and
            // served back for a year.
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/(?:xlsx@[^/]+\/dist\/xlsx\.full\.min\.js|jspdf@[^/]+\/dist\/jspdf\.umd\.min\.js|jspdf-autotable@[^/]+\/dist\/jspdf\.plugin\.autotable\.min\.js)$/,
            handler: "CacheFirst",
            options: {
              cacheName: "cdn-libraries",
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [200] }
            }
          },
          {
            // pdf.js, which is ours and same-origin, so this rule replaces
            // the two the CDN needed — and the worse of those two is simply
            // gone. pdf.js fetches its own worker as a Worker: from the CDN
            // that was a no-cors request whose response came back opaque,
            // status 0 whether it was the worker or a hotel wifi sign-in
            // page, and CacheFirst would have filed the portal page under
            // the worker's URL for a year on a device that would then never
            // read a PDF again. That is why the worker had a NetworkFirst
            // route of its own, accepting a slower read online as the price
            // of being able to correct a bad answer.
            //
            // Same-origin, the response is basic and its status is plain, so
            // there is nothing left that cannot be judged: both files take
            // CacheFirst on 200 alone, the truck keeps working offline, and
            // a captive portal cannot poison either one. The bytes are
            // pinned in the repo, so the URL naming them never goes stale.
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/pdfjs/"),
            handler: "CacheFirst",
            options: {
              cacheName: "pdfjs",
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [200] }
            }
          }
        ]
      }
    })
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom", "@supabase/supabase-js"],
        },
      },
    },
  },
});
