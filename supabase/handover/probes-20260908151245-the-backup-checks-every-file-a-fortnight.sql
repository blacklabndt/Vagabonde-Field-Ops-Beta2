-- Probes for 20260908151245_the_backup_checks_every_file_a_fortnight.sql.
-- Run as the postgres role; the simulated block rolls back.

-- 1. The two columns exist and the first check is due within a day of the
--    migration: expect every_days 14 and next_at in the future, under 26 h.
select backup_verify_every_days, backup_verify_next_at,
       backup_verify_next_at > now() and backup_verify_next_at < now() + interval '26 hours' as due_soon
  from public.app_settings where id = true;

-- 2. backup_state() carries them for the panel, as an Admin: expect the
--    two keys present and no secret.
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Admin' order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
select (public.backup_state()) ? 'verify_next_at' as has_next,
       (public.backup_state()) ? 'verify_every_days' as has_every,
       (public.backup_state()) ? 'backup_refresh_token' as leaks_secret;   -- t, t, f
rollback;

-- 3. After the first verify run: one row of kind verify, complete, with its
--    counts naming the folder it checked and the three tallies.
select folder_name, status, started_at, finished_at,
       counts -> 'verified' as verified, counts -> 'repaired' as repaired,
       counts -> 'unrepairable' as unrepairable, counts -> 'notes' as notes
  from public.backup_runs where kind = 'verify' order by created_at desc limit 1;
