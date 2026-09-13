# Codex review: Ask learns tasks

Kyle assigned Codex planning, review and testing, with Claude implementing fixes. The implementation contract is `docs/superpowers/plans/2026-09-13-ask-learns-tasks.md` and its linked design.

## Initial review of work in progress

- `node --test vite-app/src/askLearn.test.mjs vite-app/src/askBudget.test.mjs`: 30 passes, one failed test file. The learning suite could not import `LEARN_QUERY_CHARS` from `askLearn.ts`. This is an incomplete implementation snapshot, not a final regression verdict.
- `ask/index.ts` calculates capacity using `existing.length - decided.replace.length`. An atomic replacement preserves row count, including when it fails. Use the existing count for additions and report omitted candidates.
- The extraction parser, extraction prompt and production call site must adopt the evidence envelope together. Missing evidence must reject a mutation, and replacements plus additions must total at most three.
- The answer prompt still restricts answers to tools alone. Broaden general guidance while preserving fresh authorized business-record reads, action confirmations and honest external-capability boundaries.
- The existing receipt says `Learned:`. The completed feature must make crew sharing visible and show only actual persisted notes.

These findings were included in the Claude CLI implementation handoff. Runtime files remain Claude's responsibility.

## Verification scope

Scripted tests can prove parser, retrieval, persistence orchestration and transport behavior. They cannot establish whether a live model correctly identifies user teaching, excludes sensitive information or distinguishes explicit confirmation from a vague acknowledgment. Live quality must be reported separately. The repository's ordinary Playwright configuration uses the live Supabase project, so it is not an isolated memory evaluation environment.

## Review findings for Claude

1. **Fix conflicting trust instructions.** `learnedLines()` still says "A note from an Admin is fact" and describes only app notes, while `systemPrompt()` says attribution is not general expertise. Update the retrieved-memory preamble and its test to cover task methods, fallible authorship, built-in knowledge precedence and no technical certification. A later memory block must not contradict the answer's trust rule.
2. **Exercise production persistence orchestration.** The added scripted learning case calls pure body/parser/retrieval pieces, but never executes the replacement/insertion path. Task 3 requires behavioral coverage of successful save, failed save, refused correction without fallback, and replacement-plus-add at a full window. Extract an injectable pure orchestrator if needed and call it from the production function; tests must exercise that same implementation, rather than reproduce its arithmetic.
3. **Reject provider-truncated extraction.** The design requires cut-off output to learn nothing. The production handler currently ignores `stop_reason`, and the parser searches for the last closing brace. A complete add-only object followed by a cut-off second object can salvage a mutation from a truncated response. Check the provider completion reason before parsing and add a behavioral regression that a `max_tokens` response writes nothing, even if its text contains valid JSON.

## Interim verification

Codex independently ran `npm.cmd test` after the initial implementation edits: render checks, lint, Edge Function typecheck and all 917 tests passed. These results do not close the review findings above. Full build and final verification remain pending fixes.

## Final review — local implementation accepted

Reviewed implementation commits `4a5d376` and `ec776e1`. All three findings above are resolved:

- The retrieved-memory preamble now covers task methods, distinguishes authorship from expertise and rejects technical certification by a note.
- Production `learn()` calls `applyLearned()` with caller-authorized Supabase adapters. The behavioral suite exercises this same orchestrator for successful and refused writes, correction refusal without fallback, and capacity after successful or failed replacement.
- Production `learn()` calls `decideLearned()` and exits without writes unless the provider reports `end_turn`. Tests cover `max_tokens` with otherwise valid JSON.

Codex independently verified the final committed code:

- `npm.cmd test`: render checks, Biome lint, Deno Edge Function typecheck and **924 tests passed, zero failed or skipped**.
- `npm.cmd --prefix vite-app run build`: passed, including PWA generation.
- `git diff --check`: passed.

No further blocking code findings in this review. Live model quality, real save/recall/correct/forget across accounts, and narrow/desktop browser layout remain unverified; see the evaluation document for fixtures. This review does not claim deployment. The existing unrelated `CLAUDE.md` edit was preserved.

## Round 2 handoff verification

Fresh verification again passed: `npm.cmd test` (924 passed, zero failed or skipped, including render checks, lint and Deno typechecking), `npm.cmd --prefix vite-app run build` and `git diff --check`. No additional blocking finding in the fixes reviewed.

Deployment handoff correction for Claude: the repository function directory is `supabase/functions/ask`, not `ask-assistant`. The corresponding command is `npx supabase functions deploy ask --project-ref eielmvxzdwwprmmfamlq`. No deployment was performed. Live model quality remains unmeasured.
