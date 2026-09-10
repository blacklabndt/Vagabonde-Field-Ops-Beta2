# Ask, third slice: sending a JHA, sending a ticket for approval

Date: 10 September 2026. Follows
`2026-09-10-ask-drafts-design.md` (drafting) and
`2026-09-10-ask-assistant-design.md` (the assistant and its rule). The
fourth slice, timers, follows this one.

## What it is

The person can say "send the JHA from Tuesday on S-10113 to Dave Beaudry"
or "send T-10231 for approval", and the card answers with a confirm block
naming the record, the job and every address it will go to, with **Send**
and **Not now**. Pressing Send calls the same `Db` method Job detail's
own buttons call — `Db.sendJhaEmail` for an assessment,
`Db.sendTicketApproval` for a ticket — and the function behind it
(`send-jha`, `send-ticket-approval`) checks the caller's session, the
record and the recipients as it does for the screens. The result lands as
an answer turn in the thread, in words, so a later question can see it
went.

The rule from the first spec holds and is what this slice is built
around: the assistant never holds more authority than the person who
pressed the button. The `ask` function sends nothing and writes nothing.
It reads the record as the caller, checks the same gates the screens
check, resolves recipients under a stricter rule than the screens, and
proposes. The person confirms in the card, and the app's own send path
does the sending.

## The proposal

Like a draft, a send is an `action` on the function's response beside the
answer, the last action call in a question winning. Two new kinds:

```
{ kind: "send_jha", summary, done, to: [address…], message,
  jha: { id, file }, job: { id, job_number } }
{ kind: "send_ticket_approval", summary, done, to: [address],
  ticket: { id }, job: { id, job_number } }
```

`summary` is what the confirm block says before the send ("Send the
hazard assessment RT-Pipeline-tie-in-v4.pdf (work date 2026-09-08) on
S-10113 to dave@pembina.com and t.beaudry@…"); `done` is the answer turn
after it ("Sent … to …"). `message` on a JHA send is the same default
Job detail's Send dialog offers. `to` is a list of addresses and nothing
else — never a name, never a contact id — so the card shows exactly what
the function will be given.

The card shows the block on the latest answer only, as it does a draft.
**Send** runs App's `runAskAction`, which for a send kind calls the `Db`
method and answers `done`; the card drops the action, pushes `done` as an
assistant turn and stays open. A refusal (the function's own words —
"That ticket is already approved", Resend's testing-mode refusal, a bad
address) shows in the card's error line and the proposal stays, so the
person can read it and press Not now. **Not now** drops the action and
keeps the words, as for a draft.

After a send the device cache entry for that job's list (`jhas.<jobId>`
or `tickets.<jobId>`) is removed, so the next read of Job detail shows the
sent stamp rather than the remembered copy.

## Tools this slice adds (`_shared/askTools.ts`)

Two reads and two sends. Both reads sit behind the `job` tab, because
that is the tab Job detail — where these lists live — sits behind, and
the read policies (`jhas read`: jha, job or users; `tickets select`:
staff) let anyone holding it read them.

- `list_jhas(job_number)` — the job's assessments, newest first: id,
  template, work date, status, who filed it and when, whether a PDF
  exists (`has_pdf`), when and to whom it was last sent.
