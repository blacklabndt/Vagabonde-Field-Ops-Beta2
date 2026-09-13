-- Why every Job detail page says "permission denied for table tickets".
--
-- The message comes from jobDetail.jsx's refresh(), which reads four things
-- at once (jhas, reports, tickets, scheduled_sends) and reports the first
-- rejection. "permission denied for table <t>" is 42501: a missing GRANT,
-- not RLS — RLS refuses a read by returning zero rows, never an error. So
-- the `authenticated` role has lost a privilege it needs on public.tickets
-- in the live project. Nothing in supabase/migrations revokes SELECT on
-- tickets, so the live grants have drifted from the repo.
--
-- Run each block as the owner in the SQL editor and paste the output back.

-- ═══ 1 · What authenticated actually holds on tickets ════════════════════
-- Table-level privileges. Expect at least SELECT, INSERT, DELETE.
select grantee, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'tickets'
   and grantee in ('anon', 'authenticated', 'service_role')
 order by grantee, privilege_type;

-- ═══ 2 · Column-level privileges ════════════════════════════════════════
-- The five-column UPDATE grant should be the ONLY thing here. Any SELECT
-- rows in this result mean table-level SELECT was revoked and replaced
-- column by column — and a column added since (gst_rate, invoice_number,
-- queried_at, query_text, query_by, client_key, chased_at) would then be
-- unreadable, which is exactly this error.
select grantee, privilege_type, column_name
  from information_schema.column_privileges
 where table_schema = 'public' and table_name = 'tickets'
   and grantee in ('anon', 'authenticated')
 order by grantee, privilege_type, column_name;

-- ═══ 3 · The same question the blunt way ════════════════════════════════
select has_table_privilege('authenticated', 'public.tickets', 'SELECT') as can_select,
       has_table_privilege('authenticated', 'public.tickets', 'INSERT') as can_insert,
       has_table_privilege('authenticated', 'public.tickets', 'DELETE') as can_delete;

-- Per column, for every column the app's job-detail read names plus the
-- ones added after the baseline.
select a.attname as column_name,
       has_column_privilege('authenticated', 'public.tickets', a.attname, 'SELECT') as can_select
  from pg_attribute a
 where a.attrelid = 'public.tickets'::regclass and a.attnum > 0 and not a.attisdropped
 order by a.attnum;

-- ═══ 4 · Reproduce the app's exact read as a signed-in technician ════════
-- The columns are JOB_TICKET_COLUMNS from vite-app/src/db.js. If block 3
-- says the privilege is there and this still raises 42501, the cause is the
-- embedded profiles(name) join, not tickets.
begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Technician' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated')::text, true);
set local role authenticated;
select t.id, t.job_id, t.work_date, t.status, t.total, t.created_at, t.technician_id
  from public.tickets t
 order by t.created_at desc
 limit 3;
rollback;

-- ═══ 5 · The other three reads, same session ════════════════════════════
-- Proves which card is the one that fails.
begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Technician' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated')::text, true);
set local role authenticated;
select 'jhas'            as src, count(*) from public.jhas;
select 'reports'         as src, count(*) from public.reports;
select 'scheduled_sends' as src, count(*) from public.scheduled_sends;
rollback;
