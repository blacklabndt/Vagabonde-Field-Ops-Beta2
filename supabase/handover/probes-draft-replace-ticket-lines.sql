-- Probes for the draft `replace_ticket_lines`. NOT RUN YET — the function is
-- not applied. Every one of them ends in ROLLBACK_ON_PURPOSE: the whole probe
-- is one transaction and nothing it makes survives it, fixtures included.
--
-- Run order: apply the draft function live, run part 1 (this file's DO
-- block), then part 2 — sections 6 to 9 at the foot, four two-session
-- procedures that cannot be automated inside one session because the thing
-- being proved in each is that a second session WAITS, and what is true by
-- the time it stops waiting.
--
-- What is asked, and why each one:
--
--   authorization   the function is SECURITY DEFINER, so its own tests are
--                   the whole gate and a null answer must refuse rather than
--                   fall through — the deactivated Admin and the no-JWT call
--                   are the two that a `= 'Admin'` written the other way
--                   round would let past.
--   status          an approved or invoiced ticket's charges are the client's
--                   record; withdraw_ticket_approval is the only way back.
--   payload         the array is the one input a caller controls entirely.
--   atomicity       the point of the whole exercise: a failure AFTER the
--                   delete must leave the ticket's old billing on the row.
--   agreement       ownership IS private.can_write_ticket's answer, asked
--                   after the lock; 1.9 asks it directly for the same three
--                   accounts, so a change to that helper shows up here as
--                   well as in the calls through the function.
--   the wait        sections 7 to 9: what a save is authorized against is
--                   what is true when the lock is granted, never what was
--                   true when it was asked for.
--
-- The tickets are made here and never borrowed: the probe deletes and
-- re-inserts a ticket's lines dozens of times, and it must not be pointed at
-- somebody's actual bill even inside a transaction that is thrown away. The
-- accounts ARE real ones — profiles.id is a foreign key to auth.users, so
-- there is no making a fake Admin — and the one that is altered (the locked
-- Admin) is put back in the same block as well as by the rollback.

do $probe$
declare
  _job     uuid;
  _techA   uuid;
  _techB   uuid;
  _admin   uuid;
  _coord   uuid;
  _helper  uuid;
  _locked  uuid;
  _tk      text := 'PROBE-RTL-1';
  _tk2     text := 'PROBE-RTL-2';
  _msg     text;
  _total   numeric;
  _labels  text[];
  _n       integer;
  _lines   jsonb := '[{"kind":"weld","label":"2in RT","unit":"ea","quantity":10,"unit_rate":12.5},
                      {"kind":"charge","label":"Mileage","unit":"km","quantity":100,"unit_rate":1.10},
                      {"kind":"charge","label":"Subsistence","unit":"day","quantity":1,"unit_rate":175}]'::jsonb;
  _canA    boolean;
  _canB    boolean;
  _canAdm  boolean;
