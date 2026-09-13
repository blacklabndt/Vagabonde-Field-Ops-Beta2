-- Read-only regression probes for the job-detail ticket reader.
-- Run blocks separately: the first deliberately raises 42501.
-- Verified live 2026-09-13 against eielmvxzdwwprmmfamlq.
-- Enforcement migration 20260912210854 removed direct SELECT on total;
-- tickets_read is the intended role-masked reader. Do not restore a broad
-- table grant to fix a frontend still selecting the base table.

-- BEFORE: even an Admin receives permission denied for table tickets.
begin;
select set_config('request.jwt.claims', json_build_object(
  'sub', (select id from public.profiles where role = 'Admin'
          and deactivated_at is null order by created_at limit 1),
  'role', 'authenticated')::text, true);
set local role authenticated;
select t.id, t.job_id, t.work_date, t.status, t.total, t.created_at,
       t.technician_id, p.name
from public.tickets t left join public.profiles p on p.id = t.technician_id
limit 0;
rollback;

-- AFTER: the same fields and profile relationship are readable via the
-- view. Only counts are returned. Observed S-12105: 14 tickets, 14 totals.
begin;
select set_config('request.jwt.claims', json_build_object(
  'sub', (select id from public.profiles where role = 'Admin'
          and deactivated_at is null order by created_at limit 1),
  'role', 'authenticated')::text, true);
set local role authenticated;
select count(*) as ticket_count, count(t.total) as priced_count
from public.tickets_read t
join public.jobs j on j.id = t.job_id
left join public.profiles p on p.id = t.technician_id
where j.job_number = 'S-12105';
rollback;

-- Price privacy remains: an active Helper sees the records and no totals.
-- Observed over all jobs: 28,816 records, zero non-null totals.
begin;
select set_config('request.jwt.claims', json_build_object(
  'sub', (select id from public.profiles where role = 'Helper'
          and deactivated_at is null order by created_at limit 1),
  'role', 'authenticated')::text, true);
set local role authenticated;
select count(*) as ticket_count, count(t.total) as priced_count
from public.tickets_read t
left join public.profiles p on p.id = t.technician_id;
rollback;
