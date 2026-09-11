-- Round 3, the live half: an EXPOSURE SCREEN, not a parity check.
--
-- probes-round3-decimal-parity.sql beside this one checks the arithmetic
-- against literal fixtures. This one asks the database which of its own
-- rows are worth replaying. READ ONLY: every statement is a SELECT.
-- Nothing here writes, and nothing here needs the GST snapshot migration.
--
-- What went wrong: until this fix the app computed a line as
--   Math.round(Math.round(quantity * 1000) * Math.round(unit_rate * 100) / 1000) / 100
-- which scales the rate to whole cents and the quantity to thousandths
-- before multiplying. That is correct only while every rate has at most two
-- decimals and every quantity three. ticket_lines.quantity and unit_rate are
-- bare `numeric` with no scale, so a rate filed at 0.575 was billed at 0.57
-- — while the sync_ticket_total trigger stored the exact
-- round(quantity * unit_rate, 2) all along.
--
-- WHAT THIS FILE CANNOT DO, stated plainly, because an earlier draft of it
-- claimed otherwise and was wrong twice:
--
--  * It cannot reproduce the old JavaScript. That formula's error comes
--    from DOUBLE rounding — Math.round(0.575 * 100) is 57 in JavaScript
--    and 58 in numeric, and Math.round(0.5005 * 1000) is 500 where numeric
--    says 501. Both operands wobble, in either direction. Arithmetic done
--    here in numeric is exact and therefore cannot land where the double
--    landed. An attempt to bracket it by rounding the rate both ways was
--    checked against quantity 0.5005 × rate 100 and missed: JavaScript
--    said 50.00, both SQL endpoints said 50.10.
--  * A row it returns is therefore a CANDIDATE, not a mismatch. Plenty
--    round identically both ways (quantity 1 × rate 1.001 is 1.00 either
--    way). Parity needs the operands replayed through the old JavaScript
--    and compared with the exact product — query 3 exports them for it.
--  * It cannot say what a client was actually sent or paid. A ticket can
--    have been re-saved since the email went. Query 4 names tickets to
--    investigate; the email and the invoice number are the record.
--
-- The predicates use a VALUE comparison (`unit_rate <> round(unit_rate, 2)`)
-- and not `scale()`: numeric keeps its trailing zeros, so scale(0.570) is 3
-- while the value is exactly representable in cents and was never at risk.

-- ── 1. Is there anything to replay? ────────────────────────────────────
-- Zero counts mean no current rows have excess operand precision. This
-- does not establish historical correctness or exclude other numeric errors.
select
  count(*) filter (where unit_rate <> round(unit_rate, 2))                                     as rate_finer_than_cents,
  count(*) filter (where quantity <> round(quantity, 3))                                       as quantity_finer_than_thousandths,
  count(*) filter (where unit_rate <> round(unit_rate, 2) or quantity <> round(quantity, 3))   as lines_to_replay,
  count(*)                                                                                     as lines_total
from public.ticket_lines;

-- ── 2. Whether a card can still file one ───────────────────────────────
-- About tomorrow as well as yesterday: a published card holding a
-- sub-cent rate files a line at one the next time anybody bills from it.
-- rate_lines is the whole of it — rate_overrides carries a job's basis and
-- bid reference and holds no price of its own.
select
  count(*) filter (where rate <> round(rate, 2)) as rate_finer_than_cents,
  count(*)                                       as rate_lines_total
from public.rate_lines;

-- ── 2b. The GST rates on file ──────────────────────────────────────────
-- A DIFFERENT question from query 2, which reads billing rates and says
-- nothing about tax. GST was computed as Math.round(cents * (rate / 100)),
-- a binary division before the multiply, so a rate whose quotient is
-- inexact could put the tax line a cent out — $50.00 at 0.03% is 1.5 cents
-- exactly, and the float answered 1. The fix is exact decimal, and at 5%
-- and 0% nothing changes; this says whether anything else is in use, which
-- has not been established either way.
select
  gst_rate,
  count(*) as clients
