-- A backup knows the hash of every file it holds.
--
-- The files phase crosses many slices, and the manifest is written by the
-- last of them; the per-file record of what was stored — the entry's name,
-- its bucket and key, its size and the SHA-256 of the bytes read through
-- Supabase the night it was stored — has to live somewhere between those
-- slices that is not the cursor (thousands of entries rewritten after every
-- unit) and not the drive (nothing appends). One row per file per run; the
-- manifest phase folds them into files.json.gz beside manifest.json, which
-- is what the next night's carry-over and a restore read.
--
-- Nobody signed in reads or writes it: the rows are the engine's, and a
-- restore verifying a file against them must not be told a hash a client
-- could have written. Rows go with their run.
create table if not exists public.backup_run_files (
  run_id uuid not null references public.backup_runs (id) on delete cascade,
  name text not null,
  bucket text not null,
  key text not null,
  size bigint not null,
  sha256 text,
  reused boolean not null default false,
  drive_id text,
  primary key (run_id, name)
);

alter table public.backup_run_files enable row level security;
revoke all on public.backup_run_files from authenticated, anon;
grant all on public.backup_run_files to service_role;
