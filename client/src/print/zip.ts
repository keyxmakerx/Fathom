// A stored (uncompressed) ZIP — enough for an .xlsx, which is a zip of XML
// parts (brief item 5). No compression, so no inflate/deflate to carry as a
// dependency; CRC-32 is the one algorithm this needs, the standard
// polynomial 0xEDB88320, table-driven.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
// 1980-01-01, the DOS epoch — every part in a generated document shares one
// timestamp rather than a real clock a byte-for-byte test would have to
// tolerate drifting.
const DOS_TIME = 0;
const DOS_DATE = 0x21;

function bytesOf(name: string): Uint8Array {
  return new TextEncoder().encode(name);
}

/**
 * Appends `Uint8Array`s and copies them into one buffer with `.set()` at
 * the end — never `array.push(...bigTypedArray)` or `[...a, ...b]` on a
 * real worksheet's worth of bytes. Spreading a typed array into a function
 * call turns into one argument per byte, and V8 refuses a call with too
 * many of those (`RangeError: Maximum call stack size exceeded`) — a cut
 * sheet with enough devices reached that ceiling in an early version of
 * this file, found by the drive's own download check, not a test with
 * only a handful of rows.
 */
class ByteWriter {
  private parts: Uint8Array[] = [];
  private length = 0;

  push(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  pushU16(n: number): void {
    this.push(Uint8Array.of(n & 0xff, (n >>> 8) & 0xff));
  }

  pushU32(n: number): void {
    this.push(Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff));
  }

  get size(): number {
    return this.length;
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

/** Every entry stored, method 0 — the zip's own "compressed size" equals
 * the uncompressed size throughout. */
export function writeStoredZip(entries: readonly ZipEntry[]): Uint8Array {
  const body = new ByteWriter();
  const central = new ByteWriter();

  for (const entry of entries) {
    const nameBytes = bytesOf(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;
    const localOffset = body.size;

    body.pushU32(LOCAL_SIG);
    body.pushU16(20); // version needed
    body.pushU16(0x0800); // flags: language encoding (UTF-8 names)
    body.pushU16(0); // method: stored
    body.pushU16(DOS_TIME);
    body.pushU16(DOS_DATE);
    body.pushU32(crc);
    body.pushU32(size);
    body.pushU32(size);
    body.pushU16(nameBytes.length);
    body.pushU16(0); // extra field length
    body.push(nameBytes);
    body.push(entry.data);

    central.pushU32(CENTRAL_SIG);
    central.pushU16(20); // version made by
    central.pushU16(20); // version needed
    central.pushU16(0x0800);
    central.pushU16(0);
    central.pushU16(DOS_TIME);
    central.pushU16(DOS_DATE);
    central.pushU32(crc);
    central.pushU32(size);
    central.pushU32(size);
    central.pushU16(nameBytes.length);
    central.pushU16(0); // extra field length
    central.pushU16(0); // comment length
    central.pushU16(0); // disk number start
    central.pushU16(0); // internal file attrs
    central.pushU32(0); // external file attrs
    central.pushU32(localOffset);
    central.push(nameBytes);
  }

  const centralStart = body.size;
  const centralSize = central.size;

  const eocd = new ByteWriter();
  eocd.pushU32(EOCD_SIG);
  eocd.pushU16(0); // disk number
  eocd.pushU16(0); // disk with central directory start
  eocd.pushU16(entries.length);
  eocd.pushU16(entries.length);
  eocd.pushU32(centralSize);
  eocd.pushU32(centralStart);
  eocd.pushU16(0); // comment length

  const out = new ByteWriter();
  out.push(body.toBytes());
  out.push(central.toBytes());
  out.push(eocd.toBytes());
  return out.toBytes();
}

/** The round trip this session's own tests need: every stored entry read
 * back by name, off the end-of-central-directory record — never a general
 * zip reader (no deflate, no multi-disk, no data descriptors). */
export function readStoredZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The EOCD is the last 22+ bytes; with no zip comment (this writer never
  // sets one) it is exactly the final 22.
  const eocdOffset = bytes.length - 22;
  if (view.getUint32(eocdOffset, true) !== EOCD_SIG) {
    throw new Error('not a stored zip this reader recognises (no EOCD at the expected offset)');
  }
  const count = view.getUint16(eocdOffset + 10, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);

  const entries: ZipEntry[] = [];
  let pos = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(pos, true) !== CENTRAL_SIG) {
      throw new Error(`central directory entry ${i} is missing its signature`);
    }
    const compression = view.getUint16(pos + 10, true);
    if (compression !== 0) throw new Error(`entry ${i} is compressed (method ${compression}); this reader only reads stored entries`);
    const crc = view.getUint32(pos + 16, true);
    const size = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen));

    if (view.getUint32(localOffset, true) !== LOCAL_SIG) {
      throw new Error(`local header for "${name}" is missing its signature`);
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = bytes.slice(dataStart, dataStart + size);
    if (crc32(data) !== crc) throw new Error(`"${name}" failed its CRC-32 check`);

    entries.push({ name, data });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
