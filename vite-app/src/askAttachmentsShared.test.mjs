import test from "node:test";
import assert from "node:assert/strict";
import * as files from "../../supabase/functions/_shared/askFiles.ts";
import { ASK_TOOLS } from "../../supabase/functions/_shared/askTools.ts";

const entry = (more = {}) => ({ id: "photo_1", name: "weld.png", type: "image/png", size: 100, width: 800, height: 600, ...more });
const pdf = image => files.checkFile({ kind: "pdf", document: { title: "Report", sections: [{ image }] } });
const plain = fn => assert.throws(fn, e => e.plain === true);

test("attachment metadata accepts only bounded fields and sanitizes names", () => {
  assert.deepEqual(files.checkInputImages(undefined), []);
  assert.deepEqual(files.checkInputImages([entry({ name: "  weld\u0000\n.png ", data: "secret image bytes", url: "https://other.test" })]), [entry({ name: "weld.png" })]);
  assert.equal(files.checkInputImages([entry({ name: "n".repeat(121) })])[0].name.length, 120);
  assert.equal(files.checkInputImages([entry({ type: "image/jpeg", width: 1600, height: 1, size: 5 * 1024 * 1024 })]).length, 1);
});

test("attachment metadata refuses spoofed IDs, malformed entries and oversized input", () => {
  for (const raw of [{}, [null], [entry(), entry()], Array.from({ length: 5 }, (_, i) => entry({ id: `p${i}` }))]) plain(() => files.checkInputImages(raw));
  for (const patch of [
    { id: "" }, { id: "a".repeat(65) }, { id: "../image" }, { id: "data:image/png" }, { id: 1 },
    { name: null }, { name: "\u0000" }, { type: "image/svg+xml" }, { type: "image/png;extra" },
    { size: 0 }, { size: 1.2 }, { size: "100" }, { size: 5 * 1024 * 1024 + 1 },
    { width: 0 }, { width: 1601 }, { width: 1.5 }, { height: Infinity }, { height: "2" }
  ]) plain(() => files.checkInputImages([entry(patch)]));
  plain(() => files.checkInputImages([entry({ size: 5 * 1024 * 1024 }), entry({ id: "b", size: 5 * 1024 * 1024 }), entry({ id: "c", size: 3 * 1024 * 1024 })]));
});

test("PDF attachments need exactly one valid source and cannot enter HTML", () => {
  assert.deepEqual(pdf({ input_id: "photo_1", caption: " Test " }).document.sections[0].image, { input_id: "photo_1", caption: "Test" });
  for (const image of [{ input_id: "../a" }, { input_id: "" }, { input_id: "a", asset: "vagabonde-logo" }, { input_id: "a", shared_path: "a.png" }, { input_id: "a", caption: "x".repeat(301) }]) plain(() => pdf(image));
  plain(() => files.checkFile({ kind: "html", text: "Hi", images: [{ input_id: "photo_1" }] }));
  plain(() => files.checkFile({ kind: "html", text: "Hi", images: [{ input_id: "photo_1", asset: "vagabonde-logo" }] }));
});

test("current request attachment gate cannot borrow shared discovery or old IDs", () => {
  const local = pdf({ input_id: "photo_1" });
  plain(() => files.requireDiscoveredImages(local, new Set(["photo_1"])));
  plain(() => files.requireDiscoveredImages(local, new Set(), new Set(["old_photo"])));
  files.requireDiscoveredImages(local, new Set(), new Set(["photo_1"]));
  const mixed = files.checkFile({ kind: "pdf", document: { title: "Mixed", sections: [{ image: { input_id: "photo_1" } }, { image: { shared_path: "crew/weld.png" } }] } });
  plain(() => files.requireDiscoveredImages(mixed, new Set(), new Set(["photo_1", "crew/weld.png"])));
  files.requireDiscoveredImages(mixed, new Set(["crew/weld.png"]), new Set(["photo_1"]));
});

test("tool schema offers bounded local IDs in PDF only", () => {
  const schema = ASK_TOOLS.find(t => t.name === "make_file").input_schema;
  const image = schema.properties.document.properties.sections.items.properties.image;
  const local = image.oneOf.find(source => source.required.includes("input_id"));
  assert.equal(local.properties.input_id.maxLength, 64);
  assert.equal(local.properties.input_id.pattern, "^[a-zA-Z0-9_-]{1,64}$");
  assert.equal(local.additionalProperties, false);
  assert.equal(schema.properties.images.items.properties.input_id, undefined);
});
