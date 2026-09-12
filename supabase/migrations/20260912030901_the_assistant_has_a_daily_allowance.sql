-- The assistant has a daily allowance, and asks one question at a time
--
-- Ask pays for two model calls per answer — the loop's (Opus, up to nine
-- rounds) and the learning pass's (Haiku, once) — and until now NOTHING
-- counted them. The character caps added this week bound what ONE call may
-- carry; they say nothing at all about how many calls a day may hold, so a
-- loop that misbehaves, or a crew that discovers Ask on the same afternoon,
-- has no ceiling but the Anthropic account's.
--
-- Two tables, because there are two different questions:
--
--   ask_leases  — who is asking RIGHT NOW. One row per person at most, and a
--                 second question from the same person while the first is in
--                 flight is refused. This is not politeness: it is what makes
--                 the day's ceiling a ceiling. A ledger checked before each
--                 call can only be overrun by calls already in flight when
--                 the line is crossed, so bounding the people in flight
--                 bounds the overshoot — see the arithmetic below.
--
--   ask_spend   — what the asking cost, by day and by person, in the tokens
--                 the PROVIDER reported. Not dollars and not an estimate:
--                 input and output are priced differently and by model, so a
--                 price table in here would be a second source of truth that
--                 rots in silence. The office converts once, when it sets the
--                 number.
--
-- THE OVERSHOOT, stated rather than hoped for. The check is made before every
-- paid call against what is already settled, so the most that can be spent
-- past the line is one call for each request in flight:
--
--     worst case  =  cap  +  (people in flight) x (one call's provider maximum)
--
-- and one call's provider maximum is documented and provider-ENFORCED, not
-- counted by us: the model's context window (a larger input is refused with a
-- 400) plus the max_tokens we ourselves send. It is a loose bound — the
-- character caps make the real figure far smaller — but it is finite, known,
-- and does not rest on a token count that Anthropic documents as an estimate.
--
-- The lease is the reason that first factor is small. Without it one account
-- could hold any number of calls open across the line at once.
--
-- Nothing here is a client's to touch: both tables are the service role's, and
-- an Admin may READ the spend (it is the office's own record of what Ask
-- costs) and write nothing, exactly as backup_runs does.

-- ── the lease: one question at a time, per person ──────────────────────────
create table if not exists public.ask_leases (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  request_id  uuid        not null,
  taken_at    timestamptz not null default now()
);

comment on table public.ask_leases is
  'One row per person with an Ask question in flight. Taken before any paid call, released after the answer. A row older than the stale window is a request whose isolate died and is taken over.';

alter table public.ask_leases enable row level security;
revoke all on public.ask_leases from anon, authenticated;

-- ── the ledger: what it cost, by day and by person ─────────────────────────
create table if not exists public.ask_spend (
  day            date   not null,
  user_id        uuid   not null references public.profiles(id) on delete cascade,
  input_tokens   bigint not null default 0,
  output_tokens  bigint not null default 0,
  calls          integer not null default 0,
  primary key (day, user_id)
);

comment on table public.ask_spend is
  'Tokens the provider reported, by Grande Prairie day and by person. Tokens, never dollars: input and output price differently and by model, so the conversion belongs to whoever sets the ceiling, not to this table.';

alter table public.ask_spend enable row level security;
revoke all on public.ask_spend from anon, authenticated;
grant select on public.ask_spend to authenticated;

-- The office's own record of what the assistant costs. Read by an Admin,
-- written by nobody — the writes are the service role's, from inside the
-- function, like backup_runs.
drop policy if exists "ask_spend admin read" on public.ask_spend;
create policy "ask_spend admin read" on public.ask_spend
  for select to authenticated
  using ((select private.user_role()) = 'Admin');

-- ── the ceiling ────────────────────────────────────────────────────────────
-- The default is on the COLUMN and not in an UPDATE, because app_settings
-- ships with no row: a fresh replay has nothing for an UPDATE to match, and
-- 20260910023039 is the migration that exists because that exact mistake left
-- a rebuilt project with no file-check clock. ADD COLUMN ... DEFAULT fills the
-- live row AND every row a fresh project's first Save inserts.
--
-- The number is deliberately generous: this is a stop on a runaway, not a
-- budget the crew must work inside. An explicit null is no ceiling at all.
alter table public.app_settings
  add column if not exists ask_daily_token_cap bigint default 10000000;

comment on column public.app_settings.ask_daily_token_cap is
  'Tokens (input + output, as the provider reported them) the assistant may spend in one Grande Prairie day. Null is no ceiling. Tokens and not dollars on purpose: output costs several times input and the rate differs per model, so convert with the worst case in mind.';

-- ── claiming the lease ─────────────────────────────────────────────────────
-- One statement, so two isolates cannot both read "free" and both insert.
-- A conflict updates ONLY when the row on file is older than the stale
-- window; when it is not, the update is skipped, nothing is returned, and the
-- caller is told somebody is already asking.
create or replace function public.ask_claim_lease(_user uuid, _request uuid, _stale_seconds integer)
returns boolean
language sql
security definer
set search_path = ''
as $$
  insert into public.ask_leases as l (user_id, request_id, taken_at)
  values (_user, _request, now())
  on conflict (user_id) do update
    set request_id = excluded.request_id, taken_at = excluded.taken_at
    where l.taken_at < now() - make_interval(secs => _stale_seconds)
  returning true;
$$;

-- Its OWN lease and no other: a request that has been taken over must not
-- release the lease the taker is holding.
create or replace function public.ask_release_lease(_user uuid, _request uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.ask_leases where user_id = _user and request_id = _request;
$$;

-- ── the ledger ─────────────────────────────────────────────────────────────
-- The day is Grande Prairie's, like every other day in this app.
--
-- The ceiling comes back with the spending, in ONE call, so that reading it
-- costs no extra round trip and — more importantly — so the new column is
-- named in one place that only the ask function reaches. Adding it to the
-- shared `appSettings()` select would have made every mail function refuse
-- until this migration landed, which is a deployment order nobody should
-- have to hold in their head.
create or replace function public.ask_allowance()
returns table (spent bigint, cap bigint)
language sql
security definer
set search_path = ''
as $$
  select
    (select coalesce(sum(input_tokens + output_tokens), 0)::bigint
       from public.ask_spend
      where day = (now() at time zone 'America/Edmonton')::date),
    (select ask_daily_token_cap from public.app_settings where id);
$$;

-- Records one call and answers with the day's new total, so the caller needs
-- no second read to know where the line is.
create or replace function public.ask_record_spend(_user uuid, _input bigint, _output bigint)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  d date := (now() at time zone 'America/Edmonton')::date;
begin
  insert into public.ask_spend as s (day, user_id, input_tokens, output_tokens, calls)
  values (d, _user, greatest(_input, 0), greatest(_output, 0), 1)
  on conflict (day, user_id) do update
    set input_tokens  = s.input_tokens  + greatest(_input, 0),
        output_tokens = s.output_tokens + greatest(_output, 0),
        calls         = s.calls + 1;
  return (select coalesce(sum(input_tokens + output_tokens), 0)::bigint
          from public.ask_spend where day = d);
end;
$$;

-- Nobody signed in may call any of the four. The function writes as the
-- service role for these and only these; every read Ask makes is still the
-- caller's own.
revoke all on function public.ask_claim_lease(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.ask_release_lease(uuid, uuid) from public, anon, authenticated;
revoke all on function public.ask_allowance() from public, anon, authenticated;
revoke all on function public.ask_record_spend(uuid, bigint, bigint) from public, anon, authenticated;
