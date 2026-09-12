-- Probes for draft-the-ceiling-is-charged-before-the-call.sql
--
-- NOT YET RUN. The draft beside this file is not applied: the session that
-- wrote both had no psql, no Supabase CLI login and no database tool at all.
-- Run these AFTER applying the draft, and do not move the draft into
-- supabase/migrations/ until they have passed.
--
-- Everything up to the two-session section is inside one transaction and
-- ROLLS BACK: these write real rows to ask_calls and ask_spend, and a
-- reservation left behind holds a million tokens of somebody's day.
--
-- Role simulation throughout, because a grant is not a policy and permissive
-- policies OR together. Ids travel in `set_config`, never psql's `:'name'`
-- substitution — psql does not substitute inside a dollar-quoted block, so a
-- `:'staff'` inside `do $$ ... $$` is sent verbatim and the probe tests
-- nothing. Same caveat as the allowance probes about notices raised inside a
-- DO block: under a SQL connector rather than psql, collect the PASS lines
-- into a temp table and grant that table to `authenticated` first.
--
-- WHAT THE SINGLE-SESSION PROBES CANNOT SHOW, AND IT IS THE MAIN CLAIM.
-- The whole ceiling rests on two concurrent reservations not both passing,
-- and that needs two connections holding transactions open at once. The
-- procedure is at the foot of this file. It is the THIRD such outstanding
-- procedure in this repo (ask_learned's 40-note cap and the lease are the
-- others) and it is the one that matters most: without it, the advisory lock
-- is asserted and not verified, and an unverified lock is exactly the shape
-- the defect took the first time — a read-then-write window nobody looked at.

begin;

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
    raise exception 'no staff or admin profile to probe with';
  end if;
end $$;

-- The cap these probes work against. The live row's own number is put back by
-- the rollback; inside the transaction it is a figure small enough to reason
-- about (three reservations of 1,000 fit, the fourth does not).
update public.app_settings set ask_daily_token_cap = 3000 where id;

-- ── 1. nobody signed in may reserve, settle or read the day ───────────────
-- All four functions are the service role's alone. A signed-in account that
-- could call ask_reserve_call could fill its own day's ceiling and lock the
-- crew out of Ask; one that could call ask_settle_call could write a
-- reservation down to nought and spend for ever.
do $$
declare denied int := 0;
begin
  set local role authenticated;
  begin perform public.ask_reserve_call(current_setting('probe.staff')::uuid, gen_random_uuid(), 'claude-opus-5', 10);
  exception when insufficient_privilege then denied := denied + 1; end;
  begin perform public.ask_settle_call(gen_random_uuid(), 1, 1);
  exception when insufficient_privilege then denied := denied + 1; end;
  begin perform public.ask_settle_unbilled(gen_random_uuid());
  exception when insufficient_privilege then denied := denied + 1; end;
  begin perform public.ask_allowance();
  exception when insufficient_privilege then denied := denied + 1; end;
  reset role;
  if denied <> 4 then raise exception 'PROBE 1 FAILED: % of 4 doors refused authenticated', denied; end if;
  raise notice 'PROBE 1 ok: all four functions refuse a signed-in account';
end $$;

-- ── 2. and the table itself is unreadable to a signed-in account ──────────
-- RLS is on with no policy, and the grants are revoked: two answers to the
-- same question, because a policy added later by mistake must still meet a
-- missing grant.
do $$
declare n int;
begin
  set local role authenticated;
  begin
    select count(*) into n from public.ask_calls;
    reset role;
    raise exception 'PROBE 2 FAILED: authenticated read % rows of ask_calls', n;
  exception when insufficient_privilege then
    reset role;
    raise notice 'PROBE 2 ok: ask_calls is unreadable to a signed-in account';
  end;
end $$;

-- ── 3. a reservation counts before its call is ever settled ───────────────
-- THE WHOLE MECHANISM. sum(coalesce(settled, reserved)) means a row written
-- and never settled holds its reserved figure against the day, which is what
-- makes a crashed call cost the ceiling instead of vanishing from it.
do $$
declare a uuid := gen_random_uuid(); s bigint; r bigint;
begin
  if public.ask_reserve_call(current_setting('probe.staff')::uuid, a, 'claude-opus-5', 1000) is not true then
    raise exception 'PROBE 3 FAILED: the first reservation was refused under a 3000 cap';
  end if;
  select settled_tokens, reserved_tokens into s, r from public.ask_allowance();
  if coalesce(s, 0) <> 0 or r <> 1000 then
    raise exception 'PROBE 3 FAILED: settled % reserved % — an unsettled reservation must count at its reserved figure', s, r;
  end if;
  raise notice 'PROBE 3 ok: an unsettled reservation holds 1000 against the day';
