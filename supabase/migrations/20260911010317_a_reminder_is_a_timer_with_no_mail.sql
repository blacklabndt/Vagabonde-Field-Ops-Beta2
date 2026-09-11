-- A reminder is a timer with no mail: a scheduled_sends row of kind
-- 'reminder' whose label is the text, fired by the same tick as a push to
-- the person's own devices and nothing else. It may name a job (the push
-- lands on the job's page) or none, so job_id becomes nullable; the
-- record_id and to_list a send carries are pinned empty. The insert policy's
-- reminder arm asks that the named job, when there is one, be one the
-- caller can read under jobs_select — the other arms look the record up the
-- same way — and everything the other arms demand (own name, staff, queued,
-- a time not yet past) is demanded of a reminder too.

alter table public.scheduled_sends drop constraint scheduled_sends_kind_check;
alter table public.scheduled_sends
  add constraint scheduled_sends_kind_check check (kind in ('jha', 'report', 'ticket_approval', 'reminder'));

alter table public.scheduled_sends alter column job_id drop not null;

drop policy "scheduled_sends insert" on public.scheduled_sends;
create policy "scheduled_sends insert" on public.scheduled_sends
  for insert to authenticated
  with check (
    set_by = (select auth.uid())
    and (select public.is_staff())
    and status = 'queued' and fired_at is null and error is null
    and run_at > now() - interval '1 minute'
    and (
      (kind = 'jha' and job_id is not null and exists (select 1 from public.jhas j where j.id::text = record_id and j.job_id = scheduled_sends.job_id))
      or (kind = 'report' and job_id is not null and exists (select 1 from public.reports r where r.id::text = record_id and r.job_id = scheduled_sends.job_id))
      or (kind = 'ticket_approval' and job_id is not null and exists (select 1 from public.tickets t where t.id = record_id and t.job_id = scheduled_sends.job_id))
      or (kind = 'reminder' and record_id = '' and to_list = ''
          and (job_id is null or exists (select 1 from public.jobs j where j.id = scheduled_sends.job_id)))
    )
  );
