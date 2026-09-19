import { describe, expect, it } from 'vitest';

import { fromHex, toHex } from './bytes';
import { normalizeLowS } from './p256';

const CURVE_ORDER_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

// The same low-S signature `session.test.ts` checks against the vector file
// -- known, from that independent source, to already be low-S.
const KNOWN_LOW_S_SIGNATURE = fromHex(
  'f7287814e9e2082c43eed17e320b25e0f016c610aacfc187c5240cf1c7e8774' +
    'b2f910812429571d9122bc2c1930fc96c843ebc1ab854444ba884b3f7702215df',
);

function flipToHighS(signature: Uint8Array): Uint8Array {
  const r = signature.slice(0, 32);
  let s = 0n;
  for (const byte of signature.slice(32, 64)) {
    s = (s << 8n) | BigInt(byte);
  }
  const highS = CURVE_ORDER_N - s;
  const highSBytes = new Uint8Array(32);
  let remaining = highS;
  for (let i = 31; i >= 0; i -= 1) {
    highSBytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  const out = new Uint8Array(64);
  out.set(r, 0);
  out.set(highSBytes, 32);
  return out;
}

describe('normalizeLowS', () => {
  // `authority::verify_es256` (crates/fathom-server/src/authority.rs) refuses
  // any signature that is not already low-S -- P-256's `NistP256::NORMALIZE_S`
  // is false, so WebCrypto's `SubtleCrypto.sign` gives no such guarantee on
  // its own. This is the one correction that stands between "this client
  // signed correctly" and "the server refuses it for a reason it never
  // states out loud."
  it('leaves an already-low-S signature unchanged', () => {
    expect(toHex(normalizeLowS(KNOWN_LOW_S_SIGNATURE))).toBe(toHex(KNOWN_LOW_S_SIGNATURE));
  });

  it('flips a high-S signature back to the same low-S value', () => {
    const highS = flipToHighS(KNOWN_LOW_S_SIGNATURE);
    expect(toHex(highS)).not.toBe(toHex(KNOWN_LOW_S_SIGNATURE));
    expect(toHex(normalizeLowS(highS))).toBe(toHex(KNOWN_LOW_S_SIGNATURE));
  });

  it('rejects anything that is not exactly 64 bytes', () => {
    expect(() => normalizeLowS(new Uint8Array(63))).toThrow();
    expect(() => normalizeLowS(new Uint8Array(65))).toThrow();
  });
});