end $$;

-- ── 4. the ceiling refuses the reservation that would cross it ────────────
do $$
declare b uuid := gen_random_uuid(); c uuid := gen_random_uuid(); d uuid := gen_random_uuid();
begin
  if public.ask_reserve_call(current_setting('probe.staff')::uuid, b, 'claude-opus-5', 1000) is not true then
    raise exception 'PROBE 4 FAILED: the second of three reservations was refused';
  end if;
  if public.ask_reserve_call(current_setting('probe.staff')::uuid, c, 'claude-opus-5', 1000) is not true then
    raise exception 'PROBE 4 FAILED: the third reservation, exactly at the cap, was refused';
  end if;
  if public.ask_reserve_call(current_setting('probe.staff')::uuid, d, 'claude-opus-5', 1) is not false then
    raise exception 'PROBE 4 FAILED: a reservation past the cap was admitted';
  end if;
  -- And the refused one wrote NO row: a refusal that still inserted would
  -- make the day unspendable one refusal at a time.
  if exists (select 1 from public.ask_calls where call_id = d) then
    raise exception 'PROBE 4 FAILED: a refused reservation left a row behind';
  end if;
  raise notice 'PROBE 4 ok: exactly at the cap is admitted, one token past it is refused, and the refusal writes nothing';
end $$;

-- ── 5. settlement replaces the reservation and is idempotent ──────────────
-- ask_record_spend ADDED, so a retry after an uncertain failure double-counted
-- and could never be retried. This one names `settled is null`, so the second
-- call is a no-op and says so by answering false.
do $$
declare e uuid := gen_random_uuid(); s bigint; r bigint; again boolean;
begin
  -- A fresh day of its own: the previous probes have filled the 3000.
  delete from public.ask_calls;
  delete from public.ask_spend;
  perform public.ask_reserve_call(current_setting('probe.staff')::uuid, e, 'claude-opus-5', 1000);
  if public.ask_settle_call(e, 40, 2) is not true then
    raise exception 'PROBE 5 FAILED: the first settlement did not land';
  end if;
  select settled_tokens, reserved_tokens into s, r from public.ask_allowance();
  if s <> 42 or r <> 0 then
    raise exception 'PROBE 5 FAILED: settled % reserved % — settling must replace the reservation, not add to it', s, r;
  end if;
  again := public.ask_settle_call(e, 40, 2);
  if again is not false then
    raise exception 'PROBE 5 FAILED: the same settlement landed twice';
  end if;
  select settled_tokens into s from public.ask_allowance();
  if s <> 42 then raise exception 'PROBE 5 FAILED: a retried settlement moved the day to %', s; end if;
  -- The office's ledger moved once, with the settlement and only with it.
  if (select input_tokens + output_tokens from public.ask_spend
        where user_id = current_setting('probe.staff')::uuid
          and day = (now() at time zone 'America/Edmonton')::date) <> 42 then
    raise exception 'PROBE 5 FAILED: ask_spend and ask_calls disagree about the call';
  end if;
  if (select calls from public.ask_spend
        where user_id = current_setting('probe.staff')::uuid
          and day = (now() at time zone 'America/Edmonton')::date) <> 1 then
    raise exception 'PROBE 5 FAILED: a retried settlement counted a second call';
  end if;
  raise notice 'PROBE 5 ok: settlement replaces the reservation once and a retry writes nothing';
end $$;

-- ── 6. settling a call nobody reserved changes nothing ────────────────────
-- A settlement for an unknown id must not invent a row: a ledger entry with
-- no reservation behind it is spending that was never admitted.
do $$
declare before bigint; after bigint;
begin
  select count(*) into before from public.ask_calls;
  if public.ask_settle_call(gen_random_uuid(), 9, 9) is not false then
    raise exception 'PROBE 6 FAILED: an unknown call settled';
  end if;
  select count(*) into after from public.ask_calls;
  if before <> after then raise exception 'PROBE 6 FAILED: settling an unknown call wrote a row'; end if;
  raise notice 'PROBE 6 ok: an unknown call cannot be settled into existence';
end $$;

