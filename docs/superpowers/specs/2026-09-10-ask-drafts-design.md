# Ask, second slice: drafting a job, a ticket, a JHA

Date: 2026-09-10. Approved by Kyle in conversation ("perfect"). Builds on
`2026-09-10-ask-assistant-design.md`, whose rule stands: the assistant
never holds more authority than the person who pressed the button, and
nothing it can reach writes.

## What it is

The person says "new job for Pembina at 03-12-071-06W6, Ledcor is the
contractor, RT on the tie-in, and start the JHA". The assistant looks up
what it needs (the client in the directory, the job's reps), then hands
the card a **proposal**: the app's own form, filled in, that opens on one
tap. The person presses Save on that form or does not. The function
inserts nothing; the form's own save path — validation, idempotency key,
offline queue — does what it always does.

Three drafts: a job, a ticket for a job, a JHA for a job. A job draft may
carry a JHA draft to open once the job is saved.

## The proposal

A draft tool's answer to the model is a sentence ("Ready: a new job for
Pembina Pipeline …"). Its side effect, inside the function's request, is
the **action** the response carries beside the answer:

```
{ answer, trace, action?: {
    kind: "draft_job" | "draft_ticket" | "draft_jha",
    summary: string,          // one sentence the card shows
    seed: object,             // what the form opens with (shapes below)
    job?: { id, job_number }, // draft_ticket / draft_jha: which job
    next?: { kind: "draft_jha", summary, seed }   // draft_job only
} }
```

One action per answer; a later draft tool call in the same loop replaces
an earlier one. The card shows `summary` under the answer with **Open the
form** and **Not now**. Open the form calls App: `startJobDraft(seed,
next)`, `startTicketForJob(job, seed)` or `startJhaForJob(job, seed)`.
Not now discards the action; the thread keeps the words.

The action is never stored: it lives on the answer turn in `askThread.js`
for the panel alone (like the trace) and is not sent back.

## Tools this slice adds (`_shared/askTools.ts`)

Read tools, run as the caller:

| tool | tab | runs |
|---|---|---|
| `find_client(q)` | board | `search_org_directory(q, 'clients', 0, 10)` → `[{ id, name, contact_count }]` |
| `find_job(q)` | board | `search_jobs(q, 'All', 'any', 0, 10)` → `[{ id, job_number, project, client_name, contractor_name, lsd, afe, status }]` |
| `job_record(job_number)` | job | the job row (`jobs` by job_number) with its client and contractor names and their contacts (`contacts` by org, primary first) → `{ job, client_rep, contractor_rep, contacts: { client: [...], contractor: [...] } }` |

Draft tools, which write nothing and shape the action:

| tool | tab (and role) | input |
|---|---|---|
| `draft_job` | board | `{ project, client_name, lsd, afe?, contractor_name?, client_rep?, contractor_rep?, job_number?, then_jha?: <draft_jha input minus job_number> }` |
| `draft_ticket` | ticket, role Admin or Technician | `{ job_number, work_date?, lines?: [{ label, quantity }] }` |
| `draft_jha` | jha | `{ job_number, template?, work_date?, helper_name?, hazards?: [name], site?: { weather?, temperature?, communication?, muster?, hospital?, firstAid? } }` |

`toolsFor(tabs, role)` now takes the role: a tool may name `roles`, and
is offered only when the caller's role is among them. `search_tickets`'
three stay as they are.

**Shaping** (`askDrafts.ts`, pure, no imports, node-tested — the draft
tools' runners call it and the tests hold it):

- `shapeJobDraft(input, client)`: `client` is the directory row the
  runner resolved (`find_client` must have found exactly one; the runner
  resolves the name again and refuses "which Pembina?" when there are two,
  "no client called X" when none — the model then asks the person).
  Project, LSD required (the form's own rule); a missing one is refused
  with the field named, so the model asks. Output is the job dialog's seed:
  `{ project, jobNumber, client, lsd, afe, contractor, clientRep,
  contractorRep }` (names as the dialog's state, reps `{ name, email,
  phone }` or blank).
- `shapeTicketDraft(input, job)`: `{ workDate, lines }` — a date as
  YYYY-MM-DD or today (the editor defaults it), `lines` kept as
  `[{ label, quantity }]` with quantity a positive number; the editor
  matches labels to the rate card and names the rest.
- `shapeJhaDraft(input, job)`: `{ template, workDate, helperName,
  suggestedHazards, site }` — `template` one of `JHA_TEMPLATES` (a word
  match: "tie-in" → the tie-in template, "facility"/"plant" → facility,
  "shop" → shop, "sour"/"H2S" → sour; unknown → the first), hazards kept
  only when they name one of `SEED_HAZARDS`, site fields kept when
  strings.

`JHA_TEMPLATES` and the hazard names live twice — data.js and
askTools.ts — and `askTools.test.mjs` reads data.js and fails on drift,
as attention.test.mjs does for `KIND_WORDS`.

## The forms take a seed

- **Job dialog** (`home.jsx`'s `NewJobDialog`) gains `seed`: initial form
  state from it, the client/contractor selects showing the seeded names
  (a seeded client the list does not hold is left blank, never created).
  The dialog moves out of Home into App so it opens from any screen:
  App holds `jobSeed` (with a nonce, the ticket's pattern) and renders the
  dialog after `<main>` when it is set; Home's `+ Job` sets an empty seed
  the same way. App's create handler keeps doing what it does, then if the
  seed carried `next`, calls `startJhaForJob(created, next.seed)`.
- **JHA builder** (`jhaMobile.jsx`) gains `seed`: template, work date,
  helper (by name, matched against the crew list once loaded), site
  fields, and `suggestedHazards`, shown as a line above the hazard list
  ("AI suggests: Driving, Radiation …") — nothing ticked. Precedence: a
  WIP copy on the device wins; then the seed; then the last JHA's details
  fill what is still blank. Seeded values join the `baseline` so an
  untouched seeded form writes no WIP.
- **Ticket editor** (`ticketMobile.jsx`): the seed gains `lines`, applied
  once the catalog has loaded through the same by-label matcher the draft
  loader uses; labels the card lacks are named in one toast.

All three keep their nonce remount, so a second draft starts clean.

## The card

Under an answer that carries an action: the summary in the answer's own
type, then **Open the form** (primary) and **Not now**. Open the form
closes the card and hands off; the answer turn keeps the summary as
words so the thread reads sensibly later. An action on an older turn is
not offered again (only the latest turn's).

## The prompt

The system prompt gains the drafting rules: look the client and the job
up before drafting; ask for what the form requires when it was not said;
never invent a rep, an LSD or a client; put hazards forward as
suggestions and say the person ticks them; one draft per answer.

## Gates, restated

The function offers `draft_job` only with the board tab, `draft_jha` only
with jha, `draft_ticket` only with ticket and a price role. The forms
apply their own rules on save (a Complete job refuses a new JHA or
ticket; a duplicate job number is refused by the database). The function
reads the job record as the caller, so a job the caller may not see
cannot be drafted against.

## Tests

- `askTools.test.mjs`: the new tools and their tabs and roles;
  `toolsFor` with and without the price role; templates and hazard names
  equal data.js's.
- `askDrafts.test.mjs`: each shaper — required fields refused by name,
  template word match, hazards filtered to the list, lines cleaned,
  dates validated.
- `askThread.test.mjs`: an action kept on the turn and not sent.
- `askLoop.test.mjs`: unchanged (the loop does not know about actions).
- The existing suites for the three forms keep passing; a small test on
  the JHA builder's precedence helper if one is extracted.
- Live: draft a job, save it, see the JHA open; draft a ticket with two
  lines; draft a JHA with a suggestion line.

## Not in this slice

Creating a client, contractor or contact that does not exist; editing
anything that exists; sending anything (next slice); timers (the one
after).
