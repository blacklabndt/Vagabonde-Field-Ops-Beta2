-- A refusal that settles nothing answers false, not "I don't know"
--
-- 20260912034222 gave the ceiling its unbilled door: the one case where the
-- provider itself says nothing was billed, so a burst of 429s cannot eat a
-- day's ceiling with no tokens spent. It was written `language sql` as
-- `update ... returning true`, and a SQL function whose statement matches no
-- row returns NULL. So the door answered NULL — not false — on both paths
-- that mean "there was nothing here to settle": a call already settled, and
-- a call nobody ever reserved.
--
-- Those two paths are the security half of this function, not its edge case.
-- The attack the shape invites is calling it on a call the provider already
-- billed, so the day forgets the spend; `settled is null` refuses that, and
-- the caller is meant to be able to SEE the refusal. NULL is the one answer
-- a boolean door must never give, because every caller reads it differently:
-- `if (!ok)` treats it as a refusal, `ok === false` misses it entirely, and
-- PostgREST hands the function's NULL back as JSON null. Its sibling
-- ask_settle_call is plpgsql and already answers a real false.
--
-- Behaviour is unchanged: the same rows update and the same rows do not.
-- What changes is that the refusal is now a value a caller can test, which
-- is what the probes beside this file assert and could not, before.
create or replace function public.ask_settle_unbilled(_call uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.ask_calls
     set settled = 0, settled_at = now()
   where call_id = _call and settled is null;
  return found;
end;
$$;

revoke all on function public.ask_settle_unbilled(uuid) from public, anon, authenticated;
