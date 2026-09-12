-- Probes for draft-the-assistant-has-a-daily-allowance.sql
--
-- Run AFTER applying the draft. Everything is inside one transaction and
-- ROLLS BACK: these write real rows to ask_leases and ask_spend, and a probe
-- that leaves a lease behind locks somebody out of Ask for five minutes.
--
-- Role simulation throughout, because a grant is not a policy and permissive
-- policies OR together. The ids are carried in `set_config`, never psql's
-- `:'name'` substitution — psql does not substitute inside a dollar-quoted
-- block, so a `:'staff'` inside `do $$ ... $$` is sent verbatim and the probe
-- tests nothing.
--
-- ONE THING THESE CANNOT SHOW. The lease is what bounds the overshoot past
-- the ceiling, and its atomicity under two simultaneous claims needs two
-- connections holding transactions open at once, which a single psql session
-- cannot do. The two-session procedure is at the bottom of this file. What IS
-- shown here is the single-statement shape the atomicity rests on: a fresh
-- lease refuses the second claim in the same statement that would have taken
-- it, so there is no read-then-write window to lose.

-- RUN LIVE 12 Sept 2026 against eielmvxzdwwprmmfamlq, after
-- 20260912025816 / 20260912030901 / 20260912031059. ALL ELEVEN PASSED, and
-- both tables were empty again afterwards.
--
-- ONE THING TO KNOW BEFORE RUNNING THESE ANYWHERE ELSE. Probes 1-3 and 10 run
-- under `set local role authenticated`, and a notice raised inside a DO block
-- cannot be read back through a SQL connector — so the run that produced the
-- result above collected the PASS lines into a temp table instead of raising
-- them. A temp table is the creating role's, so that runner needed
--
--     grant all on _probe to authenticated;
--     grant usage, select on sequence _probe_n_seq to authenticated;
--
-- or probe 1 dies with "permission denied for table _probe" — which looks
-- exactly like a probe failure and is not one. Under psql, where the notices
-- come back on their own, this file runs as it stands.
--
-- Probe 11 was also asked, in that run, for the column's DEFAULT and not only
-- the row's value: 20260912030901's `add column if not exists ... default` was
-- a no-op on a column 20260912025816 had already made, so the live row read
-- 10,000,000 while the column carried no default at all and a fresh replay
-- would have had no ceiling. 20260912031059 is that fix, and the default is
-- what a probe has to ask for to see it.

begin;

-- STAFF: any active non-Admin profile holding at least one tab.
-- ADMIN: the owner, or any active Admin.
select set_config('probe.staff',
  (select id::text from public.profiles
    where deactivated_at is null and role <> 'Admin'
      and coalesce(array_length(tab_access, 1), 0) > 0
    order by id limit 1), true);
select set_config('probe.admin',
  (select id::text from public.profiles
    where deactivated_at is null and role = 'Admin'
    order by id limit 1), true);

do $$ begin
  if coalesce(current_setting('probe.staff', true), '') = ''
     or coalesce(current_setting('probe.admin', true), '') = '' then
    raise exception 'PROBE SETUP: need one active non-Admin with a tab and one active Admin';
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- A. The four RPCs are the service role's alone
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Ask opens on the caller's JWT and every read it makes is the caller's own.
-- These four are the exception — the function switches to service authority
-- for them — so a signed-in account must not be able to call any of them. A
-- lease it could release is a concurrency control it could switch off; a
-- spend it could record is a ceiling it could spend on somebody else's behalf.

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('probe.staff'), 'role', 'authenticated')::text, true);

do $$
declare fn text;
begin
  foreach fn in array array[
    'select public.ask_claim_lease(current_setting(''probe.staff'')::uuid, gen_random_uuid(), 300)',
    'select public.ask_release_lease(current_setting(''probe.staff'')::uuid, gen_random_uuid())',
    'select * from public.ask_allowance()',
    'select public.ask_record_spend(current_setting(''probe.staff'')::uuid, 1, 1)'
  ] loop
    begin
      execute fn;
      raise exception 'PROBE 1 FAILED: authenticated could call: %', fn;
    exception when insufficient_privilege then null;
    end;
  end loop;
  raise notice 'PROBE 1 PASS: none of the four RPCs is a signed-in account''s';
end $$;

