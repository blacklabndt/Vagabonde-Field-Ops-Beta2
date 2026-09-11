# Security review for Claude — 2026-09-11

Baseline: `32f9088`, following rounds 4 and 5. Review only: no application fixes, commits, deployments, production requests, or database mutations. Existing edits to `help.js` and `adminSetup.jsx` were preserved. Local settings and credentials were not inspected.

## Decision

One confirmed authorization defect merits priority remediation. Two additional security concerns need targeted validation before being called exploitable vulnerabilities. This is a focused source audit, not a certification that every function or deployed policy is secure.

## S1 — P1: profile-locked Admin retains privileged Edge access when Auth still accepts the session

**Evidence:** `supabase/functions/_shared/backupCommon.ts:45–63` (`requireAdmin`) authenticates with `getUser()`, then selects only `role` from the caller's profile. An `Admin` passes regardless of `deactivated_at` or `tab_access`.

The current profile SELECT policy deliberately allows a signed-in person to read their own row even when locked (`supabase/migrations/20260908063429_a_locked_account_reads_only_its_own_row.sql`). Reading that row through RLS therefore does **not** establish that the person remains authorized. The database's `private.user_role()` separately rejects deactivated accounts (`20260904135107_the_token_is_not_the_record.sql:151–161`); the Edge check does not use it.

This is a supported, reachable partial-failure state, not just a hypothetical inconsistent record: `delete-user/index.ts:73–92` locks the profile first, then attempts the Auth ban. If the ban fails, it explicitly returns `ok: true, deactivated: true, banFailed: true`. In that state the account can still authenticate, and the role-only check accepts it. There is also a race between the profile lock and the ban. An Admin with all tabs removed is accepted too, despite the documented all-tabs-off lock behavior (`CLAUDE.md`, access rules).

**Impact:** the shared check authorizes `backup-run`, `backup-restore` and backup OAuth start/disconnect. The restore route then uses service authority for `preflight`, `restore_all`, and `restore_jobs` (`backup-restore/index.ts:78–101`). A revoked administrator retains the route-level authority to disrupt backups or request a destructive restore, subject to the normal configured-drive and restore validation prerequisites. This does not give an ordinary non-Admin that authority.

The same role-only caller-check pattern appears in `create-user`, `delete-user`, `unlock-user`, `password-reset`, and `mail-test`. In particular, `unlock-user/index.ts:53–105` does not reject a deactivated caller or a self-target: with Auth still accepting the caller, a locked Admin can reach the operation that clears their own lock. Password-reset checks the **target's** deactivation, which does not protect against a revoked caller.

**Safe reproduction:** run the accompanying diagnostic test. It extracts and executes the actual `requireAdmin` function, mocking an authenticated session and the own-profile row. Both a deactivated Admin and an Admin with no tabs are admitted. The mock isolates the authorization defect; it does not prove how a successfully banned user is handled by live Auth. No claim is made that a successful Auth ban is bypassed.

**Recommended fix:** centralize the active-account check for privileged endpoints: validate authentication, require a current profile, reject `deactivated_at`, require effective access consistent with the product's all-tabs-off lock rule, then enforce Admin rank. Fail closed on lookup errors. Apply it to every route that switches to service authority. Decide explicitly whether Admin-tab removal alone revokes administration; do not silently invent that policy in this patch. `ask/index.ts:171–176` already demonstrates an explicit deactivation check.

**Acceptance tests:** active Admin succeeds; missing profile, query failure, non-Admin, deactivated Admin with Auth still valid, and zero-tab Admin fail before side effects. In an isolated test environment, verify the profile-lock/Auth-ban-failure scenario and self-unlock rejection. Do not perform destructive restore tests against production.

## S2 — Investigation: arbitrary push destinations reach the outbound transport

`20260818191046_chat_push_claim.sql:13–29` accepts an arbitrary `_endpoint` for a caller with Chat access. The original `push_subscriptions` schema has a unique text endpoint; its direct INSERT path must also be considered. `_shared/webPush.ts:23–28` passes that stored endpoint directly to `web-push@3.6.7`, without application-level host or address validation.