-- ── 7. a provider refusal settles at nothing and spends nothing ───────────
-- The ONE case where the provider itself says nothing was billed. Without it
-- a burst of 429s eats the day's ceiling with no tokens spent, which is denial
-- by another road; with it, an AMBIGUOUS failure must still keep its
-- reservation, so this function is deliberately the only zero door and the
-- function calls it only on a status the provider gave.
do $$
declare f uuid := gen_random_uuid(); s bigint; r bigint; rows int;
begin
  delete from public.ask_calls; delete from public.ask_spend;
  perform public.ask_reserve_call(current_setting('probe.staff')::uuid, f, 'claude-opus-5', 1000);
  if public.ask_settle_unbilled(f) is not true then
    raise exception 'PROBE 7 FAILED: an unbilled refusal could not be settled';
  end if;
  select settled_tokens, reserved_tokens into s, r from public.ask_allowance();
  if s <> 0 or r <> 0 then
    raise exception 'PROBE 7 FAILED: settled % reserved % after an unbilled refusal', s, r;
  end if;
  select count(*) into rows from public.ask_spend;
  if rows <> 0 then raise exception 'PROBE 7 FAILED: an unbilled refusal wrote a spend row'; end if;
  if public.ask_settle_unbilled(f) is not false then
    raise exception 'PROBE 7 FAILED: an unbilled refusal settled twice';
  end if;
  raise notice 'PROBE 7 ok: a refusal the provider gave costs nothing, writes no spend row, and cannot be replayed';
end $$;

-- ── 8. an unbilled door cannot un-spend a settled call ───────────────────
-- The attack this shape invites: call ask_settle_unbilled on a call the
-- provider already billed, and the day forgets it. `settled is null` is what
-- refuses it, and it is the same clause idempotency rests on.
do $$
declare g uuid := gen_random_uuid(); s bigint;
begin
  delete from public.ask_calls; delete from public.ask_spend;
  perform public.ask_reserve_call(current_setting('probe.staff')::uuid, g, 'claude-opus-5', 1000);
  perform public.ask_settle_call(g, 500, 100);
  if public.ask_settle_unbilled(g) is not false then
    raise exception 'PROBE 8 FAILED: a settled call was written down to nothing';
  end if;
  select settled_tokens into s from public.ask_allowance();
  if s <> 600 then raise exception 'PROBE 8 FAILED: the settled figure moved to %', s; end if;
  raise notice 'PROBE 8 ok: a call the provider billed cannot be written down to nothing';
end $$;

-- ── 9. a null cap is no ceiling, and the ledger is still complete ─────────
-- What applying the draft alone leaves, and what a project that has not chosen
-- a number gets. The reservation is still WRITTEN, so a cap set that afternoon
-- starts from the truth rather than from zero.
do $$
declare h uuid := gen_random_uuid(); r bigint;
begin
  delete from public.ask_calls; delete from public.ask_spend;
  update public.app_settings set ask_daily_token_cap = null where id;
  if public.ask_reserve_call(current_setting('probe.staff')::uuid, h, 'claude-opus-5', 99999999) is not true then
    raise exception 'PROBE 9 FAILED: a null cap refused a reservation';
  end if;
  select reserved_tokens into r from public.ask_allowance();
  if r <> 99999999 then raise exception 'PROBE 9 FAILED: a null cap did not write the reservation down'; end if;
  raise notice 'PROBE 9 ok: no cap refuses nothing and still records everything';
end $$;

-- ── 10. yesterday's spending does not count against today ────────────────
-- The day is the DATABASE's reading of Grande Prairie's calendar, never the
-- function's: an isolate's clock and an isolate's zone are two more things to
-- be wrong about, and a day boundary read two ways is a few hours in which
-- neither day has a ceiling.
do $$
declare i uuid := gen_random_uuid(); j uuid := gen_random_uuid(); s bigint; r bigint;
begin
  delete from public.ask_calls; delete from public.ask_spend;
  update public.app_settings set ask_daily_token_cap = 3000 where id;
  perform public.ask_reserve_call(current_setting('probe.staff')::uuid, i, 'claude-opus-5', 1000);
  update public.ask_calls set day = day - 1 where call_id = i;
  select settled_tokens, reserved_tokens into s, r from public.ask_allowance();
  if r <> 0 then raise exception 'PROBE 10 FAILED: yesterday held % against today', r; end if;
  if public.ask_reserve_call(current_setting('probe.staff')::uuid, j, 'claude-opus-5', 3000) is not true then
    raise exception 'PROBE 10 FAILED: yesterday spent today''s whole ceiling';
  end if;
  raise notice 'PROBE 10 ok: the ceiling is per Grande Prairie day, counted by the database';
end $$;

