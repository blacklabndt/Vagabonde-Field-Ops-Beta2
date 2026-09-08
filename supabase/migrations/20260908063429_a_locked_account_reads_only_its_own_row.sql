-- A locked account's unexpired token reads nothing of the directory but
-- its own row.
--
-- delete-user locks an account with work on file — Auth ban, tab_access
-- emptied, deactivated_at stamped — but the token it already holds stays
-- good for up to an hour, and PostgREST never asks Auth. private.tab_access()
-- answers empty for that account, so every other table refuses it; the
-- 20260903054919 pass narrowed contacts, equipment, timesheet_approvals and
-- arcade_scores to is_staff() for exactly this reason and left profiles on
-- "anybody signed in": names, roles, certs, id codes, unit numbers and the
-- three dosimeter serials of the whole crew, readable by an ex-employee for
-- the rest of the hour.
--
-- Staff (at least one tab) read the directory as before; anyone signed in
-- reads their own row, which is how the app learns at boot that the account
-- is locked. is_staff() is SECURITY DEFINER, so naming it in a policy on
-- the table it reads does not recurse. The token hook's own policy, for
-- supabase_auth_admin, is untouched.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using ((select public.is_staff()) or id = (select auth.uid()));
