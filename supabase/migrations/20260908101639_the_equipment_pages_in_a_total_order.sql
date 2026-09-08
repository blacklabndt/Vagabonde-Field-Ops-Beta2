-- search_equipment pages in a total order.
--
-- It paged by OFFSET over `order by type, serial_number`, which is not a
-- unique ordering: every item of one type with no serial (createEquipment
-- writes a blank serial as null) is one tied run, sorted last, and
-- Postgres's sort is not stable. A tie straddling a page boundary could
-- show one item twice and never show the other. Db.listEquipment has
-- ordered by type, serial_number, id for exactly this reason since
-- 20260904135107; the RPC now does the same. Nothing else changes: same
-- signature, same grants (create or replace keeps them).
create or replace function public.search_equipment(
  filter_key text default 'All'::text,
  page_num integer default 0,
  page_size integer default 10,
  search text default ''::text
)
returns table(
  id uuid, type text, serial_number text, calibration_due date,
  status text, assigned_to uuid, assigned_name text, total_count bigint
)
language sql
stable
set search_path to 'public'
as $$
  with esc as (
    select '%' || replace(replace(replace(coalesce(search, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat,
           coalesce(search, '') = '' as blank,
           -- The same day equipment_stats counts by, so the tile and the
           -- filter can never name different equipment.
           (now() at time zone 'America/Edmonton')::date as today
  ),
  filtered as (
    select e.id, e.type, e.serial_number, e.calibration_due, e.status, e.assigned_to, p.name as assigned_name,
      count(*) over () as total_count
    from public.equipment e
    cross join esc
    left join public.profiles p on p.id = e.assigned_to
    where (filter_key = 'All'
       or (filter_key = 'Due soon' and e.calibration_due is not null and e.calibration_due >= esc.today and e.calibration_due <= esc.today + 30)
       or (filter_key = 'Overdue' and e.calibration_due is not null and e.calibration_due < esc.today)
       or e.type = filter_key)
      and (esc.blank
       or e.serial_number ilike esc.pat
       or e.type ilike esc.pat
       or p.name ilike esc.pat)
  )
  select * from filtered
  -- id last, so the order is total: two items of one type with no serial
  -- are a tie, and an OFFSET page boundary inside a tie doubles one and
  -- drops the other.
  order by type, serial_number, id
  offset page_num * page_size
  limit page_size;
$$;
