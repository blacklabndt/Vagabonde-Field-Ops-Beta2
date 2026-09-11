// A file Ask proposes — the shape the make_file tool must hand in, checked
// here before it is put on the response. Pure: no imports
// (backupShared.test.mjs guards that), so the node suite covers every
// refusal. The bytes are never built here: the device builds them
// (vite-app/src/askFiles.js) from this checked shape, and the function
// writes nothing.
//
// Five kinds. HTML and CSS are text. CSV is one table; XLSX is one to ten
// sheets of tables; PDF is a small document of sections, each some text
// and/or a table. A table is columns and rows, every row as wide as the
// columns. Everything is bounded, and a refusal says what to fix in words
// the model can act on.

export const FILE_KINDS = ["html", "css", "csv", "xlsx", "pdf"] as const;
export type FileKind = typeof FILE_KINDS[number];
export const MAX_TEXT_CHARS = 200_000;
export const MAX_ROWS = 2000;
export const MAX_COLUMNS = 50;
export const MAX_SHEETS = 10;
export const MAX_SECTIONS = 40;
export const MAX_FILES = 5;
export const MAX_NAME = 80;

export type Cell = string | number | null;
export interface Table { columns: string[]; rows: Cell[][] }
export interface Sheet extends Table { name: string }
export interface Section { heading?: string; text?: string; table?: Table }
export interface Doc { title: string; subtitle?: string; sections: Section[] }
export interface AskFile {
  name: string; kind: FileKind;
  text?: string; table?: Table; sheets?: Sheet[]; document?: Doc;
}

export function isFileKind(v: unknown): v is FileKind {
  return typeof v === "string" && (FILE_KINDS as readonly string[]).includes(v);
}