- `list_tickets(job_number)` — the job's tickets, newest first: id
  (the ticket number), work date, status, technician, total (null unless
  the caller holds a price role, the tracker's rule), when and to whom an
  approval was last sent, and the client contact it was raised against.

- `send_jha(jha_id, recipients[])` — tab `job`. The runner reads the
  assessment as the caller (id, signer, PDF key, template, work date,
  status, sent stamps, its job's number and organisations) and refuses,
  in words the model passes on, when:
  - there is no PDF ("has no PDF yet — render it on Job detail first");
  - the caller is neither the technician who filed it nor an Admin,
    Coordinator or Technician (`send-jha`'s own gate, same words).
  Then it resolves the recipients (below) and proposes.
- `send_ticket_approval(ticket_id)` — tab `ticket` AND a price role
  (`PRICE_ROLES`), because Job detail's Send for approval sits behind
  `seesPrices`. The runner reads the ticket as the caller (id, status,
  total, technician, client contact, its job's number and client) and
  refuses when:
  - the ticket is Approved or Invoiced ("the client has already signed
    it, so there is nothing to send");
  - the total is not above zero ("has nothing on it yet");
  - the caller is neither the ticket's technician nor an Admin or
    Coordinator (`send-ticket-approval`'s own gate; a Coordinator never
    reaches here, holding no price role).
  The recipient is the ticket's own rule and no choice: the address in
  the client contact the ticket was raised against, else the job's
  current client rep (the named contact, else the client's primary
  contact) — exactly the viewer's `recipient`. With neither the tool
  refuses ("No client email on file for this ticket — add a client rep
  to the job record"). An Awaiting-approval ticket is sent again, as the
  viewer's "Send again" does; the summary says "again".

### Recipients (`_shared/askSends.ts`, pure)

A JHA's recipients come from two places only:

1. **A name** must match one contact on file for the job's client or
   contractor organisation — exact name first, else the one contact
   whose name contains the words — and that contact must have an email.
   No match, more than one, or no email on file is a refusal that names
   the person and says what to ask ("Dave has no email on file — add
   one on the Contacts screen, or ask the person for the address").
2. **A bare address** is allowed only if it appears, verbatim and
   case-insensitively, in the person's own words in the thread — the
   user turns the function was sent. An address the model produced from
   a record, from memory or from a guess is refused ("the address
   x@y.com was not typed by the person — ask them to type it").

Addresses are checked against the same pattern `mail.ts` uses, deduped
case-insensitively, at least one and at most ten (the transport's own
cap). The pure module holds the resolution, the two gates, the ticket's
address rule and the summary/done words, so the node suite covers every
refusal without a database.

## The prompt

`systemPrompt` gains one line: sending means finding the record first
(`list_jhas`, `list_tickets`) and calling the send tool once; a JHA goes
to the job's contacts by name, or to an address the person typed
themselves; a ticket approval goes to the ticket's client rep and the
person is not asked where; a send tool sends nothing — the card asks the
person to confirm — so the answer is one sentence saying so and naming
who it goes to. `wrapRecords` still frames every result as data.

## The card

The proposal block already exists. For a send kind it shows the summary
and the addresses, and its primary button says **Send** instead of Open
the form; pressing it does not close the card. While the send runs the
button says "Sending…" and the box is disabled. `runAskAction` answers
the `done` sentence for a send kind and nothing for a draft.

## Gates, restated

- The `ask` function sends nothing and writes nothing. The only send is
  `Db.sendJhaEmail` / `Db.sendTicketApproval` from App, pressed by the
  person, through the functions the screens use, which re-check the
  session, the record and the recipients.
- A send tool is offered only behind the tab (and role) the screen's own
  button sits behind, and its runner applies the function's gate before
  proposing, so a refusal is met in the card's words, not after a Send.
- Recipients: contacts on file, or an address the person typed. Nothing
  the model can reach — a query text, a project name, a note — can name
  a recipient.
- Money on a ticket the function proposes is never shown to a role that
  may not see it; the tool is not offered to one.

## Tests

- `askSends.test.mjs`: names resolve (exact, contains, primary
  ordering irrelevant), no match / two matches / no email refuse with
  the person named; a typed address passes, an untyped one is refused,
  the check is case-insensitive; dedupe; empty and eleven refused; the
  JHA gate (no PDF, signer passes, Helper who did not sign refused,
  Coordinator passes); the ticket gate (Approved, Invoiced, zero total,
  another technician's for a Technician refused, Admin passes); the
  ticket address (contact line, fallback, neither); summary and done
  words.
- `askTools.test.mjs`: the `job` tab offers the two lists and
  `send_jha`; `send_ticket_approval` needs `ticket` and a price role;
  trace lines for the four.
- `backupShared.test.mjs`: `askSends.ts` joins the guard list.
- `askLoop.test.mjs`: the prompt names the send rule.

## Not in this slice

Sending reports; cc lines; sending to anyone not on file and not typed
by the person; chasing every unsigned ticket; marking a ticket chased;
timers (the next slice).
