-- S4 of the security audit. APPLIED LIVE 11 Sept as 20260911233656; probes
-- beside it under supabase/handover/, run under role simulation, nine PASS,
-- the whole run rolled back and the crew's three real notes untouched.
--
-- One thing the probes taught that the design did not: a BEFORE INSERT
-- trigger fires ahead of the RLS WITH CHECK, so an author already at the cap
-- meets the cap's words when they attempt a forged `said_by` — the right
-- refusal for the wrong reason. Probe 5 therefore asks that question while
-- the author still has room. Worth knowing before adding another trigger
-- here: the cap can mask a policy refusal, never the other way round.
--
-- `ask_learned` is Ask's one crew memory, read into the prompt of every
-- question anybody asks. Three things let one staff account own that window,
-- and none of them needs anything to fail:
--
--  1. `grant select, insert, delete on public.ask_learned to authenticated`
--     names no columns, so a caller supplies `created_at` themselves and the
--     default never applies. The function reads
--     `.order("created_at").limit(200)` — OLDEST first — so two hundred rows
--     backdated to 1970 sit at the front of that window for ever and every
--     genuine note falls off the end. Backdating is the eviction: ordinary
--     new rows could only ever crowd out FUTURE notes, which is why the
--     column list and not the cap is the heart of this.
--  2. The cap of 200 lives in `askLearn.ts` (`roomFor`), which is the
--     extractor's own arithmetic. A direct PostgREST insert never goes near
--     it. A cap belongs where the grant is.
--  3. Nothing bounds one author's share, so even without backdating a single
--     account can fill the window and crowd out everybody else.
--
-- The insert policy already pins `said_by = auth.uid()`, so authorship
-- cannot be forged. That half was never broken and is left alone.
--
-- Live state read before writing this (11 Sept): 3 notes, 1 author, none
-- backdated, nobody near the cap — so nothing here has to clean up after
-- anything, and no legitimate note is at risk. All three rows carry the
-- IDENTICAL created_at, having been written in one pass, which is why the
-- reader's tie-breaker below is not a nicety: on today's data, ordering by
-- the timestamp alone is undefined for every row that exists.
--
-- Probes beside this file, run under role simulation, including the
-- two-session race. Apply live first, then file with the applier's version.

-- ── 1. The caller writes the words, not the clock ────────────────────────
--
-- A column list on the grant is the chosen answer, not the only possible
-- one: a BEFORE INSERT trigger could overwrite `created_at` with `now()`
-- instead, and a restrictive policy naming the column could refuse it. The
-- grant wins because it is the smallest statement of the truth — the caller
-- has no business writing that column at all — and because it needs nothing
-- to run on every insert to stay true. What is NOT enough on its own is the
-- existing insert policy: a policy cannot pin a column it does not name, and
-- that one names only `said_by`. `id` comes off with `created_at`: the
-- default is a random uuid and nothing needs the caller to choose one.

revoke insert on public.ask_learned from authenticated;
grant insert (note, said_by) on public.ask_learned to authenticated;

-- ── 2. One author's share of the window ─────────────────────────────────
--
-- Per author and not a global cap, on purpose: a global cap enforced here
-- would let the first account to reach it lock the table for the whole crew,
-- which is the same denial by another road. Forty is roomy for one person
-- describing how the app works and leaves the 200-note window room for five
-- such people; the extractor's own 200 still applies above it.
--
-- The advisory lock is the point of this function, not the count. A count
-- followed by an insert is a read of a number that another session is
-- already changing: two requests both see thirty-nine and both write, and
-- the cap is not a cap. The lock is taken on the AUTHOR, so two people
-- teaching Ask at once never wait on each other, and it is an xact lock, so
-- it goes when the transaction does however that happens.
--
-- SECURITY DEFINER with an empty search_path: the count must be the true
-- one and not what the caller's own policies let them see, and every name is
-- schema-qualified because nothing is resolved from a path.

create or replace function private.ask_learned_room()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  held integer;
begin
  -- Serialised per author for the rest of this transaction. Re-entrant, so
  -- replace_learned below may already hold it and this is free.
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(new.said_by::text, 0));

  select pg_catalog.count(*) into held
    from public.ask_learned
   where said_by = new.said_by;

  if held >= 40 then
    raise exception
      'That account has already taught Ask as much as it can hold (40 notes). Delete one before adding another.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists ask_learned_room on public.ask_learned;
create trigger ask_learned_room
  before insert on public.ask_learned
  for each row execute function private.ask_learned_room();

comment on function private.ask_learned_room() is
  'Bounds one author''s share of the shared prompt window, under a per-author advisory lock so a count is not read while another session is changing it. The extractor''s own cap lives in askLearn.ts; this is the one a direct insert also meets.';

-- ── 3. A replacement is one act ─────────────────────────────────────────
--
-- Correcting a note is a delete and then an insert, and the two were
-- separate round trips: the delete lands, the insert is refused — by the cap
-- above, by a constraint, by anything — and the note is simply gone. The
-- person asked for a correction and lost the original.
--
-- One transaction fixes that: an exception anywhere in here rolls the delete
-- back with it. SECURITY INVOKER, deliberately — the delete and the insert
-- must be decided by the caller's OWN policies (the speaker's note or an
-- Admin's to remove; `said_by = auth.uid()` to write), so this function
-- holds no more authority than the person calling it, which is the rule the
-- whole of Ask is built on.
--
-- `gone <> 1` is the other half: a missing `_old`, or one the caller may not
-- delete, is a REFUSAL and never a silent insert. RLS makes a delete the
-- caller is not entitled to indistinguishable from one that matched
-- nothing — both are zero rows — and either way this is not a replacement,
-- so it must not become an addition.

create or replace function public.replace_learned(_old uuid, _note text)
returns public.ask_learned
language plpgsql
security invoker
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  gone integer;
  made public.ask_learned;
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '28000';
  end if;

  -- Before anything is removed, and the same lock the trigger takes.
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(me::text, 0));

  delete from public.ask_learned where id = _old;
  get diagnostics gone = row_count;
  if gone <> 1 then
    raise exception
      'That note is not there to replace, or is not yours to remove. Nothing was changed.'
      using errcode = 'no_data_found';
  end if;

  insert into public.ask_learned (note, said_by)
    values (_note, me)
    returning * into made;
  return made;
end;
$$;

revoke all on function public.replace_learned(uuid, text) from public;
grant execute on function public.replace_learned(uuid, text) to authenticated;

comment on function public.replace_learned(uuid, text) is
  'Corrects one note as one act: the delete and the insert share a transaction, so a refused insert puts the original back. Invoker rights - the caller''s own policies decide both halves. A delete that matched nothing, or that RLS refused, is a refusal and never becomes an insert.';
