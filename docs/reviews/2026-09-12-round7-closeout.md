# Round 7 closeout

Reviewed application commit `cb5e51c`. The final zero-settlement objection is
resolved: only HTTP 413 with the `request_too_large` error envelope releases
the reservation without usage. Ambiguous refusals, including every 429, retain
their reservations. The direct API's documented pre-processing rejection is
the basis: https://platform.claude.com/docs/en/api/errors#request-size-limits.

Fresh release checks:

- `npm test`: 855 passed, zero failures; render scan, Biome (201 files), and
  Deno typecheck (21 functions) passed.
- `npm run build`: clean dependency installation and production build passed;
  PWA generated 36 precache entries (1185.71 KiB).
- `node docs/reviews/pdfjs-browser-probe.mjs`: 12/12 Chromium checks passed,
  including a responding same-origin module worker under the app CSP.
- Supabase migration history: all 75 local versions match remote versions;
  no pending migrations, including the reservation and lease fixes.
- Live `app_settings.ask_daily_token_cap`: 10,000,000, unchanged.

The three previously executed concurrency probes and their cleanup results
are recorded in `2026-09-12-ask-concurrency-probes.md`; they were reviewed,
not rerun in this closeout. The model-bound evidence and subsequent accounting
reviews remain in their respective review documents.

Round 7's accounting objections are closed. Chromium verification does not
establish compatibility with other browsers. The unrelated `CLAUDE.md` rewrite
remains untouched and excluded from this release commit. No claude-mem tools
were used.

Kyle authorized the final release. The Worker deployment follows this
closeout commit; its result will be reported in the session. No migration
replay is needed.
