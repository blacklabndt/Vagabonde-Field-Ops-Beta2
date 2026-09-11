-- Ask learns how the app works from conversations.
--
-- Applied live 10 Sept 2026 as 20260910225905. Probes beside it under
-- supabase/handover/.
--
-- Kyle's decision (spec: docs/superpowers/specs/2026-09-10-ask-learns-the-app-design.md):
-- Ask keeps what the crew tells it about how the app works — where a
-- button is, what a screen does, a rule someone corrects it on — with no
-- confirm button, as one crew memory. This table is that memory: one row
-- per note, and who said it.
--
-- The ask function writes these rows AS THE CALLER through RLS, in the
-- caller's own name, and nothing else; so the function still holds no
-- more authority than the person. Every staff account reads them (they
-- are the crew's); the speaker or an Admin deletes; nothing updates — a
-- note that changed is deleted and written again. The speaker's role is
-- not stored: the function joins profiles at read time, so a note said
-- by an Admin is presented as fact and one said by anybody else as "a
-- crew member said", by the role the speaker holds NOW. The cap of 200
-- notes and the three-a-turn limit are the function's (askLearn.ts).

create table public.ask_learned (
  id uuid primary key default gen_random_uuid(),
  note text not null check (length(note) between 3 and 300),
  said_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index ask_learned_created_at on public.ask_learned (created_at);
alter table public.ask_learned enable row level security;

create policy "ask_learned select" on public.ask_learned
  for select to authenticated
  using ((select public.is_staff()));

create policy "ask_learned insert" on public.ask_learned
  for insert to authenticated
  with check (said_by = (select auth.uid()) and (select public.is_staff()));

create policy "ask_learned delete" on public.ask_learned
  for delete to authenticated
  using (said_by = (select auth.uid()) or coalesce((select private.user_role()), '') = 'Admin');

grant select, insert, delete on public.ask_learned to authenticated;
grant all on public.ask_learned to service_role;
