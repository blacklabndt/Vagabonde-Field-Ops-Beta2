-- Probes for 20260911010317_a_reminder_is_a_timer_with_no_mail.sql.
-- Run as the postgres role; every block rolls back. Role simulation through
-- request.jwt.claims, as a Technician holding tabs.

-- 1. A reminder with no job, in the person's own name: expect queued, t, t.
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Technician' and cardinality(tab_access) > 0 and deactivated_at is null order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
insert into public.scheduled_sends (kind, record_id, job_id, label, to_list, run_at, set_by)
values ('reminder', '', null, 'probe: call the office', '', now() + interval '1 hour', (select auth.uid()))
returning status, job_id is null as no_job, set_by = (select auth.uid()) as own;
rollback;

-- 2. A reminder on a job the person can read: expect queued, t.
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Technician' and cardinality(tab_access) > 0 and deactivated_at is null order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
insert into public.scheduled_sends (kind, record_id, job_id, label, to_list, run_at, set_by)
select 'reminder', '', j.id, 'probe: on a job', '', now() + interval '1 hour', (select auth.uid())
from (select id from public.jobs order by created_at desc limit 1) j
returning status, job_id is not null as has_job;
rollback;

-- 3. A reminder on a job the person cannot read (none of that id is
--    visible): expect ERROR 42501 — the policy, before the foreign key.
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Technician' and cardinality(tab_access) > 0 and deactivated_at is null order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
insert into public.scheduled_sends (kind, record_id, job_id, label, to_list, run_at, set_by)
values ('reminder', '', '00000000-0000-0000-0000-00000000cccc', 'probe: job it cannot read', '', now() + interval '1 hour', (select auth.uid()))
returning id;
rollback;

-- 4. A reminder carrying an address: expect ERROR 42501 (to_list is pinned
--    empty; a reminder mails nobody).
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Technician' and cardinality(tab_access) > 0 and deactivated_at is null order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
insert into public.scheduled_sends (kind, record_id, job_id, label, to_list, run_at, set_by)
values ('reminder', '', null, 'probe: with an address', 'probe@example.com', now() + interval '1 hour', (select auth.uid()))
returning id;
rollback;

-- 5. A send of the old kinds with no job, now that the column allows null:
--    expect ERROR 42501 (each send arm demands its job).
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Technician' and cardinality(tab_access) > 0 and deactivated_at is null order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
insert into public.scheduled_sends (kind, record_id, job_id, label, to_list, run_at, set_by)
select 'jha', j.id::text, null, 'probe: a jha with no job', 'probe@example.com', now() + interval '1 hour', (select auth.uid())
from (select id from public.jhas order by signed_at desc limit 1) j
returning id;
rollback;

-- Run live 11 Sept 2026 (01:03 UTC): 1 queued/t/t; 2 queued/t; 3 42501;
-- 4 42501; 5 42501.
