-- Probes for 20260910023039_the_file_checks_clock_starts_on_its_own.
--
-- Run as a whole in one session; the transaction is rolled back at the end.
-- The live app_settings row holds the drive connection and the mail key, so
-- the probe never touches it: a temp clone made with INCLUDING DEFAULTS
-- carries the same column default, and that is the thing under test.
--
-- Expected (run live 10 Sept 2026, both rows):
--   fresh_row | seeded | due_local        | in_the_future
--   true      | true   | 2026-09-10 01:00 | true      -- a bare insert takes the default
--   false     | true   | 2026-09-10 01:00 | true      -- a row with the null takes the UPDATE
begin;
create temp table probe_settings (like public.app_settings including defaults) on commit drop;
-- A fresh project's row: nothing names the column, the default must.
insert into probe_settings (id) values (true);
-- An existing row that carries the null: the migration's UPDATE must.
insert into probe_settings (id, backup_verify_next_at) values (false, null);
update probe_settings
   set backup_verify_next_at = ((date_trunc('day', now() at time zone 'America/Edmonton') + interval '1 day 1 hour') at time zone 'America/Edmonton')
 where id = false and backup_verify_next_at is null;
select id as fresh_row,
       backup_verify_next_at is not null as seeded,
       to_char(backup_verify_next_at at time zone 'America/Edmonton', 'YYYY-MM-DD HH24:MI') as due_local,
       backup_verify_next_at > now() as in_the_future
  from probe_settings order by id desc;
rollback;
