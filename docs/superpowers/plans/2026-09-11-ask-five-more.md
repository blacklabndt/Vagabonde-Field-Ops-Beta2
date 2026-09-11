# Ask five more Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ask opens a record, checks a draft ticket before it goes, looks a client's rates up, repeats Home's Needs attention strip, and proposes cancelling an approval — on the slices' rules.

**Architecture:** Five tools in `askTools.ts`; runners in `ask/index.ts` reading as the caller; pure modules `ticketCheck.ts` (new) and `attention.ts` (twin of `attention.js`'s core); an `open` action App navigates on and a `cancel_approval` confirm App runs through the withdraw RPC.

**Tech Stack:** as before.

**Spec:** `docs/superpowers/specs/2026-09-11-ask-five-more-design.md`

## Global Constraints

- Reads as the caller; writes through the app's own doors after a card confirm; the function writes nothing new.
- New shared modules import nothing; `attention.ts`'s core equals `attention.js`'s by test.
- Every commit passes `npm --prefix vite-app test`.

---

### Task 1: Pure modules
- [ ] `attention.js`: `shared core` markers round the constants, `agoPhrase`, `byFunction`, `attentionItems`; `_shared/attention.ts` twin, annotated; `askTwins.test.mjs` pair.
- [ ] `_shared/ticketCheck.ts` + `ticketCheck.test.mjs` (findings; ceilings twinned from data.js with a drift test).

### Task 2: Tools and runners
- [ ] `askTools.ts`: open_record (job), check_ticket (ticket, price roles), rate_card (rates, price roles), needs_attention (board, Admin), cancel_approval (ticket); trace lines; the prompt paragraph in `askLoop.ts`.
- [ ] `ask/index.ts` runners.

### Task 3: The app
- [ ] `askThread.js`: `cancel_approval` in CONFIRM_KINDS ("Cancel approval"); `formLabel(action)`; `askPanel.jsx` uses it.
- [ ] `App.jsx`: `runAskAction` for open (job / ticket via `openTicket` / jha / report) and cancel_approval (`Db.withdrawTicketApproval`, cache drop, `filedNonce`).
- [ ] Gate, commit, deploy `ask` and the Worker, docs, memory.