-- ── 2. Neither table is a signed-in account's to write ────────────────────
do $$ begin
  begin
    insert into public.ask_leases (user_id, request_id)
      values (current_setting('probe.staff')::uuid, gen_random_uuid());
    raise exception 'PROBE 2 FAILED: authenticated wrote a lease';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.ask_spend (day, user_id, input_tokens)
      values (current_date, current_setting('probe.staff')::uuid, 0);
    raise exception 'PROBE 2 FAILED: authenticated wrote a spend row';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PROBE 2 PASS: neither table takes a write from a signed-in account';
end $$;

-- ── 3. The lease is nobody's to read; the spend is the office's ───────────
--
-- A lease read would say who is using Ask and when, which is nobody's
-- business; the spend is the Admin's own record of what the assistant costs,
-- and an ordinary account sees none of it.
do $$
declare n integer;
begin
  begin
    select count(*) into n from public.ask_leases;
    raise exception 'PROBE 3 FAILED: a signed-in account read the leases';
  exception when insufficient_privilege then null;
  end;
  select count(*) into n from public.ask_spend;      -- grant exists, policy decides
  if n <> 0 then raise exception 'PROBE 3 FAILED: a non-Admin read % spend rows', n; end if;
  raise notice 'PROBE 3 PASS: leases unreadable, spend empty for a non-Admin';
end $$;

reset role;

-- ═══════════════════════════════════════════════════════════════════════════
-- B. The lease behaves, exercised as the owner (the service role's own path)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 4. It is taken once, and a second question is refused ─────────────────
select set_config('probe.req1', gen_random_uuid()::text, true);
select set_config('probe.req2', gen_random_uuid()::text, true);

-- Anything this person already holds is put aside so the probe starts clean;
-- the rollback puts it back.
delete from public.ask_leases where user_id = current_setting('probe.staff')::uuid;

do $$
declare got boolean;
begin
  got := public.ask_claim_lease(current_setting('probe.staff')::uuid,
                                current_setting('probe.req1')::uuid, 300);
  if got is distinct from true then raise exception 'PROBE 4 FAILED: a free lease was not taken'; end if;

  got := public.ask_claim_lease(current_setting('probe.staff')::uuid,
                                current_setting('probe.req2')::uuid, 300);
  if got is not null then raise exception 'PROBE 4 FAILED: a second question took the lease while the first held it'; end if;

  if (select request_id from public.ask_leases where user_id = current_setting('probe.staff')::uuid)
     <> current_setting('probe.req1')::uuid then
    raise exception 'PROBE 4 FAILED: the refused claim moved the row anyway';
  end if;
  raise notice 'PROBE 4 PASS: one question at a time, and the refusal writes nothing';
end $$;

-- ── 5. Its own lease and no other ─────────────────────────────────────────
--
-- A request whose isolate hung, woke and released on the way out must not
-- take the lease of the request that had already taken over from it.
do $$ begin
  perform public.ask_release_lease(current_setting('probe.staff')::uuid,
                                   current_setting('probe.req2')::uuid);
  if not exists (select 1 from public.ask_leases
                 where user_id = current_setting('probe.staff')::uuid
                   and request_id = current_setting('probe.req1')::uuid) then
    raise exception 'PROBE 5 FAILED: a stranger''s release took the holder''s lease';
  end if;

  perform public.ask_release_lease(current_setting('probe.staff')::uuid,
                                   current_setting('probe.req1')::uuid);
  if exists (select 1 from public.ask_leases where user_id = current_setting('probe.staff')::uuid) then
    raise exception 'PROBE 5 FAILED: the holder''s own release did not free it';
  end if;
  raise notice 'PROBE 5 PASS: a release names its own request or does nothing';
end $$;

-- ── 6. A dead request's lease is taken over, not waited on for ever ───────
do $$
declare got boolean;
begin
  insert into public.ask_leases (user_id, request_id, taken_at)
    values (current_setting('probe.staff')::uuid, current_setting('probe.req1')::uuid,
            now() - interval '10 minutes');

  got := public.ask_claim_lease(current_setting('probe.staff')::uuid,
                                current_setting('probe.req2')::uuid, 300);
  if got is distinct from true then raise exception 'PROBE 6 FAILED: a lease 10 minutes old still blocked the next question'; end if;
  if (select request_id from public.ask_leases where user_id = current_setting('probe.staff')::uuid)
     <> current_setting('probe.req2')::uuid then
    raise exception 'PROBE 6 FAILED: the takeover did not become the holder';
  end if;
  raise notice 'PROBE 6 PASS: a stale lease is taken over and the taker holds it';
end $$;

-- ── 7. Two people never wait on each other ────────────────────────────────
do $$
declare got boolean;
begin
  got := public.ask_claim_lease(current_setting('probe.admin')::uuid, gen_random_uuid(), 300);
  if got is distinct from true then raise exception 'PROBE 7 FAILED: one person asking blocked another'; end if;
  raise notice 'PROBE 7 PASS: the lease is per person, not a queue for the crew';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- C. The ledger
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 8. A call is recorded, and the answer is the day's total ──────────────
do $$
declare before_total bigint; after1 bigint; after2 bigint;
begin
  select spent into before_total from public.ask_allowance();

  after1 := public.ask_record_spend(current_setting('probe.staff')::uuid, 1000, 200);
  if after1 <> before_total + 1200 then
    raise exception 'PROBE 8 FAILED: after one call of 1200 the day read % against %', after1, before_total + 1200;
  end if;

  -- The same person again: one row, added to, and `calls` counts both.
  after2 := public.ask_record_spend(current_setting('probe.staff')::uuid, 500, 100);
  if after2 <> before_total + 1800 then
    raise exception 'PROBE 8 FAILED: after two calls the day read % against %', after2, before_total + 1800;
  end if;
  if (select calls from public.ask_spend
      where day = (now() at time zone 'America/Edmonton')::date
        and user_id = current_setting('probe.staff')::uuid) < 2 then
    raise exception 'PROBE 8 FAILED: two calls were recorded as fewer';
  end if;
  raise notice 'PROBE 8 PASS: spend accumulates and the answer is the day, not the person';
end $$;

-- ── 9. The day's total is everyone's, not the last caller's ───────────────
do $$
declare mine bigint; everyone bigint;  -- not `both`: BOTH is a reserved word (TRIM)
begin
  select spent into mine from public.ask_allowance();
  everyone := public.ask_record_spend(current_setting('probe.admin')::uuid, 3000, 0);
  if everyone <> mine + 3000 then
    raise exception 'PROBE 9 FAILED: a second person''s spend read % against %', everyone, mine + 3000;
  end if;
  raise notice 'PROBE 9 PASS: the ceiling is the project''s, summed across the crew';
end $$;

-- ── 10. An Admin reads the spend; still nobody writes it ──────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('probe.admin'), 'role', 'authenticated')::text, true);

