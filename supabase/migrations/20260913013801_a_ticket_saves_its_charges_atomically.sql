-- APPLIED 13 Sept 2026 01:38:01 UTC, live, by the Management API as postgres.
-- Probes: supabase/handover/probes-20260913013801-a-ticket-saves-its-charges-atomically.sql
-- All of them run live against this project on 13 Sept, part 1 in one rolled-back
-- transaction and part 2 as real concurrent sessions. Results, in full:
--
--   part 1 (§1-5b, one transaction)  ended in 'ROLLBACK_ON_PURPOSE all probes
--     passed' on its first run: authorization (own draft, another technician,
--     an Admin, a Helper, a deactivated Admin, no JWT at all, anon's missing
--     grant, can_write_ticket asked directly), protected status (Awaiting
--     approval deliberately NOT the database's gate; Approved and Invoiced
--     refused for a technician and for an Admin alike; a ticket that has gone),
--     the payload's twelve refusals each leaving the three lines and $410 where
--     they were, the empty array as a legitimate save, round() agreeing with the
--     trigger at 4.63, atomicity through a trigger made to raise after the
--     delete (the old charges came back whole), a second ticket untouched, and
--     the deferred balance constraint made immediate on a priced and on an
--     emptied ticket. No Coordinator account exists on this project, so §1.4
--     skipped itself as written.
--   §6   two sessions on one ticket: B waited 7.25 s on A's row lock (one row in
--     pg_stat_activity waiting on Lock, never racing), and the ticket ended
--     holding exactly B ONE and B TWO at 50.00 -- none of A's. Repeated with A
--     rolling back instead of committing: the same, and no orphan line.
--   §7   the approval landing while the save waits: B raised 42501 'Ticket
--     PROBE-RTL-7 has been approved by the client ...' and the approved ticket
--     still read ORIGINAL 4 x 25 at 100.00. This is the one that proves
--     authorization is read AFTER the lock.
--   §8a  archive_clear_jobs waited 7.3 s for the save, then cleared the job: no
--     ticket, no line, no job left.
--   §8b  the save waited for the clear and raised P0002 'Ticket PROBE-RTL-8-T no
--     longer exists ...'. Nothing re-created under a job that had gone.
--   §8c  the deliberate deadlock resolved as OUTCOME II: Postgres cancelled the
--     CLEAR with 40P01 ('deadlock detected', reaching the caller as Postgres's
--     own words, which the app shows as a failed save). Asserted in full: the
--     job still there (1), both tickets at 0.00 -- A's two writes standing
--     together -- no lines, no orphans.
--   §9a  demoted to Coordinator while waiting: 42501 'Your account cannot price
--     tickets ...', ORIGINAL / 100.00 untouched. §9b  deactivated while waiting
--     (a seed account): the same refusal, because private.user_role() answers
--     null and null refuses. §9c  the ticket changed hands while waiting: 42501
--     'Ticket PROBE-RTL-9 belongs to another technician ...'. The seed account
--     was read back afterwards as Technician / null, and every PROBE-RTL fixture
--     is deleted; the orphan-line count across the whole table is 0.
--
-- Grants read back: EXECUTE to authenticated (and the owner/service role, as
-- every other definer RPC on this project), never anon and never public.
--
-- Replacing a ticket's billing is one transaction.
--
-- What it is for. The ticket editor's save replaces a ticket's lines with a
-- DELETE and then an INSERT, two round trips from a tablet. db.js holds the
-- old lines and puts them back if the insert fails, which covers the failure
-- it can see — but it only runs if the device is still alive to run it. Close
-- the tab, lose the battery, drive into a dead spot between the two calls and
-- the ticket is left with no lines and a total of $0, with nothing anywhere
-- that can put them back. That is somebody's day of welds, priced, gone; the
-- ticket looks saved and reads as free. No amount of ordering on the client
-- fixes it, because the client is the thing that goes away.
--
-- So the two statements move into the database, where "both or neither" is
-- what a transaction already means.
--
-- What it deliberately does NOT do:
--   * It does not write tickets.total. The total is the sync trigger's, as
--     it has been since the baseline, and the deferred balance constraint
--     still checks it at commit. A function that wrote the figure itself
--     would be a second source of truth for the money.
--   * It does not touch the ticket row at all — not the status, not the
--     reps, not the delays. Those are the caller's own UPDATE, under the
--     column grant and the tickets policy, and they stay there.
--   * It does not touch ticket_crew. The crew's hours are the timesheet and
--     have their own rules (they stay writable after an approval; the
--     billing does not).
--   * It is not a door into an approved ticket. Withdrawing an approval is
--     still withdraw_ticket_approval's, and this refuses everything the
--     immutability rules refuse.
--
-- The client's own refusal stays in front of it. updateTicket raises the
-- Awaiting-approval refusal with the `sentForApproval` flag, which the
-- outbox's replay reads to write the crew hours, skip the approval resend
-- and park the item — a bare database refusal would lose all of that. The
-- protected-status check below is the backstop for a caller that did not
-- read the row first, not a replacement for the one that did.

