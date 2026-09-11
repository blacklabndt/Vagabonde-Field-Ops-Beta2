# Ask six helpers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Six more things Ask can do — chase unsigned tickets, draft a contact or organisation, check the day's work, set a reminder, report hours and dose, look up equipment and contacts — on the slices' rules.

**Architecture:** Eight tools in `askTools.ts`; runners in `ask/index.ts` reading as the caller; pure modules `chasePlan.ts` (twin of chasePlan.js), `emailIn.ts` (twin), `dayCheck.ts`, `hoursDose.ts`; a reminder kind in `scheduled_sends` fired as a push; card confirms for chase and reminder; Contacts seeded from App.

**Tech Stack:** as before.

**Spec:** `docs/superpowers/specs/2026-09-10-ask-six-helpers-design.md`

## Global Constraints

- Reads as the caller; writes through forms or card confirms; the function writes nothing new.
- Migration applied live first, filed with the applier's version, probes beside it.
- New shared modules import nothing; `chasePlan.ts`'s core equals `chasePlan.js`'s by test.
- Every commit passes `npm --prefix vite-app test`.

---

### Task 1: Reminders in the timer table
- [ ] Migration: kind `reminder`, `job_id` nullable, insert policy branch; probes.
- [ ] `scheduledSends.ts`: `KINDS` + reminder, `fireGate("reminder")`, `reminderWords`, `resultPushWords` reminder branch, `whenWords` unchanged; `scheduledSends.js` `describeScheduled` reminder line.
- [ ] `scheduled-sends/index.ts`: reminder branch — push only, no device is a failure.

### Task 2: Pure modules
- [ ] `_shared/emailIn.ts` + `_shared/chasePlan.ts` with shared-core markers; twins in `common.jsx`'s `emailIn` (moved to `vite-app/src/emailIn.js`) and `chasePlan.js`; twin tests.
- [ ] `_shared/dayCheck.ts` + test; `_shared/hoursDose.ts` + test.

### Task 3: Tools and runners
- [ ] `askTools.ts`: chase_unsigned (tracker, price roles), draft_contact, draft_organisation, find_contact (contacts), day_check (job), set_reminder, my_hours, my_dose (any), find_equipment (equipment); trace lines; prompt lines.
- [ ] `ask/index.ts` runners.

### Task 4: The app
- [ ] `askThread.js`: confirm kinds chase ("Chase"), set_reminder ("Set it").
- [ ] `App.jsx`: `runAskAction` for chase (pool + toasts), set_reminder (`Db.scheduleSend` kind reminder), draft_contact / draft_organisation (`contactSeed`, switch to contacts).
- [ ] `contacts.jsx`: `seed` prop — select org, open the form or the dialog filled in.
- [ ] Deploy `ask`, `scheduled-sends`, Worker; docs; memory.
