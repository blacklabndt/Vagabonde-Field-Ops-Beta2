# App stability implementation proposal

Date: 2026-09-12. Proposal only; no product or test changes. Based on the retained Codex app reproductions and direct source inspection. Existing release results are reused; no broad tests repeated. Both leads must agree before implementation.

## APP-2: account handover and delayed cache writes

Recommended minimum complete scope: `offlineCache.js`, relevant producers in `db.js`, auth owner transitions in `App.jsx`/`components/auth.jsx`, and focused cache/database tests.

A module-local generation alone fixes the retained one-tab reproduction but is insufficient across tabs. A separate owner read followed by a put is also insufficient: another tab can claim between those operations.

1. Keep the public owner value compatible. Add a persisted opaque epoch metadata row. Claim must read owner/legacy identity, clear when required, and install owner plus epoch in one IndexedDB readwrite transaction. Same-owner claims preserve epoch and drafts; clear invalidates the epoch atomically. Never await unrelated promises inside a live transaction.
2. Capture a context containing expected account and epoch before starting a network operation. Expose checked cache reads/writes whose transaction verifies that exact context before retrieving/writing data. Stale contexts return no fallback and cannot write. Do not silently recapture the new owner when an old request finishes. Suppress stale request banner changes and `rtLastWritten` updates; key the comparison guard by context or clear/invalidate it on transitions.
3. Apply this to `readThrough` and manual asynchronous producers: jobs page (`db.js` around 989-1000), batched per-job reads (1051), status/create board updates (1105-1113,1339-1369), ticket number fallback (3025-3039). Inventory remaining direct puts before sign-off; synchronously capturing context only at the final put is too late for a delayed fetch. Identity/bootstrap reads need an explicit privileged metadata path because no account is active yet.
4. `db.js` has a second unscoped 30-second `_cache`/`_inflight` layer (240-274), with only per-key write generations. Scope it by the active account/epoch or invalidate every entry/inflight generation on account transition, and prevent a new account joining an old promise. This is a source-inspection concern beyond the retained IndexedDB repro; add a regression before claiming a separately reproduced finding.

Verification: old A success after B claim cannot populate B; old A network failure cannot retrieve B fallback; A→B→A rejects the original epoch; separate module instances share the guard; two simultaneous claims leave one consistent owner/data epoch; clear abort preserves previous owner/data and fails the claim; same-owner and legacy-identity claims preserve drafts; stale write completion cannot repopulate dedupe state. Exercise the real manual jobs-page path and memory contacts wrapper in addition to cache primitives.

## APP-1: recovery URL is only a hint

Recommended scope: `recovery.js`, boot gates in `App.jsx`, password submit in `components/auth.jsx`, recovery tests.

Record URL recovery intent provisionally at import, but set `pending()`/allow the password form only after the early SDK `PASSWORD_RECOVERY` callback supplies a session with a user. Preserve early subscription and retained state for late React mounts. Keep provisional intent separate from authorization. Initialization failure clears intent and exposes a useful reset-link error while retaining the ordinary existing session.

Boot must wait for provisional recovery resolution before restoring a profile or signing out. Installed auth-js schedules the recovery event via setTimeout after initialize resolves (GoTrueClient.ts around 698-716), so immediately clearing intent on successful initialize/getSession can race the event. Implementation must explicitly account for that ordering, with bounded failure handling. Prefer a single Recovery readiness promise/state API consumed by boot, rather than scattered timing checks. Ensure subscription handles an event between render and effect registration.

Record the recovery user ID and invalidate it on sign-out or another account's session event. Before updateUser, require an active validated recovery for the current session user; rejection must send no password update. This also prevents a mounted form being reused after an account switch. Do not claim this provides server-side atomic binding against a simultaneous external session change.

Verification: actual installed SDK plus stubbed fetch/storage; malformed access-only URL, arbitrary complete-looking invalid tokens, expired URL, and preexisting valid session all issue zero password PUTs; valid recovery before/after subscription opens once; boot does not discard valid recovery; clear and session change revoke form authority; successful valid password submission remains functional. Existing tests accepting arbitrary URL text must change.

## APP-3: concurrent tabs drain one outbox item

Recommended minimum: origin-wide exclusive Web Lock around the entire existing drain, including initial item read, handler, checkpoints, deletion and failure recording. Keep the existing per-module joined-promise behavior. Use one stable queue lock name, not owner-specific names, because legacy unstamped items can be visible to multiple owners. Read items and recheck owner only after acquiring the lock. Browser release on tab termination avoids expiring-lease overlap during slow uploads.

If Web Locks is unavailable, do not silently run unlocked. Preserve queued work and surface an actionable unsupported-sync error; both leads must approve that compatibility behavior against supported devices. An IndexedDB lease fallback is a larger alternative: atomic claim, renewal and fencing are required, and an expired lease cannot revoke an already running email request. A simple timestamp claim is not equivalent protection.

Verification: two actual module copies/shared IndexedDB with a shared lock stub yield exactly one handler call for one item; second drain reads after first delete; first network failure releases lock and preserves checkpoint; owner change while waiting does not replay old work; thrown storage/handler errors release the lock; missing-lock branch retains queue and reports failure. Browser two-tab smoke with a stub handler verifies the native lock integration without sending mail.

Limit: serialization prevents simultaneous-tab replay; it does not guarantee exactly-once email delivery after send success followed by lost response/tab crash. That requires server/provider idempotency and is separate scope, not a promise of this fix.

## Decisions required from both leads

Definite recommendations: transactionally fenced persistent cache context across all asynchronous producers; account-scoped memory cache; SDK-validated recovery authority plus provisional boot hold; cross-context queue serialization covering the complete drain.

Queue compatibility is unresolved and must not become an unconditional Web Locks requirement. Inventory the actual supported older tablet/browser versions before selecting the implementation. If any supported client lacks Web Locks, the proposed fail-closed branch would suspend its sync and is not acceptable as an unnoticed regression. Leads must choose either a documented minimum-browser change with an explicit update path, or a supported cross-context alternative together with server-side idempotency for irreversible sends. The latter is larger than a local mutex fix. A compatibility investigation is required before implementing APP-3; the retained two-tab reproduction remains valid regardless of API choice.

Recovery readiness API details also need agreement: validate the chosen initialization/event ordering against the installed SDK with the proposed integration test before adopting its timeout behavior. No token-bearing URLs or sessions should appear in logs or fixtures committed to the repository.
