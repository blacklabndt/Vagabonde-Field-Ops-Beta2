-- Probes for 20260908044141_withdrawing_an_approval_is_the_offices_too.sql.
-- Run as the postgres role; every block rolls back, so nothing moves.
-- Needs one ticket at 'Awaiting approval' with approved_at null; the live
-- project had no Coordinator account, so the Coordinator arm promotes a
-- technician inside the transaction that is rolled back.

-- 1. A Coordinator may withdraw another technician's approval: expect 1.
begin;
update public.profiles set role = 'Coordinator' where id = '<some technician id>';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"<that technician id>","role":"authenticated"}', true);
select public.withdraw_ticket_approval('<awaiting ticket id>');   -- 1
rollback;

-- 2. Another technician may not: expect 0, no row touched.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"<other technician id>","role":"authenticated"}', true);
select public.withdraw_ticket_approval('<awaiting ticket id>');   -- 0
rollback;

-- 3. The ticket's own technician may: expect 1.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"<its technician id>","role":"authenticated"}', true);
select public.withdraw_ticket_approval('<awaiting ticket id>');   -- 1
rollback;

-- Run live 8 Sept 2026 against AT-0809-25-02: 1, 0, 1.
