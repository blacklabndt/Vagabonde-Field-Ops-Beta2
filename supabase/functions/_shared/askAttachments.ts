// Where a photo pasted or dropped into Ask's card lives, and when it stops
// living there. Pure: no imports, so the node suite reads it directly.
//
// An attachment is an ordinary file in the shared drive, so the storage
// policies, the Files screen and the PDF loader all take it unchanged —
// there is no second byte path into Ask. What keeps the drive from filling
// with one-off photos is the shape of the key: the month is IN the path, so
// a nightly sweep can throw a whole month away without reading a single
// object's timestamp, and the name is the content hash, so the same photo
// pasted twice in a month is one object and not two.
//
// Dedupe is deliberately per month and not for ever. A hash-only key would
// let January's object serve a June paste and then age out underneath it;
// a fresh copy each month costs one object a month per re-used photo and
// keeps the expiry a question about the folder name alone.
//
// A file the person MOVES out of Ask/attachments (the Files screen renames
// it) is an ordinary file again and is never swept — the sweep only ever
// looks inside this root.

// ═══ shared core (twinned with vite-app/src/askAttach.js) ═══
export const ATTACH_ROOT = "Ask/attachments";
export const MAX_ATTACHMENTS = 4;
export const ATTACH_KEEP_DAYS = 90;
const MONTH_NAME = /^\d{4}-(0[1-9]|1[0-2])$/;
const ATTACH_KEY = /^Ask\/attachments\/\d{4}-(0[1-9]|1[0-2])\/[0-9a-f]{12,64}\.(png|jpg)$/;

// UTC, not the local day: the month is only ever a bucket to expire, and a
// device in another zone must not mint a second one for the same photo.
export function attachMonth(ms: number): string {
  if (!Number.isFinite(ms)) throw new Error("An attachment needs a real clock.");
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function attachPath(month: string, hash: string, format: string): string {
  if (!MONTH_NAME.test(month)) throw new Error("An attachment month is YYYY-MM.");
  if (!/^[0-9a-f]{12,64}$/.test(hash)) throw new Error("An attachment name is its content hash in lowercase hex.");
  if (format !== "PNG" && format !== "JPEG") throw new Error("An attachment is a PNG or a JPEG.");
  return `${ATTACH_ROOT}/${month}/${hash}.${format === "PNG" ? "png" : "jpg"}`;
}

export function isAttachPath(path: unknown): boolean {
  return typeof path === "string" && ATTACH_KEY.test(path);
}

// The month folders the sweep may delete whole. A folder expires only once
// its LAST day is KEEP_DAYS behind — so nothing is thrown away before 90
// days, and nothing lives past about 120. Date.UTC(y, m) is the first
// instant of the month after `m - 1`, which is the folder's end.
export function expiredAttachMonths(names: string[], nowMs: number): string[] {
  const keep = ATTACH_KEEP_DAYS * 86400000;
  return (names || []).filter(name => {
    if (!MONTH_NAME.test(name)) return false;
    const end = Date.UTC(Number(name.slice(0, 4)), Number(name.slice(5, 7)));
    return nowMs - end >= keep;
  });
}
// ═══ end shared core ═══
