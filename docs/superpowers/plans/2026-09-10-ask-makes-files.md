# Ask makes files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ask can propose HTML, CSS, CSV, XLSX and PDF files built from what its tools read; the card downloads them on the device or saves them to Files.

**Architecture:** `make_file` tool → `_shared/askFiles.ts` checks the shape and returns `files` on the response → `vite-app/src/askFiles.js` builds bytes (CSV/HTML/CSS pure; XLSX and PDF through `cdnLibs.js`, the loaders moved out of Timesheets) → the card's file block with Download and Save to Files.

**Tech Stack:** SheetJS 0.18.5 and jsPDF 2.5.2 + autotable 3.8.4 from the CDN with SRI, as Timesheets already does.

**Spec:** `docs/superpowers/specs/2026-09-10-ask-makes-files-design.md`

## Global Constraints

- The `ask` function writes nothing new; bytes are built on the device.
- HTML never carries scripts when it leaves the card.
- `askFiles.ts` imports nothing; the guard test says so.
- Every commit passes `npm --prefix vite-app test`.

---

### Task 1: The shared check

**Files:** create `supabase/functions/_shared/askFiles.ts`, `vite-app/src/askFilesShared.test.mjs`; modify `backupShared.test.mjs`.

- [ ] `FILE_KINDS`, `MAX_TEXT_CHARS = 200_000`, `MAX_ROWS = 2000`, `MAX_SHEETS = 10`, `MAX_FILES = 5`.
- [ ] `safeName(name, kind)`; `checkFile(input)` → `AskFile` or throws; `fileWords(file)`.
- [ ] Tests.

### Task 2: The tool and the function

**Files:** modify `_shared/askTools.ts`, `_shared/askLoop.ts`, `ask/index.ts`, `askTools.test.mjs`, `askLoop.test.mjs`.

- [ ] `tab: "any"` in `toolsFor`; `make_file` tool; trace line; prompt line "Files:".
- [ ] `MAX_TOKENS = 8000`.
- [ ] Runner: `checkFile`, push onto `files` (cap `MAX_FILES`), `out = { ready, name, size }`; response carries `files`.

### Task 3: The device side

**Files:** create `vite-app/src/cdnLibs.js`, `vite-app/src/askFiles.js`, `vite-app/src/askFiles.test.mjs`; modify `components/timesheets.jsx`, `workerCsp.test.mjs`, `askThread.js` + test, `components/askPanel.jsx`, `app.css`, `App.jsx`.

- [ ] `cdnLibs.js`: `cdnScript`, `loadXlsx`, `loadJsPdf` moved verbatim; Timesheets imports them; the CSP test reads `cdnLibs.js`.
- [ ] `askFiles.js`: `csvText(table)`, `stripScripts(html)`, `sizeWords(n)`, `fileBytes(file, libs)` → `{ blob, name }`, `downloadFile(file)`, `MIME`.
- [ ] `pushTurn(..., files)`; card block: Download / Save to Files (confirm → `Db.uploadSharedFile("Ask", new File(...))`, needs `files` tab from `currentUser` — App passes `canSaveFiles`).
- [ ] Deploy `ask`, Worker; docs; memory.
