-- Probes for 20260907175805_the_error_log_clear_says_where.sql.
-- Run against the live project as the postgres role; everything is rolled
-- back, so the log is not emptied by the probe.
--
-- What cannot be probed here: the refusal itself. pg-safeupdate is loaded
-- by the authenticator role's session_preload_libraries, and `load
-- 'safeupdate'` is refused in an ordinary session ("access to library
-- "safeupdate" is not allowed"), so the only session that reproduces
-- "DELETE requires a WHERE clause" is the API's. The Admin screen's Clear
-- button is the end-to-end check; these pin what can be pinned.

-- 1. The body carries the WHERE safeupdate wants.
select position('where true' in pg_get_functiondef('public.clear_function_errors()'::regprocedure)) > 0
  as body_says_where;                                   -- expect true

-- 2. An Admin's call still empties the log and answers with the count.
--    (The count subquery shares the statement's snapshot, so it reports the
--    pre-delete figure; the function's answer is the row_count.)
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"' || (select id from public.profiles where role = 'Admin' and deactivated_at is null order by created_at limit 1) || '","role":"authenticated"}',
  true);
select public.clear_function_errors() as cleared,
       (select count(*) from public.function_errors) as were_on_file;  -- cleared = were_on_file
rollback;

-- 3. Anyone below Admin is refused with 42501, before the delete.
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"' || (select id from public.profiles where role <> 'Admin' and deactivated_at is null order by created_at limit 1) || '","role":"authenticated"}',
  true);
select public.clear_function_errors();                  -- expect: Only an admin can clear the error log.
rollback;
