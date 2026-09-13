# Beta stability review: application session, offline state, recovery

Date: 2026-09-12. Baseline: `0008969`. Read-only investigation; no product edits, commits, production requests, mail sends, or password changes. All reproductions below use synthetic local data. Other agents own their own files.

## Results

Three confirmed issues: two High and one Medium. Severity reflects prerequisites stated below; no automatic account takeover or confirmed production data exposure is claimed.

Run all three retained reproductions from the repository root: `node docs/reviews/beta-stability-app-repro.mjs`. This runner executes the exact JavaScript blocks below in isolated Node processes; it passed after the report was written.

### APP-1 — High: a fabricated recovery hash opens password change over the existing session

Locations: `vite-app/src/recovery.js:28-33`; `vite-app/src/components/auth.jsx:227`; recovery gate in `vite-app/src/App.jsx:1141`. Installed SDK behavior: `vite-app/node_modules/@supabase/auth-js/src/GoTrueClient.ts:671-690,3898`.

Trigger: someone already signed in follows a URL ending `#access_token=abc&type=recovery`. The app accepts any nonempty access-token text as evidence of recovery. The SDK rejects the incomplete URL with `No session defined in URL` and deliberately preserves the existing valid session. The recovery form then calls `updateUser({password})` against that existing session.

Impact: a crafted reset-looking link can induce an existing user to change their current account password through a screen falsely claiming that they followed a valid reset link. **The user must type and submit a new password. This is not an automatic password change, credential disclosure, or demonstrated account takeover.** Without an existing valid session, this reproduction does not establish a successful password update.

Evidence: actual installed `GoTrueClient`, synthetic storage, actual recovery module, and a completely stubbed fetch returned:

```json
{"pending":true,"urlError":"No session defined in URL","retainedUser":"existing-user","updateRequest":{"url":"https://local.invalid/auth/v1/user","method":"PUT","authorization":"Bearer existing-valid-session"}}
```

Existing `recovery.test.mjs` explicitly treats `#access_token=abc&type=recovery` as a real recovery landing, so the passing test currently preserves the unsafe assumption. Recovery detection should distinguish a provisional URL hint from an SDK-validated recovery session; merely requiring additional nonempty URL fields would not validate a token.

