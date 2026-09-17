import test from "node:test";
import assert from "node:assert/strict";
import { prepareAttachments, attachmentManifest, bindPdfInputs, inputsForPdf } from "./askAttachments.js";
import { createPdfImageLoader } from "./askPdfImages.js";
import { pushTurn, askTurns, threadForSend, forgetAskThread } from "./askThread.js";

function png(size = 33) {
  const bytes = new Uint8Array(size);
  bytes.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
  const view = new DataView(bytes.buffer); view.setUint32(16, 800); view.setUint32(20, 600);
  return new File([bytes], "rig.png", { type: "image/png" });
}
const prepare = async () => ({ data: "data:image/png;base64,cGhvdG8=", width: 800, height: 600, format: "PNG" });

test("attachments normalize locally and their manifest contains only bounded metadata", async () => {
  const inputs = await prepareAttachments([png()], [], prepare);
  assert.equal(inputs.length, 1);
  const [meta] = attachmentManifest(inputs);
  assert.deepEqual(Object.keys(meta).sort(), ["height", "id", "name", "size", "type", "width"]);
  assert.equal(meta.name, "rig.png");
  assert.equal(meta.size, 33);
  assert.ok(!JSON.stringify(meta).includes("base64"));
  await assert.rejects(prepareAttachments([new File(["<svg/>"], "x.svg", {type:"image/svg+xml"})], [], prepare), /PNG|JPEG/);
  await assert.rejects(prepareAttachments([png()], Array(4).fill(inputs[0]), prepare), /four/);
  await assert.rejects(prepareAttachments([png(5*1024*1024+1)], [], prepare), /5 MiB/);
  await assert.rejects(prepareAttachments([png(5*1024*1024), png(5*1024*1024), png(5*1024*1024)], [], prepare), /12 MiB/);
});

test("file-owned attachment snapshots survive composer edits and thread reopen without sending bytes", async () => {
  forgetAskThread();
  const inputs = await prepareAttachments([png()], [], prepare);
  const id = inputs[0].id;
  const file = {kind:"pdf", name:"rig.pdf", document:{title:"Rig", sections:[{image:{input_id:id}}]}};
  bindPdfInputs([file], inputs);
  pushTurn("assistant", "PDF ready", null, null, null, [file]);
  inputs.length = 0;
  assert.equal(inputsForPdf(askTurns()[0].files[0]).get(id).image.width, 800);
  assert.ok(!JSON.stringify(file).includes("base64"));
  assert.ok(!JSON.stringify(threadForSend()).includes(id));
  assert.equal(inputsForPdf({...file}).size, 0);
  forgetAskThread();
  assert.deepEqual(askTurns(), []);
});

test("mixed attached and shared sources share one unique-image budget and missing input IDs fail", async () => {
  const inputs = await prepareAttachments([png(5*1024*1024)], [], prepare);
  const load = createPdfImageLoader(async () => png(5*1024*1024), prepare, new Map(inputs.map(i => [i.id, i])));
  const first = await load.input(inputs[0].id);
  assert.equal(await load.input(inputs[0].id), first);
  assert.notEqual((await load("rig.png")).alias, first.alias);
  await assert.rejects(load("second.png"), /12 MiB/);
  await assert.rejects(load.input("missing"), /attached image.*available/i);
});
