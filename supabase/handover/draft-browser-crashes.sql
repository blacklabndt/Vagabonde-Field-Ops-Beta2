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
-- This table is the ledger and the rate limit, not the screen. The screen is
-- public.function_errors, the log the office already reads, and a crash gets
-- one row there too -- the same four slugs and not a word more, so it shows
-- up in the Recent failures panel beside every Edge Function failure. Both
-- rows are written by file_browser_crash (below) in ONE transaction: there
-- is no outcome where the ledger holds the minute's rate limit and the
-- screen shows nothing. A collision writes neither row, so a crash-looping
-- phone cannot fill the log it was meant to inform.
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

-- One call, one transaction, both rows -- or neither.
--
-- The ledger row and the office's copy used to be two PostgREST inserts, and
-- PostgREST gives each request its own transaction: there is no way to wrap
-- two of them. So the second could fail after the first had landed, and the
-- crash would be invisible in the only screen anyone looks at WHILE the
-- primary key refused every retry for the rest of the minute. Silence that
-- looks exactly like health.
--
-- A function body is a transaction. The ledger insert and the log insert are
-- inside this one, so the office's copy cannot be the half that goes missing.
-- The unique_violation is caught here rather than at the client, which keeps
-- the rate limit exactly where it was -- the primary key, with no read before
-- the write -- while making the two rows atomic.
--
-- The log sentence is built HERE, out of the three columns the check
-- constraints have already vetted, so nothing free-text can reach
-- function_errors down this path even if report-error ships with a bug.
-- handler.ts builds the same sentence for its tests; crashReport.test.mjs
-- reads both and fails on drift.
--
-- security definer because the caller is the service role writing two tables
-- it is the only writer of; execute is revoked from everyone else, so a
-- signed-in account cannot reach it. Probed as a non-owner before it ships.
create function public.file_browser_crash(
  p_user_id uuid,
  p_minute_bucket text,
  p_error_category text,
  p_route_id text,
  p_component_id text,
  p_app_version text
) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.browser_crashes
    (user_id, minute_bucket, error_category, route_id, component_id, app_version)
  values
    (p_user_id, p_minute_bucket, p_error_category, p_route_id, p_component_id, p_app_version);

  insert into public.function_errors (function_name, message, context)
  values (
    'browser',
    'ErrorBoundary (' || p_component_id || ') on ' || p_route_id || ': ' || p_error_category,
    jsonb_build_object(
      'error_category', p_error_category,
      'route_id', p_route_id,
      'component_id', p_component_id,
      'app_version', p_app_version,
      'source', 'browser'));

  return 'filed';
exception
  -- The rate limit landing. Neither row is written and the caller is told ok,
  -- so a crash-looping phone cannot fill the log it was meant to inform.
  when unique_violation then return 'rate_limited';
end;
$$;

comment on function public.file_browser_crash(uuid, text, text, text, text, text) is
  'Files one browser crash: the browser_crashes ledger row and its companion function_errors row, in one transaction. Returns filed or rate_limited. Service role only.';

revoke all on function public.file_browser_crash(uuid, text, text, text, text, text) from public;
revoke all on function public.file_browser_crash(uuid, text, text, text, text, text) from anon, authenticated;
grant execute on function public.file_browser_crash(uuid, text, text, text, text, text) to service_role;
