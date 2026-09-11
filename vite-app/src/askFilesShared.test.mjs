// A file Ask proposes is checked before it reaches the card: each kind's
// shape is accepted, every fault is refused in words the model can act on,
// the caps hold, and the name is made safe with the kind's extension.

import test from "node:test";
import assert from "node:assert/strict";
import {
  checkFile, safeName, fileWords, fileChars, isFileKind,
  FILE_KINDS, MAX_TEXT_CHARS, MAX_ROWS, MAX_SHEETS, MAX_COLUMNS, MAX_NAME
} from "../../supabase/functions/_shared/askFiles.ts";

test("the name keeps the person's words, drops what a filesystem refuses, and takes the kind's extension", () => {
  assert.equal(safeName("Unsigned tickets", "csv"), "Unsigned tickets.csv");
  assert.equal(safeName("unsigned.csv", "csv"), "unsigned.csv");
  assert.equal(safeName("report.txt.pdf", "pdf"), "report.txt.pdf");
  assert.equal(safeName("rates.xls", "xlsx"), "rates.xlsx");
  assert.equal(safeName("a/b\\c:d*e?f\"g<h>i|j", "html"), "a b c d e f g h i j.html");
  assert.equal(safeName("  ", "css"), "ask.css");
  assert.equal(safeName(null, "pdf"), "ask.pdf");
  assert.equal(safeName("dots...", "csv"), "dots.csv");
  assert.equal(safeName("x".repeat(200), "csv").length, MAX_NAME + 4);
  assert.deepEqual(FILE_KINDS, ["html", "css", "csv", "xlsx", "pdf"]);
  assert.equal(isFileKind("xls"), false);
});

test("html and css are text, bounded", () => {
  const f = checkFile({ kind: "html", name: "page", text: "<h1>Hi</h1>" });
  assert.deepEqual(f, { name: "page.html", kind: "html", text: "<h1>Hi</h1>" });
  assert.throws(() => checkFile({ kind: "css", name: "s", text: "   " }), /needs text/);
  assert.throws(() => checkFile({ kind: "html", name: "s", text: "x".repeat(MAX_TEXT_CHARS + 1) }), /the most is/);
  assert.throws(() => checkFile({ kind: "docx", name: "s", text: "x" }), /kind must be one of/);
});

test("csv is one table, every row as wide as the columns, cells kept as strings or numbers", () => {
  const f = checkFile({ kind: "csv", name: "t", table: { columns: ["Ticket", "Total"], rows: [["T-1", 12.5], ["T-2"], ["T-3", null]] } });
  assert.deepEqual(f.table, { columns: ["Ticket", "Total"], rows: [["T-1", 12.5], ["T-2", null], ["T-3", null]] });
  assert.throws(() => checkFile({ kind: "csv", name: "t", table: { columns: [], rows: [] } }), /needs columns/);
  assert.throws(() => checkFile({ kind: "csv", name: "t", table: { columns: ["a"], rows: "no" } }), /needs rows/);
  assert.throws(() => checkFile({ kind: "csv", name: "t", table: { columns: ["a"], rows: [["x", "y"]] } }), /row 1 has 2 cells for 1 columns/);
  assert.throws(() => checkFile({ kind: "csv", name: "t", table: { columns: ["a"], rows: [1] } }), /row 1 is not a list/);
  assert.throws(() => checkFile({ kind: "csv", name: "t", table: { columns: Array(MAX_COLUMNS + 1).fill("c"), rows: [] } }), /columns; the most/);
  assert.throws(() => checkFile({ kind: "csv", name: "t", table: { columns: ["a"], rows: Array(MAX_ROWS + 1).fill(["x"]) } }), /Too many rows/);
});

test("xlsx is one to ten sheets, names made safe and unique, rows counted across sheets", () => {
  const f = checkFile({ kind: "xlsx", name: "book", sheets: [
    { name: "Open: tickets?", columns: ["a"], rows: [[1]] },
    { name: "open  tickets", columns: ["b"], rows: [["x"]] },
    { columns: ["c"], rows: [] }
  ] });
  assert.deepEqual(f.sheets.map(s => s.name), ["Open tickets", "open tickets 2", "Sheet3"]);
  assert.throws(() => checkFile({ kind: "xlsx", name: "b", sheets: [] }), /needs sheets/);
  assert.throws(() => checkFile({ kind: "xlsx", name: "b", sheets: Array(MAX_SHEETS + 1).fill({ columns: ["a"], rows: [] }) }), /sheets; the most/);
  const half = Array(MAX_ROWS / 2 + 1).fill(["x"]);
  assert.throws(() => checkFile({ kind: "xlsx", name: "b", sheets: [{ columns: ["a"], rows: half }, { columns: ["a"], rows: half }] }), /Too many rows/);
});

test("pdf is a titled document of sections, each with something in it", () => {
  const f = checkFile({ kind: "pdf", name: "job", document: { title: "S-10113", subtitle: "Summary", sections: [
    { heading: "Tickets", table: { columns: ["Ticket", "Status"], rows: [["T-1", "Draft"]] } },
    { text: "Two paragraphs." }
  ] } });
  assert.equal(f.name, "job.pdf");
  assert.equal(f.document.subtitle, "Summary");
  assert.equal(f.document.sections.length, 2);
  assert.deepEqual(f.document.sections[1], { text: "Two paragraphs." });
  assert.throws(() => checkFile({ kind: "pdf", name: "j", document: { sections: [{ text: "x" }] } }), /needs document/);
  assert.throws(() => checkFile({ kind: "pdf", name: "j", document: { title: "T", sections: [] } }), /at least one section/);
  assert.throws(() => checkFile({ kind: "pdf", name: "j", document: { title: "T", sections: [{}] } }), /Section 1 is empty/);
  assert.throws(() => checkFile({ kind: "pdf", name: "j", document: { title: "T", sections: [{ table: { columns: ["a"], rows: [["x", "y"]] } }] } }), /Section 1's table, row 1/);
});

test("the words name the file and what is in it, and the size is a rough count", () => {
  const csv = checkFile({ kind: "csv", name: "t", table: { columns: ["a", "b"], rows: [["x", 1], ["y", 2]] } });
  assert.equal(fileWords(csv), "t.csv (2 rows)");
  assert.ok(fileChars(csv) > 0);
  const x = checkFile({ kind: "xlsx", name: "b", sheets: [{ name: "One", columns: ["a"], rows: [[1]] }] });
  assert.equal(fileWords(x), "b.xlsx (1 sheet, 1 rows)");
  const h = checkFile({ kind: "html", name: "p", text: "<p>hi</p>" });
  assert.equal(fileWords(h), "p.html (9 characters)");
  const p = checkFile({ kind: "pdf", name: "j", document: { title: "T", sections: [{ text: "x" }, { table: { columns: ["a"], rows: [[1], [2]] } }] } });
  assert.equal(fileWords(p), "j.pdf (2 sections, 2 table rows)");
});
