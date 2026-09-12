-- A busy lease answers false, not "I don't know"
--
-- Found by finally running the two-session lease probe, which had been
-- outstanding for three rounds because no session had two connections at
-- once. A second asker, racing the first, was refused — and the refusal came
-- back as NULL.
--
-- It is 20260912041955's defect again, in the sibling nobody re-read.
-- ask_claim_lease was `language sql`:
--
--     insert ... on conflict (user_id) do update
--       set ... where l.taken_at < now() - make_interval(secs => _stale_seconds)
--     returning true;
--
-- When the WHERE refuses the update no row comes back, and a SQL function
-- whose statement matches no row returns NULL. So the one answer that means
-- "somebody else is already asking" was the one answer a boolean door must
-- never give: `if (!ok)` reads it as a refusal, `ok === false` misses it
-- entirely, and PostgREST hands it back as JSON null.
--
-- Ask reads it as `took.data !== true`, so the live app fails CLOSED and no
-- second question was ever admitted. This is a trap rather than a hole — but
-- it is a trap laid directly under the next person to write `=== false`, and
-- it is the reason the probe could not assert the refusal it was written to
-- assert.
--
-- Behaviour is unchanged, and the probes beside this file show it: a stale
-- lease is still takeable, a live one is still not, and the same request
-- still does not re-enter its own lease. What changes is that the refusal is
-- now a value a caller can test.
create or replace function public.ask_claim_lease(_user uuid, _request uuid, _stale_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  insert into public.ask_leases as l (user_id, request_id, taken_at)
  values (_user, _request, now())
  on conflict (user_id) do update
    set request_id = excluded.request_id, taken_at = excluded.taken_at
    where l.taken_at < now() - pg_catalog.make_interval(secs => _stale_seconds);
  return found;
end;
$fn$;

revoke all on function public.ask_claim_lease(uuid, uuid, integer) from public, anon, authenticated;
