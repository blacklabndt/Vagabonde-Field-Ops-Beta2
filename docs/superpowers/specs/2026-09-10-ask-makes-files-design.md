# Ask makes files

Date: 10 September 2026. Follows the learning slice
(`2026-09-10-ask-learns-the-app-design.md`). Kyle's request: the
assistant should be able to create HTML, CSS, CSV, XLS and PDF files.

## The shape

The model writes, the browser builds, the function still writes
nothing. A new tool, `make_file`, lets Ask propose a file from what its
tools already read in that conversation. The function checks the shape
(`_shared/askFiles.ts`, pure, in the guard list), caps the size, makes
the name safe, and returns it beside the answer as `files`. Several in
one answer are allowed — an HTML page and its CSS arrive together — so
`files` is a list, unlike `action`.

The card shows each file under the answer — name, kind, size — with
**Download** and, for an account holding Files, **Save to Files**. The
bytes are built on the device (`vite-app/src/askFiles.js`, pure where
it can be, tested): CSV from the table shape with the same cell quoting
the accounting export uses; HTML and CSS from text; XLSX through SheetJS
and PDF through jsPDF with autotable, the two libraries Timesheets
already loads on demand with SRI — their loaders move to
`vite-app/src/cdnLibs.js` so the two screens share them and
`workerCsp.test.mjs` reads that file too. Download is the CSV export's
own anchor-and-revoke. Save to Files goes through `Db.uploadSharedFile`
under the `Ask` folder, after a confirm on the card, and storage's own
policy decides (the Files tab).

## The tool

`make_file({ name, kind, text?, table?, sheets?, document? })`, offered
to any account that holds a tab at all (`tab: "any"`, a new value
`toolsFor` understands):

- `kind: "html" | "css"` — `text`, the file's whole content.
- `kind: "csv"` — `table: { columns: string[], rows: (string | number | null)[][] }`.
- `kind: "xlsx"` — `sheets: [{ name, columns, rows }]` (one to ten). Kyle
  said XLS; the file is .xlsx, which every Excel since 2007 opens, and
  SheetJS writes it without the legacy format's limits.
- `kind: "pdf"` — `document: { title, subtitle?, sections: [{ heading?, text?, table? }] }`.

`checkFile` refuses anything else in words the model can act on: a
missing part, a row wider than the columns, more than 2,000 rows in all,
text over 200 KB, a name it cannot make safe. The name keeps the
person's words, drops path characters and anything Windows refuses, and
takes the kind's extension whether or not one was given.

The model is told: build a file from what the tools returned in this
conversation; say what is in it in a sentence; a few hundred rows is
the practical ceiling and it says so rather than dropping rows silently;
a file is never a substitute for an answer.

## Safety

- An HTML file is stripped of `<script>` blocks, `on*=` attributes and
  `javascript:` URLs before it is downloaded or saved (`stripScripts`,
  tested). Ask reads records, and a record can carry planted text, so a
  page it writes never runs code — on the device, or in whatever opens
  the download.
- Files are built on the device and never pass through the server unless
  the person saves them to Files, through the same upload the Files
  screen uses.
- The function's response carries the file's content once; the card holds
  it in the thread (memory only, forgotten at sign-out with the rest).

## Budget

The answer's `max_tokens` rises from 1,500 to 8,000 so a file has room;
an answer without a file costs what it did.

## Not built

- A preview in the card (download and open is the preview).
- Files larger than the caps, or built from data the tools did not return.
- XLS (BIFF) rather than XLSX.

## Testing

- `askFiles.test.mjs` (client): `csvText` quoting and BOM, `safeName`,
  `stripScripts`, `fileBytes` for csv/html/css without the CDN, size
  words.
- `askFilesShared.test.mjs`: `checkFile` accepts each kind and refuses
  each fault with words; the caps.
- `askTools.test.mjs`: the tool for any tab, its trace line;
  `toolsFor` with `any`.
- `askThread.test.mjs`: `pushTurn` keeps `files`.
- Live: ask for a CSV of unsigned tickets, an XLSX of two sheets, a PDF
  summary of a job, an HTML page with a CSS file; download each; save
  one to Files and find it under Ask.
