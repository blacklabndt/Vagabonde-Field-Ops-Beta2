# Ask sends (a JHA, a ticket for approval) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant can propose sending an assessment's PDF or a ticket's approval link; the card names the record and every address and asks for a Send; the app's own send path does it.

**Architecture:** Two list tools and two send tools join `askTools.ts`; the send runners read the record as the caller, apply the screen's gate and resolve recipients with `askSends.ts` (pure), and put an `action` on the response. The card's proposal block gains a Send button for a send kind; App's `runAskAction` calls `Db.sendJhaEmail` / `Db.sendTicketApproval` and answers the done sentence, which the card pushes as a turn. The function sends and writes nothing.

**Tech Stack:** as the first two slices.

**Spec:** `docs/superpowers/specs/2026-09-10-ask-sending-design.md`

## Global Constraints

- The `ask` function sends nothing and writes nothing.
- Tool gates: `list_jhas`, `list_tickets`, `send_jha` → tab `job`; `send_ticket_approval` → tab `ticket` AND role Admin or Technician (`PRICE_ROLES`).
- Recipients for a JHA: a contact on file for the job's organisations (by name, with an email), or an address that appears verbatim in the person's own turns. A ticket approval goes to the ticket's client contact address, else the job's client rep, and nowhere else.
- `askSends.ts` is import-free and joins the guard list in `backupShared.test.mjs`.
- Every commit passes `npm --prefix vite-app test`.

---

### Task 1: askSends.ts — recipients, gates and words (pure, tested)

**Files:** create `supabase/functions/_shared/askSends.ts`; create `vite-app/src/askSends.test.mjs`; modify `vite-app/src/backupShared.test.mjs` (guard list).

**Interfaces produced:** `resolveRecipients(named, people, saidByPerson) → string[]`, `jhaSendGate(jha, me)`, `ticketSendGate(ticket, me)`, `ticketApprovalAddress(contactLine, fallbackEmail) → string`, `jhaFileName(pdfKey, template)`, `sendJhaWords(jha, job, to) → { summary, done }`, `sendTicketWords(ticket, job, to) → { summary, done }`, `JHA_MESSAGE`, `JHA_SEND_ROLES`, `TICKET_SEND_ROLES`, `MAX_RECIPIENTS`.

