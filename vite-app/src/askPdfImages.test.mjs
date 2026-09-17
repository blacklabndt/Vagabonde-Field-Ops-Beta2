import test from "node:test";
import assert from "node:assert/strict";
import { imageHeader, createPdfImageLoader } from "./askPdfImages.js";

function png(w = 800, h = 600) {
  const b = new Uint8Array(33);
  b.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
  const v = new DataView(b.buffer); v.setUint32(16, w); v.setUint32(20, h);
  return b;
}
function jpeg(w = 600, h = 800) {
  return new Uint8Array([255,216,255,192,0,17,8,h>>8,h&255,w>>8,w&255,3,1,17,0,2,17,0,3,17,0,255,217]);
}
test("image headers validate PNG/JPEG dimensions before decoding", () => {
  assert.deepEqual(imageHeader(png()), { width:800, height:600, format:"PNG" });
  assert.deepEqual(imageHeader(jpeg()), { width:600, height:800, format:"JPEG" });
  for (const data of [png(0), png(16385,1), png(8000,8000), new Uint8Array([255,216,255]), new TextEncoder().encode("<svg/>")]) {
    assert.throws(() => imageHeader(data), /image|pixels|PNG|JPEG/i);
  }
});
test("sources load once, preserve distinct aliases and bound unique bytes", async () => {
  const calls = [];
  const load = createPdfImageLoader(async path => { calls.push(path); return new Blob([png()], { type:"image/png" }); }, async (_blob, header) => ({ ...header, data:"normalized" }));
  const first = await load("photos/a.png");
  assert.equal(await load("photos/a.png"), first);
  assert.notEqual((await load("photos/b.png")).alias, first.alias);
  assert.deepEqual(calls, ["photos/a.png", "photos/b.png"]);
});
test("failed or invalid sources refuse the whole build with their filename", async () => {
  let decoded = false;
  for (const blob of [new Blob([png(8000,8000)], {type:"image/png"}), new Blob([png()], {type:"image/jpeg"}), new Blob([new Uint8Array(5*1024*1024+1)], {type:"image/png"})]) {
    const load = createPdfImageLoader(async () => blob, async () => { decoded = true; });
    await assert.rejects(load("photos/bad.png"), /bad.png/);
  }
  assert.equal(decoded, false);
  const denied = createPdfImageLoader(async () => { throw new Error("permission denied"); });
  await assert.rejects(denied("revoked.png"), /revoked.png.*permission denied/);
});
test("aggregate source budget rejects before decoding a third large image", async () => {
  let decoded = 0;
  const data = new Uint8Array(5*1024*1024); data.set(png());
  const load = createPdfImageLoader(async () => new Blob([data], {type:"image/png"}), async (_blob, header) => { decoded++; return {...header, data:"ok"}; });
  await load("a.png"); await load("b.png"); await load("a.png");
  await assert.rejects(load("c.png"), /12 MiB/);
  assert.equal(decoded, 2);
});
