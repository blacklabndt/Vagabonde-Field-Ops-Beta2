// A photo pasted or dropped onto Ask's card: where its key comes from, what
// the card refuses before it uploads, and which month folders the nightly
// sweep is allowed to throw away.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import {
  ATTACH_ROOT, MAX_ATTACHMENTS, ATTACH_KEEP_DAYS,
  attachMonth, attachPath, isAttachPath, expiredAttachMonths,
  imageFilesFrom, attachLabel, hashName, readAttachment,
  attachRunner, canSend, clearSent, keepName, hashOfPath
} from "./askAttach.js";
import {
  isAttachPath as isAttachPathTs,
  expiredAttachMonths as expiredAttachMonthsTs, ATTACH_ROOT as ATTACH_ROOT_TS
} from "../../supabase/functions/_shared/askAttachments.ts";
import { cleanContext, whereLines } from "../../supabase/functions/_shared/askKnowledge.ts";

const CORE = /\/\/ ═══ shared core[^\n]*\n([\s\S]*?)\/\/ ═══ end shared core ═══/;
const coreOf = file => {
  const src = readFileSync(new URL(file, import.meta.url), "utf8");
  const m = CORE.exec(src);
  assert.ok(m, `${file} has no shared core markers`);
  return m[1];
};
const shapeOf = code => code.split("\n")
  .map(l => l.replace(/\s+/g, " ").replace(/ (?=[),;])/g, "").trim())
  .filter(Boolean).join("\n");

test("the attachment key is the same code on the card and in the function", () => {
  const js = coreOf("./askAttach.js");
  const ts = coreOf("../../supabase/functions/_shared/askAttachments.ts");
  assert.ok(js.includes("export function attachPath"), "the core must hold attachPath itself");
  assert.ok(/attachPath\(month: string, hash: string, format: string\): string/.test(ts), "the function's copy is the typed one");
  assert.equal(shapeOf(stripTypeScriptTypes(ts)), shapeOf(js));
  assert.equal(ATTACH_ROOT, ATTACH_ROOT_TS);
});

test("a key is the month and the content hash, and nothing else is one", () => {
  const key = attachPath("2026-09", "a".repeat(32), "JPEG");
  assert.equal(key, "Ask/attachments/2026-09/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg");
  assert.equal(attachPath("2026-01", "0123456789ab", "PNG"), "Ask/attachments/2026-01/0123456789ab.png");
  for (const f of [isAttachPath, isAttachPathTs]) {
    assert.equal(f(key), true);
    // Nothing outside the root, no traversal, no other folder in Files, and
    // no name that is not a hash — the sweep and the gate read this.
    assert.equal(f("Ask/attachments/2026-09/../../secret.png"), false);
    assert.equal(f("Ask/attachments/2026-13/aaaaaaaaaaaa.png"), false);
    assert.equal(f("Ask/aaaaaaaaaaaa.png"), false);
    assert.equal(f("Templates/decay.png"), false);
    assert.equal(f("Ask/attachments/2026-09/holiday.png"), false);
    assert.equal(f("Ask/attachments/2026-09/AAAAAAAAAAAA.png"), false);
    assert.equal(f("Ask/attachments/2026-09/aaaaaaaaaaaa.gif"), false);
    assert.equal(f(null), false);
  }
  assert.throws(() => attachPath("2026-9", "a".repeat(32), "PNG"), /YYYY-MM/);
  assert.throws(() => attachPath("2026-09", "zz".repeat(6), "PNG"), /content hash/);
  assert.throws(() => attachPath("2026-09", "a".repeat(32), "GIF"), /PNG or a JPEG/);
  // The month is UTC: a device an hour either side of midnight on the first
  // must not mint a second folder for the same photo.
  assert.equal(attachMonth(Date.UTC(2026, 8, 1, 0, 30)), "2026-09");
  assert.equal(attachMonth(Date.UTC(2026, 8, 30, 23, 30)), "2026-09");
  assert.throws(() => attachMonth(Number.NaN), /real clock/);
});

test("a month folder is swept only once its last day is ninety days behind", () => {
  assert.equal(ATTACH_KEEP_DAYS, 90);
  const now = Date.UTC(2026, 8, 16); // 16 Sept 2026
  const names = ["2026-09", "2026-08", "2026-07", "2026-06", "2026-05", "2025-12", "notes", "2026-13", ".keep"];
  for (const f of [expiredAttachMonths, expiredAttachMonthsTs]) {
    // June ended 1 July; 16 Sept is 77 days on — not yet. May ended 1 June,
    // 107 days on — gone. Nothing that is not a month name is ever named.
    assert.deepEqual(f(names, now), ["2026-05", "2025-12"]);
    assert.deepEqual(f([], now), []);
    assert.deepEqual(f(null, now), []);
  }
  // The boundary itself: exactly ninety days after the folder's end.
  const end = Date.UTC(2026, 6); // 1 July 2026, the end of June
  assert.deepEqual(expiredAttachMonths(["2026-06"], end + 90 * 86400000), ["2026-06"]);
  assert.deepEqual(expiredAttachMonths(["2026-06"], end + 90 * 86400000 - 1), []);
});

