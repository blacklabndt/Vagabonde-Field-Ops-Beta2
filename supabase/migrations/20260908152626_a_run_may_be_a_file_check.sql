-- A run may be a file check.
--
-- backup_runs.kind is checked against a list, and 20260908151245 taught
-- the tick to queue a fifth kind without teaching the table: the first
-- verify moved the clock and then met "violates check constraint
-- backup_runs_kind_check", so no run row was made. The list now holds it.
alter table public.backup_runs drop constraint if exists backup_runs_kind_check;
alter table public.backup_runs add constraint backup_runs_kind_check
  check (kind = any (array['backup'::text, 'restore_all'::text, 'restore_jobs'::text, 'before_restore'::text, 'verify'::text]));