begin
  -- ── Fixtures ───────────────────────────────────────────────────────────
  select id into _techA  from public.profiles where role = 'Technician'  and deactivated_at is null limit 1;
  select id into _techB  from public.profiles where role = 'Technician'  and deactivated_at is null and id <> _techA limit 1;
  select id into _admin  from public.profiles where role = 'Admin'       and deactivated_at is null limit 1;
  select id into _coord  from public.profiles where role = 'Coordinator' and deactivated_at is null limit 1;
  select id into _helper from public.profiles where role = 'Helper'      and deactivated_at is null limit 1;
  select id into _job    from public.jobs where status = 'Active' limit 1;
  if _techA is null or _techB is null or _admin is null or _job is null then
    raise exception 'no fixtures: need two active technicians, an Admin and an active job';
  end if;

  -- The locked Admin is a REAL Admin, deactivated for the length of this
  -- transaction and put back below: profiles.id is a foreign key to
  -- auth.users, so a made-up account cannot be inserted, and a locked one is
  -- the case that matters — private.user_role() answers null for it, and
  -- "null is not Admin" is the whole of the test.
  _locked := _admin;

  insert into public.tickets (id, job_id, technician_id, work_date, status)
  values (_tk, _job, _techA, current_date, 'Draft');
  insert into public.ticket_lines (ticket_id, kind, label, unit, quantity, unit_rate, line_order)
  values (_tk, 'weld', 'ORIGINAL A', 'ea', 4, 25, 1),
         (_tk, 'charge', 'ORIGINAL B', 'km', 10, 2, 2);
  select total into _total from public.tickets where id = _tk;
  if _total <> 120.00 then raise exception 'fixture total is % not 120.00', _total; end if;

  -- ═════════ 1 · Authorization ═══════════════════════════════════════════

  -- 1.1 the ticket's own technician replaces the lines, in order
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', _techA, 'role', 'authenticated')::text, true);
  _total := public.replace_ticket_lines(_tk, _lines);
  perform set_config('role', 'postgres', true);
  if _total <> 410.00 then raise exception 'FAIL 1.1a: the total came back % not 410.00', _total; end if;
  select array_agg(label order by line_order) into _labels from public.ticket_lines where ticket_id = _tk;
  if _labels <> array['2in RT','Mileage','Subsistence'] then
    raise exception 'FAIL 1.1b: the card''s order was not kept: %', _labels;
  end if;
  select total into _total from public.tickets where id = _tk;
  if _total <> 410.00 then raise exception 'FAIL 1.1c: the row says % — the trigger did not write the total', _total; end if;

  -- 1.2 another technician cannot
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', _techB, 'role', 'authenticated')::text, true);
  begin
    perform public.replace_ticket_lines(_tk, '[]'::jsonb);
    _msg := null;
  exception when others then _msg := sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  if _msg is null then raise exception 'FAIL 1.2: another technician emptied the ticket'; end if;
  select count(*) into _n from public.ticket_lines where ticket_id = _tk;
  if _n <> 3 then raise exception 'FAIL 1.2b: the refusal still cost the ticket its lines (% left)', _n; end if;

  -- 1.3 an Admin can — anyone's ticket, per Kyle
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', _admin, 'role', 'authenticated')::text, true);
  _total := public.replace_ticket_lines(_tk, _lines);
  perform set_config('role', 'postgres', true);
  if _total <> 410.00 then raise exception 'FAIL 1.3: an Admin could not price another technician''s ticket'; end if;

  -- 1.4 a Coordinator cannot: the price roles are the ticket_lines policies'
  if _coord is not null then
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', _coord, 'role', 'authenticated')::text, true);
    begin
      perform public.replace_ticket_lines(_tk, '[]'::jsonb);
      _msg := null;
    exception when others then _msg := sqlerrm;
    end;
    perform set_config('role', 'postgres', true);
    if _msg is null then raise exception 'FAIL 1.4: a Coordinator replaced a ticket''s charges'; end if;
  end if;

  -- 1.5 a Helper cannot
  if _helper is not null then
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', _helper, 'role', 'authenticated')::text, true);
    begin
      perform public.replace_ticket_lines(_tk, '[]'::jsonb);
      _msg := null;
    exception when others then _msg := sqlerrm;
    end;
    perform set_config('role', 'postgres', true);
    if _msg is null then raise exception 'FAIL 1.5: a Helper replaced a ticket''s charges'; end if;
  end if;

  -- 1.6 a locked Admin cannot: user_role() answers null, and null refuses
  update public.profiles set deactivated_at = now() where id = _locked;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', _locked, 'role', 'authenticated')::text, true);
  begin
    perform public.replace_ticket_lines(_tk, '[]'::jsonb);
    _msg := null;
  exception when others then _msg := sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  update public.profiles set deactivated_at = null where id = _locked;
  if _msg is null then raise exception 'FAIL 1.6: a deactivated Admin replaced a ticket''s charges'; end if;

  -- 1.7 nobody signed in at all: the publishable key on its own
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  begin
    perform public.replace_ticket_lines(_tk, '[]'::jsonb);
    _msg := null;
  exception when others then _msg := sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  if _msg is null then raise exception 'FAIL 1.7: a call with no account behind it replaced the charges'; end if;

  -- 1.8 the anon role holds no grant on the function at all
  perform set_config('role', 'anon', true);
  begin
    perform public.replace_ticket_lines(_tk, '[]'::jsonb);
    _msg := null;
  exception when others then _msg := sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  if _msg is null then raise exception 'FAIL 1.8: anon can call replace_ticket_lines'; end if;

  -- 1.9 the gate itself, asked directly: own draft yes, another's no,
  -- an Admin's yes. The function calls this same helper after the lock, so
  -- a change to it is a change to the door and is read here too.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', _techA, 'role', 'authenticated')::text, true);
  select private.can_write_ticket(_tk) into _canA;
  perform set_config('request.jwt.claims', json_build_object('sub', _techB, 'role', 'authenticated')::text, true);
  select private.can_write_ticket(_tk) into _canB;
  perform set_config('request.jwt.claims', json_build_object('sub', _admin, 'role', 'authenticated')::text, true);
  select private.can_write_ticket(_tk) into _canAdm;
  perform set_config('role', 'postgres', true);
  if not _canA or _canB or not _canAdm then
    raise exception 'FAIL 1.9: can_write_ticket answers %/%/% where the function answers yes/no/yes', _canA, _canB, _canAdm;
  end if;

  -- ═════════ 2 · Protected status ════════════════════════════════════════

  -- 2.1 Awaiting approval — the client is holding a link to this ticket
  update public.tickets set status = 'Awaiting approval' where id = _tk;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', _techA, 'role', 'authenticated')::text, true);
  begin
    _total := public.replace_ticket_lines(_tk, '[]'::jsonb);
    _msg := null;
  exception when others then _msg := sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  -- Deliberately NOT refused by this function: the ticket is still a Draft as
  -- far as the immutability rules go, the technician still owns it, and
  -- withdrawing is not needed to correct a typo before the client signs. The
  -- refusal that matters here is updateTicket's, on the client, which carries
  -- the sentForApproval flag the outbox's replay reads — see the draft's
  -- header. This probe records that the database is NOT the gate for it.
  if _msg is not null then
    raise exception 'NOTE 2.1: an Awaiting-approval ticket was refused by the database (%). Expected the client refusal to be the gate.', _msg;
  end if;

  -- 2.2 Approved: refused, and the lines are untouched
  update public.tickets set status = 'Draft' where id = _tk;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', _techA, 'role', 'authenticated')::text, true);
  perform public.replace_ticket_lines(_tk, _lines);
  perform set_config('role', 'postgres', true);
  update public.tickets set status = 'Approved', approved_at = now(), approved_by_email = 'probe@example.test' where id = _tk;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', _techA, 'role', 'authenticated')::text, true);
  begin
    perform public.replace_ticket_lines(_tk, '[]'::jsonb);
    _msg := null;
  exception when others then _msg := sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  if _msg is null then raise exception 'FAIL 2.2: an approved ticket''s charges were replaced'; end if;
  select count(*), total into _n, _total from public.ticket_lines l join public.tickets t on t.id = l.ticket_id
   where l.ticket_id = _tk group by total;
  if _n <> 3 or _total <> 410.00 then raise exception 'FAIL 2.2b: the approved ticket now reads % lines at %', _n, _total; end if;

  -- 2.3 an Admin is refused an approved ticket too — this is not a rank
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', _admin, 'role', 'authenticated')::text, true);
  begin
    perform public.replace_ticket_lines(_tk, '[]'::jsonb);
    _msg := null;
  exception when others then _msg := sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  if _msg is null then raise exception 'FAIL 2.3: an Admin re-priced an approved ticket without withdrawing it'; end if;

  -- 2.4 Invoiced, likewise
  update public.tickets set status = 'Invoiced', invoiced_at = now() where id = _tk;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', _admin, 'role', 'authenticated')::text, true);
  begin
    perform public.replace_ticket_lines(_tk, '[]'::jsonb);
    _msg := null;
  exception when others then _msg := sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  if _msg is null then raise exception 'FAIL 2.4: an invoiced ticket''s charges were replaced'; end if;

  -- 2.5 a ticket that has gone
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', _admin, 'role', 'authenticated')::text, true);
  begin
    perform public.replace_ticket_lines('PROBE-RTL-NOPE', '[]'::jsonb);
    _msg := null;
  exception when others then _msg := sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  if _msg is null then raise exception 'FAIL 2.5: a ticket that does not exist was priced'; end if;

  -- ═════════ 3 · The payload ═════════════════════════════════════════════
  -- A fresh draft, so every refusal below is measured against known lines.
  update public.tickets set status = 'Draft', approved_at = null, invoiced_at = null,
                            approved_by_email = null where id = _tk;

  -- The role is set around each CALL and dropped again for every verifying
  -- read: ticket_lines is behind an RLS select policy that wants the price
  -- role and a tab, and a count read as the caller would answer zero for a
  -- reason that has nothing to do with what is being probed.

  -- Each of these must refuse AND leave the three lines and the $410 total.
  -- Written as one loop over the payloads so a new refusal cannot be added
  -- without the "and it changed nothing" half.
  declare
    _bad jsonb;
    _why text;
  begin
    foreach _why in array array[
      'not an array', 'an element that is not a record', 'an unknown kind',
      'an empty label', 'a quantity that is a string', 'a NaN quantity',
      'a negative quantity', 'a negative rate', 'a missing rate',
      'a total over the column'
    ] loop
      _bad := case _why
        when 'not an array'                   then '{"kind":"weld"}'::jsonb
        when 'an element that is not a record' then '["2in RT"]'::jsonb
        when 'an unknown kind'                then '[{"kind":"discount","label":"x","quantity":1,"unit_rate":1}]'::jsonb
        when 'an empty label'                 then '[{"kind":"weld","label":"   ","quantity":1,"unit_rate":1}]'::jsonb
        when 'a quantity that is a string'    then '[{"kind":"weld","label":"x","quantity":"10","unit_rate":1}]'::jsonb
        when 'a NaN quantity'                 then '[{"kind":"weld","label":"x","quantity":"NaN","unit_rate":1}]'::jsonb
        when 'a negative quantity'            then '[{"kind":"weld","label":"x","quantity":-1,"unit_rate":1}]'::jsonb
        when 'a negative rate'                then '[{"kind":"weld","label":"x","quantity":1,"unit_rate":-1}]'::jsonb
        when 'a missing rate'                 then '[{"kind":"weld","label":"x","quantity":1}]'::jsonb
        when 'a total over the column'        then '[{"kind":"weld","label":"x","quantity":1000000,"unit_rate":1000}]'::jsonb
      end;
      perform set_config('role', 'authenticated', true);
      perform set_config('request.jwt.claims', json_build_object('sub', _techA, 'role', 'authenticated')::text, true);
      begin
        perform public.replace_ticket_lines(_tk, _bad);
        _msg := null;
      exception when others then _msg := sqlerrm;
      end;
      perform set_config('role', 'postgres', true);
      if _msg is null then raise exception 'FAIL 3: % was accepted', _why; end if;
      select count(*) into _n from public.ticket_lines where ticket_id = _tk;
      if _n <> 3 then raise exception 'FAIL 3: % refused, but the ticket lost its lines (% left)', _why, _n; end if;
    end loop;
  end;

  -- 3.11 null for the array is refused the same way
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', _techA, 'role', 'authenticated')::text, true);
  begin
    perform public.replace_ticket_lines(_tk, null::jsonb);
    _msg := null;
  exception when others then _msg := sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  if _msg is null then raise exception 'FAIL 3.11: a null payload was accepted'; end if;

  -- 3.12 more than a thousand
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', _techA, 'role', 'authenticated')::text, true);
  begin
    perform public.replace_ticket_lines(_tk, (
      select jsonb_agg(jsonb_build_object('kind','weld','label','x','quantity',1,'unit_rate',1))
        from generate_series(1, 1001)));
    _msg := null;
  exception when others then _msg := sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  if _msg is null then raise exception 'FAIL 3.12: a 1001-line ticket was accepted'; end if;

  -- 3.13 an empty array IS a save: a ticket priced at nothing is legitimate
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', _techA, 'role', 'authenticated')::text, true);
  _total := public.replace_ticket_lines(_tk, '[]'::jsonb);
  perform set_config('role', 'postgres', true);
  if _total <> 0 then raise exception 'FAIL 3.13: an emptied ticket reads %', _total; end if;
  select count(*) into _n from public.ticket_lines where ticket_id = _tk;
  if _n <> 0 then raise exception 'FAIL 3.13b: % lines left', _n; end if;

  -- 3.14 sub-cent precision agrees with the trigger and the invoice: half an
  -- hour at $9.25 is $4.63 by round(), not $4.62 and not a balance failure.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', _techA, 'role', 'authenticated')::text, true);
  _total := public.replace_ticket_lines(_tk,
    '[{"kind":"charge","label":"Half hour","unit":"h","quantity":0.5,"unit_rate":9.25}]'::jsonb);
  perform set_config('role', 'postgres', true);
  if _total <> 4.63 then raise exception 'FAIL 3.14: the half hour priced at % not 4.63', _total; end if;

  -- ═════════ 4 · Atomicity ═══════════════════════════════════════════════
  -- The whole reason the function exists. A failure that lands AFTER the
  -- delete must leave the ticket's old billing exactly where it was.
  --
  -- Forced with a trigger made here and rolled back with everything else:
  -- there is no legitimate payload that passes the validation above and then
  -- fails on the insert, which is the point — but the field failure this
  -- replaces was a dropped connection between two round trips, and a trigger
  -- that raises is the only honest way to stage that inside one session.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', _techA, 'role', 'authenticated')::text, true);
  perform public.replace_ticket_lines(_tk, _lines);
  perform set_config('role', 'postgres', true);
  select total into _total from public.tickets where id = _tk;
  if _total <> 410.00 then raise exception 'FAIL 4 setup: the ticket is at % not 410.00', _total; end if;

  execute $t$
    create or replace function private.probe_boom() returns trigger
    language plpgsql as $b$
    begin
      if new.label = 'Mileage' then raise exception 'probe: the write died halfway'; end if;
      return new;
    end $b$;
  $t$;
  execute 'create trigger probe_boom before insert on public.ticket_lines for each row execute function private.probe_boom()';

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', _techA, 'role', 'authenticated')::text, true);
  begin
    perform public.replace_ticket_lines(_tk,
      '[{"kind":"weld","label":"NEW A","unit":"ea","quantity":1,"unit_rate":1},
        {"kind":"charge","label":"Mileage","unit":"km","quantity":1,"unit_rate":1}]'::jsonb);
    _msg := null;
  exception when others then _msg := sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  execute 'drop trigger probe_boom on public.ticket_lines';
  execute 'drop function private.probe_boom()';

  if _msg is null then raise exception 'FAIL 4.1: the half-failed write reported success'; end if;
  select array_agg(label order by line_order), count(*) into _labels, _n
    from public.ticket_lines where ticket_id = _tk;
  if _n <> 3 or _labels <> array['2in RT','Mileage','Subsistence'] then
    raise exception 'FAIL 4.2: the ticket''s old charges did not come back: % (%)', _labels, _n;
  end if;
  select total into _total from public.tickets where id = _tk;
  if _total <> 410.00 then
    raise exception 'FAIL 4.3: the ticket is at % — a failed save changed the money', _total;
  end if;

  -- 4.4 and the same failure through the OLD client-side dance would have
  -- left it empty. Recorded as arithmetic rather than run: delete-then-insert
  -- from a device is two statements in two transactions, and the first one
  -- commits on its own.

  -- ═════════ 5 · A second ticket is not touched ══════════════════════════
  insert into public.tickets (id, job_id, technician_id, work_date, status)
  values (_tk2, _job, _techA, current_date, 'Draft');
  insert into public.ticket_lines (ticket_id, kind, label, unit, quantity, unit_rate, line_order)
  values (_tk2, 'weld', 'OTHER TICKET', 'ea', 2, 50, 1);
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', _techA, 'role', 'authenticated')::text, true);
  perform public.replace_ticket_lines(_tk, '[]'::jsonb);
  perform set_config('role', 'postgres', true);
  select count(*), max(total) into _n, _total from public.ticket_lines l
    join public.tickets t on t.id = l.ticket_id where l.ticket_id = _tk2;
  if _n <> 1 or _total <> 100.00 then
    raise exception 'FAIL 5: emptying one ticket reached another (% lines, %)', _n, _total;
  end if;

  -- ═════════ 5b · The deferred balance constraint, made to fire ══════════
  -- tickets_total_balances is a DEFERRABLE INITIALLY DEFERRED constraint
  -- trigger: it is checked at COMMIT, and this whole probe deliberately never
  -- commits. So every assertion above about the total is an assertion about
  -- what the sync trigger WROTE, and not one of them is an assertion about
  -- what the constraint would have said — a probe that only ever rolls back
  -- cannot prove a commit-time check by sitting there.
  --
  -- `set constraints all immediate` makes the pending checks run NOW, inside
  -- the transaction, and raise here if the ticket does not balance. It is the
  -- one way to ask the commit's question without committing. Run after the
  -- replacements above, so what it checks is the state they left.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', _techA, 'role', 'authenticated')::text, true);
  _total := public.replace_ticket_lines(_tk, _lines);
  perform set_config('role', 'postgres', true);
  begin
    set constraints all immediate;
    _msg := null;
  exception when others then _msg := sqlerrm;
  end;
  set constraints all deferred;
  if _msg is not null then
    raise exception 'FAIL 5b.1: the ticket does not balance at commit time: %', _msg;
  end if;
  if _total <> 410.00 then raise exception 'FAIL 5b.2: the returned total is % not 410.00', _total; end if;

  -- 5b.3 the same question after an emptied ticket, which is the case where
  -- the trigger writes 0 and the constraint has a sum of no rows to agree
  -- with — the shape a coalesce written the wrong way round gets wrong, and
  -- one that only a commit-time check would ever catch.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', _techA, 'role', 'authenticated')::text, true);
  perform public.replace_ticket_lines(_tk, '[]'::jsonb);
  perform set_config('role', 'postgres', true);
  begin
    set constraints all immediate;
    _msg := null;
  exception when others then _msg := sqlerrm;
  end;
  set constraints all deferred;
  if _msg is not null then
    raise exception 'FAIL 5b.3: an emptied ticket does not balance at commit time: %', _msg;
  end if;

  raise exception 'ROLLBACK_ON_PURPOSE all probes passed';
