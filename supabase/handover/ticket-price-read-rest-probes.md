# Ticket read compatibility probes

Status: **live SQL metadata verified through signed-in Chrome on 2026-09-13; anonymous REST schema probes verified below; authenticated runtime checks still pending**. The live view exposes both `gst_rate` and `client_key`. Its options are `security_barrier=true` and `security_invoker=false`; its explicit `is_staff()` predicate gates rows and its CASE exposes `total` only for Admin/Technician. SQL metadata alone does not verify PostgREST embeds or runtime role enforcement.

Live migration history contains `20260912205211_a_ticket_total_is_read_through_a_view` (view and reporting routines) and `20260912210854_a_ticket_total_is_read_through_a_view_enforced` (column grants). Both stored statements retain historical DRAFT comments despite being present in applied migration history. The enforcement migration is now filed locally verbatim from the statements Kyle supplied on 2026-09-13; the earlier view migration is also now filed verbatim from Kyle’s supplied statements. Enforcement excludes `total` from authenticated base-table SELECT but includes `gst_rate`.

The signed-in Kyle Keith browser still reproduces the original permission-denied error on S-12105 after reload. This verifies the current browser is still affected, not that the working-tree fix has failed. No deployment or live schema changes were performed. Browser control provides UI interaction and read-only DOM inspection; it does not provide an authenticated REST-request execution surface, so authenticated HTTP probes remain unexecuted; the later anonymous schema probes are recorded below.

The browser now reads prices through `tickets_read` for job cards, offline prefetch, archive export, My Tickets drafts, both createTicket idempotency lookups, reopening drafts, and updateTicket's existing-draft save/replay precheck. Writes remain on `tickets`. Mark-invoiced uses its existing RPC.

For a connected agent: issue these read-only requests to `https://eielmvxzdwwprmmfamlq.supabase.co/rest/v1/tickets_read`, with the project's public API key in `apikey` and an existing authenticated user's JWT in `Authorization: Bearer ...`. URL-encode each `select` parameter. Do not paste credentials into reports or commit them.

Each schema probe uses `limit=0` to validate columns and relationships without returning customer rows:

| Caller | Query parameters |
| --- | --- |
| Archive | `select=id,work_date,status,total,gst_rate,delays,client_contact,contractor_contact,approved_at,approved_by_email,approval_sent_at,approval_sent_to,invoiced_at,queried_at,query_text,query_by,profiles(name),ticket_lines(kind,label,unit,quantity,unit_rate,line_order)&limit=0` |
| My Tickets | `select=id,work_date,status,total,created_at,jobs(job_number,project,clients(name))&limit=0` |
| Both idempotency lookups | `select=id,total&client_key=is.null&limit=0` |
| Reopen draft | `select=id,job_id,technician_id,work_date,status,total,gst_rate,delays,client_contact,contractor_contact,ticket_lines(kind,label,unit,quantity,unit_rate)&limit=0` |
| Save/replay precheck | `select=status,job_id,total,jobs(status,job_number)&limit=0` |

Expected schema result: HTTP 200 and `[]` for every request. A missing-column error requires examining/widening the view; a missing or ambiguous relationship requires repairing the view's relationship exposure or using explicit relationship hints validated against the API. Do not restore broad base-table price grants.

After schema checks, run the same reads for a known permitted ticket/draft with `id=eq.<ticket-id>&limit=1`. Verify a price-authorized Admin/Technician gets the stored total and lines; a non-price role gets masked totals and restricted lines according to the existing policies. Repeat the affected screens under those roles, including offline prefetch and draft save/replay. Record HTTP outcomes and role names without tokens or customer payloads.

Local regression coverage: `vite-app/src/ticketPriceReads.test.mjs` exercises the actual six query paths against a boundary fake that rejects base-table total reads with 42501. All six failed before the changes and pass afterward. This validates query routing and returned behavior, **not live view schema or role enforcement**.

## PostgREST compatibility: answered 2026-09-13, no JWT required

The open question — do the columns and the `profiles` / `ticket_lines` /
`jobs(clients(...))` embeds resolve through the view — is answerable
without a signed-in session, because PostgREST resolves the schema cache
*before* it executes. Two error classes separate cleanly:

- an unknown embed target fails at plan time: `PGRST200` / HTTP 400,
  "Could not find a relationship … in the schema cache";
- an unknown column fails at plan time too: `42703` / HTTP 400,
  "column tickets_read.<name> does not exist";
- a **resolved** query fails only at execution, as `42501` / HTTP 401,
  "permission denied for view tickets_read", because `anon` holds no
  grant on the view.

So `42501` on an anonymous request is the *pass* signal: everything named
in the request resolved. Reproduce with the publishable key alone
(`vite-app/.env.example`), no `Authorization` header:

```
curl -s -G 'https://eielmvxzdwwprmmfamlq.supabase.co/rest/v1/tickets_read' \
  --data-urlencode 'select=<the caller's select>' --data-urlencode 'limit=0' \
  -H 'apikey: <publishable key>'
```

Observed 2026-09-13:

| Probe | Result |
| --- | --- |
| control — `id,not_a_real_table(x)` | 400 `PGRST200` (relationship missing, as designed) |
| control — `id,not_a_real_column` | 400 `42703` (column missing, as designed) |
| `id` | 401 `42501` |
| `id,total,gst_rate,client_key,technician_id,job_id` | 401 `42501` |
| Archive select (incl. `profiles(name)`, `ticket_lines(...)`) | 401 `42501` |
| My Tickets — `jobs(job_number,project,clients(name))` | 401 `42501` |
| Reopen draft — `ticket_lines(...)` | 401 `42501` |
| Save/replay precheck — `jobs(status,job_number)` | 401 `42501` |
| `client_key=eq.zzz` filter | 400 `22P02` invalid uuid — the column exists and is `uuid`; a missing one would have been `42703` |

**Conclusion: all six converted call sites are schema-compatible with
`tickets_read`.** Every column they name exists on the view, and all four
embeds — `profiles`, `ticket_lines`, `jobs`, and `jobs→clients` — are in
the PostgREST relationship cache for the view. No view widening is needed.

What these probes still do **not** cover, and what the earlier SQL
role-simulation probes in `probes-job-detail-ticket-read.sql` do cover:
row visibility (`is_staff()`, matching the base table's `tickets select`
policy exactly — verified against the baseline, no widening) and the
role-dependent masking of `total` (Helper: 28,816 rows, zero totals).
The remaining gap is runtime behaviour under a real session, which the
deploy itself exercises: load a job page as an Admin and as a Helper.

## Live migrations filed locally

`20260912210854_a_ticket_total_is_read_through_a_view_enforced.sql` is now
filed in `supabase/migrations/` verbatim from Kyle's supplied live-history
statements. Its DRAFT comment is historical, not its current applied status.
This records an existing live migration; it was not reapplied.

`20260912205211_a_ticket_total_is_read_through_a_view` remains applied live
but absent from `supabase/migrations/`. Retrieve its complete statements
from `supabase_migrations.schema_migrations` and file under its live version.
The enforcement migration depends on that earlier view creation, so local
migration history is still incomplete.

Note for a later review: the view is `security_barrier=true`,
`security_invoker=false`. Row visibility therefore rests on the view's own
explicit `is_staff()` predicate rather than on `tickets`' RLS. That happens
to match the base policy today, so it is not a live hole — but the two can
now drift apart silently. Any future narrowing of `tickets select` must be
mirrored into the view.
