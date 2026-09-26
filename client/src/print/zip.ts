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

function u16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}

function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function bytesOf(name: string): Uint8Array {
  return new TextEncoder().encode(name);
}

/** Every entry stored, method 0 — the zip's own "compressed size" equals
 * the uncompressed size throughout. */
export function writeStoredZip(entries: readonly ZipEntry[]): Uint8Array {
  const chunks: number[] = [];
  const centralChunks: number[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = bytesOf(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;
    const localOffset = offset;

    const local = [
      ...u32(LOCAL_SIG),
      ...u16(20), // version needed
      ...u16(0x0800), // flags: language encoding (UTF-8 names)
      ...u16(0), // method: stored
      ...u16(DOS_TIME),
      ...u16(DOS_DATE),
      ...u32(crc),
      ...u32(size),
      ...u32(size),
      ...u16(nameBytes.length),
      ...u16(0), // extra field length
    ];
    chunks.push(...local, ...nameBytes, ...entry.data);
    offset += local.length + nameBytes.length + entry.data.length;

    const central = [
      ...u32(CENTRAL_SIG),
      ...u16(20), // version made by
      ...u16(20), // version needed
      ...u16(0x0800),
      ...u16(0),
      ...u16(DOS_TIME),
      ...u16(DOS_DATE),
      ...u32(crc),
      ...u32(size),
      ...u32(size),
      ...u16(nameBytes.length),
      ...u16(0), // extra field length
      ...u16(0), // comment length
      ...u16(0), // disk number start
      ...u16(0), // internal file attrs
      ...u32(0), // external file attrs
      ...u32(localOffset),
    ];
    centralChunks.push(...central, ...nameBytes);
  }

  const centralStart = offset;
  const centralSize = centralChunks.length;
  const eocd = [
    ...u32(EOCD_SIG),
    ...u16(0), // disk number
    ...u16(0), // disk with central directory start
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(centralSize),
    ...u32(centralStart),
    ...u16(0), // comment length
  ];

  return Uint8Array.from([...chunks, ...centralChunks, ...eocd]);
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
