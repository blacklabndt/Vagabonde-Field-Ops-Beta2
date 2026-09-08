-- Probes for 20260908053815_the_token_hook_reads_profiles.sql.
-- Run as the postgres role; reads only.

-- 1. The hook's role can read profiles and reach the schema: expect t, t.
select has_table_privilege('supabase_auth_admin', 'public.profiles', 'SELECT'),
       has_schema_privilege('supabase_auth_admin', 'public', 'USAGE');

-- 2. The hook is still SECURITY INVOKER — the grant above is what carries
--    its read, so this must stay false or the grant is no longer the gate.
select prosecdef from pg_proc
 where proname = 'custom_access_token_hook' and pronamespace = 'public'::regnamespace;   -- f

-- 3. The read the hook makes, as that role: expect one row per profile,
--    and no "permission denied".
begin;
set local role supabase_auth_admin;
select count(*) from public.profiles;
rollback;

-- Run live 8 Sept 2026: t t, f, and the count.
