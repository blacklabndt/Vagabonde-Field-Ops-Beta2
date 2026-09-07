// A minimal ZIP writer — enough to put a handful of files in one download.
//
// Written here rather than pulled in, because the alternative is a second
// <script> from a CDN injected into a page that holds a signed-in session.
// SheetJS is already loaded that way and that is one supply-chain surface more
// than ideal; adding another to concatenate a few files is not a trade worth
// making. The format below is the 1989 PKZIP layout that every operating
// system still opens natively.
//
// Stored, not deflated. Everything this zips is already a .xlsx, which is
// itself a deflated zip — compressing it again would spend CPU on a phone or
// an office laptop to save nothing. The cost is a few hundred bytes of headers.
//
// Not implemented on purpose: Zip64, encryption, directories, and any entry
// over 4 GB. A pay period of timesheets is measured in tens of kilobytes; if
// that ever stops being true this file should be replaced rather than extended.

// CRC-32, the same polynomial the format has always used. Table built once on
// first use rather than at module load, so a screen that never exports a zip
// never pays for it.
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[i] = c >>> 0;
  }
  return CRC_TABLE;
}

// Exported for the archive's manifest: the same CRC the entries carry, so a
// downloaded zip can be read back and checked file by file.
export function crc32(bytes) {
  const table = crcTable();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// MS-DOS packed date and time, which is what the format stores. Two-second
// resolution, and years count from 1980 — a quirk of the era, not a mistake.
function dosStamp(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

// Names are stored as UTF-8 and flagged as such (bit 11), so an accented name
// is not mangled by whatever code page the opening machine happens to use.
const utf8 = s => new TextEncoder().encode(s);

class Writer {
  constructor() { this.parts = []; this.length = 0; }
  bytes(b) { this.parts.push(b); this.length += b.length; }
}

// A fixed-size record written into one buffer. Each header used to go in
// as thirteen or fifteen two- and four-byte arrays, and a year's archive
// of ten thousand PDFs handed the Blob some 300,000 parts, most of them
// two bytes of payload under many more of object — at the moment memory
// is already tightest. Little-endian throughout, as the format is.
class Record {
  constructor(size) { this.buf = new Uint8Array(size); this.view = new DataView(this.buf.buffer); this.at = 0; }
  u16(n) { this.view.setUint16(this.at, n & 0xFFFF, true); this.at += 2; return this; }
  u32(n) { this.view.setUint32(this.at, n >>> 0, true); this.at += 4; return this; }
  done() {
    if (this.at !== this.buf.length) throw new Error(`zip record: wrote ${this.at} of ${this.buf.length} bytes`);
    return this.buf;
  }
}
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;

// files: [{ name, data: Uint8Array, crc? }] -> Blob
//
// `crc` is optional and only an economy: the archive already computes one per
// entry for its manifest, and a year of PDFs is a lot of bytes to run through
// the same polynomial twice. Absent, it is computed here as it always was.
export function makeZip(files, when = new Date()) {
  const { time, date } = dosStamp(when);
  const w = new Writer();
  const central = [];

  for (const f of files) {
    const name = utf8(f.name);
    const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    const crc = f.crc == null ? crc32(data) : f.crc >>> 0;
    const offset = w.length;

    // Local file header
    w.bytes(new Record(LOCAL_HEADER)
      .u32(0x04034B50)
      .u16(20)            // version needed: 2.0
      .u16(0x0800)        // flags: UTF-8 names
      .u16(0)             // method: stored
      .u16(time).u16(date)
      .u32(crc)
      .u32(data.length)   // compressed size == uncompressed, stored
      .u32(data.length)
      .u16(name.length)
      .u16(0)             // no extra field
      .done());
    w.bytes(name);
    w.bytes(data);

    central.push({ name, crc, size: data.length, offset });
  }

  const centralStart = w.length;
  for (const e of central) {
    w.bytes(new Record(CENTRAL_HEADER)
      .u32(0x02014B50)
      .u16(20)            // version made by
      .u16(20)            // version needed
      .u16(0x0800)
      .u16(0)
      .u16(time).u16(date)
      .u32(e.crc)
      .u32(e.size).u32(e.size)
      .u16(e.name.length)
      .u16(0).u16(0)      // extra, comment
      .u16(0)             // disk number
      .u16(0)             // internal attrs
      .u32(0)             // external attrs
      .u32(e.offset)
      .done());
    w.bytes(e.name);
  }

  // Measured before the trailer is written. Taking w.length after the
  // signature and counts have gone in reports the directory as twelve bytes
  // longer than it is, and every reader rejects the archive outright:
  // "Bad magic number for central directory".
  const centralSize = w.length - centralStart;

  // End of central directory
  w.bytes(new Record(END_RECORD)
    .u32(0x06054B50)
    .u16(0).u16(0)
    .u16(central.length).u16(central.length)
    .u32(centralSize)
    .u32(centralStart)
    .u16(0)               // no comment
    .done());

  // The pieces are handed to the Blob as they are, rather than copied into
  // one buffer first: a year's archive is hundreds of megabytes, and holding
  // the parts and a joined copy of them at the same time is twice the memory
  // for a concatenation the Blob does anyway.
  return new Blob(w.parts, { type: "application/zip" });
}

// Anything that could confuse a filesystem, plus the characters Windows
// refuses outright. Trailing dots and spaces are stripped because Explorer
// silently drops them and two people whose names differ only there would
// otherwise collide inside the archive.
export function safeFilename(s, fallback = "unnamed") {
  const cleaned = String(s || "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  // A name that survives as nothing but separators — "///" becoming "---" —
  // is a legal filename and a useless one. These end up as entries somebody
  // has to pick through in a bundle, so anything with no letter or digit left
  // in it gets the fallback instead.
  return /[a-z0-9]/i.test(cleaned) ? cleaned : fallback;
}

// Hands the browser a file to save. Kept here so the revoke is not forgotten:
// an object URL left behind pins its blob in memory for the life of the tab,
// which for a bundle of workbooks is megabytes.
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