Reproduce from `vite-app` using `node --input-type=module` with this JavaScript on stdin (all fetches are mocked):

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const hash = '#access_token=abc&type=recovery';
globalThis.window = {
  location: { href: 'https://local.invalid/' + hash, hash, pathname: '/', search: '' },
  history: { replaceState() {} }, addEventListener() {}, removeEventListener() {}
};
globalThis.document = {
  visibilityState: 'visible', addEventListener() {}, removeEventListener() {}
};
const { GoTrueClient } = await import('@supabase/auth-js');
const session = {
  access_token: 'existing-valid-session', refresh_token: 'existing-refresh',
  expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600,
  token_type: 'bearer', user: { id: 'existing-user', email: 'existing@local.invalid' }
};
const store = new Map([['probe-auth', JSON.stringify(session)]]);
const requests = [];
const client = new GoTrueClient({
  url: 'https://local.invalid/auth/v1', storageKey: 'probe-auth',
  storage: {
    getItem: k => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k)
  },
  autoRefreshToken: false, detectSessionInUrl: true,
  fetch: async (url, init) => {
    requests.push({ url, method: init.method, authorization: init.headers.Authorization });
    return new Response(JSON.stringify({ id: 'existing-user', email: 'existing@local.invalid' }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
});
globalThis.__probeClient = { auth: client };
const source = (await readFile('./src/recovery.js', 'utf8')).replace(
  'import { sbClient } from "./config.js";', 'const sbClient=globalThis.__probeClient;');
const { Recovery } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const init = await client.initialize();
assert.equal(Recovery.pending(), true);
assert.equal(init.error.message, 'No session defined in URL');
const before = await client.getSession();
assert.equal(before.data.session.user.id, 'existing-user');
assert.equal((await client.updateUser({ password: 'local-fake-password' })).error, null);
assert.equal(requests[0].authorization, 'Bearer existing-valid-session');
console.log({ pending: Recovery.pending(), urlError: init.error.message,
  retainedUser: before.data.session.user.id, updateRequest: requests[0] });
await client.stopAutoRefresh();
process.exit(0);
```

### APP-2 — High: a previous account's delayed read repopulates the next account's cache

Locations: `vite-app/src/offlineCache.js:175` (`claimFor`), `:234-254` (`readThrough`); real unscoped reference-data caller at `vite-app/src/db.js:545` (`contacts`); app handover at `vite-app/src/App.jsx:815`.

Trigger: account A has a request in flight; account B takes ownership with `claimFor(B)`, which clears the store; A's already-started request then resolves. `readThrough` writes A's response into the now B-owned cache without checking an owner/generation captured before the request.

Impact: B can receive A's cached response when B's corresponding request subsequently fails on the network. The cache owner still says B, so later same-owner claims retain the contaminated entry. A delayed response crossing an account handover is required. The synthetic test proves the ownership invariant fails; it does not claim a particular live contact was private to one actual account. The mechanism also applies to keys holding permission-sensitive data such as job records and rates.

Evidence: `cache.owner === account-B` while offline read of `contacts` returned `[{"name":"A private contact"}]`. Neither cancellation of the React consumer nor clearing at sign-out prevents the module's delayed write. Owner-scoped storage or an ownership generation checked before writes/fallback is needed to make the handover durable.

Reproduce from `vite-app` with stdin to `node --input-type=module`:

```js
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
const { OfflineCache: cache } = await import('./src/offlineCache.js');
await cache.claimFor('account-A');
let resolveOld;
const oldRead = cache.readThrough('contacts', () => new Promise(r => resolveOld = r));
await cache.claimFor('account-B');
resolveOld([{ name: 'A private contact' }]);
await oldRead;
// A readThrough write deliberately runs asynchronously. Wait for the observable row.
for (let i = 0; i < 100 && !(await cache.read('contacts')); i++)
  await new Promise(r => setTimeout(r, 5));
const stale = await cache.readThrough('contacts', () => { throw new TypeError('Failed to fetch'); });
assert.equal(await cache.owner(), 'account-B');
assert.equal(stale[0].name, 'A private contact');
console.log('owner:', await cache.owner(), 'offline result:', stale);
```

### APP-3 — Medium: two tabs drain the same persisted queue item concurrently

Locations: `vite-app/src/offlineQueue.js:118,120,159,226`; auto-flush per signed-in app at `vite-app/src/App.jsx:600-604`; report email replay at `vite-app/src/App.jsx:389-401`.

Trigger: the same account has two tabs/app windows open on the same origin with a queued item. Both auto-flush after load/reconnection before either handler completes. The mutex is module-local, while IndexedDB is shared across tabs. Both read the same item and invoke its handler.

Impact: repeat side effects, particularly duplicate report-email requests: the replay handler sends each time, and `supabase/functions/send-report/index.ts:79` invokes `mailReport`, whose `supabase/functions/_shared/mailReport.ts:90` calls `sendMail`. No replay-level cross-tab claim or send idempotency key was found in that path. Existing client keys protect some database creates, so **this is not evidence that every ticket/JHA/report row necessarily duplicates**. The actual confirmed runtime observation is two handler invocations for one persisted item; no email was sent in this review. Both tabs also report a successful sync for the same item.

Evidence: two independent copies of the actual module sharing one fake IndexedDB produced `calls === 2`, with each result `{"synced":1,"stillOffline":false}`. This models independent tab module state without needing a live browser or network. A cross-context lock/claim or server-side side-effect idempotency should cover reconnect drains.

Reproduce from `vite-app` with stdin to `node --input-type=module`:

```js
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
const { OfflineQueue: tabA } = await import('./src/offlineQueue.js?tab=A');
const { OfflineQueue: tabB } = await import('./src/offlineQueue.js?tab=B');
tabA.setOwner('account-A'); tabB.setOwner('account-A');
await tabA.enqueue('probe', { value: 1 });
let calls = 0, release;
const gate = new Promise(r => release = r);
const handler = async () => { calls++; if (calls === 2) release(); await gate; };
const timeout = setTimeout(() => { console.error('Second invocation not observed'); process.exit(1); }, 2000);
const results = await Promise.all([tabA.flush({ probe: handler }), tabB.flush({ probe: handler })]);
clearTimeout(timeout);
assert.equal(calls, 2);
console.log({ calls, results });
```

## Verification and coverage limits

Command run from `vite-app`:

```text
node --test src/session.test.mjs src/offlineQueue.test.mjs src/offlineCache.test.mjs src/recovery.test.mjs src/route.test.mjs
```

Result: **70 tests passed, 0 failed**, approximately 0.59 seconds. The three additional probes above were executed successfully against the same checked-out implementation. No full suite or build was run by this reviewer; parent owns those checks.

Covered existing behavior: normal session restoration; hung getSession/profile timeout fallback; offline no-session behavior; unreadable/absent remembered identities; revoked access; cache failures and owner claims; queue ordering/checkpoints/refusal preservation; single-module flush joining; recovery-event timing; malformed routes and contextual route handling.

Read-only inspection also covered App boot/sign-out/reconnect handling and popstate/navigation error restoration, `ErrorBoundary` reset on screen changes, reference-data cache callers, queue handlers, and the report-send path. No additional navigation finding is confirmed. Actual browser back gestures, IndexedDB quota/transaction aborts on devices, genuine expired refresh tokens against Supabase, and production mail delivery were not exercised. The navigation test suite checks route helpers; it does not establish that overlapping async navigation responses cannot reopen an older requested job. That remains a coverage gap, not a fourth confirmed finding.

Relevant guidance read: CLAUDE.md offline work/cache ownership and sign-out rules (343-374), verification habits (1383 onward). `rg --files` found no AGENTS.md in this checkout.
