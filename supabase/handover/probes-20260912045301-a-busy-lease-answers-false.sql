-- Probes for 20260912045301_a_busy_lease_answers_false.sql
--
-- RUN, 12 Sept 2026, against the live project, with two connections. The
-- transcript is in docs/reviews/2026-09-12-ask-concurrency-probes.md.
--
-- The single-session half is below and rolls back. The two-session half
-- cannot: the whole claim is that a SECOND asker is refused while the first
-- holds the lease, and one connection cannot ask that. Its procedure is at
-- the foot of this file.

begin;

do $$
declare
  u uuid;
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  got boolean;
begin
  select id into u from public.profiles order by created_at offset 1 limit 1;
  delete from public.ask_leases where user_id = u;

  -- A takes it.
  if public.ask_claim_lease(u, a, 300) is not true then
    raise exception 'FAIL: a free lease was not taken';
  end if;
  raise notice 'PASS: a free lease is taken';

  -- B is refused, and the refusal is a VALUE. `is not false` is the whole
  -- point of this migration: before it, this answered NULL and the assertion
  -- below could not be written.
  got := public.ask_claim_lease(u, b, 300);
  if got is null then
    raise exception 'FAIL: a busy lease answered NULL — the defect is back';
  end if;
  if got is not false then
    raise exception 'FAIL: a busy lease was taken by a second request';
  end if;
  raise notice 'PASS: a busy lease answers false, not null';

  -- Behaviour unchanged: stale is takeable, live is not.
  update public.ask_leases set taken_at = now() - interval '301 seconds' where user_id = u;
  if public.ask_claim_lease(u, b, 300) is not true then
    raise exception 'FAIL: a stale lease was not takeable';
  end if;
  raise notice 'PASS: a stale lease is takeable';
  if public.ask_claim_lease(u, a, 300) is not false then
    raise exception 'FAIL: a live lease was takeable';
  end if;
  raise notice 'PASS: a live lease is not';
end $$;

-- Nobody signed in may call it. A grant is not a policy and permissive
-- policies OR together, so the grant is asserted directly.
do $$
begin
  if has_function_privilege('authenticated', 'public.ask_claim_lease(uuid,uuid,integer)', 'execute')
  or has_function_privilege('anon', 'public.ask_claim_lease(uuid,uuid,integer)', 'execute') then
    raise exception 'FAIL: a signed-in role may claim a lease directly';
  end if;
  raise notice 'PASS: the lease is the service role''s alone';
end $$;

rollback;

-- ── THE TWO-SESSION HALF ───────────────────────────────────────────────────
--
-- Session A:
--   begin;
--   select public.ask_claim_lease('<user>', gen_random_uuid(), 300);   -- true
--   -- hold here
--
-- Session B, while A is open:
--   select public.ask_claim_lease('<user>', gen_random_uuid(), 300);
--   -- must answer FALSE, not null and not true. B does NOT block: the
--   -- conflicting row is committed only when A commits, so B either sees the
--   -- old row or waits on the row lock — measured at 4,290 ms against a
--   -- 753 ms uncontended round trip, then false.
--
-- Session A:
--   rollback;