-- ── 11. the old door is gone ─────────────────────────────────────────────
-- ask_record_spend ADDED to the ledger with no reservation behind it, so
-- leaving it in place would be a second way to spend past the ceiling — and
-- the deployed function still calls it, which is why the function must be
-- deployed in the same breath as this migration.
do $$ begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'ask_record_spend') then
    raise exception 'PROBE 11 FAILED: ask_record_spend is still callable';
  end if;
  raise notice 'PROBE 11 ok: the unreserved door into the ledger is gone';
end $$;

-- ── 12. ninety days of rows and no more ──────────────────────────────────
-- A ledger that only grows is a different bug in a year. The prune is inside
-- the reservation's own advisory lock, so two reservations cannot race it.
do $$
declare k uuid := gen_random_uuid(); l uuid := gen_random_uuid();
begin
  delete from public.ask_calls; delete from public.ask_spend;
  perform public.ask_reserve_call(current_setting('probe.staff')::uuid, k, 'claude-opus-5', 10);
  update public.ask_calls set day = day - 200 where call_id = k;
  perform public.ask_reserve_call(current_setting('probe.staff')::uuid, l, 'claude-opus-5', 10);
  if exists (select 1 from public.ask_calls where call_id = k) then
    raise exception 'PROBE 12 FAILED: a 200-day-old reservation survived a new one';
  end if;
  if not exists (select 1 from public.ask_calls where call_id = l) then
    raise exception 'PROBE 12 FAILED: the prune took the new reservation with it';
  end if;
  raise notice 'PROBE 12 ok: rows older than ninety days go, and today''s stays';
end $$;

rollback;

-- ─────────────────────────────────────────────────────────────────────────
-- THE TWO-SESSION PROBE. STILL UNRUN, AND IT IS THE MAIN CLAIM.
-- ─────────────────────────────────────────────────────────────────────────
--
-- Every probe above ran in ONE connection, so every one of them saw a
-- reservation that had already committed. The defect the advisory lock exists
-- for cannot be reached that way: under READ COMMITTED, two transactions that
-- each read the day's total BEFORE either inserts both find room, both insert,
-- and the day ends at twice the cap with nothing having failed. That is the
-- ceiling failing at the one moment it is being tested, and it needs two
-- connections holding transactions open at once.
--
-- Two psql windows, A and B. Set the cap to 1000 first, in either:
--
--     update public.app_settings set ask_daily_token_cap = 1000 where id;
--     delete from public.ask_calls;
--
-- A:  begin;
--     select public.ask_reserve_call(
--       (select id from public.profiles where deactivated_at is null order by id limit 1),
--       gen_random_uuid(), 'claude-opus-5', 1000);
--     -- answers true. DO NOT COMMIT YET.
--
-- B:  begin;
--     select public.ask_reserve_call(
--       (select id from public.profiles where deactivated_at is null order by id limit 1),
--       gen_random_uuid(), 'claude-opus-5', 1000);
--     -- MUST BLOCK HERE, on A's advisory xact lock. If it answers `true`
--     -- immediately, the lock is not doing its job and the ceiling is not one.
--
-- A:  commit;
--
-- B:  -- unblocks and MUST answer false: A's row is committed and visible, and
--     -- B re-reads the total inside the lock it has just taken.
--     rollback;
--
--     select coalesce(sum(coalesce(settled, reserved)), 0) from public.ask_calls
--       where day = (now() at time zone 'America/Edmonton')::date;
--     -- MUST be 1000, never 2000.
--
-- Then put the live cap back and empty the table:
--
--     update public.app_settings set ask_daily_token_cap = 10000000 where id;
--     delete from public.ask_calls;
--
-- THE NEGATIVE CONTROL MATTERS AS MUCH AS THE PROBE. Comment the
-- pg_advisory_xact_lock line out of a COPY of ask_reserve_call, run the same
-- two windows against it, and B must answer `true` and the total must read
-- 2000. A probe that passes against both versions is testing something else —
-- which is the mistake the pdf.js worker check made twice, and it passed both
-- times.
--
-- IT IS THE THIRD OUTSTANDING TWO-SESSION PROCEDURE IN THIS REPO. The other
-- two are at the feet of
-- probes-20260911233656-ask-learned-is-bounded-and-cannot-be-backdated.sql
-- (the 40-note cap's per-author lock) and
-- probes-20260912030901-the-assistant-has-a-daily-allowance.sql (the lease).
-- All three assert a lock and none of the three has verified one. Until they
-- are run, round 7 is incompletely verified and this draft is not history.
