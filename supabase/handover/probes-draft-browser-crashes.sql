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

-- Not yet run live: the draft is unapplied.
