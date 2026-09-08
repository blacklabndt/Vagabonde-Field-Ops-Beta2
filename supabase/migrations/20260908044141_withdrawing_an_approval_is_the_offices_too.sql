-- Withdrawing an approval is the ticket's technician's or the office's.
--
-- 20260907044223 narrowed private.can_write_ticket to own-or-Admin, which
-- was right for the two callers it named — the ticket_lines and ticket_crew
-- policies, where a Coordinator has no business rewriting somebody's charges
-- or hours. It had a third caller it did not name: withdraw_ticket_approval,
-- which sits on the billing tracker, is deliberately not price-gated, and is
-- the office's way to kill a signing link before a client puts their name to
-- a figure that is wrong. A Coordinator pressing it has been told since then
-- that the ticket "isn't yours".
--
-- So the RPC states its own rule instead of borrowing the editor's: the
-- ticket's technician, an Admin, or a Coordinator. The approval columns stay
-- the service role's — this definer function is still the only door to them,
-- and the status/approved_at filters on the UPDATE are unchanged.
create or replace function public.withdraw_ticket_approval(p_id text)
returns integer
language plpgsql security definer set search_path to 'public' as $$
declare
  n integer;
begin
  if not (select is_staff()) then
    return 0;
  end if;
  if not exists (
    select 1 from public.tickets t
     where t.id = p_id
       and t.approved_at is null
       and (
         t.technician_id = (select auth.uid())
         or (select private.user_role()) = any (array['Admin'::text, 'Coordinator'::text])
       )
  ) then
    return 0;
  end if;
  update public.tickets
     set status = 'Draft', approval_token = null, approval_sent_at = null,
         approval_expires_at = null, approval_sent_to = null, approval_sent_by = null
   where id = p_id and status = 'Awaiting approval' and approved_at is null;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.withdraw_ticket_approval(text) from public, anon;
grant execute on function public.withdraw_ticket_approval(text) to authenticated;
