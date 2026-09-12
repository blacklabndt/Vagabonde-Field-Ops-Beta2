-- DRAFT, NOT APPLIED. Phase 2, and only after every step in the header of
-- ticket-money-select.sql has been done -- in particular step 4, the
-- deployed-API probe of the reverse ticket_lines embed, and step 3, seeing
-- the new build load on a real tablet. This is the irreversible half: a
-- device still serving an old build from its service worker stops reading
-- tickets the moment this lands, and nobody in the office can refresh it
-- for the crew. Keep service_role grants untouched -- mail, the approval
-- page and the backups all read the money through them.
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