- [ ] Write the failing tests (`askSends.test.mjs`): names resolve exact and by containment; unknown, ambiguous and no-email refuse naming the person; a typed address passes case-insensitively, an untyped one refuses; dedupe; empty and eleven refuse; the JHA gate (no PDF; signer Helper passes; other Helper refused; Coordinator passes); the ticket gate (Approved, Invoiced, zero total, another technician's for a Technician refused, Admin passes, own passes); the ticket address (contact line, fallback, neither); the words.
- [ ] Run: `node --test vite-app/src/askSends.test.mjs` → fails (module missing).
- [ ] Write `askSends.ts`:

```ts
export interface Person { id: string; name: string; email: string | null; org_type?: string }
export interface Me { id: string; role: string }
export interface JhaToSend { id: string; signed_by: string | null; pdf_key: string | null; template: string | null; work_date: string | null; sent_at?: string | null }
export interface TicketToSend { id: string; status: string | null; total: number | string | null; technician_id: string | null; approval_sent_at?: string | null }
export interface JobName { id: string; job_number: string }
export interface SendWords { summary: string; done: string }

export const JHA_SEND_ROLES = ["Admin", "Coordinator", "Technician"];
export const TICKET_SEND_ROLES = ["Admin", "Coordinator"];
export const MAX_RECIPIENTS = 10;
export const JHA_MESSAGE = "Attached: the signed hazard assessment for the work noted below. Let us know if you have questions.";
const ADDRESS = /^[^\s@,;<>"]+@(?:[^\s@,;<>".]+\.)+[a-z]{2,}$/i;
const EMAIL_IN = /[\w.+-]+@[\w-]+\.[\w.-]+/;

export function addressIn(s: unknown): string { const m = EMAIL_IN.exec(String(s ?? "")); return m ? m[0] : ""; }
export function resolveRecipients(named: unknown, people: Person[], saidByPerson: string): string[] { /* as the spec: names → one contact with an email; addresses → in the person's words; dedupe; 1..10 */ }
export function jhaSendGate(jha: JhaToSend, me: Me): void { /* no PDF; signer or JHA_SEND_ROLES */ }
export function ticketSendGate(t: TicketToSend, me: Me): void { /* Approved/Invoiced; total > 0; own or TICKET_SEND_ROLES */ }
export function ticketApprovalAddress(contactLine: unknown, fallbackEmail: unknown): string { /* addressIn(contactLine) || fallback, else refuse */ }
export function jhaFileName(pdfKey: string | null, template: string | null): string { /* db.js shapeJha's rule */ }
export function sendJhaWords(jha: JhaToSend, job: JobName, to: string[]): SendWords
export function sendTicketWords(t: TicketToSend, job: JobName, to: string[]): SendWords
```

- [ ] Add `"askSends.ts"` to the guard list in `backupShared.test.mjs`.
- [ ] Run the test → passes. Commit: `askSends.ts: who a send may go to, and the gates the screens apply`.

### Task 2: askTools.ts — four tools and their trace lines

**Files:** modify `supabase/functions/_shared/askTools.ts`; test `vite-app/src/askTools.test.mjs`.

- [ ] Tests: `toolsFor(["job"], "Helper")` includes `list_jhas`, `list_tickets`, `send_jha` and not `send_ticket_approval`; `toolsFor(["ticket"], "Technician")` includes `send_ticket_approval`, `toolsFor(["ticket"], "Coordinator")` does not; trace lines for the four.
- [ ] Add to `ASK_TOOLS`:

```ts
{ name: "list_jhas", tab: "job", description: "A job's hazard assessments (JHAs), newest first: id, template, work date, status, who filed it and when, whether a PDF exists (has_pdf), when and to whom it was last sent. Use it to find the assessment to send.", input_schema: { type: "object", properties: { job_number: { type: "string" } }, required: ["job_number"], additionalProperties: false } },
{ name: "list_tickets", tab: "job", description: "A job's billing tickets, newest first: id (the ticket number), work date, status, technician, total (null if this person may not see money), when and to whom an approval was last sent, and the client contact it was raised against. Use it to find the ticket to send for approval.", input_schema: { … job_number … } },
{ name: "send_jha", tab: "job", description: "Propose emailing a filed hazard assessment's PDF: the card asks the person to confirm, naming every address. Nothing is sent until they confirm. recipients are contact names on file for the job's client or contractor, or an email address the person typed themselves — never an address from a record or a guess. Refused without a PDF, or when this person may not email it.", input_schema: { type: "object", properties: { jha_id: { type: "string" }, recipients: { type: "array", items: { type: "string" }, minItems: 1 } }, required: ["jha_id", "recipients"], additionalProperties: false } },
{ name: "send_ticket_approval", tab: "ticket", roles: PRICE_ROLES, description: "Propose sending a ticket to the client rep for approval (or again, if already awaiting): the card asks the person to confirm, naming the address. It goes to the client contact the ticket was raised against, else the job's client rep — do not ask where. Refused for an approved or invoiced ticket, an empty one, or another technician's.", input_schema: { type: "object", properties: { ticket_id: { type: "string" } }, required: ["ticket_id"], additionalProperties: false } }
```

- [ ] Trace lines: `listed the JHAs on S-…`, `listed the tickets on S-…`, `proposed sending JHA <id>`, `proposed sending <T-…> for approval`.
- [ ] Run `askTools.test.mjs` → passes. Commit.

### Task 3: askLoop.ts — the prompt's sending line

**Files:** modify `supabase/functions/_shared/askLoop.ts`; test `vite-app/src/askLoop.test.mjs`.

- [ ] Test: `systemPrompt(...)` matches `/Sending:/` and `/typed themselves/`.
- [ ] Add after the Drafting line: `"Sending: to email a JHA or send a ticket for approval, find the record first (list_jhas, list_tickets), then call the send tool once. A JHA goes to the job's contacts by name, or to an address the person typed themselves; a ticket approval goes to the ticket's client rep — do not ask where. A send tool sends nothing: the card asks the person to confirm. Answer in one sentence saying so and naming who it goes to."`
- [ ] Run → passes. Commit.

### Task 4: ask/index.ts — the four runners

**Files:** modify `supabase/functions/ask/index.ts`.

- [ ] Import `windowTurns` from askLoop.ts and the askSends exports. Compute `saidByPerson` once: the user turns of `windowTurns(thread)` joined by newline.
- [ ] Generalise `activeJob` into `jobNumbered(number, activeOnly)`; extract `contactsFor(orgIds)` from `jobRecord`.
- [ ] `list_jhas`: job by number (any status); `jhas` select `id, template, work_date, status, signed_at, pdf_key, sent_at, sent_to, profiles(name)` for `job_id`, newest first, 50; map to `{ id, template, work_date, status, filed_by, filed_at, has_pdf, sent_at, sent_to }`.
- [ ] `list_tickets`: `tickets` select `id, work_date, status, total, technician_id, approval_sent_at, approval_sent_to, client_contact, profiles(name)`, newest first, 50; `total` null unless `PRICE_ROLES.includes(me.role)`; `client_contact: client_contact?.name ?? null`.
- [ ] `send_jha`: read `jhas` by id with `jobs(id, job_number, client_id, contractor_id)`; refuse "No assessment with that id — use list_jhas to find it."; `jhaSendGate`; `contactsFor([client, contractor])`; `resolveRecipients(input.recipients, people, saidByPerson)`; `sendJhaWords`; `action = { kind: "send_jha", summary, done, to, message: JHA_MESSAGE, jha: { id, file }, job: { id, job_number } }`; `out = { ready: true, summary, to }`.
- [ ] `send_ticket_approval`: read `tickets` by id with `jobs(id, job_number, client_id, client_contact_id)`; refuse unknown; `ticketSendGate`; the job's client rep = the contact by `client_contact_id`, else the client's primary; `to = [ticketApprovalAddress(row.client_contact?.name, rep?.email)]`; words; action `{ kind: "send_ticket_approval", summary, done, to, ticket: { id }, job }`.
- [ ] `npm run typecheck` → 0. Commit: `Ask proposes a send: four runners, nothing sent`.

### Task 5: The card and App — Send, and the done turn

**Files:** modify `vite-app/src/askThread.js` (+ test), `vite-app/src/components/askPanel.jsx`, `vite-app/src/App.jsx`, `vite-app/src/app.css`.

- [ ] `askThread.js`: `export function isSendAction(action) { return !!action && typeof action.kind === "string" && action.kind.startsWith("send_"); }` with a test.
- [ ] `askPanel.jsx`: `sendingAction` state; `confirmSend(i, action)`: `await onAction(action)` → `dropAction(i)`, `pushTurn("assistant", said)`, `setTurns(askTurns())`; catch → the error line (network → "No connection — nothing was sent."); the proposal block shows `To: …` and a **Send** / "Sending…" button for a send kind, Open the form otherwise; the box and Not now disabled while sending.
- [ ] `App.jsx` `runAskAction`: for a send kind call `Db.sendJhaEmail({ jhaId, to: to.join(", "), cc: "", message })` or `Db.sendTicketApproval({ ticketId, to: to[0] })`, then `OfflineCache.remove("jhas."/"tickets." + job.id)`, return `action.done`; errors propagate to the card.
- [ ] `app.css`: `.ask-proposal-to { margin-top: 4px; font-size: 12px; opacity: 0.8; word-break: break-all; }`.
- [ ] `npm --prefix vite-app test` → green. Commit: `The card sends what Ask proposed, after the person says so`.

### Task 6: Deploy and document

- [ ] `npx supabase functions deploy ask --project-ref eielmvxzdwwprmmfamlq`; probe → 401 "Not signed in".
- [ ] `npm run build && npx wrangler deploy`; the new chunk answers 200.
- [ ] CLAUDE.md's Ask bullet gains the sending paragraph; "Twelve shared modules — … askSends.ts"; README lists askSends.
- [ ] Commit and push.