// The person's words for the name, made safe for every OS and the shared
// drive: path characters and the ones Windows refuses go, whitespace
// folds to one space, and the kind's extension is put on whether or not
// one was given (a wrong one is replaced).
export function safeName(name: unknown, kind: FileKind): string {
  // Path characters and the ones Windows refuses by regex; control
  // characters by code, because a control range in a regex is refused by the lint.
  let base = [...String(name ?? "")].filter(c => c.charCodeAt(0) >= 32).join("")
    .replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  base = base.replace(/\.(html?|css|csv|xlsx?|pdf)$/i, "").trim();
  base = base.replace(/\.+$/, "").trim();
  if (!base) base = "ask";
  if (base.length > MAX_NAME) base = base.slice(0, MAX_NAME).trim();
  return `${base}.${kind}`;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const cell = (v: unknown): Cell => (v == null ? null : typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" ? v : typeof v === "boolean" ? String(v) : String(v));

function checkTable(raw: unknown, where: string, rowsSoFar: number): Table {
  const t = (raw && typeof raw === "object") ? raw as { columns?: unknown; rows?: unknown } : null;
  if (!t || !Array.isArray(t.columns) || !t.columns.length) throw new Error(`${where} needs columns — a list of column names.`);
  if (t.columns.length > MAX_COLUMNS) throw new Error(`${where} has ${t.columns.length} columns; the most is ${MAX_COLUMNS}.`);
  const columns = t.columns.map(c => String(c ?? "").trim());
  if (!Array.isArray(t.rows)) throw new Error(`${where} needs rows — a list of rows, each a list of cells.`);
  if (rowsSoFar + t.rows.length > MAX_ROWS) throw new Error(`Too many rows: the most in one file is ${MAX_ROWS}. Narrow it down and say so.`);
  const rows = t.rows.map((r, i) => {
    if (!Array.isArray(r)) throw new Error(`${where}, row ${i + 1} is not a list of cells.`);
    if (r.length > columns.length) throw new Error(`${where}, row ${i + 1} has ${r.length} cells for ${columns.length} columns.`);
    const out = r.map(cell);
    while (out.length < columns.length) out.push(null);
    return out;
  });
  return { columns, rows };
}

// The tool's input, checked and shaped, or a refusal in words.
export function checkFile(raw: unknown): AskFile {
  const r = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
  if (!isFileKind(r.kind)) throw new Error(`kind must be one of ${FILE_KINDS.join(", ")}.`);
  const kind = r.kind;
  const name = safeName(r.name, kind);
  if (kind === "html" || kind === "css") {
    const text = str(r.text);
    if (!text || !text.trim()) throw new Error(`A ${kind} file needs text — the file's whole content.`);
    if (text.length > MAX_TEXT_CHARS) throw new Error(`The text is ${text.length} characters; the most is ${MAX_TEXT_CHARS}.`);
    return { name, kind, text };
  }
  if (kind === "csv") {
    return { name, kind, table: checkTable(r.table, "A csv file's table", 0) };
  }
  if (kind === "xlsx") {
    if (!Array.isArray(r.sheets) || !r.sheets.length) throw new Error("An xlsx file needs sheets — a list of { name, columns, rows }.");
    if (r.sheets.length > MAX_SHEETS) throw new Error(`${r.sheets.length} sheets; the most is ${MAX_SHEETS}.`);
    let rowsSoFar = 0;
    const seen = new Set<string>();
    const sheets = r.sheets.map((s, i) => {
      const o = (s && typeof s === "object") ? s as { name?: unknown } : {};
      let sheetName = String(o.name ?? "").replace(/[\\/?*[\]:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || `Sheet${i + 1}`;
      while (seen.has(sheetName.toLowerCase())) sheetName = `${sheetName.slice(0, 28)} ${i + 1}`;
      seen.add(sheetName.toLowerCase());
      const table = checkTable(s, `Sheet "${sheetName}"`, rowsSoFar);
      rowsSoFar += table.rows.length;
      return { name: sheetName, ...table };
    });
    return { name, kind, sheets };
  }
  // pdf
  const d = (r.document && typeof r.document === "object") ? r.document as { title?: unknown; subtitle?: unknown; sections?: unknown } : null;
  const title = d ? str(d.title)?.trim() ?? "" : "";
  if (!d || !title) throw new Error("A pdf file needs document: { title, sections: [{ heading?, text?, table? }] }.");
  if (!Array.isArray(d.sections) || !d.sections.length) throw new Error("A pdf document needs at least one section with text or a table.");
  if (d.sections.length > MAX_SECTIONS) throw new Error(`${d.sections.length} sections; the most is ${MAX_SECTIONS}.`);
  let rowsSoFar = 0;
  let chars = title.length;
  const sections = d.sections.map((s, i) => {
    const o = (s && typeof s === "object") ? s as { heading?: unknown; text?: unknown; table?: unknown } : {};
    const section: Section = {};
    const heading = str(o.heading)?.trim();
    const text = str(o.text)?.trim();
    if (heading) section.heading = heading;
    if (text) section.text = text;
    chars += (heading?.length ?? 0) + (text?.length ?? 0);
    if (o.table != null) {
      section.table = checkTable(o.table, `Section ${i + 1}'s table`, rowsSoFar);
      rowsSoFar += section.table.rows.length;
    }
    if (!section.heading && !section.text && !section.table) throw new Error(`Section ${i + 1} is empty — give it a heading, text or a table.`);
    return section;
  });
  if (chars > MAX_TEXT_CHARS) throw new Error(`The document's text is ${chars} characters; the most is ${MAX_TEXT_CHARS}.`);
  const doc: Doc = { title, sections };
  const subtitle = str(d.subtitle)?.trim();
  if (subtitle) doc.subtitle = subtitle;
  return { name, kind, document: doc };
}

// A rough size, for the tool's reply and the card, before the bytes exist.
export function fileChars(file: AskFile): number {
  if (file.text) return file.text.length;
  const tableChars = (t: Table) => t.columns.join(",").length + t.rows.reduce((n, r) => n + r.map(c => String(c ?? "")).join(",").length + 2, 0);
  if (file.table) return tableChars(file.table);
  if (file.sheets) return file.sheets.reduce((n, s) => n + tableChars(s), 0);
  if (file.document) {
    return file.document.title.length + file.document.sections.reduce((n, s) => n + (s.heading?.length ?? 0) + (s.text?.length ?? 0) + (s.table ? tableChars(s.table) : 0), 0);
  }
  return 0;
}

export function fileWords(file: AskFile): string {
  const rows = file.table ? file.table.rows.length
    : file.sheets ? file.sheets.reduce((n, s) => n + s.rows.length, 0)
    : file.document ? file.document.sections.reduce((n, s) => n + (s.table?.rows.length ?? 0), 0)
    : 0;
  const what = file.kind === "xlsx" ? `${file.sheets?.length ?? 0} sheet${(file.sheets?.length ?? 0) === 1 ? "" : "s"}, ${rows} rows`
    : file.kind === "csv" ? `${rows} rows`
    : file.kind === "pdf" ? `${file.document?.sections.length ?? 0} section${(file.document?.sections.length ?? 0) === 1 ? "" : "s"}${rows ? `, ${rows} table rows` : ""}`
    : `${file.text?.length ?? 0} characters`;
  return `${file.name} (${what})`;
}
