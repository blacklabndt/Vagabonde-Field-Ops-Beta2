// Isolated PostgreSQL regression harness. Never connects to Supabase.
// Pass the file URL of an installed @electric-sql/pglite entrypoint as argv[2].
// --before verifies the regression against the original grants (must fail).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { PGlite } = await import(process.argv[2]);
const db = new PGlite();
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const baseline = read('../migrations/20260817040000_beta1_baseline.sql');
const table = baseline.match(/create table public\.tickets \([\s\S]*?\n\);/)[0];
let checks = 0;
const equal = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
const rows = async sql => (await db.query(sql)).rows;
const refused = async sql => {
  await assert.rejects(db.query(sql), e => e.code === '42501'); checks++;
};
async function caller(role, staff = true) {
  await db.exec('reset role');
  await db.query("select set_config('qa.role', $1, false), set_config('qa.staff', $2, false)", [role, String(staff)]);
  await db.exec('set role authenticated');
}
try {
  await db.exec(`
    create role authenticated; create role anon; create role service_role bypassrls;
    create schema private;
    create function private.user_role() returns text language sql stable as
      $$ select current_setting('qa.role', true) $$;
    create function public.is_staff() returns boolean language sql stable as
      $$ select coalesce(current_setting('qa.staff', true)::boolean, false) $$;
    grant usage on schema public, private to authenticated, anon, service_role;
    create table public.profiles (id uuid primary key, name text);
    create table public.clients (id uuid primary key, name text, gst_rate numeric);
    create table public.jobs (id uuid primary key, job_number text, project text, client_id uuid references clients);
    ${table}
    alter table public.tickets
      add column approved_signature text,
      add column approval_sent_to text,
      add column approval_sent_by uuid,
      add column client_key uuid,
      add column chased_at timestamptz,
      add column queried_at timestamptz,
      add column query_text text,
      add column query_by text,
      add column invoice_number integer,
      add column gst_rate numeric(5,2);
    alter table public.tickets enable row level security;
    create policy "tickets select" on public.tickets for select to authenticated using (public.is_staff());
    grant select on all tables in schema public to authenticated;
    grant all on public.tickets to service_role;
    -- Deliberately include a prior column grant: revoking table SELECT alone
    -- must not leave an old explicit total grant behind.
    grant select(total) on public.tickets to authenticated;
    -- Simulate Supabase defaults; the view must explicitly remove writes.
    alter default privileges in schema public grant all on tables to authenticated, anon;
    insert into clients values ('00000000-0000-0000-0000-000000000001','QA client',5);
    insert into jobs values ('00000000-0000-0000-0000-000000000002','QA-job','QA project','00000000-0000-0000-0000-000000000001');
    insert into profiles values ('00000000-0000-0000-0000-000000000003','QA technician');
    insert into tickets(id,job_id,technician_id,work_date,status,total,gst_rate,invoice_number)
      values ('QA-ticket','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',current_date,'Approved',123.45,5,17);
  `);
  if (!process.argv.includes('--before')) {
    await db.exec(read('./ticket-money-select.sql'));
    await db.exec(read('./ticket-money-select-enforce.sql'));
  }
  await caller('Helper');
  await refused('select total from public.tickets');
  await refused('select id from public.tickets where total > 100');
  await refused('select id from public.tickets order by total');
  await refused('select * from public.tickets');
  equal(await rows('select id,status from public.tickets'), [{ id: 'QA-ticket', status: 'Approved' }]);
  for (const role of ['Helper', 'Coordinator', 'Admin', 'Technician']) {
    await caller(role);
    const priced = ['Admin', 'Technician'].includes(role);
    equal(await rows('select id,total from public.tickets_read'), [{ id: 'QA-ticket', total: priced ? '123.45' : null }]);
    equal((await rows('select id from public.tickets_read where total > 100')).length, priced ? 1 : 0);
    const search = await rows('select * from public.search_tickets()');
    equal(search.length, 1);
    equal(search[0].total, priced ? '123.45' : null);
    equal(search[0].filtered_total, priced ? '123.45' : null);
    equal(search[0].invoice_number, 17);
    const stats = (await rows('select * from public.ticket_tracker_stats()'))[0];
    equal(String(stats.approved_count), '1');
    equal(stats.approved_total, priced ? '123.45' : null);
    const aging = (await rows('select * from public.ticket_aging()'))[0];
    equal(String(aging.tickets), '1');
    equal(aging.total, priced ? '123.45' : null);
    await refused("update public.tickets_read set status='Draft' where id='QA-ticket'");
    await refused("delete from public.tickets_read where id='QA-ticket'");
    await refused("insert into public.tickets_read(id,job_id,work_date) values ('bad','00000000-0000-0000-0000-000000000002',current_date)");
  }
  for (const role of ['Helper', 'Admin', 'Technician']) {
    await caller(role, false);
    equal(await rows('select id from public.tickets'), []);
    equal(await rows('select id,total from public.tickets_read'), []);
    equal(await rows('select * from public.search_tickets()'), []);
    equal(await rows('select * from public.ticket_aging()'), []);
    equal(String((await rows('select * from public.ticket_tracker_stats()'))[0].approved_count), '0');
  }
  await db.exec('reset role; set role anon');
  await refused('select * from public.tickets_read');
  await refused('select total from public.tickets');
  await db.exec('reset role; set role service_role');
  equal(await rows('select total from public.tickets'), [{ total: '123.45' }]);
  console.log(`PASS: ${checks} isolated PostgreSQL permission and RPC assertions. No live data used.`);
} finally {
  await db.close();
}
