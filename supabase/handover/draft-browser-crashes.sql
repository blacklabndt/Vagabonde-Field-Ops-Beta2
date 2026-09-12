-- DRAFT: not applied. The table the report-error Edge Function writes when a
-- browser ErrorBoundary trips. Apply through the live migration applier, run
-- the companion probes (probes-draft-browser-crashes.sql), then file this
-- exact SQL under supabase/migrations with the version the applier returns.
-- Deploy report-error and the app AFTER this: the function has nothing to
-- write into until it exists.
--
-- Four columns of content and not one of them free text. The whole argument
-- is in supabase/functions/_shared/crashReport.ts: approval tokens and OAuth
-- codes travel in URLs, and a React error message or component stack can
-- carry one. The check constraints below are the database's own copy of the
-- allowlists in that module -- deliberately duplicated, because a function
-- can be redeployed with a bug and the table should still refuse the row.
-- crashReport.test.mjs reads this file and the module and fails on drift.
--
-- This table is the ledger and the rate limit, not the screen. Once a row is
-- in, report-error writes one companion row into public.function_errors --
-- the log the office already reads -- carrying the same four slugs and not a
-- word more, so a browser crash shows up in the Recent failures panel beside
-- every Edge Function failure. A collision (the rate limit) writes neither,
-- so a crash-looping phone cannot fill the log it was meant to inform.
--
-- The primary key IS the rate limit: one report per account per minute, with
-- the minute stamped from the server's clock. A second crash in the same
-- minute collides and the function swallows the collision. Counting rows
-- first and then inserting would leave a window two crashing tabs can both
-- pass through.

create table public.browser_crashes (
  user_id uuid not null references auth.users(id) on delete cascade,
  minute_bucket text not null,
  error_category text not null,
  route_id text not null,
  component_id text not null,
  app_version text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, minute_bucket),
  constraint browser_crashes_minute_bucket_check
    check (minute_bucket ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  constraint browser_crashes_error_category_check
    check (error_category in ('chunk-load','network','type-error','range-error','reference-error','syntax-error','unknown')),
  constraint browser_crashes_route_id_check
    check (route_id in ('board','job','jha','upload','ticket','mytickets','chat','files','contacts','equipment','timesheets','rates','tracker','users','mail','root','unknown')),
  constraint browser_crashes_component_id_check
    check (component_id in ('root','screen')),
  constraint browser_crashes_app_version_check
    check (app_version ~ '^[0-9A-Za-z][0-9A-Za-z .+-]{0,59}$')
);

comment on table public.browser_crashes is
  'One row per account per minute when a browser ErrorBoundary trips. Four allowlisted identifiers only - no message, no stack, no URL. Written by the report-error Edge Function as the service role; never by a signed-in account.';

create index idx_browser_crashes_created on public.browser_crashes (created_at desc);

alter table public.browser_crashes enable row level security;

-- Read like function_errors reads: Admins, and nobody else. There is no
-- insert, update or delete policy on purpose - RLS denies what it does not
-- allow, so the service role is the only writer and no grant has to be
-- narrowed later to take that back.
create policy "browser crashes read"
  on public.browser_crashes for select to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = (select auth.uid()) and p.role = 'Admin'));

revoke insert, update, delete on public.browser_crashes from anon, authenticated;
