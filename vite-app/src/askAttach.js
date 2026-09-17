// A photo pasted or dropped into Ask's card. The card holds the checking
// and the naming; db.js does the upload and askPanel.jsx the chips.
//
// An attachment is uploaded to the shared drive like any other file, so the
// storage policy is the gate (the files tab), the Files screen shows it, and
// the PDF builder's own loader reads it back with no new byte path. The key
// carries the month and the content hash — see askAttachments.ts for why
// both, and for the sweep that reads the month back.
//
// Nothing here decodes an image: the header is inspected the way the PDF
// loader inspects it (askPdfImages.js, one set of rules), so a file that is
// not really a PNG or JPEG is refused before it is ever uploaded.

import { imageHeader, MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL } from "./askPdfImages.js";

// ═══ shared core (twinned with supabase/functions/_shared/askAttachments.ts) ═══
export const ATTACH_ROOT = "Ask/attachments";
export const MAX_ATTACHMENTS = 4;
export const ATTACH_KEEP_DAYS = 90;
const MONTH_NAME = /^\d{4}-(0[1-9]|1[0-2])$/;
const ATTACH_KEY = /^Ask\/attachments\/\d{4}-(0[1-9]|1[0-2])\/[0-9a-f]{12,64}\.(png|jpg)$/;

