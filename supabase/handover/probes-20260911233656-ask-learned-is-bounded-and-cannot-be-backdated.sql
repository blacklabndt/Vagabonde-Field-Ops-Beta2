-- Probes for draft-ask-learned-is-bounded-and-cannot-be-backdated.sql
--
-- Run AFTER applying the draft, under role simulation: permissive policies
-- OR together, a grant is not a policy, and an invoker function is parsed at
-- call time as whoever calls it — so every one of these has to be exercised
-- as a real caller and never as the owner. (That last point is not
-- theoretical here: `replace_learned` is SECURITY INVOKER, and the tracker's
-- stats failed for every account for three minutes once because an invoker
-- function was only ever tried as the owner.)
--
-- Everything runs inside a transaction and ROLLS BACK. These write to the
-- live `ask_learned` — the crew's actual memory, 3 notes as of 11 Sept — so
-- nothing may be left behind, and an abort on a failed assertion leaves
-- nothing behind either.
--
-- The ids are passed through `set_config`, NOT through psql's `:'name'`
-- substitution: psql does not substitute inside a dollar-quoted block, so a
-- `:'staff'` in a `do $$ ... $$` is sent to the server verbatim and the
-- probe tests nothing. (That mistake was in the first draft of this file.)

begin;

-- STAFF: any active non-Admin profile holding at least one tab.
-- OTHER: any second active profile.
select set_config('probe.staff', '00000000-0000-0000-0000-000000000000', true);
select set_config('probe.other', '00000000-0000-0000-0000-000000000000', true);

-- What this author already holds, so nothing below assumes an empty slate.
select set_config('probe.held',
  (select pg_catalog.count(*)::text from public.ask_learned
    where said_by = current_setting('probe.staff')::uuid), true);

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('probe.staff'), 'role', 'authenticated')::text, true);

-- ── 1. The clock is not the caller's ─────────────────────────────────────
--
-- Before the draft this succeeded and put the row at the front of the
-- oldest-first window, which is the eviction. After it, the column is simply
-- not in the grant.

do $$
begin
  insert into public.ask_learned (note, said_by, created_at)
    values ('probe: backdated', (current_setting('request.jwt.claims')::json->>'sub')::uuid, '1970-01-01');
  raise exception 'FAIL 1: a caller still supplied created_at';
exception
  when insufficient_privilege then
    raise notice 'PASS 1: created_at is not the caller''s to write';
end $$;

-- ── 2. An ordinary note still lands, stamped by the database ────────────

do $$
declare stamped timestamptz;
begin
  insert into public.ask_learned (note, said_by)
    values ('probe: an ordinary note', (current_setting('request.jwt.claims')::json->>'sub')::uuid)
    returning created_at into stamped;
  if stamped is null or stamped < pg_catalog.now() - interval '1 minute' then
    raise exception 'FAIL 2: the default did not stamp the row (%)', stamped;
  end if;
  raise notice 'PASS 2: the row is stamped now, by the database';
end $$;

-- ── 3. One author's share is bounded, from wherever they started ────────

do $$
declare
  me uuid := (current_setting('request.jwt.claims')::json->>'sub')::uuid;
  room integer := 40 - (current_setting('probe.held')::integer + 1);  -- +1 for probe 2
begin
  if room > 0 then
    insert into public.ask_learned (note, said_by)
      select 'probe: filling ' || g, me from generate_series(1, room) g;
  end if;
  begin
    insert into public.ask_learned (note, said_by) values ('probe: one too many', me);
    raise exception 'FAIL 3: the cap did not hold';
  exception
    when check_violation then
      raise notice 'PASS 3: one author is bounded at forty';
  end;
end $$;

-- ── 4. The cap bounds an author, not the table ──────────────────────────
--
-- The point of per-author: the first account to fill up must not stop the
-- rest of the crew teaching Ask anything.

select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('probe.other'), 'role', 'authenticated')::text, true);

do $$
declare made uuid;
begin
  insert into public.ask_learned (note, said_by)
    values ('probe: somebody else still can', (current_setting('request.jwt.claims')::json->>'sub')::uuid)
    returning id into made;
  if made is null then raise exception 'FAIL 4: a full author blocked everybody'; end if;
  raise notice 'PASS 4: the cap bounds an author, not the table';
  perform set_config('probe.made', made::text, true);
