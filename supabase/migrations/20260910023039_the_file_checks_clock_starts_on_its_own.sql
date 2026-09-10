-- The file check's clock starts on its own in a fresh project.
--
-- 20260908151245 seeded backup_verify_next_at with an UPDATE of the one
-- app_settings row. A fresh replay of the repo has no row at all — the table
-- ships with none; the panel's first Save or a restore's upsert makes it, and
-- neither names the column (the restore skips every backup_* column on
-- purpose). The tick queues a file check only when the column holds a time,
-- and the panel's line about the check is hidden on the same null, so the
-- rebuilt project — the one whose copies matter most — never checked a file
-- and nothing said so. The column now defaults the way the seed did: 01:00
-- Grande Prairie tomorrow, an hour behind the default backup hour. The
-- UPDATE is for a row that already exists with the null; live carries the
-- seed, so it touches nothing there.
alter table public.app_settings
  alter column backup_verify_next_at
  set default ((date_trunc('day', now() at time zone 'America/Edmonton') + interval '1 day 1 hour') at time zone 'America/Edmonton');

update public.app_settings
   set backup_verify_next_at = ((date_trunc('day', now() at time zone 'America/Edmonton') + interval '1 day 1 hour') at time zone 'America/Edmonton')
 where id = true and backup_verify_next_at is null;