end $probe$;

-- ═════════ Session setup for every two-session probe below ══════════════
-- READ THIS FIRST. Sections 6 to 9 are run by hand in separate psql sessions,
-- and both halves of the role simulation they use are TRANSACTION-LOCAL:
-- `set local role` is documented as having no effect at all outside a
-- transaction block (it warns and is discarded), and `set_config(..., true)`
-- is local by that third argument. A session that runs them at the prompt and
-- then calls the function is calling it as the OWNER with no claims — which
-- passes every check for the wrong reason and proves nothing.
--
-- So every simulated-caller session below is written as one transaction and
-- has to be run as one. The recipe, once, and referred to as «as techA»:
--
--   begin;
--     set local role authenticated;
--     select set_config('request.jwt.claims',
--       json_build_object('sub','<techA uuid>','role','authenticated')::text, true);
--     -- the call under test goes here; it is what blocks
--   commit;    -- or rollback; each probe says which, and it MATTERS:
--              -- the lock is held until the transaction ends, so a session
--              -- left open blocks the next probe and the app with it.
--
-- «as an Admin» is the same with the Admin's uuid. «as postgres» means the
-- owning superuser role with no simulation at all — it is standing in for the
-- service role (approve-ticket, archive's RPC), which is what those two
-- really run as.
--
-- Check the simulation actually took before trusting any refusal:
--   select current_user, current_setting('request.jwt.claims', true);
-- inside the transaction. `authenticated` and the claims you set, or stop.
--
-- Every session that is told to «hold open» must be ended — commit or
-- rollback — before the next probe is started. `select pid, state, query from
-- pg_stat_activity where state = 'idle in transaction';` finds one forgotten.

-- ═════════ 6 · Concurrency, two sessions ═════════════════════════════════
-- What is being proved: FOR UPDATE on the parent ticket makes two saves of
-- one ticket a queue, and the loser writes its whole payload over the
-- winner's — never half of each. It cannot be done in one session, because
-- the second call has to BLOCK.
--
-- Session A (as techA — the full preamble above, inside its begin):
--   begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims',
--     json_build_object('sub','<techA uuid>','role','authenticated')::text, true);
--   select public.replace_ticket_lines('<draft ticket>',
--     '[{"kind":"weld","label":"A ONE","quantity":1,"unit_rate":10}]');
--   -- leave the transaction OPEN
--
-- Session B (as techA in its own session, or as an Admin — same preamble):
--   begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims',
--     json_build_object('sub','<techA uuid>','role','authenticated')::text, true);
--   select public.replace_ticket_lines('<draft ticket>',
--     '[{"kind":"weld","label":"B ONE","quantity":1,"unit_rate":20},
--       {"kind":"weld","label":"B TWO","quantity":1,"unit_rate":30}]');
--   -- this must HANG rather than answer. B stays open until A ends.
--
-- Session C (or any psql):
--   select count(*) from pg_stat_activity
--    where wait_event_type = 'Lock' and query like '%replace_ticket_lines%';
--   -- expect 1: B is waiting on A's row lock, not racing it.
--
-- Session A:
--   commit;                       -- B unblocks and finishes
-- Session B:
--   commit;                       -- and must be ended too, or it holds the row
--
-- Then, as postgres:
--   select label, line_order from public.ticket_lines
--    where ticket_id = '<draft ticket>' order by line_order;
--   -- expect exactly B ONE, B TWO — the whole of B's save, none of A's.
--   select total from public.tickets where id = '<draft ticket>';
--   -- expect 50.00.
--
-- Repeat with A rolling back instead of committing: B still finishes with
-- exactly its own two lines, and the ticket never passes through a state
-- holding one line from each.
--
-- Afterwards, put the ticket back: this half is NOT rolled back for you.
-- Use a ticket made for the purpose and delete it when the check is done.