create or replace function public.replace_ticket_lines(_ticket_id text, _lines jsonb)
returns numeric
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  _uid    uuid := (select auth.uid());
  _role   text;
  _t      public.tickets%rowtype;
  _n      integer;
  _line   jsonb;
  _kind   text;
  _label  text;
  _qty    numeric;
  _rate   numeric;
  _sum    numeric := 0;
  _total  numeric;
begin
  -- ── Signed in at all ───────────────────────────────────────────────────
  -- Definer, so the checks below ARE the gate: nothing about this function is
  -- decided by a policy. Every one of them is written null-safe, because the
  -- interesting callers are the ones with nothing: no JWT at all (the
  -- publishable key on its own), a deactivated account (private.user_role()
  -- answers null for one, by 20260904135107), a profile that has gone. `=`
  -- against null is null and `if null then` does not run its branch, so each
  -- test is written to REFUSE on null rather than to permit on a match.
  --
  -- This one test is asked before the lock because it cannot change while we
  -- wait: auth.uid() is read out of the request's own JWT and is a constant
  -- for the life of the statement. Everything that a person or an Admin could
  -- change — the role, the deactivation, the ownership, the status — is asked
  -- AFTER the wait, below, and only after it.
  if _uid is null then
    raise exception 'You are not signed in — sign in again and save the ticket.'
      using errcode = '28000';
  end if;

  -- ── The row, locked ────────────────────────────────────────────────────
  -- FOR UPDATE on the PARENT is what makes two saves of one ticket a queue
  -- instead of a race. The line rows are deleted and re-inserted, so there is
  -- nothing stable to lock down there: two replacements running at once could
  -- interleave into a ticket holding half of each save's lines and a total
  -- that matches neither. Whoever takes the lock finishes; the other waits and
  -- then replaces what the first one wrote, which is last-write-wins — the
  -- rule the ticket editor already states, applied to a whole save rather
  -- than to individual rows.
  select * into _t from public.tickets where id = _ticket_id for update;
  if not found then
    raise exception 'Ticket % no longer exists — there is nothing to save onto.', _ticket_id
      using errcode = 'P0002';
  end if;

  -- ── Who is asking, AFTER the wait ──────────────────────────────────────
  -- The lock can be held by another save for as long as that save takes, and
  -- an office can do a great deal in that time: change somebody's role, lock
  -- their account, approve the ticket. Authorization read before the wait and
  -- spent after it is authorization for a state that has already gone —
  -- exactly the window this function exists to close, one level up. Read
  -- COMMITTED gives each statement its own snapshot, so every question below
  -- is answered against what is true NOW and not against the snapshot the
  -- wait began under; `_t` itself is the row this statement locked, which is
  -- likewise the committed one.
  select private.user_role() into _role;
  if _role is null or _role not in ('Admin', 'Technician') then
    -- The same rule as the ticket_lines policies: prices are Admins' and
    -- Technicians'. A role that cannot READ a ticket's lines must never be
    -- able to replace them — a Coordinator's save once read zero lines and
    -- deleted the real ones.
    raise exception 'Your account cannot price tickets, so it cannot change this ticket''s charges.'
      using errcode = '42501';
  end if;

  -- Protected status, from the row this statement has locked, and named in
  -- words the technician can act on. can_write_ticket below refuses an
  -- approved ticket too, but it refuses everything with one answer, and
  -- "another technician's" is not what happened here.
  if _t.approved_at is not null or _t.status in ('Approved', 'Invoiced') then
    raise exception 'Ticket % has been % — its charges cannot be changed. Raise a new ticket for any correction.',
      _ticket_id, case when _t.status = 'Invoiced' then 'invoiced' else 'approved by the client' end
      using errcode = '42501';
  end if;

  -- Ownership is private.can_write_ticket's answer and not a copy of it. It
  -- is the gate behind every ticket_lines and ticket_crew write already
  -- (20260907044223: own draft, or an Admin's), and this function is a door
  -- into exactly those rows — a second statement of the same rule here is a
  -- second thing to keep in step, and the one that would be forgotten. It is
  -- STABLE and called in its own statement after the lock, so it reads the
  -- committed role and the committed row, not the pre-wait ones.
  -- `coalesce(…, false)`: a null answer is a refusal.
  if not coalesce(private.can_write_ticket(_ticket_id), false) then
    raise exception 'Ticket % belongs to another technician — your account cannot change it.', _ticket_id
      using errcode = '42501';
  end if;

  -- ── The payload, before anything is deleted ────────────────────────────
  -- Validated in full first. The transaction would roll a later refusal back
  -- anyway, but a refusal that never touched a row is cheaper, and it cannot
  -- be misread in the log as a save that half happened.
  if _lines is null or jsonb_typeof(_lines) <> 'array' then
    raise exception 'The ticket''s charges were not sent in a form the database can read.'
      using errcode = '22023';
  end if;
  _n := jsonb_array_length(_lines);
  -- A ceiling on the count — not because a ticket has ever come near it, but
  -- because the array is the one input a caller controls entirely. The
  -- busiest real ticket on file is under a hundred lines.
  if _n > 1000 then
    raise exception 'A ticket cannot carry more than 1000 charges; this one has %.', _n
      using errcode = '22023';
  end if;

  for _line in select value from jsonb_array_elements(_lines) loop
    if jsonb_typeof(_line) <> 'object' then
      raise exception 'One of the ticket''s charges was not sent as a record.' using errcode = '22023';
    end if;
    _kind  := _line->>'kind';
    _label := _line->>'label';
    if _kind is null or _kind not in ('weld', 'charge') then
      raise exception 'A charge has to be a weld or a charge; "%" is neither.', coalesce(_kind, 'nothing')
        using errcode = '22023';
    end if;
    if _label is null or btrim(_label) = '' then
      raise exception 'Every charge needs a description.' using errcode = '22023';
    end if;
    if length(_label) > 300 or length(coalesce(_line->>'unit', '')) > 40 then
      raise exception 'A charge''s description is longer than the ticket can hold.' using errcode = '22023';
    end if;
    -- jsonb_typeof tells a number from a string that looks like one, so the
    -- casts below are only reached for real JSON numbers — and JSON has no
    -- NaN, so the string 'NaN' (a legal numeric literal in Postgres, and one
    -- every ordinary comparison lets through) cannot arrive as one. The
    -- explicit test is kept anyway, and written the one way that works:
    -- Postgres numeric NaN EQUALS itself, so the `x <> x` this was first
    -- written as is never true and tests nothing. It is named instead.
    if jsonb_typeof(_line->'quantity') <> 'number' or jsonb_typeof(_line->'unit_rate') <> 'number' then
      raise exception 'A charge''s quantity and rate have to be numbers.' using errcode = '22023';
    end if;
    _qty  := (_line->>'quantity')::numeric;
    _rate := (_line->>'unit_rate')::numeric;
    if _qty is null or _rate is null or _qty = 'NaN'::numeric or _rate = 'NaN'::numeric then
      raise exception 'A charge''s quantity and rate have to be numbers.' using errcode = '22023';
    end if;
    if _qty < 0 or _rate < 0 then
      raise exception 'A charge cannot have a negative quantity or rate.' using errcode = '22023';
    end if;
    -- The line's own charge, by the ONE formula: the rounded product, the
    -- same round(quantity * unit_rate, 2) the sync trigger and the balance
    -- constraint use, and the same figure lineTotal and lineCents produce on
    -- the client and in the invoice. A second formula here would be a third
    -- opinion about somebody's bill.
    _sum := _sum + round(_qty * _rate, 2);
  end loop;

  -- tickets.total is numeric(10,2). Overflowing it raises "numeric field
  -- overflow" from inside the sync trigger — not a sentence anybody can act
  -- on, and raised AFTER the delete, which is the exact shape of the beta
  -- bug. Refused here in words, before a row is touched, as assertBillable
  -- does on the client and with the same figure.
  if _sum > 99999999.99 then
    raise exception 'This ticket adds up to $%, which cannot be right — check the quantities and rates against what was actually worked.',
      to_char(_sum, 'FM999,999,999,990.00')
      using errcode = '22003';
  end if;

  -- Precision is deliberately NOT checked here. billableNumber refuses excess
  -- decimals at the client's write, where a typo can still be corrected; a
  -- ticket already on file may hold an orphan line filed at whatever
  -- precision its card carried that day, and refusing to save a ticket
  -- BECAUSE of a line it already has would strand it.

  -- ── Both, or neither ───────────────────────────────────────────────────
  delete from public.ticket_lines where ticket_id = _ticket_id;

  if _n > 0 then
    -- line_order is the ORDER OF THE ARRAY, not the sequence's next values.
    -- The column is only ever read as `where ticket_id = … order by
    -- line_order`, and every row of this ticket has just been deleted, so
    -- 1..n is a complete and stable order for it. It is also the only way to
    -- be sure of the order at all: nextval() in the target list of an
    -- INSERT … SELECT is not guaranteed to be evaluated in the source's
    -- sorted order, and the invoice prints by this column.
    insert into public.ticket_lines (ticket_id, kind, label, unit, quantity, unit_rate, line_order)
    select _ticket_id,
           e.value->>'kind',
           e.value->>'label',
           nullif(e.value->>'unit', ''),
           (e.value->>'quantity')::numeric,
           (e.value->>'unit_rate')::numeric,
           e.ord
      from jsonb_array_elements(_lines) with ordinality as e(value, ord);
  end if;

  -- What the trigger made of it, read back rather than assumed: the caller
  -- puts this figure on the foot bar, and the one number a save reports
  -- should be the number that is now on the row.
  select total into _total from public.tickets where id = _ticket_id;
  return _total;
end;
$function$;

comment on function public.replace_ticket_lines(text, jsonb) is
  'Replaces one ticket''s billing lines in a single transaction. Own draft or an Admin''s, price roles only, never an approved or invoiced ticket. The total stays the sync trigger''s.';

-- Signed-in accounts, never anonymous ones — the baseline's rule for every
-- RPC. The service role reaches ticket_lines directly (the backups and the
-- restore) and has no use for this door.
revoke execute on function public.replace_ticket_lines(text, jsonb) from public, anon;
grant execute on function public.replace_ticket_lines(text, jsonb) to authenticated;
