-- LIVE RELEASE 2026-09-12: migration 20260912160845 applied.
-- Probes 1-9/8b passed via the assertion-based companion *-live.sql.
-- Probe 10 passed with two concurrent Management API database sessions:
-- A held its transaction open; B observed waiting on transactionid with
-- one blocker, then returned rate_limited after A committed. One ledger
-- row and one log row verified; both probe rows removed afterwards.
-- Historical offline notes below describe the pre-release run.

-- Probes for draft-browser-crashes.sql. Run as the postgres role AFTER the
-- draft is applied; every block rolls back, so no crash row survives the
-- probe. Role simulation through request.jwt.claims, per the RLS rule.

-- 1. The rate limit is the primary key: two reports in the same minute for
--    the same account, and the second collides. Expect the insert after the
--    savepoint to raise unique_violation (23505) - the code report-error
--    swallows. Then the next minute is a different row and is allowed:
--    expect rows_for_two_minutes 2.
begin;
insert into public.browser_crashes (user_id, minute_bucket, error_category, route_id, component_id, app_version)
values ((select id from auth.users order by created_at limit 1), '2026-09-12T10:00', 'chunk-load', 'board', 'screen', '0.93-beta 2');
savepoint two;
insert into public.browser_crashes (user_id, minute_bucket, error_category, route_id, component_id, app_version)
values ((select id from auth.users order by created_at limit 1), '2026-09-12T10:00', 'type-error', 'job', 'screen', '0.93-beta 2');
rollback to two;
insert into public.browser_crashes (user_id, minute_bucket, error_category, route_id, component_id, app_version)
values ((select id from auth.users order by created_at limit 1), '2026-09-12T10:01', 'type-error', 'job', 'screen', '0.93-beta 2');
select count(*) as rows_for_two_minutes from public.browser_crashes;
rollback;

-- 2. The database refuses what the module refuses, even if the function is
--    redeployed with a bug. Each of these must raise check_violation (23514):
--    an invented category, a route that is really a URL with a token in it,
--    and a version string that is really a URL with a token hash in it.
begin;
savepoint bad_category;
insert into public.browser_crashes (user_id, minute_bucket, error_category, route_id, component_id, app_version)
values ((select id from auth.users order by created_at limit 1), '2026-09-12T11:00', 'made-up', 'board', 'screen', '0.93-beta 2');
rollback to bad_category;
savepoint bad_route;
insert into public.browser_crashes (user_id, minute_bucket, error_category, route_id, component_id, app_version)
values ((select id from auth.users order by created_at limit 1), '2026-09-12T11:00', 'unknown', '/approve?token=abc', 'screen', '0.93-beta 2');
rollback to bad_route;
savepoint bad_version;
insert into public.browser_crashes (user_id, minute_bucket, error_category, route_id, component_id, app_version)
values ((select id from auth.users order by created_at limit 1), '2026-09-12T11:00', 'unknown', 'board', 'screen', 'https://example.com/x?token=sha256:deadbeef');
rollback to bad_version;
select 'all three refused' as checks;
rollback;

-- 3. An Admin reads the log; a Technician reads nothing. Expect admin_sees 1,
--    tech_sees 0.
begin;
insert into public.browser_crashes (user_id, minute_bucket, error_category, route_id, component_id, app_version)
values ((select id from auth.users order by created_at limit 1), '2026-09-12T12:00', 'chunk-load', 'board', 'screen', '0.93-beta 2');
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Admin' order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
select count(*) as admin_sees from public.browser_crashes;
reset role;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Technician' and deactivated_at is null order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
select count(*) as tech_sees from public.browser_crashes;
rollback;

-- 4. No signed-in account writes the table directly - the service role is the
--    only writer. Expect insufficient_privilege (42501), from the revoked
--    grant, not merely a policy refusal.
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Admin' order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
insert into public.browser_crashes (user_id, minute_bucket, error_category, route_id, component_id, app_version)
values ((select auth.uid()), '2026-09-12T13:00', 'unknown', 'board', 'screen', '0.93-beta 2');
rollback;


-- 5. file_browser_crash writes BOTH rows, in one transaction. One call, and
--    the ledger has the crash and function_errors has the office's copy.
--    Expect filed = 'filed', ledger 1, log 1, and the log line built from
--    the slugs alone.
begin;
select public.file_browser_crash(
  (select id from auth.users order by created_at limit 1),
  '2026-09-12T14:00', 'chunk-load', 'board', 'screen', '0.93-beta 2') as filed;
select count(*) as ledger from public.browser_crashes where minute_bucket = '2026-09-12T14:00';
select function_name, message, context
  from public.function_errors
 where function_name = 'browser'
 order by created_at desc limit 1;
rollback;

-- 6. The rate limit, through the function: a second call in the same minute
--    returns 'rate_limited' and writes NEITHER row. Expect rate_limited =
--    'rate_limited', ledger 1, log 1 -- not 2. A crash-looping phone must
--    not fill the log it was meant to inform.
begin;
select public.file_browser_crash(
  (select id from auth.users order by created_at limit 1),
  '2026-09-12T15:00', 'chunk-load', 'board', 'screen', '0.93-beta 2') as first_call;
select public.file_browser_crash(
  (select id from auth.users order by created_at limit 1),
  '2026-09-12T15:00', 'type-error', 'job', 'screen', '0.93-beta 2') as rate_limited;
