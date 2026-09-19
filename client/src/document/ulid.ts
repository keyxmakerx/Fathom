// ULID over Crockford base32 — the browser side of `crates/fathom-id`'s
// contract (`crates/fathom-id/src/lib.rs`). Read from there, not guessed: 26
// characters, MSB first, alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, decode
// case-insensitive with I/L -> 1 and O -> 0, first character capped at 7 (26
// * 5 = 130 bits; a 128-bit value never sets more than the top 2 of that
// first character's 5 bits). Lexicographic order over the 26-character
// encoding equals numeric order over the underlying 128-bit value (the same
// crate's own doc comment), which is what lets every ordering in this
// package compare ids as plain strings.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const TIMESTAMP_MAX_MS = (1n << 48n) - 1n;

/** Why a candidate ULID string did not decode — `fathom_id::DecodeError`'s
 * three variants, named the same way. */
export type UlidDecodeError =
  | { kind: 'length'; length: number }
  | { kind: 'char'; index: number; char: string }
  | { kind: 'overflow' };

export class UlidError extends Error {
  readonly reason: UlidDecodeError;
  constructor(reason: UlidDecodeError) {
    super(ulidErrorMessage(reason));
    this.name = 'UlidError';
    this.reason = reason;
  }
}

function ulidErrorMessage(reason: UlidDecodeError): string {
  switch (reason.kind) {
    case 'length':
      return `ulid: expected 26 characters, found ${reason.length}`;
    case 'char':
      return `ulid: byte ${reason.char} at index ${reason.index} is outside the Crockford alphabet`;
    case 'overflow':
      return 'ulid: first character above 7 would exceed 128 bits';
  }
}

function decodeChar(c: string): number | undefined {
  switch (c) {
    case '0':
    case 'O':
    case 'o':
      return 0;
    case '1':
    case 'I':
    case 'i':
    case 'L':
    case 'l':
      return 1;
    default:
      break;
  }
  if (c >= '2' && c <= '9') {
    return c.charCodeAt(0) - '0'.charCodeAt(0);
  }
  const upper = c.toUpperCase();
  if (upper >= 'A' && upper <= 'H') {
    return upper.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
  }
  if (upper === 'J' || upper === 'K') {
    return upper.charCodeAt(0) - 'A'.charCodeAt(0) + 9;
  }
  if (upper === 'M' || upper === 'N') {
    return upper.charCodeAt(0) - 'A'.charCodeAt(0) + 8;
  }
  if (upper >= 'P' && upper <= 'T') {
    return upper.charCodeAt(0) - 'A'.charCodeAt(0) + 7;
  }
  if (upper >= 'V' && upper <= 'Z') {
    return upper.charCodeAt(0) - 'A'.charCodeAt(0) + 6;
  }
  return undefined;
}

/** 26-character Crockford encoding, always uppercase — the exact inverse of
 * `decodeUlid`. */
export function encodeUlid(value: bigint): string {
  const out = new Array<string>(26);
  let v = value;
  for (let i = 25; i >= 0; i -= 1) {
    out[i] = ALPHABET[Number(v & 0x1fn)];
    v >>= 5n;
  }
  return out.join('');
}

/** Decode-only, matching `Ulid::decode`'s own leniency (Crockford aliases
 * accepted). Callers that must refuse a second spelling use
 * `canonicalUlid`, the same split `fathom-graph`'s `id.rs` makes. */
export function decodeUlid(s: string): bigint {
  if (s.length !== 26) {
    throw new UlidError({ kind: 'length', length: s.length });
  }
  const first = decodeChar(s[0]);
  if (first === undefined) {
    throw new UlidError({ kind: 'char', index: 0, char: s[0] });
  }
  if (first > 7) {
    throw new UlidError({ kind: 'overflow' });
  }
  let v = BigInt(first);
  for (let i = 1; i < 26; i += 1) {
    const d = decodeChar(s[i]);
    if (d === undefined) {
      throw new UlidError({ kind: 'char', index: i, char: s[i] });
    }
    v = (v << 5n) | BigInt(d);
  }
  return v;
}

/** The one spelling a stored file may use: decodes, then refuses unless the
 * text re-encodes to itself (`fathom-graph::id::parse_ulid`'s rule). */
export function canonicalUlid(s: string): bigint {
  const v = decodeUlid(s);
  if (encodeUlid(v) !== s) {
    throw new UlidError({ kind: 'char', index: 0, char: s[0] });
  }
  return v;
}

export function isCanonicalUlid(s: string): boolean {
  try {
    canonicalUlid(s);
    return true;
  } catch {
    return false;
  }
}

/** A fresh ULID: `timestampMs` (defaults to now) in the top 48 bits, 80 bits
 * of `crypto.getRandomValues` below it — invariant 9's caller-supplied-entropy
 * rule, satisfied here because the browser, not the engine, is the boundary
 * that owns a clock and an RNG. */
export function newUlid(timestampMs: number = Date.now()): string {
  const t = BigInt(Math.trunc(timestampMs));
  if (t < 0n || t > TIMESTAMP_MAX_MS) {
    throw new Error(`ulid: timestamp ${timestampMs} does not fit 48 bits`);
  }
  const randomBytes = new Uint8Array(10);
  crypto.getRandomValues(randomBytes);
  let random = 0n;
  for (const b of randomBytes) {
    random = (random << 8n) | BigInt(b);
  }
  return encodeUlid((t << 80n) | random);
}
