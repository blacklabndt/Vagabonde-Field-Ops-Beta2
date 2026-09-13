-- APPLIED 12 Sept 2026 as version 20260912210854. Phase 2: the direct
-- total disclosure is closed. Phase 1 (20260912205211) built tickets_read and
-- rebuilt the three reporting RPCs over it; every reader was deployed, the new
-- build was confirmed loading on a real device, and the deployed-API probe
-- (probes-ticket-money-select-api.mjs) answered 200 on the reverse ticket_lines
-- embed before this was applied and 11/11 after it -- including the three
-- refusals below.
--
-- What this took away, from authenticated only: SELECT on the tickets table,
-- the column-level total grant under it, and -- by listing the columns that
-- stay -- approval_token, approval_expires_at and approved_ip. Nothing reads
-- those three on caller authority; approve-ticket and mailApproval reach them
-- with the service role, whose grants are untouched, as mail, the approval page
-- and the backups all need them.
--
-- A new column on tickets is NOT readable by a signed-in account until it is
-- added to this grant AND to tickets_read. That is the point of the explicit
-- list; it is also the trap.
begin;
do $$
begin
  if to_regclass('public.tickets_read') is null then
    raise exception 'Apply ticket-money-select.sql and deploy its readers before enforcement.';
  end if;
end $$;
revoke select on public.tickets from public, anon, authenticated;
-- Table-level revoke does not remove an existing column-level grant.
revoke select (total) on public.tickets from public, anon, authenticated;
-- Explicit list: newly added columns do not automatically become readable.
grant select (
  id, job_id, technician_id, work_date, status, client_contact,
  contractor_contact, approved_at, approved_by_email,
  invoiced_at, created_at, approval_sent_at,
  delays, approved_signature, approval_sent_to,
  approval_sent_by, client_key, chased_at, queried_at, query_text,
  query_by, invoice_number, gst_rate
) on public.tickets to authenticated;
-- approval_token, approval_expires_at and approved_ip are left out on
-- purpose, not by oversight: nothing reads them on caller authority, the
-- token is a stored credential and the IP is a client rep's. approve-ticket
-- and mailApproval reach them with the service role, whose grants are
-- untouched. tickets_read omits them for the same reason.
notify pgrst, 'reload schema';
commit;
