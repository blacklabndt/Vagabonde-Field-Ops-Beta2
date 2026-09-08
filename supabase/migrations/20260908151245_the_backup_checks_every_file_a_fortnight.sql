-- The backup checks every file once a fortnight.
--
-- The nightly spot check hashes one carried-over file. A `verify` run —
-- queued by the tick when backup_verify_next_at falls due, after the
-- backups it queues, and worked in the same slices — downloads every file
-- in the newest complete backup folder, hashes it against files.json.gz,
-- and re-stores from Supabase whatever does not match. The due time moves
-- when a verify STARTS, the backups' own rule, every
-- backup_verify_every_days days. First due tonight at 01:00 Grande Prairie,
-- an hour behind the scheduled backup.
alter table public.app_settings
  add column if not exists backup_verify_every_days integer not null default 14,
  add column if not exists backup_verify_next_at timestamptz;

update public.app_settings
   set backup_verify_next_at = ((date_trunc('day', now() at time zone 'America/Edmonton') + interval '1 day 1 hour') at time zone 'America/Edmonton')
 where id = true and backup_verify_next_at is null;

-- backup_state() carries the two, so the panel can say when the next full
-- check is. Same body otherwise.
create or replace function public.backup_state()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s public.app_settings;
  last_run jsonb;
  active jsonb;
begin
  if (select private.user_role()) is distinct from 'Admin' then
    raise exception 'The backup settings are an Admin''s.';
  end if;

  select * into s from public.app_settings limit 1;

  select to_jsonb(r) into last_run from (
    select id, kind, status, phase, counts, error, folder_name, started_at, finished_at
      from public.backup_runs
     where status in ('complete', 'failed')
     order by coalesce(finished_at, created_at) desc
     limit 1
  ) r;

  select to_jsonb(r) into active from (
    select id, kind, status, phase, counts, folder_name, created_at, started_at, heartbeat_at
      from public.backup_runs
     where status in ('queued', 'running')
     order by created_at
     limit 1
  ) r;

  return jsonb_build_object(
    'provider', s.backup_provider,
    'account', s.backup_account,
    'connected', (s.backup_refresh_token is not null),
    'connection_error', s.backup_connection_error,
    'root_folder_id', s.backup_root_folder_id,
    'frequency', coalesce(s.backup_frequency, 'daily'),
    'weekday', coalesce(s.backup_weekday, 0),
    'hour', coalesce(s.backup_hour, 2),
    'keep', coalesce(s.backup_keep, 14),
    'next_run_at', s.backup_next_run_at,
    'verify_every_days', coalesce(s.backup_verify_every_days, 14),
    'verify_next_at', s.backup_verify_next_at,
    'client_id_google', s.backup_client_id_google,
    'client_id_microsoft', s.backup_client_id_microsoft,
    'client_id_dropbox', s.backup_client_id_dropbox,
    'has_secret_google', (s.backup_client_secret_google is not null),
    'has_secret_microsoft', (s.backup_client_secret_microsoft is not null),
    'has_secret_dropbox', (s.backup_client_secret_dropbox is not null),
    'approval_base_url', s.approval_base_url,
    'last_run', last_run,
    'active_run', active
  );
end;
$$;
