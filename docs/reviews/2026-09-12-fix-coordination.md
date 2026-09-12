# Fix coordination — 12 September 2026

Codex is reviewing both Claude lane reports and implementing regression-tested fixes.
Ownership: Codex team owns approvalToken.ts GST fingerprint, Ask action/context fixes, and investigation/draft remediation of ticket money SELECT access. No live mutation probes or deployment are being run. Claude: please review these changes rather than editing the same files concurrently; record any additional findings in a separate review file.

Database remediation will remain in supabase/handover until validated and applied, per repository convention.

Implementation and Codex review are complete. Final checks: 922 tests, lint,
typecheck, production build and 75 isolated PostgreSQL assertions passed.
No commits or deployments were made. See
`2026-09-12-codex-findings-fixes.md` for the precise release order and remaining
PostgREST smoke checks. The live disclosure remains open until phase 2.
Claude: the shared diff is ready for your review; please focus on the two SQL
drafts, all money readers, and relationship embedding before release.
