# Runbook — applying and probing `replace_ticket_lines`

For running the draft by hand in the Supabase SQL editor. The authority is
`probes-draft-replace-ticket-lines.sql`; this only says the ORDER, which tab
does what, and where each session must `commit` or `rollback`.

**Two tabs.** Open two SQL editor tabs and keep them apart for the whole of
part 2. Call them **A** and **B**. A session left open with a lock held
blocks the live app — if you stop halfway, run `rollback;` in BOTH tabs
before you walk away.

## Step 0 — the ids, once

Run in tab A and keep the answers beside you; every section below
substitutes them.

```sql
select id, role, deactivated_at, email
  from public.profiles p
  join auth.users u on u.id = p.id
 where u.email like '%@seed.vagabonde.ca'
 order by role;
```

You need: a **techA**, a **techB**, an **Admin**, a **Coordinator**, a
**Helper**, and one Admin you may lock and unlock (the probe puts it back).
Use SEED accounts only — 9b deactivates an account, and a lost connection
mid-probe locks a real person out of the app.

Also note a client uuid for section 8's job:
```sql
select id, name from public.clients limit 5;
```

## Step 1 — apply the draft

Paste `draft-replace-ticket-lines.sql` whole into tab A. Run it.
**Write down the applier's timestamp** (the SQL editor's own clock, UTC,
`YYYYMMDDHHMMSS`) — the migration file is named from it, and repo files and
applied migrations must reconcile 1:1.

## Step 2 — part 1 (sections 1–5)

Tab A. Paste the whole DO block from the head of
`probes-draft-replace-ticket-lines.sql` — from `do $probe$` to its
terminator. It is one transaction and ends in a deliberate rollback: nothing
it makes survives, fixtures included.

Expected: it raises its own NOTICEs and finishes with the rollback. Any
`EXCEPTION` that is not the closing one is a blocker — the function does not
ship.

## Step 3 — part 2, the four two-session procedures

Each is written out in full at the foot of the probe file. Order matters
only in that each rebuilds its own fixture.

| § | Tab A | Tab B | Who commits |
|---|---|---|---|
| 6 | the save, holding | — | A, then read the row |
| 7 | `for update`, holds; then approves | the save, HANGS | A commits, B raises 42501, B rolls back |
| 8a | the save, holds | `archive_clear_jobs`, HANGS | A commits, then B commits |
| 8b | the save, HANGS | the clear, holds | B commits, A raises P0002, A rolls back |
| 8c | save T, then save T2 (waits) | `for update` T2, then the clear (waits) | Postgres cancels ONE — record which |
| 9a | `for update`, holds; demotes techA | the save, HANGS | A commits, B raises 42501, B rolls back |
| 9b | as 9a but sets `deactivated_at` | the save, HANGS | same — then PUT THE ACCOUNT BACK |
| 9c | as 9a but reassigns `technician_id` | the save, HANGS | A commits, B refused by ownership |

Every "as somebody" session opens with the same three lines before its call:

```sql
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub','<uuid>','role','authenticated')::text, true);
```

**8c has no predetermined winner.** Both outcomes are written out in the
probe file; assert the one that happened, in full, and record which it was.

**After 9b, always:**
```sql
select role, deactivated_at from public.profiles where id = '<techA uuid>';
-- expect Technician, null
```

**After everything:**
```sql
select count(*) from public.ticket_lines l
  left join public.tickets t on t.id = l.ticket_id
 where t.id is null;    -- 0, always
delete from public.jobs   where job_number like 'PROBE-RTL-%';
delete from public.tickets where id like 'PROBE-RTL-%';
```

## Step 4 — file it

Give me the applier timestamp, the part 1 output, and the part 2 results
(including which side lost 8c). I write
`supabase/migrations/<timestamp>_a_ticket_saves_its_charges_atomically.sql`
with the draft's body, move the probes beside it, and record the results in
the migration's own header the way the other applied migrations do.
