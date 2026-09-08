-- The token hook reads profiles as supabase_auth_admin.
--
-- public.custom_access_token_hook is SECURITY INVOKER: Auth calls it as
-- supabase_auth_admin at every token issue, and its read of profiles runs
-- with that role's own privileges. The live project has always carried
-- `supabase_auth_admin=r` on public.profiles (and USAGE on the schema), but
-- the baseline's transcription of the ACLs dropped it — the RLS policy at
-- the baseline's line 1369 is written for that role and, without the table
-- grant, attaches to nothing. In a fresh environment the hook's own
-- `exception when others then return event` then swallowed "permission
-- denied for table profiles" and issued every token with no tab_access or
-- app_role claim and no error anywhere.
--
-- A no-op on the live project; it is here so the repo stands the hook up
-- working on replay.
grant usage on schema public to supabase_auth_admin;
grant select on table public.profiles to supabase_auth_admin;
