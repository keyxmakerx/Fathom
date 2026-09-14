import { concatBytes } from './bytes';

// The P-256 group order. `crates/fathom-server/tests/vectors/gen_session_vectors.py`
// carries the same constant for its independent ECDSA arithmetic.
const CURVE_ORDER_N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const HALF_ORDER = CURVE_ORDER_N >> 1n;

function beBytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

function bigIntToBeBytes(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

/**
 * `crates/fathom-server/src/authority.rs::verify_es256` refuses a signature
 * whose `s` is not already the low one of the two values that verify a
 * P-256 ECDSA signature (`parsed != parsed.normalize_s()`) -- read there as
 * "P-256's `NistP256::NORMALIZE_S` is false", so the Rust signer normalises
 * by hand before writing a signature out (`SoftwareKey::sign`). WebCrypto's
 * `SubtleCrypto.sign` makes no such promise: it may return either `s` or
 * `N - s`. This is that same correction, done on the one signature-producing
 * path this client has, so a request this client signs is never refused for
 * a reason the server never states out loud.
 */
export function normalizeLowS(signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) {
    throw new Error('expected a 64-byte P-256 signature (r || s)');
  }
  const r = signature.slice(0, 32);
  const s = beBytesToBigInt(signature.slice(32, 64));
  if (s <= HALF_ORDER) {
    return signature;
  }
  return concatBytes(r, bigIntToBeBytes(CURVE_ORDER_N - s, 32));
}
