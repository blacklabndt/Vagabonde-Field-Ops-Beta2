# Cybersecurity evidence review retry — 12 September 2026

Completed the previously interrupted evidence review with a read-only subagent review and parent review. No automatic review rejection occurred during this retry. This is completion of the evidence review, not a new live API security test or a comprehensive security clearance.

Starting state: branch `codex/live-bug-hunt-20260912`, commit `bfa6241`; existing `vite-app/e2e/hunt/` untracked. Preserved all existing files. No probe scripts executed, network requests made, or application code changed.

## Confirmed harness problems

| Source under vite-app/e2e/hunt/ | Finding |
| --- | --- |
| l4-cols2.mjs:8–26 | Selects arbitrary first JHA/chat records and attempts updates/deletion without proving seed ownership or restoring accepted changes. |
| l4-cross.mjs:13–45; l4-crew.mjs:16–18 | Attempts changes/deletion on hardcoded existing tickets/profiles and sampled crew. No seed ownership validation or reliable rollback. |
| l4-sends.mjs:9–11 | Calls real approval-mail endpoints without dry-run; an unexpectedly accepted request could send mail. |
| l4-rpc.mjs:10–22 | Includes error clearing, restore wipe, and backup kick calls. These cannot safely rely on the permission check under test refusing them. |
| l4-fns.mjs:10–17 | Includes mail, backup, digest, retention, and scheduled-send operations with potential side effects if accepted. |
| l4-cols2.mjs:43–46 | Additional schedule inserts do not capture IDs for cleanup; listing leftovers does not remove them. |
| l4-learn.mjs:49–50; l4-learn2.mjs:37–39 | Cleanup uses shared note prefixes, including Admin-wide deletion, and lacks exception-safe cleanup. It can overlap concurrent tests or miss accepted records outside the prefix. |
| l4-cross.mjs:21–28; l4-cols.mjs:29–37 | Invalid column probes and sequential state changes can make results misleading. Schema rejection does not prove authorization enforcement. |
| l4-cross.mjs:33; l4-sends.mjs:7–12 | Logs include approval-token fields and live record excerpts; avoid sharing raw output. |

Parent independently inspected cols2, cross, crew, sends, RPC, function, and learned-note cleanup call sites. Subagent reviewed the mutation paths and returned the same core conclusions.

## Evidence limits and disposition

No saved response logs for these older l4 API probes were located in the inspected hunt files or `.auth` evidence inventory. Retained browser/queue/Admin evidence belongs to separately documented completed checks. Source code proves intended requests, not their execution, success, refusal, or cleanup.

No new application vulnerability is confirmed by this review. Historical API outcomes and cleanup remain unverified. Do not mark authorization controls as passed on this evidence.

For subsequent testing, replace arbitrary targets with fixtures whose exact IDs and seed ownership are verified, preserve preconditions, record assertions and redacted responses, and clean up exact created IDs with absence checks in exception-safe paths. Mail, clearing, restore, retention, and scheduling side effects need isolated test infrastructure before executing refusal probes. The existing scripts are preserved, not approved for live rerun.

Claude handoff: joint review can use these findings immediately; do not rerun the listed mutation scripts against live data. No product fix is justified solely by their source.
