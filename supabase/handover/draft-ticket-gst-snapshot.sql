-- HISTORICAL COPY: applied live and filed on 2026-09-11 as
-- supabase/migrations/20260911204844_a_ticket_remembers_its_gst_rate.sql.
-- Not pending. Do not apply this duplicate; use the filed migration as history.
-- Existing tickets remain null: no historical rate is invented/backfilled.

alter table public.tickets
  add column gst_rate numeric(5,2) check (gst_rate >= 0 and gst_rate <= 100);

comment on column public.tickets.gst_rate is
  'Rate reserved on first approval attempt or first invoicing; retained on retry/withdrawal/un-invoice. Null legacy tickets fall back to the client rate.';

-- The existing UPDATE grant lists editor columns, not this service-owned
-- column. Keep it that way. Restrictive INSERT policy ANDs with the existing
-- insert policy rather than replacing its authorization/approval checks.
revoke update (gst_rate) on public.tickets from anon, authenticated;
create policy tickets_gst_insert_guard on public.tickets
  as restrictive for insert to authenticated with check (gst_rate is null);

-- A row-locked, once-only reservation shared by simultaneous sends. Reserve
-- before making the external mail request; a failed request may have sent
-- mail despite the failure, so retries must not choose a different rate.
-- No approval status/token is written here. Only the service role calls it.
create function public.freeze_ticket_gst(p_ticket_id text)
returns numeric
language plpgsql security definer set search_path to 'public' as $$
declare rate numeric;
begin
  update public.tickets t
     set gst_rate = coalesce(t.gst_rate,
       (select c.gst_rate from public.jobs j join public.clients c on c.id = j.client_id where j.id = t.job_id), 5)
   where t.id = p_ticket_id and t.status in ('Draft', 'Awaiting approval')
   returning t.gst_rate into rate;
  if not found then
    raise exception 'Ticket not found or no longer awaiting approval.' using errcode = '22023';
  end if;
  return rate;
end $$;
revoke all on function public.freeze_ticket_gst(text) from public, anon, authenticated;
grant execute on function public.freeze_ticket_gst(text) to service_role;

-- The existing Admin-only invoice workflow, also reserving a still-null rate.
create or replace function public.mark_tickets_invoiced(p_ids text[], p_invoiced boolean default true)
returns integer
language plpgsql security definer set search_path to 'public' as $$
declare n integer;
begin
  if (select private.user_role()) is distinct from 'Admin' then
    raise exception 'Only an admin can mark a ticket invoiced.' using errcode = '42501';
  end if;
  if p_invoiced then
    update public.tickets as t
       set status = 'Invoiced',
           invoiced_at = now(),
           invoice_number = coalesce(invoice_number, nextval('public.invoice_number_seq')),
           gst_rate = coalesce(t.gst_rate,
             (select c.gst_rate from public.jobs j join public.clients c on c.id = j.client_id where j.id = t.job_id), 5)
     where id = any(p_ids) and status = 'Approved' and approved_at is not null;
  else
    update public.tickets set status = 'Approved', invoiced_at = null
     where id = any(p_ids) and status = 'Invoiced';
  end if;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.mark_tickets_invoiced(text[], boolean) from public, anon;
grant execute on function public.mark_tickets_invoiced(text[], boolean) to authenticated;

-- Tracker/CSV keep the same response shape but prefer the ticket snapshot.
create or replace function public.search_tickets(
  status_filter text default 'All', page_num integer default 0, page_size integer default 10,
  q text default '', date_from date default null, date_to date default null)
returns table(id text, work_date date, status text, total numeric, created_at timestamp with time zone,
              job_number text, project text, client_name text, technician_name text,
              chased_at timestamp with time zone, invoiced_at timestamp with time zone,
              queried_at timestamp with time zone, query_text text, query_by text,
              total_count bigint, filtered_total numeric, client_gst_rate numeric,
              invoice_number integer, client_id uuid)
language sql stable set search_path to 'public' as $$
  with esc as (
    select '%' || replace(replace(replace(coalesce(q, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat,
           coalesce(q, '') = '' as blank,
           (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]) as priced
  ),
  hit as (
    select t.id, t.work_date, t.status,
           case when esc.priced then t.total end as total,
           t.created_at, t.chased_at, t.invoiced_at,
           t.queried_at, t.query_text, t.query_by, t.invoice_number,
           j.job_number, j.project, c.name as client_name, p.name as technician_name,
           coalesce(t.gst_rate, c.gst_rate) as client_gst_rate, j.client_id
      from public.tickets t
      cross join esc
      left join public.jobs j on j.id = t.job_id
      left join public.clients c on c.id = j.client_id
      left join public.profiles p on p.id = t.technician_id
     where (status_filter = 'All'
            or (status_filter = 'Over 7 days' and t.status = 'Awaiting approval' and now() - t.created_at > interval '7 days')
            or t.status = status_filter)
       and (esc.blank
            or t.id ilike esc.pat or j.job_number ilike esc.pat
            or j.project ilike esc.pat or c.name ilike esc.pat or p.name ilike esc.pat)
       and (date_from is null or t.work_date >= date_from)
       and (date_to is null or t.work_date <= date_to)
  )
  select h.id, h.work_date, h.status, h.total, h.created_at, h.job_number, h.project, h.client_name,
         h.technician_name, h.chased_at, h.invoiced_at, h.queried_at, h.query_text, h.query_by,
         count(*) over () as total_count,
         -- null for roles that don't see prices: every h.total is null for them.
         sum(h.total) over () as filtered_total,
         -- Not money. A ticket whose job has no client has no rate, and the
         -- app reads that absence as the ordinary 5%.
         h.client_gst_rate,
         h.invoice_number,
         h.client_id
    from hit h
   order by h.created_at desc, h.id desc
  offset page_num * page_size limit page_size;
$$;
revoke execute on function public.search_tickets(text, integer, integer, text, date, date) from public, anon;
grant execute on function public.search_tickets(text, integer, integer, text, date, date) to authenticated;
