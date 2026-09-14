// The wire framing every message in `crates/fathom-server/src/api.rs` uses:
// a 4-byte little-endian length prefix ahead of each variable-length field.
// Mirrors `crates/fathom-server/src/crypto.rs`'s `lp`, `u32_le`, `u64_le` and
// `read_lp` exactly -- see `session.ts` for why an independent byte-for-byte
// match matters here rather than being merely convenient.

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** `u32_le(n)`, appended -- fixed width, no prefix. */
export function u32LE(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

/** `u64_le(n)`, appended. Accepts `bigint` so a counter or timestamp near
 * `Number.MAX_SAFE_INTEGER` is not silently rounded. */
export function u64LE(n: number | bigint): Uint8Array {
  const value = typeof n === 'bigint' ? n : BigInt(n);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

export function readU64LE(bytes: Uint8Array): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
}

/** `LP(x) = u32_le(len(x)) || x`. */
export function lp(bytes: Uint8Array): Uint8Array {
  return concatBytes(u32LE(bytes.length), bytes);
}

export interface LpField {
  value: Uint8Array;
  rest: Uint8Array;
}

/** Read one length-prefixed field, returning it and the rest -- the mirror of
 * `crypto::read_lp`. Throws rather than returning `undefined` on a truncated
 * message: every caller in this client is parsing a server response it is
 * about to trust, and a short read there is not a case to fall through. */
export function readLp(bytes: Uint8Array): LpField {
  if (bytes.length < 4) {
    throw new Error('malformed response: truncated length prefix');
  }
  const len = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  if (bytes.length < 4 + len) {
    throw new Error('malformed response: truncated field');
  }
  return {
    value: bytes.slice(4, 4 + len),
    rest: bytes.slice(4 + len),
  };
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('malformed hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
