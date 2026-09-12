-- DRAFT, NOT APPLIED. Phase 2 only AFTER ticket-money-select.sql, reader
-- deployment (app, Ask, render-invoice), and PostgREST embedded-read probes.
-- Older browser builds must refresh; they can no longer read tickets.total.
-- Keep service_role grants untouched: mail, approval and backups use them.
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
  contractor_contact, approved_at, approved_by_email, approved_ip,
  invoiced_at, created_at, approval_token, approval_sent_at,
  approval_expires_at, delays, approved_signature, approval_sent_to,
  approval_sent_by, client_key, chased_at, queried_at, query_text,
  query_by, invoice_number, gst_rate
) on public.tickets to authenticated;
notify pgrst, 'reload schema';
commit;
