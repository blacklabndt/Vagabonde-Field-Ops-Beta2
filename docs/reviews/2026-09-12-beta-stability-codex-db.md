# Beta stability — database contracts

Reviewed 12 September 2026 against checkout initially reported as `0008969`. Read-only investigation; no product edits, database writes, deployments, or migrations. Read CLAUDE.md database/access and migration rules; no AGENTS.md found in repository file inventory.

## Confirmed findings

### High: interrupted replacement can leave an existing ticket without its billing lines

Location: `vite-app/src/db.js:3375–3393`, especially the compensating insert at 3388–3391.

Trigger: editing a draft successfully deletes its old lines, then the connection remains unavailable for both the replacement insert and the attempted restoration. These are separate PostgREST transactions. The old lines have already been committed away; both insert attempts fail. The restoration's returned error and rejection are discarded. The function throws the original network error while the database retains an empty ticket (the line trigger brings its total to zero).

Confirmed by executing the actual `Db.updateTicket` implementation with real data helpers and a stateful PostgREST-shaped fake. Initial state: one $100 line. Intended replacement: one $200 line. Actual output:

```json
{"error":"Failed to fetch: persistent connection loss","remainingLines":[],"insertAttempts":2,"history":["tickets:update","ticket_lines:select","ticket_lines:delete","ticket_lines:insert","ticket_lines:insert"]}
```

This is a local fault injection, not a claim that a production ticket was damaged. Outbox/recovery data may allow a later retry to repair the draft; the server state is nevertheless destructive until repair, and a closed browser cannot perform the compensating request. The comments promising that the money does not vanish are stronger than the implementation. An atomic database operation for guarded line replacement would close the gap; retries alone cannot make several requests atomic.

Executable reproduction from repository root (Node; no network/database access):

```js
// Save as a temporary .cjs file at repository root, then run node <file>.
(async () => {
  const fs = require('fs');
  const data = await import('./vite-app/src/data.js');
  const source = fs.readFileSync('vite-app/src/db.js', 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  let saved = [{kind:'charge',label:'Old',unit:'ea',quantity:1,unit_rate:100,line_order:1}];
  let inserts = 0;
  const history = [];
  const client = {from(table) {
    let op = 'select';
    return {
      select(){return this}, eq(){return this}, order(){return this},
      update(){op='update';return this}, delete(){op='delete';return this},
      insert(){op='insert';return this},
      maybeSingle(){return Promise.resolve({data:{status:'Draft',job_id:'J',total:100,jobs:{status:'Open'}}})},
      then(ok,bad) {
        history.push(table+':'+op);
        let result;
        if(table==='tickets') result={data:[{id:'T'}]};
        else if(op==='select') result={data:saved.slice()};
        else if(op==='delete'){saved=[];result={error:null}}
        else{inserts++;result={error:new Error('Failed to fetch: persistent connection loss')}}
        return Promise.resolve(result).then(ok,bad);
      }
    };
  }};
  const deps={...data,sbClient:client,isNetworkError:()=>true,Toasts:{show(){}}};
  const Db=new Function(...Object.keys(deps),source+';return Db;')(...Object.values(deps));
  try {
    await Db.updateTicket({ticketId:'T',lines:[{kind:'charge',label:'New',unit:'ea',quantity:1,unit_rate:200}],status:'Draft'});
  } catch(e) {
    console.log(JSON.stringify({error:e.message,remainingLines:saved,insertAttempts:inserts,history}));
  }
})();
```

### Low: checked-in isolated SQL regression harness names deleted draft files

`supabase/handover/probes-ticket-money-select.mjs:67–68` reads `./ticket-money-select.sql` and `./ticket-money-select-enforce.sql`, but these have been filed as timestamped migrations. Running the harness as documented with the existing PGlite package fails ENOENT before its assertions. Replacing only those two paths in memory with `../migrations/20260912205211_a_ticket_total_is_read_through_a_view.sql` and `../migrations/20260912210854_a_ticket_total_is_read_through_a_view_enforced.sql` allowed all **99 isolated PostgreSQL permission and RPC assertions to pass**. Repository files were not changed.

## Verification and coverage

- `node --test vite-app/src/ticketMoneyRead.test.mjs vite-app/src/paging.test.mjs vite-app/src/ticketFingerprint.test.mjs`: **21/21 pass**.
- Inspected view owner rights, security barrier, explicit staff predicate, masked total, base column grants, service-role retention, and reporting RPC replacements. No new incompatibility confirmed in current caller read paths. Remaining direct ticket reads inspected name allowed metadata; monetary reads use `tickets_read`.
- Phase 1 and phase 2 ordering is explicit in migration files. Full migration replay and live migration-ledger reconciliation were not performed by this agent, so 1:1 live consistency is not independently certified.
- Parent independently reports seven successful authenticated read-only live API checks, including numeric priced totals, reverse and forward embeds, metadata, and exact `403/42501` refusals. See `docs/reviews/beta-stability-live-read.txt`. This agent did not obtain Helper credentials or repeat those requests.
- Parent identified two weaknesses in the existing live probe: `row.total !== null || Number(row.total) === 0` also accepts null; denial assertions accepting any HTTP >=400 can mistake server errors for authorization enforcement. These are coverage defects, not independently proven application defects.
- Keyset helper tests cover a reduced static API cap and deletion during traversal. `listTicketsForExport` (`db.js:2837–2863`) remains offset-based; concurrent deletion can skip a surviving ticket. This limitation is already explicitly documented in source. It is not a newly discovered regression, and no snapshot-consistent accounting export was established.
- Ticket idempotency uses a unique client key and resolves an existing record before insertion/retries. It prevents duplicate headers but does not make header, lines and crew writes one transaction. The destructive replacement reproduction above is separate from duplicate prevention.

No claim is made that browser/offline recovery repairs every interrupted save, that simultaneous edits are serialized, or that backup/restore operations are snapshot consistent. Those require additional integration/concurrency testing.