end $$;

-- ── 5. Authorship is still pinned (regression) ──────────────────────────
--
-- `said_by = auth.uid()` was never the defect. Prove the narrower grant did
-- not disturb it.

do $$
begin
  insert into public.ask_learned (note, said_by)
    values ('probe: signed by somebody else', current_setting('probe.staff')::uuid);
  raise exception 'FAIL 5: a caller wrote a note in another name';
exception
  when insufficient_privilege then
    raise notice 'PASS 5: a note is still signed by whoever wrote it';
end $$;

-- ── 6. A replacement is one act, and a refused one changes nothing ──────

do $$
declare
  mine uuid := current_setting('probe.made')::uuid;
  back public.ask_learned;
begin
  back := public.replace_learned(mine, 'probe: the corrected note');
  if back.note <> 'probe: the corrected note' then
    raise exception 'FAIL 6a: the replacement did not return the new note';
  end if;
  if exists (select 1 from public.ask_learned where id = mine) then
    raise exception 'FAIL 6a: the old note is still there';
  end if;
  raise notice 'PASS 6a: a correction removes one and adds one';
  perform set_config('probe.made', back.id::text, true);
end $$;

do $$
declare before_count integer;
begin
  select pg_catalog.count(*) into before_count from public.ask_learned;
  begin
    -- A note that is not there, and one this caller may not delete, are the
    -- same zero rows under RLS. Neither may become an insertion.
    perform public.replace_learned('00000000-0000-0000-0000-000000000001'::uuid, 'probe: from nowhere');
    raise exception 'FAIL 6b: replacing a note that is not there inserted one';
  exception
    when no_data_found then
      if (select pg_catalog.count(*) from public.ask_learned) <> before_count then
        raise exception 'FAIL 6b: the refused replacement still changed the table';
      end if;
      raise notice 'PASS 6b: a replacement with nothing to replace changes nothing';
  end;
end $$;

do $$
declare
  theirs uuid := (select id from public.ask_learned
                   where said_by = current_setting('probe.staff')::uuid limit 1);
  before_count integer;
begin
  select pg_catalog.count(*) into before_count from public.ask_learned;
  begin
    perform public.replace_learned(theirs, 'probe: over somebody else''s note');
    raise exception 'FAIL 6c: one account replaced another account''s note';
  exception
    when no_data_found then
      if (select pg_catalog.count(*) from public.ask_learned) <> before_count then
        raise exception 'FAIL 6c: the refusal still changed the table';
      end if;
      raise notice 'PASS 6c: a note that is not yours is not yours to replace';
  end;
end $$;

-- ── 7. Deleting one's own note still works ──────────────────────────────

do $$
begin
  delete from public.ask_learned where id = current_setting('probe.made')::uuid;
  if exists (select 1 from public.ask_learned where id = current_setting('probe.made')::uuid) then
    raise exception 'FAIL 7: an author can no longer forget their own note';
  end if;
  raise notice 'PASS 7: an author still forgets their own note';
end $$;

reset role;
rollback;

-- ── 8. The race, which needs two sessions and cannot live above ─────────
--
-- Read committed is what this project runs at, so a count and an insert in
-- separate statements see different worlds. Run this as two connections,
-- against the REAL paths (a direct insert, and replace_learned), and read
-- the final count.
--
-- Session A:
--   begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims',
--     json_build_object('sub', '<STAFF>', 'role', 'authenticated')::text, true);
--   -- bring the author to 39 first, outside this transaction, then:
--   insert into public.ask_learned (note, said_by) values ('race A', '<STAFF>');
--   -- hold here, do NOT commit
--
-- Session B (while A is open):
--   begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims', ...same...);
--   insert into public.ask_learned (note, said_by) values ('race B', '<STAFF>');
--   -- EXPECTED: this BLOCKS on A's advisory lock rather than reading 39 too
--
-- Session A: commit;
-- Session B: EXPECTED: check_violation, "already taught Ask as much as it
--   can hold". Then rollback both and confirm the author's count is 40 and
--   never 41.
--
-- Without the lock in private.ask_learned_room, B does not block, reads 39,
-- and both land: 41. That is the whole reason the lock is there.
