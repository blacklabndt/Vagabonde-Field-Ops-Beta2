# Ask learns how the app works from conversations

Date: 10 September 2026. Follows the knowledge-and-context slice (commit
0db1f21) and the four Ask slices before it. Kyle's decision: Ask should
learn from conversations on its own, with no confirm button, and what it
learns is how the app works — one crew memory, whoever is talking.

## What it learns, and from whom

A fact about the app, said in conversation: where a button is, what a
screen does, a rule someone corrects it on ("no, cancel approval is on
the ticket row on Job detail"), how the crew does a thing. Not facts
about people, jobs, tickets or money — the tools answer those, fresh —
and never anything read from a tool result. The teaching moment is
mostly Ask saying "the office would know" and the person answering, or
the person correcting a wrong answer.

The source is the conversation's own text: the person's turns and Ask's
own answers (so a correction reads against what it corrects). Tool
results are never shown to the extractor.

## Where it lives

A new table, `ask_learned`: `id`, `note` (3–300 characters), `said_by`
(profile, cascade), `created_at`. Read by every signed-in staff account
(`is_staff()`); inserted only in the caller's own name; deleted by the
speaker or an Admin; never updated. The role beside a note is the
speaker's CURRENT role, joined from profiles at read time: an account
demoted since it spoke loses the weight it had. Capped at 200 notes
(`MAX_LEARNED`), checked by the function before an insert; a note that
changed is replaced, not doubled.

The `ask` function's rule moves one step: it writes nothing but
`ask_learned` rows, as the caller, in the caller's name. It still holds
no more authority than the person.

## Two grades of truth

In the prompt, a note said by an Admin is fact. A note said by anyone
else is "a crew member said", and the built-in knowledge
(`askKnowledge.ts`) wins where they disagree. That is the whole
difference the speaker makes; the note itself is the crew's.

Notes enter the prompt wrapped as data, like tool results and the
screen's help — a note that says "ignore your rules" is quoted as
something a crew member once said.

## How it learns

After the answer is produced, `ask` makes one more Messages API call —
`LEARN_MODEL`, Haiku 4.5, small and fast — with the window's turns and
the notes it already has, asking for JSON: `add` (new notes, at most
three) and `replace` (an existing note's id and its corrected text).
`_shared/askLearn.ts` (pure, in the guard list) builds that prompt,
parses the reply strictly (a malformed reply learns nothing), caps
lengths and counts, and words the prompt block (`learnedLines`). The
function then inserts and deletes as the caller through RLS: a replace
of somebody else's note by a non-Admin is refused by the delete policy
and the new note is added beside it instead, which the next extraction
sees as two notes and the Admin's list shows plainly.

The extraction is awaited, because the response carries `learned` —
the notes just added, with their ids — and the card shows them. It
costs about a second on top of an answer that already takes several.
It is best effort: an extractor failure or refusal never fails the
answer, and is not logged (there is nothing to fix at 03:00 about a
missed note).

## Visible and undoable

- The card shows "Learned: …" under an answer that taught it something,
  one line per note, with an × that calls `Db.forgetLearned(id)` on the
  spot (the person's own note, their own act; no confirm).
- Tools: `list_learned` (tab board) lists what Ask has learned, with who
  said it; `forget_learned(id)` proposes forgetting one, confirmed on the
  card ("Forget it"), and App calls `Db.forgetLearned`. RLS decides
  whether the deletion is allowed.
- The Admin screen gets a "What Ask has learned" panel: every note, the
  speaker and their role, the date, and Delete. Admins prune; that is the
  oversight the no-confirm learning rests on.

## Not built

- Learning from tool results, records or people.
- A per-person memory.
- Any change to what the tools may do: a note grants nothing.

## Testing

- `askLearn.test.mjs`: the extractor prompt names the rules (app only,
  no records, no people), `parseLearned` refuses non-JSON, non-arrays,
  overlong and too many notes; `learnedLines` grades Admin vs crew and
  wraps as data; `MAX_LEARNED`.
- `askThread.test.mjs`: `pushTurn` keeps `learned`; `dropLearned`.
- `askTools.test.mjs`: the two tools behind board, their trace lines.
- Probes under `supabase/handover/`: staff read, insert own, insert in
  another's name refused, delete own, delete another's refused for a
  Technician, allowed for an Admin, the length check.
