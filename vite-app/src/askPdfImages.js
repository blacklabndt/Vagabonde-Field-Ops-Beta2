// PDF photo input stays on the device. Inspect headers before allocating a
// decoded bitmap, then rasterize to a bounded size for the PDF builder.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_TOTAL = 12 * 1024 * 1024;
export const MAX_IMAGE_PDF_BYTES = 10 * 1024 * 1024;

function dimensions(width, height, format) {
  if (!width || !height || width > 16384 || height > 16384 || width * height > 40000000) {
    throw new Error("The image exceeds 40 million pixels or 16,384 pixels per side, or has invalid dimensions.");
  }
  return { width, height, format };
}

export function imageHeader(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const png = [137,80,78,71,13,10,26,10];
  if (bytes.length >= 33 && png.every((n, i) => bytes[i] === n) && v.getUint32(8) === 13 && v.getUint32(12) === 0x49484452) {
    return dimensions(v.getUint32(16), v.getUint32(20), "PNG");
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let at = 2;
    while (at + 3 < bytes.length) {
      if (bytes[at++] !== 255) break;
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > bytes.length) break;
      const length = v.getUint16(at);
      if (length < 2 || at + length > bytes.length) break;
      if ([0xc0,0xc1,0xc2].includes(marker) && length >= 8) {
        return dimensions(v.getUint16(at + 5), v.getUint16(at + 3), "JPEG");
      }
      at += length;
    }
  }
  throw new Error("Use a valid PNG or JPEG image.");
}

export async function normalizePdfImage(blob, header) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { img.src = ""; reject(new Error("Image decoding timed out.")); }, 15000);
      img.onload = () => { clearTimeout(timer); resolve(); };
      img.onerror = () => { clearTimeout(timer); reject(new Error("The image could not be decoded.")); };
      img.src = url;
    });
    // Browser decoding applies camera orientation; fit using decoded dimensions.
    dimensions(img.naturalWidth, img.naturalHeight, header.format);
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("The browser could not prepare this image.");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { data: canvas.toDataURL(header.format === "PNG" ? "image/png" : "image/jpeg", 0.85), width: canvas.width, height: canvas.height, format: header.format };
  } finally {
    img.onload = null; img.onerror = null;
    URL.revokeObjectURL(url);
  }
}

async function downloadSharedImage(path) {
  const { sbClient } = await import("./config.js");
  const { data, error } = await sbClient.storage.from("shared").download(path);
  if (error) throw error;
  return data;
}

// Cache only within this build: each new Download/Save rechecks access.
export function createPdfImageLoader(download = downloadSharedImage, prepare = normalizePdfImage) {
  const cache = new Map();
  let total = 0;
  return async path => {
    if (cache.has(path)) return cache.get(path);
    try {
      const blob = await download(path);
      if (!(blob instanceof Blob) || !blob.size || blob.size > MAX_IMAGE_BYTES) throw new Error("Use an image no larger than 5 MiB.");
      if (total + blob.size > MAX_IMAGE_TOTAL) throw new Error("The images exceed the 12 MiB total source budget.");
      const header = imageHeader(new Uint8Array(await blob.arrayBuffer()));
      const expected = header.format === "PNG" ? "image/png" : "image/jpeg";
      if (blob.type.toLowerCase().split(";")[0] !== expected) throw new Error("The image type does not match its PNG/JPEG contents.");
      const image = { ...await prepare(blob, header), alias: `shared-image-${cache.size}` };
      total += blob.size;
      cache.set(path, image);
      return image;
    } catch (e) {
      throw new Error(`Could not include "${String(path).split("/").pop()}": ${e.message || "Image unavailable."}`);
    }
  };
}
