-- DRAFT — not applied, not filed under migrations. Reviewed by Codex before
-- it goes anywhere near the live project; the timestamp comes from the
-- applier, and the file is written under supabase/migrations/ with that
-- version only once it has been applied. See CLAUDE.md, "Migrations".
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
  -- ── Who is asking ──────────────────────────────────────────────────────
  -- Definer, so the checks below ARE the gate: nothing about this function
  -- is decided by a policy. Every one of them is written null-safe, because
  -- the interesting callers are the ones with nothing: no JWT at all (the
  -- publishable key on its own), a deactivated account (private.user_role()
  -- answers null for one, by 20260904135107), a profile that has gone. `=`
  -- against null is null and `if null then` does not run its branch, so each
  -- test is written to REFUSE on null rather than to permit on a match.
  if _uid is null then
    raise exception 'You are not signed in — sign in again and save the ticket.'
      using errcode = '28000';
  end if;

  select private.user_role() into _role;
  if _role is null or _role not in ('Admin', 'Technician') then
    -- The same rule as the ticket_lines policies: prices are Admins' and
    -- Technicians'. A role that cannot READ a ticket's lines must never be
    -- able to replace them — a Coordinator's save once read zero lines and
    -- deleted the real ones.
    raise exception 'Your account cannot price tickets, so it cannot change this ticket''s charges.'
      using errcode = '42501';
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

  -- ── Whose ticket, and may it still be changed ──────────────────────────
  -- Mirrors private.can_write_ticket (own draft, or an Admin's) and states it
  -- rather than borrowing it, so the whole rule is legible at the one door
  -- that can empty a ticket's billing — and so it is read from the row this
  -- statement has LOCKED, not from a second, unlocked look at the same table.
  -- The probes assert the two still agree.
  if _t.approved_at is not null or _t.status in ('Approved', 'Invoiced') then
    raise exception 'Ticket % has been % — its charges cannot be changed. Raise a new ticket for any correction.',
      _ticket_id, case when _t.status = 'Invoiced' then 'invoiced' else 'approved by the client' end
      using errcode = '42501';
  end if;
  if _role <> 'Admin' and _t.technician_id is distinct from _uid then
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
    -- casts below are only reached for real numbers. 'NaN' is a legal numeric
    -- literal in Postgres and every comparison against it is false, which
    -- would make it slip past a sign test written the other way round; it is
    -- caught by name here rather than by luck.
    if jsonb_typeof(_line->'quantity') <> 'number' or jsonb_typeof(_line->'unit_rate') <> 'number' then
      raise exception 'A charge''s quantity and rate have to be numbers.' using errcode = '22023';
    end if;
    _qty  := (_line->>'quantity')::numeric;
    _rate := (_line->>'unit_rate')::numeric;
    if _qty is null or _rate is null or _qty <> _qty or _rate <> _rate then
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
