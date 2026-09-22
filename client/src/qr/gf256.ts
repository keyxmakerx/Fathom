// GF(256) arithmetic and the Reed–Solomon remainder a QR symbol's error
// correction codewords are (ADR-0056 decision 5: the enrolment screen draws
// the QR code itself, from a zero-dependency encoder, so the
// Content-Security-Policy does not move).
//
// The field is the one ISO/IEC 18004 §7.5.2 fixes for QR: GF(2^8) modulo the
// primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D), with 2 as the
// generating element. Nothing here is QR-specific beyond that constant — it
// is the arithmetic, written out, and `encode.ts` is what knows about
// symbols.
//
// Written 2026-09-22.

/** x^8 + x^4 + x^3 + x^2 + 1 — ISO/IEC 18004 §7.5.2. */
const PRIMITIVE = 0x11d;

// The antilog table is doubled (0..509) so a product of two logs can be read
// without a modulo: log a + log b is at most 508.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= PRIMITIVE;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}

/** Multiply in GF(256). Zero has no logarithm, so it is answered first. */
export function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/**
 * The generator polynomial of degree `degree`: (x - a^0)(x - a^1)…, which in
 * a field of characteristic two is (x + a^0)(x + a^1)….
 *
 * Returned **without** its leading 1: `coefficients[i]` multiplies
 * x^(degree-1-i). That is the shape the division below wants, and carrying a
 * coefficient that is always 1 would only invite an off-by-one.
 */
export function generatorPoly(degree: number): Uint8Array {
  let result = new Uint8Array([1]);
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    // result = result * (x + root), leading 1 still implicit at index 0.
    const next = new Uint8Array(result.length + 1);
    for (let j = 0; j < result.length; j += 1) {
      next[j] ^= result[j];
      next[j + 1] ^= mul(result[j], root);
    }
    result = next;
    root = mul(root, 2);
  }
  return result.slice(1);
}

/**
 * The Reed–Solomon remainder of `data` against a generator of `degree`,
 * which is what a QR block's error correction codewords are: the systematic
 * encoding of a block is its data codewords followed by this.
 */
export function remainder(data: Uint8Array, degree: number): Uint8Array {
  const generator = generatorPoly(degree);
  const result = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[degree - 1] = 0;
    for (let i = 0; i < degree; i += 1) {
      result[i] ^= mul(generator[i], factor);
    }
  }
  return result;
}
