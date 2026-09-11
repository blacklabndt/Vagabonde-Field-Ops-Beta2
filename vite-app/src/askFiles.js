// The bytes of a file Ask proposed, built on the device from the checked
// shape the function returned (_shared/askFiles.ts): CSV and the two text
// kinds here in plain code, XLSX through SheetJS and PDF through jsPDF,
// loaded on demand (cdnLibs.js). The builders that take a library take it
// as an argument, so the node suite runs them against a fake; the two
// entry points at the bottom are the card's.
//
// An HTML file is stripped of scripts and handlers before it leaves the
// card: Ask reads records, a record can carry planted text, and a page it
// writes must never run code — here, or in whatever opens the download.

import { saveBlob } from "./zip.js";
import { loadXlsx, loadJsPdf } from "./cdnLibs.js";

export const MIME = {
  html: "text/html;charset=utf-8",
  css: "text/css;charset=utf-8",
  csv: "text/csv;charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf"
};

// Every cell quoted, and one that Excel would read as a formula made text:
// a project named "=HYPERLINK(...)" would run when accounting opened the
// export. A leading apostrophe makes it text, which is what it is. The
// accounting export (common.jsx) uses this same cell.
export const csvCell = v => {
  const s = String(v == null ? "" : v);
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

// The BOM is what makes Excel read this as UTF-8 — without it, accented
// client and site names arrive mangled.
export function csvText(table) {
  const rows = [table.columns, ...table.rows];
  return "﻿" + rows.map(r => r.map(csvCell).join(",")).join("\r\n");
}

// Scripts, inline handlers and javascript: URLs out; everything else stays.
export function stripScripts(html) {
  return String(html ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*$/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(\s(?:href|src|action|formaction|xlink:href)\s*=\s*["']?)\s*javascript:[^"'\s>]*/gi, "$1#");
}

export function sizeWords(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// A workbook: one worksheet per sheet, the columns as the first row.
export function buildXlsx(XLSX, sheets) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet([s.columns, ...s.rows]);
    XLSX.utils.book_append_sheet(wb, ws, s.name);
  }
  return XLSX.write(wb, { bookType: "xlsx", type: "array" });
}

// A letter-size document: the title, a subtitle, then each section's
// heading, its text wrapped to the page, and its table through autotable;
// the cursor carries down the page and over page breaks.
export function buildPdf(JsPDF, doc) {
  const pdf = new JsPDF({ unit: "pt", format: "letter" });
  const margin = 48;
  const width = pdf.internal.pageSize.getWidth() - margin * 2;
  const bottom = pdf.internal.pageSize.getHeight() - margin;
  let y = margin;
  const need = h => { if (y + h > bottom) { pdf.addPage(); y = margin; } };
  const lines = (text, size) => { pdf.setFontSize(size); return pdf.splitTextToSize(String(text), width); };
  const write = (text, size, style, gapAfter) => {
    pdf.setFont("helvetica", style);
    const ls = lines(text, size);
    const lh = size * 1.3;
    for (const l of ls) { need(lh); pdf.text(l, margin, y + size); y += lh; }
    y += gapAfter;
  };
  write(doc.title, 18, "bold", 4);
  if (doc.subtitle) { pdf.setTextColor(110); write(doc.subtitle, 11, "normal", 10); pdf.setTextColor(0); } else y += 8;
  for (const s of doc.sections) {
    if (s.heading) write(s.heading, 13, "bold", 2);
    if (s.text) write(s.text, 10, "normal", 6);
    if (s.table) {
      need(40);
      pdf.autoTable({
        head: [s.table.columns],
        body: s.table.rows.map(r => r.map(c => (c == null ? "" : String(c)))),
        startY: y, margin: { left: margin, right: margin },
        styles: { fontSize: 9, cellPadding: 3 },
        headStyles: { fillColor: [40, 40, 40] }
      });
      y = pdf.lastAutoTable.finalY + 14;
    }
  }
  return pdf.output("blob");
}

// The bytes of one checked file, as a Blob of the kind's type.
export async function fileBlob(file) {
  if (file.kind === "html") return new Blob([stripScripts(file.text)], { type: MIME.html });
  if (file.kind === "css") return new Blob([String(file.text ?? "")], { type: MIME.css });
  if (file.kind === "csv") return new Blob([csvText(file.table)], { type: MIME.csv });
  if (file.kind === "xlsx") return new Blob([buildXlsx(await loadXlsx(), file.sheets)], { type: MIME.xlsx });
  if (file.kind === "pdf") {
    const out = buildPdf(await loadJsPdf(), file.document);
    return out instanceof Blob ? out : new Blob([out], { type: MIME.pdf });
  }
  throw new Error(`Nothing builds a "${file.kind}" file.`);
}

export async function downloadFile(file) {
  saveBlob(await fileBlob(file), file.name);
}

// For Save to Files: the same bytes as a File, the way a drop on the Files
// screen arrives.
export async function fileToUpload(file) {
  return new File([await fileBlob(file)], file.name, { type: MIME[file.kind] || "application/octet-stream" });
}
