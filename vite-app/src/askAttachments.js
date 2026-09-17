import { imageHeader, normalizePdfImage, MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL } from "./askPdfImages.js";

// Only normalized pixels are retained. The original files never leave this call.
export async function prepareAttachments(files, existing = [], prepare = normalizePdfImage) {
  const picked = Array.from(files);
  if (existing.length + picked.length > 4) throw new Error("Attach at most four images.");
  let total = existing.reduce((sum, item) => sum + item.size, 0);
  for (const file of picked) {
    if (!file.size || file.size > MAX_IMAGE_BYTES) throw new Error("Use an image no larger than 5 MiB.");
    if (!["image/png", "image/jpeg"].includes(file.type)) throw new Error("Attach PNG or JPEG images.");
    total += file.size;
  }
  if (total > MAX_IMAGE_TOTAL) throw new Error("The attachments exceed the 12 MiB total source budget.");
  const added = [];
  for (const file of picked) {
    const name = [...String(file.name || "Image")].filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127).join("").slice(0, 120) || "Image";
    try {
      const header = imageHeader(new Uint8Array(await file.arrayBuffer()));
      if (file.type !== (header.format === "PNG" ? "image/png" : "image/jpeg")) throw new Error("The image type does not match its PNG/JPEG contents.");
      const image = await prepare(file, header);
      if (image.data.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 64) throw new Error("The prepared image exceeds 5 MiB; use a smaller image.");
      added.push(Object.freeze({ id: crypto.randomUUID(), name, type: file.type, size: file.size, width: image.width, height: image.height, image: Object.freeze(image) }));
    } catch (e) {
      throw new Error(`Could not attach "${name}": ${e.message || "Image unavailable."}`);
    }
  }
  return [...existing, ...added];
}

export function attachmentManifest(inputs) {
  return inputs.map(({id, name, type, size, width, height}) => ({id, name, type, size, width, height}));
}

// The thread owns file objects. Weak keys release pixels when those turns
// expire or sign-out clears the thread, without serializing image bytes.
const fileInputs = new WeakMap();
export function bindPdfInputs(files, inputs) {
  const available = new Map(inputs.map(input => [input.id, input]));
  const bindings = [];
  for (const file of files || []) {
    if (file.kind !== "pdf") continue;
    const kept = new Map();
    for (const section of file.document.sections) {
      const id = section.image?.input_id;
      if (!id) continue;
      if (!available.has(id)) throw new Error("An attached image is no longer available. Attach it again and retry.");
      kept.set(id, available.get(id));
    }
    bindings.push([file, kept]);
  }
  for (const [file, kept] of bindings) fileInputs.set(file, kept);
}

export function inputsForPdf(file) { return new Map(fileInputs.get(file) || []); }
