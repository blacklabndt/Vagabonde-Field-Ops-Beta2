-- NOT RUN. Run the entire file as the database owner AFTER the draft migration.
-- Requires one active Admin and Technician. Creates synthetic records only;
-- every write rolls back. The invoice fixture already has an unused negative
-- invoice number, so mark_tickets_invoiced does NOT consume nextval().
begin;

create temp table gst_probe on commit drop as
select gen_random_uuid() as client_id, gen_random_uuid() as job_id,
       'GST-PROBE-' || gen_random_uuid()::text as tag,
       (select id from public.profiles where role = 'Admin' and deactivated_at is null order by created_at limit 1) as admin_id,
       (select id from public.profiles where role = 'Technician' and deactivated_at is null order by created_at limit 1) as tech_id;
grant select on gst_probe to authenticated, service_role;

do $$
declare f record; number integer;
begin
  select * into f from gst_probe;
  if f.admin_id is null or f.tech_id is null then raise exception 'Need active Admin and Technician fixtures'; end if;
  select n into number from generate_series(-1, -1000, -1) n
    where not exists (select 1 from public.tickets where invoice_number = n) limit 1;
  if number is null then raise exception 'No unused probe invoice number'; end if;
  insert into public.clients(id, name, gst_rate) values (f.client_id, f.tag, 5);
  insert into public.jobs(id, job_number, project, client_id, status, created_by)
    values (f.job_id, f.tag, f.tag, f.client_id, 'Active', f.tech_id);
  insert into public.tickets(id, job_id, technician_id, work_date)
    values (f.tag || '-paid', f.job_id, f.tech_id, current_date),
           (f.tag || '-exempt', f.job_id, f.tech_id, current_date);
  insert into public.tickets(id, job_id, technician_id, work_date, status, approved_at, invoice_number)
    values (f.tag || '-invoice', f.job_id, f.tech_id, current_date, 'Approved', now(), number);
  if has_function_privilege('authenticated', 'public.freeze_ticket_gst(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.freeze_ticket_gst(text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.freeze_ticket_gst(text)', 'EXECUTE') then
    raise exception 'Snapshot RPC grants are wrong';
  end if;
  if has_column_privilege('authenticated', 'public.tickets', 'gst_rate', 'UPDATE') then
    raise exception 'Authenticated can update the snapshot';
  end if;
end $$;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
do $$
declare f record;
begin
  select * into f from gst_probe;
  if public.freeze_ticket_gst(f.tag || '-paid') <> 5 then raise exception 'First paid snapshot is wrong'; end if;
  update public.clients set gst_rate = 0 where id = f.client_id;
  if public.freeze_ticket_gst(f.tag || '-paid') <> 5 then raise exception 'Retry changed paid snapshot'; end if;
  if public.freeze_ticket_gst(f.tag || '-exempt') <> 0 then raise exception 'Exemption not captured'; end if;
  update public.clients set gst_rate = 5 where id = f.client_id;
  if public.freeze_ticket_gst(f.tag || '-exempt') <> 0 then raise exception 'Zero snapshot treated as missing'; end if;
  if (select gst_rate from public.tickets where id = f.tag || '-invoice') is not null then
    raise exception 'Legacy row was backfilled';
  end if;
  if exists (select 1 from public.tickets where id in (f.tag || '-paid', f.tag || '-exempt')
             and (status <> 'Draft' or approval_sent_at is not null or approval_token is not null)) then
    raise exception 'Snapshot marked approval sent';
  end if;
  begin
    update public.tickets set gst_rate = 101 where id = f.tag || '-paid';
    raise exception 'Invalid tax rate accepted';
  exception when check_violation then null;
  end;
  begin
    perform public.freeze_ticket_gst(f.tag || '-invoice');
    raise exception 'Approved ticket accepted by send snapshot';
  exception when invalid_parameter_value then null;
  end;
  raise notice 'PASS: service snapshot, retry, exemption, legacy null, range/status guards';
end $$;
reset role;

select set_config('request.jwt.claims', json_build_object('sub', tech_id, 'role', 'authenticated')::text, true) from gst_probe;
set local role authenticated;
do $$
declare f record;
begin
  select * into f from gst_probe;
  begin
    update public.tickets set gst_rate = 0 where id = f.tag || '-paid';
    raise exception 'Technician directly changed snapshot';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.freeze_ticket_gst(f.tag || '-paid');
    raise exception 'Technician called service RPC';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.tickets(id, job_id, technician_id, work_date, gst_rate)
      values (f.tag || '-forged', f.job_id, f.tech_id, current_date, 0);
    raise exception 'Technician planted snapshot on insert';
  exception when insufficient_privilege then null;
  end;
  -- Same write with null must be allowed: the prior rejection must not be
  -- an unrelated insert authorization failure.
  insert into public.tickets(id, job_id, technician_id, work_date, gst_rate)
    values (f.tag || '-ordinary', f.job_id, f.tech_id, current_date, null);
  raise notice 'PASS: technician update/RPC/insert denied, ordinary insert allowed';
end $$;
reset role;

select set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true) from gst_probe;
set local role authenticated;
do $$
declare f record; r numeric;
begin
  select * into f from gst_probe;
  begin
    update public.tickets set gst_rate = 0 where id = f.tag || '-paid';
    raise exception 'Admin bypassed service snapshot through direct update';
  exception when insufficient_privilege then null;
  end;
  if public.mark_tickets_invoiced(array[f.tag || '-invoice'], true) <> 1 then raise exception 'Invoice fixture not marked'; end if;
  if (select gst_rate from public.tickets where id = f.tag || '-invoice') <> 5 then raise exception 'First invoice did not snapshot'; end if;
  update public.clients set gst_rate = 0 where id = f.client_id;
  perform public.mark_tickets_invoiced(array[f.tag || '-invoice'], false);
  perform public.mark_tickets_invoiced(array[f.tag || '-invoice'], true);
  if (select gst_rate from public.tickets where id = f.tag || '-invoice') <> 5 then raise exception 'Re-invoice changed snapshot'; end if;
  select client_gst_rate into r from public.search_tickets('All', 0, 20, f.tag) where id = f.tag || '-paid';
  if r is distinct from 5::numeric then raise exception 'Tracker/CSV lost paid snapshot'; end if;
  select client_gst_rate into r from public.search_tickets('All', 0, 20, f.tag) where id = f.tag || '-exempt';
  if r is distinct from 0::numeric then raise exception 'Tracker/CSV lost exempt snapshot'; end if;
  select client_gst_rate into r from public.search_tickets('All', 0, 20, f.tag) where id = f.tag || '-ordinary';
  if r is distinct from 0::numeric then raise exception 'Legacy fallback changed'; end if;
  raise notice 'PASS: Admin write denied, first invoice/re-invoice snapshot and tracker/CSV reads';
end $$;
reset role;
rollback;
