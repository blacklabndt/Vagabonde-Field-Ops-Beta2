-- Probes for 20260908141656_a_backup_knows_the_hash_of_every_file.sql.
-- Run as the postgres role; the simulated block rolls back.

-- 1. The table exists with its primary key on (run_id, name): expect t.
select exists (
  select 1 from pg_constraint
   where conrelid = 'public.backup_run_files'::regclass and contype = 'p'
     and conkey = array[
       (select attnum from pg_attribute where attrelid = 'public.backup_run_files'::regclass and attname = 'run_id'),
       (select attnum from pg_attribute where attrelid = 'public.backup_run_files'::regclass and attname = 'name')]
) as pk_is_run_and_name;

-- 2. A signed-in Admin reads nothing from it (RLS on, no policy, no grant):
--    expect a permission refusal, not rows.
begin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'Admin' order by id limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
select count(*) from public.backup_run_files;   -- permission denied for table backup_run_files
rollback;

-- 3. Rows go with their run: expect the FK to cascade.
select confdeltype = 'c' as cascades from pg_constraint
 where conrelid = 'public.backup_run_files'::regclass and contype = 'f';

-- 4. After tonight's backup: one row per file the manifest counts, every
--    row hashed, and the spot check answered. Run after the first run on
--    this code completes.
select r.folder_name, r.counts -> 'files' as files, r.counts -> 'spot' as spot,
       count(f.*) as rows_recorded, count(f.sha256) as hashed
  from public.backup_runs r left join public.backup_run_files f on f.run_id = r.id
 where r.kind = 'backup' and r.status = 'complete'
 group by r.id order by r.started_at desc limit 1;

-- Run live 8 Sept 2026, after the first two runs on this code:
--   1: t.  2: permission denied for table backup_run_files.  3: t.
--   4, first run (no base index): 25 files, reused 0, spot "nothing carried
--      over to check", 25 rows, 25 hashed.
--   4, second run: 25 files, reused 7 (every one with a hash), spot
--      "ok: reports%2FBT5-9005%2F1787256136677-report.pdf", 25 rows, 25 hashed.