// UTC, not the local day: the month is only ever a bucket to expire, and a
// device in another zone must not mint a second one for the same photo.
export function attachMonth(ms) {
  if (!Number.isFinite(ms)) throw new Error("An attachment needs a real clock.");
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function attachPath(month, hash, format) {
  if (!MONTH_NAME.test(month)) throw new Error("An attachment month is YYYY-MM.");
  if (!/^[0-9a-f]{12,64}$/.test(hash)) throw new Error("An attachment name is its content hash in lowercase hex.");
  if (format !== "PNG" && format !== "JPEG") throw new Error("An attachment is a PNG or a JPEG.");
  return `${ATTACH_ROOT}/${month}/${hash}.${format === "PNG" ? "png" : "jpg"}`;
}

export function isAttachPath(path) {
  return typeof path === "string" && ATTACH_KEY.test(path);
}

// The month folders the sweep may delete whole. A folder expires only once
// its LAST day is KEEP_DAYS behind — so nothing is thrown away before 90
// days, and nothing lives past about 120. Date.UTC(y, m) is the first
// instant of the month after `m - 1`, which is the folder's end.
export function expiredAttachMonths(names, nowMs) {
  const keep = ATTACH_KEEP_DAYS * 86400000;
  return (names || []).filter(name => {
    if (!MONTH_NAME.test(name)) return false;
    const end = Date.UTC(Number(name.slice(0, 4)), Number(name.slice(5, 7)));
    return nowMs - end >= keep;
  });
}
// ═══ end shared core ═══

// What a drop or a paste actually carried. A paste of a screenshot arrives
// as a clipboard item with no name; a drop of a folder, or of text, carries
// items that are not files at all. Anything that is not an image file is
// passed over in silence — the count is what the card reports on.
export function imageFilesFrom(transfer) {
  const out = [];
  const add = file => { if (file && /^image\//i.test(file.type || "")) out.push(file); };
  for (const item of transfer?.items ? [...transfer.items] : []) if (item.kind === "file") add(item.getAsFile());
  if (out.length) return out;
  for (const file of transfer?.files ? [...transfer.files] : []) add(file);
  return out;
}

// The name under the chip. A pasted screenshot has no name of its own.
export function attachLabel(file, index) {
  const name = String(file?.name || "").trim();
  return name && name !== "image.png" ? name : `Pasted image ${index + 1}`;
}

// Lowercase hex of the bytes, which is the object's name. Truncated to 32
// hex characters: a 128-bit prefix of SHA-256, which is a key and not a
// signature — there is nothing here for a collision to buy, and a shorter
// name is one a person can read in the Files screen.
export async function hashName(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// One file, checked and named — never uploaded from here. `soFar` is the
// bytes already attached this card, so the 12 MiB budget the PDF loader
// spends is the same budget the card refuses to exceed before the upload.
export async function readAttachment(file, { soFar = 0, count = 0, nowMs = Date.now() } = {}) {
  if (count >= MAX_ATTACHMENTS) throw new Error("Four images is the most Claudia can hold at once.");
  if (!file || !file.size) throw new Error("That file is empty.");
  if (file.size > MAX_IMAGE_BYTES) throw new Error(`“${attachLabel(file, count)}” is larger than 5 MiB.`);
  if (soFar + file.size > MAX_IMAGE_TOTAL) throw new Error("The attached images would exceed the 12 MiB total.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const header = imageHeader(bytes);
  const path = attachPath(attachMonth(nowMs), await hashName(bytes), header.format);
  return { path, bytes, size: file.size, format: header.format, type: header.format === "PNG" ? "image/png" : "image/jpeg" };
}

// ── The card's own decisions, kept out of the component so they can be tested
// without a browser. The three of them are the interaction bugs a first cut
// had: a send that outran its upload, two drops that read the same "so far",
// and a reply that cleared a photo attached while it was in flight. ──

// Enter and the Send button ask the SAME question. The button's `disabled`
// is a courtesy; this is the gate.
export function canSend({ text, busy, attaching }) {
  return Boolean(String(text || "").trim()) && !busy && !attaching;
}

// A reply clears the photos THAT question carried and nothing else, so one
// dropped while the answer was on its way is still attached afterwards. The
// match is the chip's own id and NOT its path: detach a photo, send, then
// paste the SAME photo again before the answer lands, and the new chip has
// the old one's path (the key is the content hash) — cleared by path, the
// reply would take a photo down that it never carried.
export function clearSent(attached, sentIds) {
  const sent = new Set(sentIds || []);
  return (attached || []).filter(a => !sent.has(a.id));
}

// Keep writes a second copy under Ask/ as an ordinary file, so it needs a
// real name — a pasted screenshot's label has no extension of its own, and
// two screenshots pasted on different days are both "Pasted image 1". The
// content hash goes in the name WHOLE: it is the attachment key's own 32 hex
// characters (128 bits of SHA-256), so a name already taken in Ask/ is the
// same photo and "already kept" is the truth. A shortened tag is not — eight
// hex characters is 32 bits, which a person with two screenshots and a few
// minutes can collide on purpose, and the collision would tell them their
// photo was saved when another one was sitting under that name. The base is
// cut to 50 characters so storageKeySafe's 100-character slice (which only
// ever shortens) can never eat the hash.
export function keepName(label, type, hash) {
  const ext = type === "image/png" ? "png" : "jpg";
  const bare = String(label || "image").trim() || "image";
  const stem = bare.replace(/\.(png|jpe?g)$/i, "").slice(0, 50) || "image";
  const tag = keepTag(hash);
  return tag ? `${stem}-${tag}.${ext}` : `${stem}.${ext}`;
}

// The hash a Keep name may carry, or "" when there is none to carry. A name
// with no tag is not evidence of anything, so the card must not read a
// refusal over one as "already kept" — see askPanel.jsx.
export function keepTag(hash) {
  return /^[0-9a-f]{12,64}$/.test(String(hash || "")) ? String(hash) : "";
}

// The hash a Keep name carries, read back off the attachment's own key —
// the key is `.../<hash>.png`, so nothing has to be re-digested.
export function hashOfPath(path) {
  const m = /\/([0-9a-f]{12,64})\.(?:png|jpg)$/.exec(String(path || ""));
  return m ? m[1] : "";
}

// Every drop and paste runs through one chain. Overlapping drops must not
// both read the same "bytes attached so far" (two 7 MiB photos would fit a
// 12 MiB budget neither of them saw), and the second must not clear the
// "Attaching…" word while the first is still uploading — hence the depth
// count rather than a boolean each one sets and unsets.
export function attachRunner({ setBusy, onError }) {
  let chain = Promise.resolve();
  let depth = 0;
  let busy = false;
  return {
    busy: () => busy,
    idle: () => chain,
    run(files, one) {
      if (!files || !files.length) return chain;
      depth += 1;
      busy = true;
      setBusy(true);
      chain = chain.then(async () => {
        const trouble = [];
        for (const file of files) {
          try { await one(file); }
          catch (e) { trouble.push(e?.message || "That image couldn't be attached."); }
        }
        depth -= 1;
        if (depth === 0) { busy = false; setBusy(false); }
        if (trouble.length) onError(trouble[0]);
      });
      return chain;
    }
  };
}