The diagnostic proves that a loopback HTTPS URL reaches `sendNotification`; it substitutes the transport and does **not** prove that the actual library or deployed network reaches it. An attacker also needs usable encryption keys and a notification trigger. Treat this as a potential authenticated server-side request forgery and outbound-resource-abuse surface, not as demonstrated access to internal services or metadata.

**Claude follow-up:** inspect the pinned transport's URL/redirect behavior and test with a controlled receiver in an isolated environment, using valid subscription keys. Establish supported browser push-service hosts and enforce a maintained destination policy at registration and send time. Cover both RPC and direct table writes, non-HTTPS URLs, loopback/private destinations, redirects, and existing stored subscriptions. Check subscription-count and outbound-request limits. Do not probe live internal addresses.

## S3 — Investigation: OAuth nonce consumption does not establish a single winner

`backup-oauth/index.ts:spendNonce` conditionally clears the presented state but neither checks the returned error nor verifies that a row was affected. `callback` first reads the expected state, then calls this helper, then validates against its earlier snapshot. Two requests which both read the old state can both pass local validation even though only one clears it. A database update error can also be ignored.

The diagnostic proves that a zero-row consumption returns normally. It does not demonstrate account takeover: state is high entropy, an OAuth code is additionally required, and provider-side single-use code enforcement may stop duplicate exchanges. Provider binding is also absent from the stored state record and deserves review while this logic is changed.

**Recommended improvement:** atomically consume a matching, unexpired, provider-bound state with a returning row, reject database errors and zero-row results, and exchange the code only for the winning request. Add a barrier-controlled concurrency test requiring exactly one exchange attempt. Cancellation should consume only its own state as it does now.

## Coverage and limits

| Area | Work performed / result |
| --- | --- |
| Edge authentication and service authority | Inventoried 21 function entry points and reviewed caller-check patterns; traced privileged backup and account-management paths. S1 confirmed. Not every function body was exhaustively reviewed. |
| Database authorization | Examined current-profile role revocation, own-profile read exception, push subscription policies, and backup RPC grants. Live policy application and full migration replay were not verified. |
| Public approval | Read token lookup, bounded POST parsing, signature validation, approval-state checks and query mail gating. Tokens are hashed for lookup; successful signatures are conditionally written. No new exploit established in this pass. |
| Backup OAuth | Checked authentication, state generation, callback validation and consumption. S1 and S3 apply. No provider calls made. |
| Browser / Worker | Reviewed fixed-origin approval proxy, body limits, security headers and dynamic inline-script hashes; checked invoice iframe sandbox and storage URL call sites. No stored-XSS exploit established. Dynamic hashing of all returned script blocks is not an independent defense against server-side HTML injection; escaping remains essential. |
| Push | Traced authenticated subscription registration to service-side outbound send. S2 remains unverified at the transport/network boundary. |
| Secrets and storage | Examined selected settings/RPC grant patterns and signed URL usage. No credential values read, no historical-secret scan, no comprehensive bucket-policy proof. |
| Not covered | Live penetration testing, infrastructure/IAM configuration, dependency vulnerability database scan, complete SQL policy matrix, full AI prompt-injection exercise, and comprehensive denial-of-service testing. |

## Verification and handoff

Executed successfully, exit 0: **205 tests passed**, including four new diagnostic cases and existing selected suites:

```powershell
node --test docs/reviews/security-repro.test.mjs vite-app/src/workerCsp.test.mjs vite-app/src/storageKeySafe.test.mjs vite-app/src/backupShared.test.mjs vite-app/src/backupRestore.test.mjs vite-app/src/approvalRun.test.mjs
```

The four diagnostic tests intentionally assert the current problematic behavior; a successful fix should invalidate the corresponding assertions. Convert them to rejection/single-winner regression tests when implementing fixes. Existing passing tests do not disprove these security findings. Mocks do not establish production exploitability.

No build/typecheck was needed for this documentation-and-diagnostic-only change; neither was rerun. Claude should start with S1, reproduce it independently, implement the shared authorization fix, then run the normal tests, lint, typecheck and build gates before shipping. Resolve S2 and S3 separately without inflating their evidence level.