-- ═════════ 7 · A replacement against an approval ═════════════════════════
-- What is being proved: a save that is waiting on the ticket's lock, with an
-- approval landing while it waits, cannot end with the approved ticket
-- carrying the waiting save's charges. This is the field case — a technician
-- taps Save in a dead spot, the reply is slow, and the office (or the client's
-- own signature through approve-ticket) approves the ticket in that second.
--
-- It is the reason authorization is read AFTER the lock and never before it:
-- a status read before a wait says nothing about the status after it.
--
-- Fixture, as postgres (make them, never borrow them):
--   insert into public.tickets (id, job_id, technician_id, work_date, status)
--   values ('PROBE-RTL-7', '<active job uuid>', '<techA uuid>', current_date, 'Draft');
--   insert into public.ticket_lines (ticket_id, kind, label, unit, quantity, unit_rate, line_order)
--   values ('PROBE-RTL-7', 'weld', 'ORIGINAL', 'ea', 4, 25, 1);
--
-- Session A (as postgres — standing in for approve-ticket's service role):
--   begin;
--   select id from public.tickets where id = 'PROBE-RTL-7' for update;
--   -- leave the transaction OPEN
--
-- Session B (as techA — and the begin is not optional: without it the two
-- SET LOCALs are discarded and the call runs as the owner, which SUCCEEDS and
-- reads as a passing probe while proving the opposite of what it claims):
--   begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims',
--     json_build_object('sub','<techA uuid>','role','authenticated')::text, true);
--   select current_user;     -- 'authenticated', or stop here
--   select public.replace_ticket_lines('PROBE-RTL-7',
--     '[{"kind":"weld","label":"LATE SAVE","quantity":1,"unit_rate":999}]');
--   -- must HANG on A's lock. When it unblocks and raises, end it:
--   rollback;
--
-- Session A:
--   update public.tickets
--      set status = 'Approved', approved_at = now(), approved_by_name = 'probe'
--    where id = 'PROBE-RTL-7';
--   commit;
--
-- Expected: B does NOT succeed. It unblocks, re-reads the row it has just
-- locked, finds Approved, and raises
--   'Ticket PROBE-RTL-7 has been approved by the client — its charges cannot
--    be changed. Raise a new ticket for any correction.'   (SQLSTATE 42501)
-- Then, as postgres:
--   select label, quantity, unit_rate from public.ticket_lines
--    where ticket_id = 'PROBE-RTL-7';
--   -- expect ORIGINAL 4 x 25 and nothing else: the approved ticket is what
--   -- the client signed.
--   select total from public.tickets where id = 'PROBE-RTL-7';   -- 100.00
--
-- A failure here — B succeeding, or the ticket ending at 999.00 — means the
-- status was read from the pre-wait snapshot, and the function must not ship.
--
-- Cleanup, as postgres:
--   delete from public.tickets where id = 'PROBE-RTL-7';

