-- Probes for the draft `replace_ticket_lines`. NOT RUN YET — the function is
-- not applied. Every one of them ends in ROLLBACK_ON_PURPOSE: the whole probe
-- is one transaction and nothing it makes survives it, fixtures included.
--
-- Run order: apply the draft function live, run part 1 (this file's DO
-- block), then part 2 (the two-session concurrency procedure at the foot,
-- which cannot be automated inside one session because the thing being
-- proved is that a second session WAITS).
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
--   agreement       the inline rule must still answer what
--                   private.can_write_ticket answers, or there are two rules.
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

  -- 1.9 the inline rule and private.can_write_ticket still answer the same
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

  raise exception 'ROLLBACK_ON_PURPOSE all probes passed';
end $probe$;

-- ═════════ 6 · Concurrency, two sessions ═════════════════════════════════
-- What is being proved: FOR UPDATE on the parent ticket makes two saves of
-- one ticket a queue, and the loser writes its whole payload over the
-- winner's — never half of each. It cannot be done in one session, because
-- the second call has to BLOCK.
--
-- Session A:
--   begin;
--   select public.replace_ticket_lines('<draft ticket>',
--     '[{"kind":"weld","label":"A ONE","quantity":1,"unit_rate":10}]');
--   -- leave the transaction OPEN
--
-- Session B (same account, or an Admin):
--   select public.replace_ticket_lines('<draft ticket>',
--     '[{"kind":"weld","label":"B ONE","quantity":1,"unit_rate":20},
--       {"kind":"weld","label":"B TWO","quantity":1,"unit_rate":30}]');
--   -- this must HANG rather than answer.
--
-- Session C (or any psql):
--   select count(*) from pg_stat_activity
--    where wait_event_type = 'Lock' and query like '%replace_ticket_lines%';
--   -- expect 1: B is waiting on A's row lock, not racing it.
--
-- Session A:
--   commit;                       -- B unblocks and finishes
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