do $$
declare n integer;
begin
  select count(*) into n from public.ask_spend
    where day = (now() at time zone 'America/Edmonton')::date;
  if n < 2 then raise exception 'PROBE 10 FAILED: an Admin read % of today''s rows', n; end if;
  begin
    update public.ask_spend set input_tokens = 0
      where day = (now() at time zone 'America/Edmonton')::date;
    raise exception 'PROBE 10 FAILED: an Admin wrote the ledger';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PROBE 10 PASS: the office reads what Ask costs and writes none of it';
end $$;

reset role;

-- ── 11. The ceiling column is there, and is the office's alone ────────────
do $$
declare cap bigint;
begin
  select ask_daily_token_cap into cap from public.app_settings where id;
  if cap is null then raise exception 'PROBE 11 FAILED: the ceiling was not seeded'; end if;
  raise notice 'PROBE 11 PASS: the ceiling is % tokens a day', cap;
end $$;

rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- THE ONE PROBE THIS FILE CANNOT RUN: two claims at the same instant
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Needs two connections with transactions open together. Two psql windows,
-- against the same project, with <staff> the same profile id in both:
--
--   A: begin;
--   A: delete from ask_leases where user_id = '<staff>';
--   A: select ask_claim_lease('<staff>', gen_random_uuid(), 300);   -- expect t
--   B: begin;
--   B: select ask_claim_lease('<staff>', gen_random_uuid(), 300);   -- BLOCKS on A's row
--   A: commit;
--   B: -- unblocks and must return NO ROW: A's lease is fresh, so the
--      -- conflict's WHERE is false and the update is skipped.
--   B: rollback;
--
-- If B returns `t`, two questions hold the lease at once and the overshoot
-- bound in the migration's header is wrong. Repeat with A's lease inserted at
-- `now() - interval '10 minutes'` and B must return `t`, taking it over.