from public.clients
group by gst_rate
order by gst_rate;

-- ── 3. The operands, for replay ────────────────────────────────────────
-- Export these and run each pair through BOTH formulas in JavaScript —
-- node docs/reviews/round3-decimal-parity.mjs export.json
-- Save this result as a JSON array. Decimal text preserves the SQL digits.
-- Replay compares both formulas against `stored`, not merely each other.
-- This is a reconstruction using CURRENT operands, not sent-invoice evidence.
-- The 2000-row limit makes this a sample when the candidate count is larger;
-- paginate by l.id for a complete export and verify its count against query 1.
select
  l.id,
  l.ticket_id,
  l.label,
  l.unit,
  l.quantity::text as quantity,
  l.unit_rate::text as unit_rate,
  round(l.quantity * l.unit_rate, 2)::text as stored
from public.ticket_lines l
where l.unit_rate <> round(l.unit_rate, 2)
   or l.quantity <> round(l.quantity, 3)
order by l.id
limit 2000;

-- ── 4. Which of those tickets to investigate ───────────────────────────
-- Not proof of what was received or paid — a ticket can have been re-saved
-- since its email went, and only the sent invoice says what the client
-- saw. This narrows the reading: a Draft nobody ever sent is not anybody's
-- money, and an Invoiced ticket is.
with candidates as (
  select distinct ticket_id
  from public.ticket_lines
  where unit_rate <> round(unit_rate, 2)
     or quantity <> round(quantity, 3)
)
select
  t.status,
  count(*)                                              as tickets,
  count(*) filter (where t.approval_sent_at is not null) as approval_emailed,
  count(*) filter (where t.approved_at is not null)      as signed_by_client,
  count(*) filter (where t.invoiced_at is not null)      as invoiced,
  min(t.work_date)                                      as earliest,
  max(t.work_date)                                      as latest
from public.tickets t
join candidates c on c.ticket_id = t.id
group by t.status
order by t.status;

-- ── 5. The stored total is still the trigger's ─────────────────────────
-- Belt and braces, and independent of everything above: tickets.total
-- should equal the exact sum of its own lines on every ticket. If this
-- returns rows the problem is not the app's arithmetic and the trigger
-- itself needs reading.
select
  t.id, t.status, t.total, coalesce(s.lines_total, 0) as lines_total,
  t.total - coalesce(s.lines_total, 0) as difference
from public.tickets t
left join (
  select ticket_id, sum(round(quantity * unit_rate, 2)) as lines_total
  from public.ticket_lines group by ticket_id
) s on s.ticket_id = t.id
where t.total is distinct from coalesce(s.lines_total, 0)
order by abs(t.total - coalesce(s.lines_total, 0)) desc
limit 100;

-- ── 6. The crew columns hold what they should ──────────────────────────
-- storedNumber used toFixed, which answers "2.67" for 2.675 where
-- numeric(6,2) answers 2.68. That loss is NOT recoverable from the stored
-- rows — the app wrote a figure it had already rounded, so the column
-- agrees with itself and always will. This is here for the other failure:
-- a row finer than its column would mean the rounding was skipped on some
-- path, which is worth knowing and would be new.
select
  count(*) filter (where straight_hours <> round(straight_hours, 2)) as straight_finer,
  count(*) filter (where ot_hours       <> round(ot_hours, 2))       as ot_finer,
  count(*) filter (where solo_hours     <> round(solo_hours, 2))     as solo_finer,
  count(*) filter (where solo_ot_hours  <> round(solo_ot_hours, 2))  as solo_ot_finer,
  count(*) filter (where dose_mr        <> round(dose_mr, 2))        as dose_finer,
  count(*) filter (where mileage_km     <> round(mileage_km, 1))     as mileage_finer,
  count(*)                                                           as crew_rows
from public.ticket_crew;
