-- The ceiling is charged before the call, not after it
--
-- 20260912030901 gave Ask a daily ceiling and enforced it on SETTLED spend —
-- the figures the provider itself reported. That left one hole, and Codex
-- named it: the hold for a call in flight lived in the isolate. A worker
-- retired between the provider's billed answer and the ledger write loses
-- that spend for good, and retirement on CPU, memory, wall clock or
-- EarlyDrop is routine. The likeliest moment sits inside the window —
-- reading an 8,000-token reply is real CPU work under a 2 s cap of its own.
-- So the ceiling could be walked past by a request that simply died at the
-- right instant, over and over, and nothing would ever say so.
--
-- The first repair proposed here was to carry the hold on the lease row and
-- flush it at the next stale takeover. Codex refused it, and was right:
-- THERE MIGHT NEVER BE ANOTHER REQUEST. A single-user project, or the last
-- question of the evening, would carry an unrecorded spend over the day
-- boundary and out of the ledger permanently. A reconciliation that waits
-- for traffic is not a ceiling; it is a hope about traffic.
--
-- So a reservation is a ROW, and it counts from the moment it exists:
--
--     the day's total  =  sum(coalesce(settled, reserved))
--
-- A reservation is written before its call goes out and keeps counting at
-- the reserved figure until the provider's own figure replaces it. Crash,
-- abort, timeout, an unreadable bill, a settlement write that fails — every
-- one of them leaves `settled` null, and the row goes on holding the
-- model's whole documented maximum until the day rolls over. There is no
-- refund path and no sweeper, deliberately: a write an attacker can make
-- fail must not be a ceiling they can switch off.
--
-- The reserved figure is the PROVIDER'S maximum for the model — the context
-- window (a larger input is refused with a 400) plus the max_tokens we send.
-- Not a token estimate: Anthropic documents its own counter as an estimate
-- and publishes no tokenizer, so nothing computed on our side could be a
-- bound. The price of a bound that cannot be exceeded is that it is loose,
-- and the consequence is arithmetic rather than a surprise:
--
--     outstanding  ~  (people asking at once + today's lost calls) x 1,008,000
--
-- which is why the cap is a SAFETY ceiling and not a spending plan, and why
-- the number the office types has to be sized for that arithmetic. Real use
-- is two orders under it, because the character caps in askLoop.ts hold one
-- call's input there.
--
-- ask_spend stays exactly as it is: the human-readable per-day ledger, now
-- written from settlement instead of from the function. ask_record_spend
-- goes, because a second door into the ledger that skips the reservation is
-- a second way to spend past the ceiling.

-- ── the reservations ───────────────────────────────────────────────────────
create table if not exists public.ask_calls (
  call_id     uuid primary key,
  user_id     uuid        not null references public.profiles(id) on delete cascade,
  day         date        not null,
  model       text        not null,
  reserved    bigint      not null check (reserved >= 0),
  settled     bigint      check (settled >= 0),
  created_at  timestamptz not null default now(),
  settled_at  timestamptz
);

comment on table public.ask_calls is
  'One row per PAID model call, written before the call goes out. The day''s total is sum(coalesce(settled, reserved)), so a reservation counts against the ceiling from before its call and keeps counting at the reserved figure until the provider''s own figure replaces it. A row whose settled stays null is a call that crashed, timed out or could not be read: it holds the model''s documented maximum for the rest of the day, on purpose.';

comment on column public.ask_calls.reserved is
  'The provider''s maximum for this model: context window plus the max_tokens we send. Not an estimate — a figure the API itself enforces.';
comment on column public.ask_calls.settled is
  'The provider''s own usage figure, all four names summed. Null means the call was never settled and is still held at `reserved`.';

create index if not exists ask_calls_day_idx on public.ask_calls (day);

alter table public.ask_calls enable row level security;
revoke all on public.ask_calls from anon, authenticated;

-- ── admission ──────────────────────────────────────────────────────────────
-- The advisory lock is not decoration. Under READ COMMITTED two concurrent
-- reservations each read the pre-insert total, each find room, and both
-- insert — which is exactly the ceiling failing at the one moment it is
-- being tested. The ask_learned cap trigger takes a per-author lock for the
-- same reason; this is that pattern on the day.
--
-- A null or non-positive cap is no ceiling: the reservation is still written
-- (so the ledger is complete and a cap set later starts from the truth) and
-- nothing is refused.
create or replace function public.ask_reserve_call(_user uuid, _call uuid, _model text, _reserved bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  d           date   := (now() at time zone 'America/Edmonton')::date;
  c           bigint;
  outstanding bigint;
  want        bigint := greatest(coalesce(_reserved, 0), 0);
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ask_calls'), pg_catalog.hashtext(d::text));

  -- A ledger that only grows is a different bug in a year. Ninety days is
  -- well past any question anyone will ask about a day's spending, and the
  -- delete is inside the lock so two reservations cannot race it.
  delete from public.ask_calls where day < d - 90;

  select ask_daily_token_cap into c from public.app_settings where id;

  if c is not null and c > 0 then
    select coalesce(sum(coalesce(k.settled, k.reserved)), 0)::bigint into outstanding
      from public.ask_calls k where k.day = d;
    if outstanding + want > c then
      return false;
    end if;
  end if;

  insert into public.ask_calls (call_id, user_id, day, model, reserved)
  values (_call, _user, d, coalesce(_model, ''), want)
  on conflict (call_id) do nothing;
  return true;
end;
$$;

-- ── settlement ─────────────────────────────────────────────────────────────
-- Idempotent by call_id: the update names `settled is null`, so a retry
-- after an uncertain failure writes nothing a second time. That is what
-- ask_record_spend's ADD could never promise, and it is why a settlement
-- write MAY now be retried where that one could not be.
--
-- The ask_spend row moves with the settlement and only with it, so the
-- office's ledger and the reservation ledger cannot disagree about a call.
create or replace function public.ask_settle_call(_call uuid, _input bigint, _output bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  u uuid;
  d date;
  i bigint := greatest(coalesce(_input, 0), 0);
  o bigint := greatest(coalesce(_output, 0), 0);
begin
  update public.ask_calls
     set settled = i + o, settled_at = now()
   where call_id = _call and settled is null
   returning user_id, day into u, d;
  if u is null then
    return false;
  end if;

  insert into public.ask_spend as s (day, user_id, input_tokens, output_tokens, calls)
  values (d, u, i, o, 1)
  on conflict (day, user_id) do update
    set input_tokens  = s.input_tokens  + i,
        output_tokens = s.output_tokens + o,
        calls         = s.calls + 1;
  return true;
end;
$$;

-- A refusal the provider gave BEFORE it ran anything — a 400, a 401, a 429 —
-- is the one case where nothing was billed and the provider itself says so.
-- Settling those at nothing is not a refund path: an ambiguous failure (a
-- 5xx, an abort, a dead isolate) never reaches here and keeps its reservation
-- in full. Without it a burst of rate-limit refusals would eat a day's
-- ceiling without a single token being spent, which is denial by another
-- road. It writes no ask_spend row, because nothing was spent.
create or replace function public.ask_settle_unbilled(_call uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$
  update public.ask_calls
     set settled = 0, settled_at = now()
   where call_id = _call and settled is null
  returning true;
$$;

-- ── what the day looks like ────────────────────────────────────────────────
-- Three numbers rather than one, because a figure in neither column is a
-- figure nobody can explain: what the provider has billed, what is held
-- against calls that never settled, and the line. Nothing in the app reads
-- it now that admission is the database's own decision — it is the probe's
-- read and the office's diagnostic, and it is the service role's alone.
drop function if exists public.ask_allowance();
create or replace function public.ask_allowance()
returns table (settled_tokens bigint, reserved_tokens bigint, token_cap bigint)
language sql
security definer
set search_path = ''
as $$
  select
    (select coalesce(sum(k.settled), 0)::bigint
       from public.ask_calls k
      where k.day = (now() at time zone 'America/Edmonton')::date),
    (select coalesce(sum(k.reserved), 0)::bigint
       from public.ask_calls k
      where k.day = (now() at time zone 'America/Edmonton')::date and k.settled is null),
    (select a.ask_daily_token_cap from public.app_settings a where a.id);
$$;

-- The old door into the ledger. It ADDED, so it could not be retried safely,
-- and it wrote spend that no reservation had ever admitted. Both jobs are
-- ask_settle_call's now.
drop function if exists public.ask_record_spend(uuid, bigint, bigint);

-- Nobody signed in may call any of these. The function writes as the service
-- role for these and only these; every read Ask makes is still the caller's.
revoke all on function public.ask_reserve_call(uuid, uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.ask_settle_call(uuid, bigint, bigint) from public, anon, authenticated;
revoke all on function public.ask_settle_unbilled(uuid) from public, anon, authenticated;
revoke all on function public.ask_allowance() from public, anon, authenticated;