test("a drop or a paste yields the image files and passes over everything else", () => {
  const png = { type: "image/png", name: "weld.png" };
  const text = { type: "text/plain", name: "notes.txt" };
  const items = [
    { kind: "file", getAsFile: () => png },
    { kind: "file", getAsFile: () => text },
    { kind: "string", getAsFile: () => null }
  ];
  assert.deepEqual(imageFilesFrom({ items, files: [] }), [png]);
  // A browser that gives files but no usable items still works.
  assert.deepEqual(imageFilesFrom({ items: [], files: [png, text] }), [png]);
  assert.deepEqual(imageFilesFrom({ items: [{ kind: "string", getAsFile: () => null }], files: [text] }), []);
  assert.deepEqual(imageFilesFrom(null), []);
  // A pasted screenshot has no name of its own.
  assert.equal(attachLabel({ name: "weld.png" }, 0), "weld.png");
  assert.equal(attachLabel({ name: "image.png" }, 1), "Pasted image 2");
  assert.equal(attachLabel({}, 0), "Pasted image 1");
});

// A one-pixel PNG, enough for the header reader.
const PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
  8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1
]);
const fileOf = (bytes, over) => ({
  size: over ?? bytes.length,
  name: "weld.png",
  type: "image/png",
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
});

test("the card names a photo for its own bytes and refuses what the PDF loader would", async () => {
  const now = Date.UTC(2026, 8, 16);
  const a = await readAttachment(fileOf(PNG), { nowMs: now });
  assert.equal(a.format, "PNG");
  assert.equal(a.type, "image/png");
  assert.equal(isAttachPath(a.path), true);
  assert.match(a.path, /^Ask\/attachments\/2026-09\/[0-9a-f]{32}\.png$/);
  // The same bytes are the same object — that is the whole dedupe.
  const again = await readAttachment(fileOf(PNG), { nowMs: now });
  assert.equal(again.path, a.path);
  assert.equal(a.path.split("/").pop(), `${await hashName(PNG)}.png`);

  assert.equal(MAX_ATTACHMENTS, 4);
  await assert.rejects(() => readAttachment(fileOf(PNG), { count: 4, nowMs: now }), /Four images/);
  await assert.rejects(() => readAttachment(fileOf(PNG, 6 * 1024 * 1024), { nowMs: now }), /larger than 5 MiB/);
  await assert.rejects(() => readAttachment(fileOf(PNG, 3 * 1024 * 1024), { soFar: 10 * 1024 * 1024, nowMs: now }), /12 MiB/);
  await assert.rejects(() => readAttachment(fileOf(Uint8Array.from([1, 2, 3, 4])), { nowMs: now }), /valid PNG or JPEG/);
  await assert.rejects(() => readAttachment({ size: 0 }, { nowMs: now }), /empty/);
});

test("the function takes an attached key as a shape and never as a right", () => {
  const good = `Ask/attachments/2026-09/${"b".repeat(32)}.png`;
  const ctx = cleanContext({ screen: "board", attachments: [good, good, "Templates/decay.png", "../etc/passwd", 7] });
  // Deduped, and only what the card could have minted.
  assert.deepEqual(ctx.attachments, [good]);
  assert.deepEqual(cleanContext({}).attachments, []);
  assert.deepEqual(cleanContext({ attachments: "nope" }).attachments, []);
  // Four is the ceiling even if a tampered-with card sends more.
  const many = Array.from({ length: 9 }, (_, i) => `Ask/attachments/2026-09/${String(i).repeat(12)}.png`);
  assert.equal(cleanContext({ attachments: many }).attachments.length, MAX_ATTACHMENTS);
  // Ask is told the keys and told it has not seen them.
  const lines = whereLines(ctx);
  assert.ok(lines.includes(good));
  assert.match(lines, /do not describe their contents/);
  // With no attachment nothing is added, and an unknown place still answers.
  assert.ok(!whereLines(cleanContext({ screen: "board" })).includes("attached"));
  assert.match(whereLines(cleanContext({ attachments: [good] })), /not known[\s\S]*attached/);
});

// ── The three interaction cases. Each was a real way to lose a photo or to
// send a question without one, and none of them is visible from the pure
// naming above — they are about order. ──

const later = (ms, value) => new Promise(r => setTimeout(() => r(value), ms));

test("Enter is the same gate as the Send button, and an upload holds it shut", () => {
  assert.equal(canSend({ text: "what is this", busy: false, attaching: false }), true);
  // The photo is still going up: the question would arrive without it.
  assert.equal(canSend({ text: "what is this", busy: false, attaching: true }), false);
  assert.equal(canSend({ text: "  ", busy: false, attaching: false }), false);
  assert.equal(canSend({ text: "x", busy: true, attaching: false }), false);
});

