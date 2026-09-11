// The device side of a file Ask proposed: CSV quoting with the accounting
// export's cell, scripts stripped out of HTML, the workbook and the PDF
// built through a fake library the way the real one is called.

import test from "node:test";
import assert from "node:assert/strict";
import { csvCell, csvText, stripScripts, sizeWords, buildXlsx, buildPdf, MIME } from "./askFiles.js";

test("csv: every cell quoted, formulas made text, a BOM in front, columns first", () => {
  assert.equal(csvCell('a "b"'), '"a ""b"""');
  assert.equal(csvCell("=HYPERLINK(x)"), '"\'=HYPERLINK(x)"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(12.5), '"12.5"');
  const t = csvText({ columns: ["Ticket", "Total"], rows: [["T-1", 12.5], ["T-2", null]] });
  assert.equal(t, '﻿"Ticket","Total"\r\n"T-1","12.5"\r\n"T-2",""');
});

test("html: scripts, handlers and javascript: urls go; the page stays", () => {
  const html = '<html><head><script src="x.js"></script><style>p{}</style></head><body onload="evil()"><p onclick=\'go()\' class="a">Hi</p><a href="javascript:alert(1)">x</a><a href="https://ok">ok</a><script>bad()</script><img src=x onerror=bad()></body></html>';
  const out = stripScripts(html);
  assert.doesNotMatch(out, /<script/i);
  assert.doesNotMatch(out, /onload|onclick|onerror/i);
  assert.doesNotMatch(out, /javascript:/i);
  assert.match(out, /<style>p\{\}<\/style>/);
  assert.match(out, /<p class="a">Hi<\/p>/);
  assert.match(out, /href="https:\/\/ok"/);
  assert.match(out, /<a href="#">x<\/a>/);
  // An unclosed script swallows the rest rather than leaving half a script.
  assert.equal(stripScripts("<p>a</p><script>x("), "<p>a</p>");
  assert.equal(stripScripts(null), "");
});

test("sizes read as bytes, KB or MB", () => {
  assert.equal(sizeWords(800), "800 B");
  assert.equal(sizeWords(12 * 1024), "12 KB");
  assert.equal(sizeWords(1.25 * 1024 * 1024), "1.3 MB");
});

test("a workbook is one worksheet per sheet with the columns as the first row", () => {
  const calls = [];
  const XLSX = {
    utils: {
      book_new: () => ({ sheets: [] }),
      aoa_to_sheet: rows => ({ rows }),
      book_append_sheet: (wb, ws, name) => { wb.sheets.push({ name, rows: ws.rows }); }
    },
    write: (wb, opts) => { calls.push(opts); return wb; }
  };
  const out = buildXlsx(XLSX, [{ name: "One", columns: ["a", "b"], rows: [[1, "x"]] }, { name: "Two", columns: ["c"], rows: [] }]);
  assert.deepEqual(out.sheets, [{ name: "One", rows: [["a", "b"], [1, "x"]] }, { name: "Two", rows: [["c"]] }]);
  assert.deepEqual(calls, [{ bookType: "xlsx", type: "array" }]);
});

test("a pdf writes the title, the sections and their tables down the page and over page breaks", () => {
  const events = [];
  class FakePdf {
    constructor() {
      this.internal = { pageSize: { getWidth: () => 612, getHeight: () => 200 } };
      this.lastAutoTable = { finalY: 0 };
    }
    setFontSize(n) { this.size = n; }
    setFont(_f, style) { this.style = style; }
    setTextColor() {}
    splitTextToSize(text) { return String(text).split("\n"); }
    text(t, _x, y) { events.push(["text", t, Math.round(y), this.style]); }
    addPage() { events.push(["page"]); }
    autoTable(o) { events.push(["table", o.head, o.body, Math.round(o.startY)]); this.lastAutoTable = { finalY: o.startY + 30 }; }
    output(kind) { return `blob:${kind}:${events.length}`; }
  }
  const out = buildPdf(FakePdf, {
    title: "S-10113", subtitle: "Summary",
    sections: [
      { heading: "Tickets", table: { columns: ["Ticket", "Total"], rows: [["T-1", 12.5], ["T-2", null]] } },
      { text: "line one\nline two\nline three\nline four\nline five" }
    ]
  });
  assert.equal(out, `blob:blob:${events.length}`);
  assert.deepEqual(events[0], ["text", "S-10113", 66, "bold"]);
  assert.deepEqual(events[1], ["text", "Summary", 86, "normal"]);
  assert.deepEqual(events[2], ["text", "Tickets", 113, "bold"]);
  const table = events.find(e => e[0] === "table");
  assert.deepEqual(table[1], [["Ticket", "Total"]]);
  assert.deepEqual(table[2], [["T-1", "12.5"], ["T-2", ""]]);
  // Five lines of text on a 200pt page after the table: a page break happens.
  assert.ok(events.some(e => e[0] === "page"));
  assert.equal(MIME.pdf, "application/pdf");
});