-- ═════════ 8 · A replacement against archive_clear_jobs ══════════════════
-- What is being proved: the app's other bulk delete and this function cannot
-- corrupt each other, and that if they deadlock it is a clean rollback with a
-- real error rather than half a ticket.
--
-- archive_clear_jobs deletes jobs and everything under them, tickets and their
-- lines included, and it takes its locks in its own order. A save running
-- against a ticket on a job being cleared is the collision.
--
-- Fixture, as postgres: a job of its own, with one draft ticket on it.
--   insert into public.jobs (job_number, client_id, status, created_by)
--   values ('PROBE-RTL-8', '<client uuid>', 'Active', '<admin uuid>')
--   returning id;                                   -- <probe job uuid>
--   insert into public.tickets (id, job_id, technician_id, work_date, status)
--   values ('PROBE-RTL-8-T', '<probe job uuid>', '<techA uuid>', current_date, 'Draft');
--   insert into public.ticket_lines (ticket_id, kind, label, unit, quantity, unit_rate, line_order)
--   values ('PROBE-RTL-8-T', 'weld', 'ORIGINAL', 'ea', 4, 25, 1);
--
-- 8a · the clear waits for the save.
-- Every session below is "as" somebody in the preamble's sense: begin, the two
-- SET LOCALs, the call. They are written short here; run them long.
--
--   Session A (as techA):
--     begin;
--     set local role authenticated;
--     select set_config('request.jwt.claims',
--       json_build_object('sub','<techA uuid>','role','authenticated')::text, true);
--     select public.replace_ticket_lines('PROBE-RTL-8-T',
--       '[{"kind":"weld","label":"SAVED","quantity":1,"unit_rate":10}]');   -- hold open
--   Session B (as an Admin):
--     begin;
--     set local role authenticated;
--     select set_config('request.jwt.claims',
--       json_build_object('sub','<admin uuid>','role','authenticated')::text, true);
--     select public.archive_clear_jobs(array['<probe job uuid>']::uuid[]);
--     -- must HANG: it cannot delete rows A has locked.
--   Session A: commit;
--   Session B: commit;
--   Expected: B completes; the job, the ticket and its lines are all gone.
--     select count(*) from public.tickets where id = 'PROBE-RTL-8-T';           -- 0
--     select count(*) from public.ticket_lines where ticket_id = 'PROBE-RTL-8-T'; -- 0
--   The save committed and was then deleted with the job it was on, which is
--   what the Admin asked for. No orphan line, no ticket with no job.
--
-- 8b · the save waits for the clear.
--   Rebuild the fixture, then:
--   Session B (as an Admin; begin, set local role, set_config, then):
--     select public.archive_clear_jobs(array['<probe job uuid>']::uuid[]);   -- hold open
--   Session A (as techA; the same preamble, then):
--     select public.replace_ticket_lines('PROBE-RTL-8-T', '[]'::jsonb);      -- must HANG
--   Session B: commit;
--   Session A: rollback;   -- after reading the error
--   Expected: A raises 'Ticket PROBE-RTL-8-T no longer exists — there is
--   nothing to save onto.' (SQLSTATE P0002) — the `if not found` after the
--   FOR UPDATE, which is what that branch is for. Not a null, not a silent
--   success, and no row re-created under a job that has gone.
--
-- 8c · deadlock, deliberately.
--   Rebuild the fixture with TWO draft tickets on the probe job (…-T, …-T2).
--   Both tickets start with ORIGINAL 'ea' 4 x 25 - total 100.00 each - so
--   "unchanged" is one figure to check and not a judgement.
--   Session A (as techA; begin, set local role, set_config, then):
--     select public.replace_ticket_lines('PROBE-RTL-8-T', '[]'::jsonb);        -- locks T
--   Session B (as an Admin; the same preamble, then):
--     select id from public.tickets where id = 'PROBE-RTL-8-T2' for update;    -- locks T2
--   Session A:
--     select public.replace_ticket_lines('PROBE-RTL-8-T2', '[]'::jsonb);       -- waits on B
--   Session B:
--     select public.archive_clear_jobs(array['<probe job uuid>']::uuid[]);     -- waits on A
--
--   After deadlock_timeout (1 s by default) Postgres cancels exactly ONE of
--   them with SQLSTATE 40P01, 'deadlock detected'. WHICH one is not ours to
--   choose, so both outcomes are written out and the one that happened is
--   asserted in full. Record which it was, and the exact message.
--
--   Outcome I - A loses (the technician's save is cancelled):
--     * A's session is in a failed transaction; A runs `rollback;`.
--     * B then completes its clear and commits.
--     * As postgres, afterwards:
--         select count(*) from public.jobs where job_number = 'PROBE-RTL-8';   -- 0
--         select count(*) from public.tickets where id in
--           ('PROBE-RTL-8-T','PROBE-RTL-8-T2');                                -- 0
--         select count(*) from public.ticket_lines where ticket_id in
--           ('PROBE-RTL-8-T','PROBE-RTL-8-T2');                                -- 0
--       A's emptying of T rolled back with the rest of A, and the clear then
--       deleted everything, which is the Admin's own act. Nothing partial.
--
--   Outcome II - B loses (the clear is cancelled):
--     * B's session is in a failed transaction; B runs `rollback;`.
--     * A then completes its second replacement and commits.
--     * As postgres, afterwards:
--         select count(*) from public.jobs where job_number = 'PROBE-RTL-8';   -- 1
--         select id, total from public.tickets
--          where id in ('PROBE-RTL-8-T','PROBE-RTL-8-T2') order by id;
--         -- BOTH 0.00: A emptied T before the wait and T2 after it, and A is
--         -- the side that survived, so both of A's own writes stand together.
--         select count(*) from public.ticket_lines where ticket_id in
--           ('PROBE-RTL-8-T','PROBE-RTL-8-T2');                                -- 0
--       The job is untouched, and the clear left NOTHING behind - not one
--       deleted ticket, not one orphan line - which is the point of asserting
--       it rather than assuming it.
--
--   True of both outcomes, and a blocker if either fails:
--     * the loser's transaction rolled back WHOLE - no ticket anywhere holding
--       lines from one side and a total from the other, and no row of a
--       deleted job left behind;
--     * the error REACHES THE CALLER. 40P01 is not one of the sentences this
--       function writes, so it arrives as PostgREST's own, which the app shows
--       as a failed save the technician retries - and a retry after a deadlock
--       is safe precisely because nothing of the cancelled side landed;
--     * select count(*) from public.ticket_lines l
--         left join public.tickets t on t.id = l.ticket_id
--        where t.id is null;    -- 0, always.
--
-- Cleanup, as postgres:
--   delete from public.jobs where job_number = 'PROBE-RTL-8';   -- cascades

-- ═════════ 9 · The role changes while the save waits ═════════════════════
-- What is being proved: authorization is spent no earlier than it is read. A
-- save that starts while the caller is a Technician and finishes after the
-- office has demoted or locked that account must be refused, not honoured.
-- This is the amendment the pre-lock role read failed: private.user_role()
-- called before a wait answers about a state that is over by the time it is
-- used, and READ COMMITTED gives the post-lock call its own fresh snapshot.
--
-- Fixture, as postgres: a draft ticket 'PROBE-RTL-9' owned by techA, one line
-- ORIGINAL 4 x 25 (total 100.00), exactly as section 7.
--
-- 9a · demoted while waiting.
--   Session A (postgres): begin;
--     select id from public.tickets where id = 'PROBE-RTL-9' for update;   -- hold
--   Session B (as techA - begin, set local role, set_config, then):
--     select public.replace_ticket_lines('PROBE-RTL-9',
--       '[{"kind":"weld","label":"AFTER DEMOTION","quantity":1,"unit_rate":999}]');
--     -- hangs; `rollback;` once it raises
--   Session A: update public.profiles set role = 'Coordinator' where id = '<techA uuid>';
--              commit;
--   Expected: B raises 'Your account cannot price tickets, so it cannot change
--   this ticket''s charges.' (42501), and the ticket still reads ORIGINAL /
--   100.00.
--   Put it back, as postgres:
--     update public.profiles set role = 'Technician' where id = '<techA uuid>';
--
-- 9b · locked while waiting.
--   The same shape, but Session A does
--     update public.profiles set deactivated_at = now() where id = '<techA uuid>';
--   before committing. private.user_role() answers null for a deactivated
--   account (20260904135107), and null must REFUSE rather than fall through:
--   expect the same 42501 and an unchanged ticket.
--   Put it back: update public.profiles set deactivated_at = null where id = '<techA uuid>';
--   Do 9b on a SEED account (@seed.vagabonde.ca) and never on a crew member's:
--   a deactivation left behind by a lost connection locks a real person out of
--   the app.
--
-- 9c · the ticket changes hands while the save waits.
--   Session A holds the lock and does
--     update public.tickets set technician_id = '<techB uuid>' where id = 'PROBE-RTL-9';
--   before committing. Expected: B (techA, still a Technician) is refused with
--   'Ticket PROBE-RTL-9 belongs to another technician — your account cannot
--   change it.' — private.can_write_ticket, asked after the lock, reading the
--   committed row.
--
-- Cleanup, as postgres:
--   delete from public.tickets where id = 'PROBE-RTL-9';
--   -- and confirm the account is as it was:
--   --   select role, deactivated_at from public.profiles where id = '<techA uuid>';
--   --   expect Technician, null
