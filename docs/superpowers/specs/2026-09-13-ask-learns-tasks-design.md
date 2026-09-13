# Ask learns reusable tasks

Owner: Codex (design and review). Implementer: Claude, as Kyle requested.

## Outcome

Ask helps with app questions and unfamiliar tasks, learns a concise reusable procedure from what a person teaches it or explicitly confirms worked, and retrieves that procedure in a later conversation. Learning is persistent memory, not model training or installation of new executable tools.

Example: a user teaches a weekly handover checklist. Ask saves the reusable checklist, shows exactly what was saved, and recalls it next week without retaining the names, job details or figures from the original handover. A person can correct or forget it using the existing memory controls.

## Current implementation and choices

`askLearn.ts` deliberately extracts only app facts into `ask_learned`. `askLoop.ts` says to answer exclusively from tools and sends unfamiliar app questions to the office. Memory already has relevance ranking, per-author database limits, atomic corrections, caller RLS, and visible saved-note receipts. The existing evaluation document distinguishes scripted integration tests from live model quality.

Three approaches considered:

1. Only loosen the answer prompt: enables general help but does not teach Ask reusable tasks.
2. Extend the existing note memory with compact task recipes and evidence checks: recommended first release. It reuses tested persistence, corrections, visibility and spending controls.
3. Build a separate structured skill library with execution and embeddings: more capacity but introduces schema, execution and retrieval systems before we know they are needed.

Use approach 2. A task recipe is a complete short procedure, not a disconnected fragment or executable code. Existing 300-character notes are a deliberate limit: keep only a complete useful summary that fits; never truncate steps or promise a complete detailed workflow was saved. Do not create chains of notes whose partial retrieval could change a procedure's meaning. Rich long procedures can be a subsequent increment.

## Answer behavior

- App navigation and permissions use built-in app knowledge and relevant learned app notes. Unknown app behavior must be identified as unknown.
- Specific business records, amounts and current statuses require fresh authorized tools.
- General tasks may use general model knowledge and information the user supplies. Ask asks a focused question when a missing input changes the answer, then offers practical steps or a draft in chat.
- Current external facts requiring verification must be labeled unverified when no verification tool exists. Do not claim to browse or access an external app.
- Learned recipes guide explanations and composition of existing tools. They never add tool names, permissions, background execution or new confirmation exemptions.
- Model-generated advice alone is not evidence for learning. An unanswered help request is not a learned skill. Save a user-taught procedure or a prior procedure the user explicitly says worked; generic acknowledgments and the current unconfirmed assistant answer do not qualify.

## Memory contract

Keep the current crew-wide automatic learning choice documented in `askLearn.ts`. Only reusable, non-sensitive app facts and task methods belong there. Do not retain personal preferences, private workflows, secrets, identifiers, contacts, record contents, transient dates or amounts. Do not turn a user confirmation into certification of a technical or safety-critical procedure.

Preserve the stored `note` text and existing schema/RPCs. New task notes use the readable convention `Task: <when to use it>; <complete concise steps>`. Existing unprefixed notes remain valid app notes. The extractor must supply source user-turn indices for every proposed addition/replacement; validate those indices against the exact bounded conversation sent to it. This is provenance checking, not deterministic proof that a model understood the statement correctly. Semantic quality must be evaluated with live cases.

No new model calls. Use the existing one metered extraction pass and its existing request/output limits. Enforce a combined maximum of three mutations per turn. Keep the 200-note application window, 40-note per-author database cap, 300-character note length and 20,000-character retrieved block. Corrections preserve the old note on failure. Do not silently split, truncate or evict notes to make room. Report useful capacity/save errors without failing the answer.

Retrieve using the newest user question plus a bounded amount of immediately relevant prior user context so that 'do that again' can find a task discussed earlier. Preserve the existing prompt fence and attribution. Admin authorship does not establish expertise for non-app advice. Built-in app rules win; all learned content remains untrusted data.

Show the actual persisted note with the existing Forget affordance, labeled visibly as shared crew memory. List and forget both app notes and task recipes through the existing tools. Sign-out clears the thread but not shared memory; another crew member may see a recipe, and the UI must make that scope clear.

## Acceptance

Teach, save, start a fresh conversation, recall, correct, recall the correction, forget, and confirm it is no longer retrieved. Cover both app help and a general non-app task. Reject unsupported tool execution, cross-user deletion, private-data capture, self-confirmed learning and permission changes. Learning failures leave the main answer intact. Keep all existing budgeting, deadline, data-access and action-confirmation tests green.

No migration is needed for this increment. No deployment is part of the planning handoff. Record separately what is implemented, verified locally and verified against a live model.
