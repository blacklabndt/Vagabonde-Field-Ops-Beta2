// Manual integration check: node vite-app/scripts/check-ask-attachments.mjs
// Requires npm --prefix vite-app ci and Playwright Chromium installed.
// Uses fixture Ask responses, real React, browser image decoding and jsPDF.
// No login, model call or live data. jsPDF's pinned CDN needs network access.
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({ root, server: { host:"127.0.0.1", port:0 }, logLevel:"error" });
await server.listen();
const browser = await chromium.launch({ headless:true });
try {
  const page = await browser.newPage({viewport:{width:1100,height:900}});
  await page.route("**/__attachment-check", route => route.fulfill({contentType:"text/html", body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fonts/barlow.css"><link rel="stylesheet" href="/_ds/industry-4eca1223-ce17-4bd0-9b75-9c7070304b91/styles.css"></head><body><div id="root"></div></body></html>'}));
  await page.goto(`${server.resolvedUrls.local[0]}__attachment-check`);
  const png = await page.evaluate(async () => {
    const {default:refresh} = await import("/@react-refresh");
    refresh.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => type => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    const {default:React} = await import("/node_modules/.vite/deps/react.js");
    const {default:ReactDOM} = await import("/node_modules/.vite/deps/react-dom_client.js");
    const {Db} = await import("/src/db.js");
    const {AskLauncher} = await import("/src/components/askPanel.jsx");
    await import("/src/app.css");
    window.requests = [];
    window.failNext = true;
    Db.listJobNumbers = async () => [];
    Db.ask = async (thread, context) => {
      window.requests.push({thread,context});
      if (window.failNext) { window.failNext = false; throw new Error("Fixture request failed; retry."); }
      if (window.deferNext) { window.deferNext = false; await new Promise(resolve => { window.releaseAsk = resolve; }); }
      return {answer:"Your PDF is ready.", files:[{kind:"pdf",name:"attached.pdf",document:{title:"Attached image check",sections:context.input_images.map(i => ({image:{input_id:i.id,caption:i.name}}))}}]};
    };
    ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(AskLauncher, {context:{screen:"home"}, canSaveFiles:true, onOpenJob:()=>{}, onAction:()=>{}}));
    const c = document.createElement("canvas"); c.width=2400; c.height=1200;
    const ctx=c.getContext("2d"); ctx.fillStyle="#d53232";ctx.fillRect(0,0,c.width,c.height);
    return c.toDataURL("image/png").split(",")[1];
  });
  const photo = {name:"rig.png",mimeType:"image/png",buffer:Buffer.from(png,"base64")};
  await page.getByRole("button",{name:"Ask Claudia"}).click();
  await page.locator('input[type="file"]').setInputFiles(photo);
  await expect(page.getByRole("img",{name:"rig.png"})).toBeVisible();
  await page.locator("textarea").fill("Put my attached rig image in a PDF.");
  await page.getByRole("button",{name:"Send",exact:true}).click();
  await expect(page.locator(".ask-error")).toContainText("Fixture request failed");
  await expect(page.getByRole("img",{name:"rig.png"})).toBeVisible();
  await page.getByRole("button",{name:"Send",exact:true}).click();
  await expect(page.getByText("Your PDF is ready.", {exact:true})).toBeVisible();
  const manifest = await page.evaluate(() => window.requests[1].context.input_images);
  assert.equal(manifest[0].width,1600); assert.equal(manifest[0].height,800);
  assert.deepEqual(Object.keys(manifest[0]).sort(),["height","id","name","size","type","width"]);
  await page.getByRole("button",{name:"Remove rig.png"}).click();
  await page.getByRole("button",{name:"Close",exact:true}).click();
  await page.getByRole("button",{name:"Ask Claudia"}).click();
  const result = await page.evaluate(async () => {
    const {askTurns} = await import("/src/askThread.js");
    const {fileBlob,fileToUpload} = await import("/src/askFiles.js");
    const file=askTurns().at(-1).files[0];
    const blob=await fileBlob(file); const upload=await fileToUpload(file);
    const pdfjs=await import("/pdfjs/pdf.min.js");
    pdfjs.GlobalWorkerOptions.workerSrc="/pdfjs/pdf.worker.min.js";
    const pdf=await pdfjs.getDocument({data:new Uint8Array(await blob.arrayBuffer())}).promise;
    const first=await pdf.getPage(1);
    const ops=await first.getOperatorList();
    const text=(await first.getTextContent()).items.map(i=>i.str).join(" ");
    return {size:blob.size,name:upload.name,images:ops.fnArray.filter(fn=>fn===pdfjs.OPS.paintImageXObject).length,text};
  });
  assert.equal(result.name,"attached.pdf"); assert.equal(result.images,1); assert.match(result.text,/rig.png/);
  for (const kind of ["drop","paste"]) {
    await page.evaluate(({png,kind}) => {
      const bytes=Uint8Array.from(atob(png),c=>c.charCodeAt(0));
      const dt=new DataTransfer(); dt.items.add(new File([bytes],`${kind}.png`,{type:"image/png"}));
      if (kind==="drop") document.querySelector(".ask-card").dispatchEvent(new DragEvent("drop",{dataTransfer:dt,bubbles:true,cancelable:true}));
      else document.querySelector("textarea").dispatchEvent(new ClipboardEvent("paste",{clipboardData:dt,bubbles:true,cancelable:true}));
    },{png,kind});
    await expect(page.getByRole("img",{name:`${kind}.png`})).toBeVisible();
  }
  await page.locator('input[type="file"]').setInputFiles({name:"bad.svg",mimeType:"image/svg+xml",buffer:Buffer.from("<svg/>")});
  await expect(page.locator(".ask-error")).toContainText("PNG or JPEG");
  await page.setViewportSize({width:390,height:844});
  await expect(page.getByRole("button",{name:"Send",exact:true})).toBeVisible();
  await page.screenshot({path:fileURLToPath(new URL("../../tmp/ask-attachments-mobile.png",import.meta.url))});
  await page.evaluate(() => { window.deferNext = true; });
  await page.locator("textarea").fill("Make another PDF.");
  await page.getByRole("button",{name:"Send",exact:true}).click();
  await page.waitForFunction(() => typeof window.releaseAsk === "function");
  await page.getByRole("button",{name:"Close",exact:true}).click();
  await expect(page.getByRole("button",{name:"Ask Claudia"})).toBeVisible();
  await page.evaluate(() => { window.releaseAsk(); window.releaseAsk = null; });
  await page.waitForFunction(async () => (await import("/src/askThread.js")).askTurns().length === 4);
  await page.getByRole("button",{name:"Ask Claudia"}).click();
  await expect(page.getByText("Your PDF is ready.",{exact:true})).toHaveCount(2);
  await page.evaluate(() => { window.deferNext = true; });
  await page.locator("textarea").fill("This request will outlive sign-out.");
  await page.getByRole("button",{name:"Send",exact:true}).click();
  await page.waitForFunction(() => typeof window.releaseAsk === "function");
  await page.getByRole("button",{name:"Close",exact:true}).click();
  await expect(page.getByRole("button",{name:"Ask Claudia"})).toBeVisible();
  await page.evaluate(async () => {
    const {forgetAskThread}=await import("/src/askThread.js"); forgetAskThread();
    window.releaseAsk();
    await new Promise(resolve => setTimeout(resolve,0));
  });
  assert.equal(await page.evaluate(async () => (await import("/src/askThread.js")).askTurns().length),0);
  console.log(JSON.stringify({passed:"picker, drop, paste, retry, metadata privacy, reopen, PDF pixels/caption, upload bytes, invalid type, mobile controls, close during request, sign-out",...result}));
} finally {
  await browser.close(); await server.close();
}