select count(*) as ledger from public.browser_crashes where minute_bucket = '2026-09-12T15:00';
select count(*) as log_rows from public.function_errors
 where function_name = 'browser' and context->>'route_id' in ('board','job')
   and created_at > now() - interval '1 minute';
rollback;

-- 7. The half that used to be possible is now impossible: if the office's
--    copy cannot be written, the ledger row is not written either -- so the
--    primary key does not spend the minute hiding a crash nobody can see.
--    Break function_errors for the length of the transaction and call it.
--    Expect an error (not a return), then ledger 0.
begin;
alter table public.function_errors add constraint probe_refuse_browser
  check (function_name <> 'browser') not valid;
savepoint half;
select public.file_browser_crash(
  (select id from auth.users order by created_at limit 1),
  '2026-09-12T16:00', 'chunk-load', 'board', 'screen', '0.93-beta 2');
rollback to half;
select count(*) as ledger_after_failed_log from public.browser_crashes
 where minute_bucket = '2026-09-12T16:00';
rollback;

-- 8. The table's own rules still apply through the function: a route that is
--    really a URL raises check_violation (23514) and is NOT swallowed as the
--    rate limit. Only the LEDGER key's own collision returns a word.
begin;
select public.file_browser_crash(
  (select id from auth.users order by created_at limit 1),
  '2026-09-12T17:00', 'unknown', '/approve?token=abc', 'screen', '0.93-beta 2');
rollback;

-- 8b. And a uniqueness failure that is NOT this account's minute is a
--     failure too. The ledger insert carries ON CONFLICT on its own key, so
--     nothing else returns 'rate_limited' -- which matters, because a crash
--     answered "filed" while nothing was written is exactly the silence this
--     table exists to end. Force a collision on the office's copy instead.
--     Expect unique_violation (23505) RAISED, not a returned word, and
--     ledger 0 -- the minute is still free for the next report.
begin;
create unique index probe_one_browser_message on public.function_errors (message)
  where function_name = 'browser';
insert into public.function_errors (function_name, message, context)
  values ('browser', 'ErrorBoundary (screen) on board: chunk-load', '{}'::jsonb);
savepoint collide;
select public.file_browser_crash(
  (select id from auth.users order by created_at limit 1),
  '2026-09-12T17:30', 'chunk-load', 'board', 'screen', '0.93-beta 2');
rollback to collide;
select count(*) as ledger_after_log_collision from public.browser_crashes
 where minute_bucket = '2026-09-12T17:30';
rollback;

-- 9. A signed-in account cannot call it. security definer means the function
--    writes as its owner, so execute is the whole gate -- probe it as a
--    non-owner, per the rule. Expect insufficient_privilege (42501).
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Admin' order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.file_browser_crash(
  (select auth.uid()), '2026-09-12T18:00', 'chunk-load', 'board', 'screen', '0.93-beta 2');
rollback;

-- 10. Two sessions, not one transaction: the rate limit under real
--     concurrency. This one needs TWO psql connections, because a single
--     session cannot race itself.
--
--     Session A:  begin;
--                 select public.file_browser_crash(<user>, '<same minute>', 'chunk-load', 'board', 'screen', '0.93-beta 2');
--                 -- leave the transaction OPEN
--     Session B:  select public.file_browser_crash(<user>, '<same minute>', 'type-error', 'job', 'screen', '0.93-beta 2');
--                 -- BLOCKS on the primary key index, as it must
--     Session A:  commit;
--     Session B:  -- unblocks and returns rate_limited
--
--     Then, in either session: expect one browser_crashes row for that
--     minute and one 'browser' row in function_errors. If B returns 'filed'
--     or a second row appears, the key is not the rate limit and the whole
--     design is wrong.
--     Afterwards: delete from public.browser_crashes where minute_bucket = '<same minute>';
--                 delete from public.function_errors where function_name = 'browser' and ...;

-- Not yet run live: the draft is unapplied.
--
-- Run offline, 2026-09-12, against real Postgres compiled to WASM (PGlite,
-- v0.3) in a throwaway harness: the draft applied to an empty database with
-- Supabase's roles, grants, auth.users, auth.uid(), profiles and
-- function_errors recreated around it. Probes 1 to 9 all came back exactly
-- as each one specifies:
--   1  23505 on the second report, rows_for_two_minutes 2
--   2  23514 x3 (category, route, version), "all three refused"
--   3  admin_sees 1, tech_sees 0
--   4  42501 from the revoked grant, not a policy refusal
--   5  filed; ledger 1; message "ErrorBoundary (screen) on board: chunk-load"
--   6  rate_limited; ledger 1; log_rows 1
--   7  23514 raised; ledger_after_failed_log 0
--   8  23514 raised through the function, not swallowed
--   8b 23505 RAISED (not returned); ledger_after_log_collision 0
--   9  42501, permission denied for function file_browser_crash
-- Nothing survived: browser_crashes 0, function_errors('browser') 0.
--
-- 10 was NOT run: PGlite is a single connection and cannot race itself. It
-- needs two real sessions. Uniqueness under concurrency is Postgres's own
-- guarantee, but this design rests on it, so it stays unproven until it is
-- run against a live database with two connections.
--
-- A WASM Postgres is the real engine, not a model, but it is not this
-- project: no live data, no live roles, no live policies from other
-- migrations OR-ing with these. These results retire the question "does the
-- SQL do what the comments say"; they do not retire the live run.
