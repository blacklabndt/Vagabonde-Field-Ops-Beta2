-- Probes for 20260908063429_a_locked_account_reads_only_its_own_row.sql.
-- Run as the postgres role; every block rolls back, so no account is
-- really locked by the probe. Role simulation through request.jwt.claims.

-- 1. A locked account (no tabs, deactivated_at set) sees one row, its own:
--    expect visible 1, only_own t.
begin;
update public.profiles set deactivated_at = now(), tab_access = '{}'
 where id = (select id from public.profiles where role = 'Technician' and cardinality(tab_access) > 0 and deactivated_at is null order by id limit 1);
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where deactivated_at is not null and tab_access = '{}' order by deactivated_at desc limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
select count(*) as visible, bool_and(id = (select auth.uid())) as only_own from public.profiles;
rollback;

-- 2. A staff account (at least one tab) reads the whole directory: expect
--    the same count the postgres role sees.
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Technician' and cardinality(tab_access) > 0 and deactivated_at is null order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
select count(*) as visible_to_staff from public.profiles;
rollback;

-- Run live 8 Sept 2026: 1 t; 44 (of 44).
