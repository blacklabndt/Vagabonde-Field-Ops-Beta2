-- A send can wait for its time.
--
-- Applied live 10 Sept 2026 as 20260910213858, after scheduled-sends was
-- deployed. Probes beside it under supabase/handover/.
--
-- Ask's fourth slice (spec: docs/superpowers/specs/2026-09-10-ask-timers-design.md):
-- a JHA, a report or a ticket approval can be scheduled for a time and
-- goes out whether or not the app is open. The queue is this table; the
-- clock is the cron job at the bottom, which calls the scheduled-sends
-- function every five minutes with x-internal-secret, admin-digest's shape.
--
-- Nobody is signed in when a scheduled send fires, so its authority is two
-- halves. The first is here: the row is inserted through RLS as the
-- person, and the insert policy looks the record up under the caller's OWN
-- read policies (the subqueries run as the caller), so a record they
-- cannot see cannot be scheduled, nor a row in anybody else's name, nor
-- one already marked sent. The second half is the function's: at fire
-- time it re-applies the send function's own gate against the person's
-- current profile and the record's current state.
--
-- Signed-in accounts may change one thing afterwards — a queued or failed
-- row of their own (the office, anyone's) to cancelled: the column grant
-- lets them write `status` alone, and the policy's WITH CHECK pins the
-- word. Everything else is the service role's. No delete: a cancelled or
-- failed row is the record of what was asked for.
--
-- DEPLOY THE FUNCTION FIRST. A job scheduled against a function that is not
-- there yet gets a 404 every five minutes until it is deployed. The URL and
-- the publishable key are baked in, which makes this the seventh migration
-- to re-point when the repo is replayed into a fresh project — CLAUDE.md's
-- fresh-environment warning and HANDOVER.md Path B.

create table public.scheduled_sends (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('jha', 'report', 'ticket_approval')),
  -- The JHA or report uuid, or the ticket number: text, because a ticket's id is its number.
  record_id text not null,
  job_id uuid not null references public.jobs(id) on delete cascade,
  -- What Job detail's strip and the card call it: "JHA RT-Shop.pdf (2026-09-08)".
  label text not null,
  -- Comma-separated addresses, mail.ts's recipients() shape; checked again at fire time.
  to_list text not null,
  message text not null default '',
  run_at timestamptz not null,
  set_by uuid not null references public.profiles(id),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'cancelled')),
  created_at timestamptz not null default now(),
  fired_at timestamptz,
  error text
);
create index scheduled_sends_due on public.scheduled_sends (run_at) where status in ('queued', 'sending');
create index scheduled_sends_job on public.scheduled_sends (job_id);

alter table public.scheduled_sends enable row level security;

create policy "scheduled_sends select" on public.scheduled_sends
  for select to authenticated
  using (set_by = (select auth.uid())
         or coalesce((select private.user_role()), '') in ('Admin', 'Coordinator'));

create policy "scheduled_sends insert" on public.scheduled_sends
  for insert to authenticated
  with check (
    set_by = (select auth.uid())
    and (select public.is_staff())
    and status = 'queued' and fired_at is null and error is null
    and run_at > now() - interval '1 minute'
    and (
      (kind = 'jha' and exists (select 1 from public.jhas j where j.id::text = record_id and j.job_id = scheduled_sends.job_id))
      or (kind = 'report' and exists (select 1 from public.reports r where r.id::text = record_id and r.job_id = scheduled_sends.job_id))
      or (kind = 'ticket_approval' and exists (select 1 from public.tickets t where t.id = record_id and t.job_id = scheduled_sends.job_id))
    )
  );

create policy "scheduled_sends cancel" on public.scheduled_sends
  for update to authenticated
  using ((set_by = (select auth.uid())
          or coalesce((select private.user_role()), '') in ('Admin', 'Coordinator'))
         and status in ('queued', 'failed'))
  with check (status = 'cancelled');

grant select, insert on public.scheduled_sends to authenticated;
grant update (status) on public.scheduled_sends to authenticated;
revoke delete on public.scheduled_sends from authenticated, anon;
grant all on public.scheduled_sends to service_role;

-- The clock. Every five minutes; the function answers in a second when
-- nothing is due.
select cron.schedule(
  'scheduled-sends-tick',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://eielmvxzdwwprmmfamlq.supabase.co/functions/v1/scheduled-sends',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_iRMrq2AOLFWQvx4UxiCjmw_B_kSw1zg',
      'x-internal-secret', (select value from private.internal_config where key = 'edge_shared_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
