begin;
set local lock_timeout='5s';
create temp table crash_probe_results(label text, actual text);
do $p$
declare u uuid := (select id from auth.users order by created_at limit 1); r text; n int;
begin
 r:=public.file_browser_crash(u,'2099-01-01T00:00','chunk-load','board','screen','release-probe');
 assert r='filed';
 r:=public.file_browser_crash(u,'2099-01-01T00:00','type-error','job','screen','release-probe');
 assert r='rate_limited';
 select count(*) into n from public.browser_crashes where app_version='release-probe'; assert n=1;
 select count(*) into n from public.function_errors where context->>'app_version'='release-probe'; assert n=1;
 begin
 insert into public.browser_crashes select * from public.browser_crashes where app_version='release-probe';
 raise exception 'duplicate accepted'; exception when unique_violation then null; end;
 r:=public.file_browser_crash(u,'2099-01-01T00:01','chunk-load','board','screen','release-probe'); assert r='filed';
 begin perform public.file_browser_crash(u,'2099-01-01T00:02','made-up','board','screen','release-probe'); raise exception 'category accepted'; exception when check_violation then null; end;
 begin perform public.file_browser_crash(u,'2099-01-01T00:02','unknown','/approve?token=abc','screen','release-probe'); raise exception 'route accepted'; exception when check_violation then null; end;
 begin perform public.file_browser_crash(u,'2099-01-01T00:02','unknown','board','screen','https://example.com/token'); raise exception 'version accepted'; exception when check_violation then null; end;
end $p$;
select set_config('request.jwt.claims',json_build_object('sub',(select id from profiles where role='Admin' limit 1),'role','authenticated')::text,true);
set local role authenticated;
do $p$ declare n int; begin
 select count(*) into n from public.browser_crashes where app_version='release-probe'; assert n=2;
 begin insert into public.browser_crashes(user_id,minute_bucket,error_category,route_id,component_id,app_version) values(auth.uid(),'2099-01-01T00:03','unknown','board','screen','release-probe'); raise exception 'write accepted'; exception when insufficient_privilege then null; end;
 begin perform public.file_browser_crash(auth.uid(),'2099-01-01T00:03','unknown','board','screen','release-probe'); raise exception 'RPC accepted'; exception when insufficient_privilege then null; end;
end $p$;
reset role;
select set_config('request.jwt.claims',json_build_object('sub',(select id from profiles where role='Technician' and deactivated_at is null limit 1),'role','authenticated')::text,true);
set local role authenticated;
do $p$ declare n int; begin select count(*) into n from public.browser_crashes where app_version='release-probe'; assert n=0; end $p$;
reset role;
alter table public.function_errors add constraint probe_refuse_browser check(function_name<>'browser') not valid;
do $p$ declare n int; begin
 begin perform public.file_browser_crash((select id from auth.users order by created_at limit 1),'2099-01-01T00:04','unknown','board','screen','release-probe'); raise exception 'log rejection ignored'; exception when check_violation then null; end;
 select count(*) into n from public.browser_crashes where minute_bucket='2099-01-01T00:04'; assert n=0;
end $p$;
alter table public.function_errors drop constraint probe_refuse_browser;
create unique index probe_browser_release_unique on public.function_errors(message) where context->>'app_version'='collision-probe';
insert into public.function_errors(function_name,message,context) values('browser','ErrorBoundary (screen) on board: chunk-load','{"app_version":"collision-probe"}');
do $p$ declare n int; begin
 begin perform public.file_browser_crash((select id from auth.users order by created_at limit 1),'2099-01-01T00:05','chunk-load','board','screen','collision-probe'); raise exception 'log collision ignored'; exception when unique_violation then null; end;
 select count(*) into n from public.browser_crashes where minute_bucket='2099-01-01T00:05'; assert n=0;
end $p$;
rollback;
select 'PASS: probes 1-9 including 8b; assertions succeeded; all changes rolled back' as result;