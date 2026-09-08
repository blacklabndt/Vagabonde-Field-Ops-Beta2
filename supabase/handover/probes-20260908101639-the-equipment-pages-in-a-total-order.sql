-- Probes for 20260908101639_the_equipment_pages_in_a_total_order.sql.
-- Run as the postgres role; rolled back. Role simulation as a technician,
-- since the RPC runs with the caller's rights.

-- 1. Four pages of ONE row, as a technician, so every page boundary falls
--    between two rows and a tie the ORDER BY does not break shows up as a
--    repeat or a gap: every id once, and as many as total_count says.
--    Expect rows_paged = distinct_ids = total (for a register of four).
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Technician' and cardinality(tab_access) > 0 and deactivated_at is null order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
with pages as (
  select id, 0 as pg from public.search_equipment('All', 0, 1, '')
  union all select id, 1 from public.search_equipment('All', 1, 1, '')
  union all select id, 2 from public.search_equipment('All', 2, 1, '')
  union all select id, 3 from public.search_equipment('All', 3, 1, '')
)
select count(*) as rows_paged, count(distinct id) as distinct_ids,
       (select total_count from public.search_equipment('All', 0, 1, '') limit 1) as total
  from pages;
rollback;

-- 2. The order is total: expect the function body to end its ORDER BY
--    with id.
select pg_get_functiondef('public.search_equipment'::regproc) ~ 'order by type, serial_number, id' as total_order;

-- Run live 8 Sept 2026, one row per page: 4, 4, 4; t.
