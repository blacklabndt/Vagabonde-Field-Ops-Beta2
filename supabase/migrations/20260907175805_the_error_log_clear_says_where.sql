-- The Admin screen's Clear button answered "DELETE requires a WHERE clause".
-- That is pg-safeupdate speaking: the authenticator role preloads it
-- (session_preload_libraries = supautils, safeupdate), and it refuses an
-- unfiltered DELETE or UPDATE in every statement the API's sessions run —
-- inside a security-definer function as much as at the top level. The
-- function's own gate is the Admin check above the delete; the WHERE it
-- needs is `where true`, which safeupdate accepts and which changes nothing
-- about what goes. The probe in supabase/handover cannot load the library
-- itself (not on this session's allowed list), so it checks the body and
-- the count under role simulation and leaves the refusal to the API.
create or replace function public.clear_function_errors()
returns integer
language plpgsql security definer set search_path to 'public' as $$
declare n integer;
begin
  if (select private.user_role()) is distinct from 'Admin' then
    raise exception 'Only an admin can clear the error log.' using errcode = '42501';
  end if;
  delete from public.function_errors where true;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.clear_function_errors() from public, anon;
grant execute on function public.clear_function_errors() to authenticated;
