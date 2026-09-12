// Does a pdf.js version still read a report the way the Upload dialog does?
//
// Not part of `npm test`: pdfjs-dist is not a dependency of this app — it
// arrives by URL, which is the whole reason cdnPins.test.mjs exists. This
// is the bench test behind docs/reviews/2026-09-11-pdfjs-upgrade-proposal.md.
//
//   mkdir pdfjs-probe && cd pdfjs-probe
//   npm init -y && npm pkg set type=module
//   npm install pdfjs-dist@5.4.149
//   node <this file> ./node_modules/pdfjs-dist/legacy/build/pdf.mjs
//
// ONE VERSION PER PROCESS. Loading two in one process makes 3.x's global
// fake worker answer 4.x's API and the run dies on "The API version does
// not match the Worker version" — which is the probe's own fault and not
// the library's.

// Node has neither; every browser has both, and 5.x touches them at load.
if (!globalThis.DOMMatrix) {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor(i = [1, 0, 0, 1, 0, 0]) { [this.a, this.b, this.c, this.d, this.e, this.f] = i; }
  };
}
if (!globalThis.Path2D) globalThis.Path2D = class Path2D {};

// A two-page report with real text and correct xref offsets. Nothing
// crafted: the question is whether an ordinary file still reads.
function makePdf() {
  const content = t => `BT /F1 12 Tf 72 720 Td (${t}) Tj ET`;
  const streams = [content("RT Report  Welds 101, 102, 103"), content("Continued  Weld 104")];
  const objs = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>";
  objs[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>";
  objs[4] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>";
  objs[5] = `<< /Length ${streams[0].length} >>\nstream\n${streams[0]}\nendstream`;
  objs[6] = `<< /Length ${streams[1].length} >>\nstream\n${streams[1]}\nendstream`;
  objs[7] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let out = "%PDF-1.4\n";
  const at = [];
  for (let i = 1; i <= 7; i++) { at[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = out.length;
  out += "xref\n0 8\n0000000000 65535 f \n";
  for (let i = 1; i <= 7; i++) out += String(at[i]).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

const spec = process.argv[2];
if (!spec) { console.error("give it a path to a pdf.js build"); process.exit(2); }
// Resolved against where you are standing, not against this file. A bare
// relative specifier in import() resolves against the MODULE, which sent
// the first run of this probe looking for pdf.js inside docs/reviews.
const { resolve } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const mod = await import(pathToFileURL(resolve(process.cwd(), spec)).href);
const pdfjs = mod.getDocument ? mod : mod.default;

const task = pdfjs.getDocument({ data: makePdf() });
const doc = await task.promise;

// jobDetail.jsx's pdfText(), body for body.
let text = "";
for (let i = 1; i <= Math.min(doc.numPages, 40); i++) {
  const page = await doc.getPage(i);
  text += (await page.getTextContent()).items.map(it => it.str).join(" ") + "\n";
}

const EXPECT = "RT Report Welds 101, 102, 103\nContinued Weld 104\n";
console.log("version        ", pdfjs.version ?? "(not exported)");
console.log("text           ", JSON.stringify(text));
console.log("matches 3.11.174", text === EXPECT);
// 6.x removed PDFDocumentProxy.destroy(). The dialog calls it in a finally,
// so on 6.x the text is read and then thrown away by the TypeError raised
// on the way out. loadingTask.destroy() is on 4, 5 and 6.
console.log("doc.destroy    ", typeof doc.destroy);
console.log("task.destroy   ", typeof task.destroy);
await task.destroy();
console.log("task.destroy() ok");
