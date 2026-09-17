// Local browser integration probe. Storage responses are fixtures; no login,
// model call or live data is used. Real image decoding, jsPDF and PDF.js run.
// Manual check from the repository root (separate from npm test):
//   npm --prefix vite-app ci
//   npm --prefix vite-app exec -- playwright install chromium
//   node vite-app/scripts/check-ask-pdf-images.mjs
// Requires network access for the app's pinned jsPDF CDN loader. Writes a PDF
// and page PNGs to tmp/pdfs/ for visual inspection; do not commit those outputs.
// Run after changing PDF image loading, sizing, captions, or download/save.
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = fileURLToPath(new URL("../../tmp/pdfs/", import.meta.url));
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route("**/__pdf-check", route => route.fulfill({ contentType:"text/html", body:"<!doctype html><title>PDF image verification</title>" }));
  await page.goto(`${server.resolvedUrls.local[0]}__pdf-check`);
  const fixtures = await page.evaluate(() => {
    const make = (width,height,color,type) => {
      const c = document.createElement("canvas"); c.width=width; c.height=height;
      const ctx=c.getContext("2d"); ctx.fillStyle=color; ctx.fillRect(0,0,width,height);
      ctx.fillStyle="white"; ctx.font="bold 90px sans-serif"; ctx.fillText(`${width} x ${height}`,40,140);
      return c.toDataURL(type).split(",")[1];
    };
    return { "landscape.png":make(2400,1200,"#cf3728","image/png"), "portrait.jpg":make(900,1800,"#176ab1","image/jpeg") };
  });
  const requested = [];
  await page.route("**/storage/v1/object/**", async route => {
    const name = new URL(route.request().url()).pathname.split("/").pop();
    requested.push(name);
    if (fixtures[name]) await route.fulfill({ contentType:name.endsWith("png")?"image/png":"image/jpeg", body:Buffer.from(fixtures[name],"base64") });
    else await route.fulfill({ status:403, contentType:"application/json", body:JSON.stringify({message:"Access denied",statusCode:"403"}) });
  });
  const result = await page.evaluate(async () => {
    const { fileBlob, fileToUpload } = await import("/src/askFiles.js");
    const file = {name:"image-check.pdf",kind:"pdf",document:{title:"Ask PDF image verification",sections:[
      {image:{shared_path:"photos/landscape.png",caption:"Landscape PNG: red, resized from 2400 pixels wide."}},
      {heading:"Inspection notes",text:"An image can be followed by text and a table.",table:{columns:["Item","Status"],rows:[["Weld A","Checked"]]}},
      {image:{shared_path:"photos/portrait.jpg",caption:"Portrait JPEG: blue. This caption stays on the page with the photo. ".repeat(3).trim()}},
      {image:{shared_path:"photos/landscape.png",caption:"Repeated PNG uses the same image bytes."}}
    ]}};
    const blob = await fileBlob(file);
    const upload = await fileToUpload(file);
    if (upload.type !== "application/pdf" || upload.name !== file.name) throw new Error("Upload metadata mismatch");
    let refused = false;
    try { await fileBlob({kind:"pdf",document:{title:"Denied",sections:[{image:{shared_path:"denied.png"}}]}}); }
    catch (e) { refused = e.message.includes("denied.png"); }
    if (!refused) throw new Error("Revoked image must fail the whole PDF");
    const pdfjs = await import("/pdfjs/pdf.min.js");
    pdfjs.GlobalWorkerOptions.workerSrc="/pdfjs/pdf.worker.min.js";
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const pdf = await pdfjs.getDocument({data:bytes.slice()}).promise;
    const pages = [];
    for(let n=1;n<=pdf.numPages;n++) {
      const p=await pdf.getPage(n); const viewport=p.getViewport({scale:1});
      const canvas=document.createElement("canvas"); canvas.width=viewport.width; canvas.height=viewport.height;
      await p.render({canvasContext:canvas.getContext("2d"),viewport}).promise;
      const text=(await p.getTextContent()).items.map(item=>item.str).join(" ");
      pages.push({png:canvas.toDataURL("image/png").split(",")[1],text});
    }
    return {bytes:Array.from(bytes),size:blob.size,pages};
  });
  assert.deepEqual(requested, ["landscape.png","portrait.jpg","landscape.png","portrait.jpg","denied.png"]);
  assert.ok(result.pages.length >= 3);
  assert.ok(result.pages.some(p=>p.text.includes("Portrait JPEG")));
  await mkdir(output,{recursive:true});
  await writeFile(`${output}ask-image-check.pdf`,Buffer.from(result.bytes));
  for(let i=0;i<result.pages.length;i++) await writeFile(`${output}ask-image-check-${i+1}.png`,Buffer.from(result.pages[i].png,"base64"));
  console.log(JSON.stringify({pages:result.pages.length,bytes:result.size,storageRequests:requested,output}));
} finally {
  await browser.close();
  await server.close();
}
