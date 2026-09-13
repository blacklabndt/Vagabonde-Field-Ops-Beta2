-- APPLIED 12 Sept 2026. Phase 1: prepare the masked read relation and the RPCs.
-- Until phase 2 the original direct total disclosure remains open. Phase 1
-- closes nothing; never say that it has.
--
-- The order is not a preference. Each step is what makes the next one safe:
--
--   1. Apply this file. Nothing is taken away, so nothing can break.
--   2. Deploy the app and Ask. render-invoice is no longer part of this --
--      the invoice read names no money column and stays on the base table.
--   3. Put the new build on a tablet and open it. The app is a PWA: an
--      installed copy serves itself from its own service worker, and the
--      office cannot refresh it for the crew. Between phase 1 and phase 2
--      an old build keeps working, so the gap may be as wide as it needs
--      to be -- but the moment phase 2 lands, any device still on the old
--      build reads no ticket at all. Confirm the new build is what a real
--      tablet loads before going on, not merely what CI deployed.
--   4. Run probes-ticket-money-select-api.mjs against the deployed API, as
--      a price role and as a Helper. It is the only thing that answers the
--      one question the isolated harness cannot: whether PostgREST still
--      resolves the REVERSE ticket_lines embed through a view. Two reads
--      depend on it -- reopening a draft (getTicket) and the archive's
--      Job details.txt. If it refuses, stop: read the lines in a second
--      request instead, and do not apply phase 2 until it answers 200.
--   5. Only then apply ticket-money-select-enforce.sql, and run the API
--      probe again -- it reports which phase it found and asserts the
--      refusals once enforcement is on.
begin;

-- Owner rights are intentional: authenticated will lose base total SELECT.
-- Therefore enforce the current tickets SELECT predicate explicitly here.
-- Any future row-scope change must update this predicate as well as base RLS.
--
-- Three columns of the base table are deliberately absent from this list and
-- from the phase 2 grant: approval_token, approval_expires_at and approved_ip.
-- No read on caller authority names any of them anywhere in the app, Ask or
-- the Edge Functions -- approve-ticket filters on the token hash and
-- mailApproval writes it, both with the service role, which this never
-- touches. The token is a stored credential and the IP is a client rep's;
-- a list being written from scratch is the moment to leave them out.
create or replace view public.tickets_read
with (security_barrier = true, security_invoker = false) as
select t.id, t.job_id, t.technician_id, t.work_date, t.status,
       t.client_contact, t.contractor_contact,
       case when (select private.user_role()) = any (array['Admin'::text, 'Technician'::text])
            then t.total else null::numeric end as total,
       t.approved_at, t.approved_by_email, t.invoiced_at,
       t.created_at, t.approval_sent_at,
       t.delays, t.approved_signature, t.approval_sent_to, t.approval_sent_by,
       t.client_key, t.chased_at, t.queried_at, t.query_text, t.query_by,
       t.invoice_number, t.gst_rate
  from public.tickets t
 where (select public.is_staff());

-- Default privileges can grant writes to views, including auto-updatable
-- metadata columns. This relation is a read door only.
revoke all on public.tickets_read from public, anon, authenticated;
grant select on public.tickets_read to authenticated;
comment on view public.tickets_read is
  'Staff ticket metadata; total is null except for Admin and Technician. Read only. Explicit staff predicate mirrors tickets SELECT RLS.';

-- The three existing SECURITY INVOKER reporting routines follow below.
-- Their contracts and joins stay unchanged; only the ticket source changes.
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
      from public.tickets_read t
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

create or replace function public.ticket_tracker_stats()
returns table(unsigned_count bigint, unsigned_total numeric, over7_count bigint, over7_total numeric,
              approved_count bigint, approved_total numeric, invoiced_count bigint, invoiced_total numeric)
language sql stable set search_path to 'public' as $$
  -- One row always, even with no tickets: the flag is a scalar subquery,
  -- not a join, so the aggregate keeps its no-GROUP-BY single row.
  with priced as (
    select (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]) as ok
  )
  select
    count(*) filter (where status = 'Awaiting approval'),
    case when (select ok from priced) then coalesce(sum(total) filter (where status = 'Awaiting approval'), 0) end,
    count(*) filter (where status = 'Awaiting approval' and now() - created_at > interval '7 days'),
    case when (select ok from priced) then coalesce(sum(total) filter (where status = 'Awaiting approval' and now() - created_at > interval '7 days'), 0) end,
    count(*) filter (where status = 'Approved'),
    case when (select ok from priced) then coalesce(sum(total) filter (where status = 'Approved'), 0) end,
    count(*) filter (where status = 'Invoiced'),
    case when (select ok from priced) then coalesce(sum(total) filter (where status = 'Invoiced'), 0) end
  from public.tickets_read;
$$;


create or replace function public.ticket_aging()
returns table(client_id uuid, client_name text, bucket text, tickets bigint, total numeric)
language sql
stable
security invoker
set search_path to 'public'
as $$
  -- Every column is aliased and the outer select list is positional, the way
  -- dose_totals is: the RETURNS TABLE names are parameters inside a sql
  -- body, and a bare `client_id`, `client_name` or `total` here would be
  -- ambiguous against the tables this reads.
  with priced as (
    select (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]) as ok
  ),
  today as (
    select (now() at time zone 'America/Edmonton')::date as d
  ),
  aged as (
    select j.client_id      as cid,
           c.name           as cname,
           (x.d - t.work_date) as age_days,
           t.total          as amount
      from public.tickets_read t
      cross join today x
      left join public.jobs j    on j.id = t.job_id
      left join public.clients c on c.id = j.client_id
     -- Sent to the client and not yet through. Draft is not outstanding.
     where t.status = any (array['Awaiting approval'::text, 'Approved'::text, 'Invoiced'::text])
  ),
  bucketed as (
    select a.cid, a.cname, a.amount,
           -- Cast, so the bucket is text and not `unknown` waiting to be
           -- resolved by whatever reads it next.
           (case when a.age_days < 30 then 'current'
                 when a.age_days < 60 then '30'
                 when a.age_days < 90 then '60'
                 else '90'
            end)::text as bkt
      from aged a
  )
  select b.cid, b.cname, b.bkt,
         count(*),
         -- null, not 0, for a role that may not see prices — the whole
         -- column, so nothing downstream has to guess which zeros are real.
         case when (select ok from priced) then coalesce(sum(b.amount), 0) end
    from bucketed b
   group by b.cid, b.cname, b.bkt;
$$;


revoke execute on function public.ticket_tracker_stats() from public, anon;
grant execute on function public.ticket_tracker_stats() to authenticated;
revoke execute on function public.ticket_aging() from public, anon;
grant execute on function public.ticket_aging() to authenticated;

notify pgrst, 'reload schema';
commit;

