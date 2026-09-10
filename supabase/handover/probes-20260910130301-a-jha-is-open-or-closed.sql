-- Probes for 20260910130301_a_jha_is_open_or_closed.
--
-- Two probes, each its own transaction, each rolled back. The first is
-- expected to FAIL — the failure is the evidence — so run it on its own and
-- read the error; the second answers with one row.
--
-- Expected (run live 10 Sept 2026):
--   probe 1: ERROR 23514: new row for relation "jhas" violates check
--            constraint "jhas_status_check"   -- nothing written; rolled back
--   probe 2: live_constraint                                          | outside | total | bare_insert | closed_insert
--            CHECK ((status = ANY (ARRAY['Open'::text, 'Closed'::text]))) | 0       | 13    | Open        | Closed

-- Probe 1: a third word is refused on the live table. The transaction is
-- aborted by the refusal and rolled back; the row keeps its status.
begin;
update public.jhas set status = 'Done' where id = (select id from public.jhas order by created_at limit 1);
rollback;

-- Probe 2: the constraint as the catalog holds it, every live row inside the
-- list, and the two writes the app makes still landing — on a temp clone
-- that carries the same CHECK, so no assessment is touched. job_id is the
-- one column a bare insert must name.
begin;
create temp table probe_jhas (like public.jhas including defaults including constraints) on commit drop;
insert into probe_jhas (job_id) values ((select id from public.jobs limit 1));
insert into probe_jhas (job_id, status) values ((select id from public.jobs limit 1), 'Closed');
select
  (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.jhas'::regclass and conname = 'jhas_status_check') as live_constraint,
  (select count(*) from public.jhas where status not in ('Open', 'Closed')) as outside,
  (select count(*) from public.jhas) as total,
  (select status from probe_jhas where status = 'Open' limit 1) as bare_insert,
  (select status from probe_jhas where status = 'Closed' limit 1) as closed_insert;
rollback;