test("a reply clears the photos it carried and leaves one attached since", () => {
  const held = [{ id: 1, path: "a" }, { id: 2, path: "b" }, { id: 3, path: "c" }];
  // "b" was dropped while the answer was on its way — it never went.
  assert.deepEqual(clearSent(held, [1, 3]).map(x => x.path), ["b"]);
  assert.deepEqual(clearSent(held, []).map(x => x.path), ["a", "b", "c"]);
  assert.deepEqual(clearSent([], [1]), []);
});

test("re-attaching the very same photo mid-reply keeps its chip", () => {
  // Photo A is sent (id 1), detached, and pasted again before the answer
  // lands. The new chip has A's path, because the key IS the content hash.
  const held = [{ id: 2, path: "Ask/attachments/2026-09/abc.png" }];
  assert.deepEqual(clearSent(held, [1]).map(x => x.id), [2]);
});

test("overlapping drops upload one at a time and the word stays until the last", async () => {
  const busy = [];
  const errors = [];
  const runner = attachRunner({ setBusy: on => busy.push(on), onError: e => errors.push(e) });
  const order = [];
  let live = 0;
  let most = 0;
  const one = async file => {
    live += 1;
    most = Math.max(most, live);
    order.push(`start ${file}`);
    await later(5);
    order.push(`done ${file}`);
    live -= 1;
  };
  const first = runner.run(["1", "2"], one);
  // A second drop while the first is still going.
  const second = runner.run(["3"], one);
  assert.equal(runner.busy(), true);
  await Promise.all([first, second]);
  assert.equal(most, 1, "two uploads must never be in flight together");
  assert.deepEqual(order, ["start 1", "done 1", "start 2", "done 2", "start 3", "done 3"]);
  // Busy went on once and off once: the second drop did not clear the word
  // out from under the first, and the first did not clear it under the second.
  assert.equal(runner.busy(), false);
  assert.deepEqual(busy.filter((v, i, a) => i === 0 || a[i - 1] !== v), [true, false]);
  assert.deepEqual(errors, []);
});

test("one bad photo takes only itself down and its reason is shown", async () => {
  const errors = [];
  const runner = attachRunner({ setBusy: () => {}, onError: e => errors.push(e) });
  const landed = [];
  await runner.run(["good", "bad", "also good"], async f => {
    if (f === "bad") throw new Error("That image is larger than 5 MiB.");
    landed.push(f);
  });
  assert.deepEqual(landed, ["good", "also good"]);
  assert.deepEqual(errors, ["That image is larger than 5 MiB."]);
  assert.equal(runner.busy(), false);
  // Nothing to do is not a busy state.
  await runner.run([], async () => { throw new Error("never"); });
  assert.equal(errors.length, 1);
});

test("a Keep name carries the photo's own hash, so two screenshots differ", () => {
  const a = keepName("Pasted image 1", "image/png", "0123456789abcdef0123456789abcdef");
  const b = keepName("Pasted image 1", "image/png", "fedcba9876543210fedcba9876543210");
  assert.equal(a, "Pasted image 1-01234567.png");
  assert.notEqual(a, b);
  // Same photo, same name — which is what makes "already kept" true.
  assert.equal(keepName("Pasted image 1", "image/png", "0123456789abcdef0123456789abcdef"), a);
  assert.equal(keepName("weld-3.JPG", "image/jpeg", "abcdef0123456789"), "weld-3-abcdef01.jpg");
  assert.equal(keepName("", "image/png", ""), "image.png");
  // storageKeySafe slices the key at 100 characters: the hash must survive.
  const long = keepName("x".repeat(200), "image/png", "0123456789abcdef");
  assert.ok(long.length < 80 && long.endsWith("-01234567.png"));
});

test("the hash a Keep name uses is read off the attachment's own key", () => {
  assert.equal(hashOfPath("Ask/attachments/2026-09/0123456789abcdef.png"), "0123456789abcdef");
  assert.equal(hashOfPath("Ask/attachments/2026-09/abc.png"), "");
  assert.equal(hashOfPath(null), "");
});

test("the card offers Keep and says when an attachment is cleared", () => {
  const src = readFileSync(new URL("./components/askPanel.jsx", import.meta.url), "utf8");
  // The permanent copy goes to Files, through the upload the Files screen uses.
  assert.match(src, /Db\.uploadSharedFile\("Ask", new File\(/);
  assert.match(src, /keepName\(a\.label, a\.type, hashOfPath\(a\.path\)\)/);
  // A reply clears chips by their own id, never by the path they share.
  assert.match(src, /clearSent\(attachedRef\.current, sentIds\)/);
  // The gate is the function, not the button's disabled attribute.
  assert.match(src, /canSend\(\{ text, busy, attaching: attachingRef\.current \}\)/);
  // And the expiry is on the card, not only in the commit message.
  assert.match(src, /cleared from Files after about three months/);
});
