-- Probes for 20260910213858_a_send_can_wait_for_its_time.sql.
-- Run as the postgres role; every block rolls back. Role simulation through
-- request.jwt.claims. Each block ends on the one row it answers with.

-- 1. A Technician schedules a JHA they can read, in their own name:
--    expect status queued, own t.
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Technician' and cardinality(tab_access) > 0 and deactivated_at is null order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
with j as (select id, job_id from public.jhas order by signed_at desc limit 1)
insert into public.scheduled_sends (kind, record_id, job_id, label, to_list, run_at, set_by)
select 'jha', j.id::text, j.job_id, 'probe', 'probe@example.com', now() + interval '1 hour', (select auth.uid()) from j
returning status, set_by = (select auth.uid()) as own;
rollback;

-- 2. In somebody else's name: expect ERROR 42501 (row-level security).
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Technician' and cardinality(tab_access) > 0 and deactivated_at is null order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
insert into public.scheduled_sends (kind, record_id, job_id, label, to_list, run_at, set_by)
select 'jha', j.id::text, j.job_id, 'probe', 'probe@example.com', now() + interval '1 hour',
       (select id from public.profiles where id <> auth.uid() limit 1)
from (select id, job_id from public.jhas order by signed_at desc limit 1) j
returning id;
rollback;

-- 3. Already marked sent: expect ERROR 42501.
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Technician' and cardinality(tab_access) > 0 and deactivated_at is null order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
insert into public.scheduled_sends (kind, record_id, job_id, label, to_list, run_at, set_by, status)
select 'jha', j.id::text, j.job_id, 'probe', 'probe@example.com', now() + interval '1 hour', (select auth.uid()), 'sent'
from (select id, job_id from public.jhas order by signed_at desc limit 1) j
returning id;
rollback;

-- 4. The record on a job it does not belong to: expect ERROR 42501.
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Technician' and cardinality(tab_access) > 0 and deactivated_at is null order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
insert into public.scheduled_sends (kind, record_id, job_id, label, to_list, run_at, set_by)
select 'jha', j.id::text, (select id from public.jobs where id <> j.job_id limit 1), 'probe', 'probe@example.com', now() + interval '1 hour', (select auth.uid())
from (select id, job_id from public.jhas order by signed_at desc limit 1) j
returning id;
rollback;

-- 5. Another technician neither sees nor cancels a queued row: expect 0, 0.
begin;
with t as (select id from public.profiles where role = 'Technician' and cardinality(tab_access) > 0 and deactivated_at is null order by id limit 1),
     j as (select id, job_id from public.jhas order by signed_at desc limit 1)
insert into public.scheduled_sends (id, kind, record_id, job_id, label, to_list, run_at, set_by)
select '00000000-0000-0000-0000-00000000aaaa', 'jha', j.id::text, j.job_id, 'probe', 'probe@example.com', now() + interval '1 hour', t.id from t, j;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Technician' and cardinality(tab_access) > 0 and deactivated_at is null order by id offset 1 limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
with u as (update public.scheduled_sends set status = 'cancelled' where id = '00000000-0000-0000-0000-00000000aaaa' returning id)
select count(*) as other_tech_cancelled, (select count(*) from public.scheduled_sends where id = '00000000-0000-0000-0000-00000000aaaa') as other_tech_sees from u;
rollback;

-- 6. The owner cancels: expect 1.
begin;
with t as (select id from public.profiles where role = 'Technician' and cardinality(tab_access) > 0 and deactivated_at is null order by id limit 1),
     j as (select id, job_id from public.jhas order by signed_at desc limit 1)
insert into public.scheduled_sends (id, kind, record_id, job_id, label, to_list, run_at, set_by)
select '00000000-0000-0000-0000-00000000aaaa', 'jha', j.id::text, j.job_id, 'probe', 'probe@example.com', now() + interval '1 hour', t.id from t, j;
select set_config('request.jwt.claims', json_build_object('sub', (select set_by from public.scheduled_sends where id = '00000000-0000-0000-0000-00000000aaaa'), 'role', 'authenticated')::text, true);
set local role authenticated;
with u as (update public.scheduled_sends set status = 'cancelled' where id = '00000000-0000-0000-0000-00000000aaaa' returning id)
select count(*) as owner_cancelled from u;
rollback;

-- 7. A cancelled row cannot be re-queued: expect 0. (Run after 6's update
--    inside the same transaction, before the rollback.)
--    with u as (update public.scheduled_sends set status = 'queued' where id = '00000000-0000-0000-0000-00000000aaaa' returning id) select count(*) as requeued from u;

-- 8. A Coordinator cancels another's queued row: expect 1, 1. No
--    Coordinator account exists live, so one is made for the probe and
--    rolled back with it.
begin;
update public.profiles set role = 'Coordinator' where id = (select id from public.profiles where role = 'Technician' and cardinality(tab_access) > 0 and deactivated_at is null order by id offset 1 limit 1);
with t as (select id from public.profiles where role = 'Technician' and cardinality(tab_access) > 0 and deactivated_at is null order by id limit 1),
     j as (select id, job_id from public.jhas order by signed_at desc limit 1)
insert into public.scheduled_sends (id, kind, record_id, job_id, label, to_list, run_at, set_by)
select '00000000-0000-0000-0000-00000000bbbb', 'jha', j.id::text, j.job_id, 'probe', 'probe@example.com', now() + interval '1 hour', t.id from t, j;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Coordinator' and deactivated_at is null order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
with u as (update public.scheduled_sends set status = 'cancelled' where id = '00000000-0000-0000-0000-00000000bbbb' returning id)
select count(*) as coordinator_cancelled, (select count(*) from public.scheduled_sends where id = '00000000-0000-0000-0000-00000000bbbb') as coordinator_sees from u;
rollback;

-- 9. A Helper schedules a ticket approval: tickets select is is_staff(), so
--    the INSERT passes RLS (expect queued) — the fire-time gate in
--    scheduled-sends is what refuses it, and Ask's runner refuses it before
--    proposing (a price role, then ticketSendGate).
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Helper' and cardinality(tab_access) > 0 and deactivated_at is null order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
insert into public.scheduled_sends (kind, record_id, job_id, label, to_list, run_at, set_by)
select 'ticket_approval', t.id, t.job_id, 'probe', 'probe@example.com', now() + interval '1 hour', (select auth.uid())
from (select id, job_id from public.tickets where status = 'Draft' order by created_at desc limit 1) t
returning status;
rollback;

-- 10. The clock exists and the tick answers: expect one active row, and
--     net._http_response showing 200 {"ok":true,"fired":0,...} every five minutes.
select jobname, schedule, active from cron.job where jobname = 'scheduled-sends-tick';

-- Run live 10 Sept 2026: 1 queued/t; 2 42501; 3 42501; 4 42501; 5 0/0;
-- 6 1; 7 0; 8 1/1; 9 queued; 10 active, first tick 21:40 UTC answered
-- 200 {"ok":true,"fired":0,"failed":0,"stuck":0}.
