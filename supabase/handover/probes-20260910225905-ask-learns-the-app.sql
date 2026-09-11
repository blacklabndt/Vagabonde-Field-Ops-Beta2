-- Probes for 20260910225905_ask_learns_the_app.sql.
-- Run as the postgres role; every block rolls back. Role simulation through
-- request.jwt.claims. Each block ends on the one row it answers with. All
-- seven were run live on 10 Sept 2026 and answered as written.

-- 1. A Technician writes a note in their own name: expect own true.
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Technician' and cardinality(tab_access) > 0 and deactivated_at is null order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
insert into public.ask_learned (note, said_by) values ('probe: cancel approval is on the ticket row', (select auth.uid()))
returning said_by = (select auth.uid()) as own, length(note) as len;
rollback;

-- 2. In somebody else's name: expect ERROR 42501 (row-level security).
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Technician' and cardinality(tab_access) > 0 and deactivated_at is null order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
insert into public.ask_learned (note, said_by) values ('probe: in another name', (select id from public.profiles where id <> auth.uid() limit 1))
returning id;
rollback;

-- 3. The speaker deletes their own note: expect deleted 1.
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Technician' and cardinality(tab_access) > 0 and deactivated_at is null order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
insert into public.ask_learned (note, said_by) values ('probe: own note to delete', (select auth.uid()));
with d as (delete from public.ask_learned where note = 'probe: own note to delete' returning id) select count(*) as deleted from d;
rollback;

-- 4. An Admin deletes a Technician's note: expect admin_deleted 1.
begin;
insert into public.ask_learned (note, said_by) values ('probe: a technician said this', (select id from public.profiles where role = 'Technician' and cardinality(tab_access) > 0 and deactivated_at is null order by id limit 1));
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Admin' and deactivated_at is null order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
with d as (delete from public.ask_learned where note = 'probe: a technician said this' returning id) select count(*) as admin_deleted from d;
rollback;

-- 5. A Technician cannot delete an Admin's note, and still reads it:
--    expect technician_deleted 0, still_readable 1.
begin;
insert into public.ask_learned (note, said_by) values ('probe: an admin said this', (select id from public.profiles where role = 'Admin' and deactivated_at is null order by id limit 1));
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Technician' and cardinality(tab_access) > 0 and deactivated_at is null order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
with d as (delete from public.ask_learned where note = 'probe: an admin said this' returning id) select count(*) as technician_deleted, (select count(*) from public.ask_learned where note = 'probe: an admin said this') as still_readable from d;
rollback;

-- 6. The memory is the crew's: a Helper reads an Admin's note, and the
--    speaker's role is read from profiles: expect helper_reads 1, Admin.
begin;
insert into public.ask_learned (note, said_by) values ('probe: readable by staff', (select id from public.profiles where role = 'Admin' and deactivated_at is null order by id limit 1));
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Helper' and cardinality(tab_access) > 0 and deactivated_at is null order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
select count(*) as helper_reads, (select role from public.profiles where id = (select said_by from public.ask_learned where note = 'probe: readable by staff')) as speaker_role from public.ask_learned where note = 'probe: readable by staff';
rollback;

-- 7. A note under three characters: expect ERROR 23514 (check constraint).
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Admin' and deactivated_at is null order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
insert into public.ask_learned (note, said_by) values ('no', (select auth.uid())) returning id;
rollback;
