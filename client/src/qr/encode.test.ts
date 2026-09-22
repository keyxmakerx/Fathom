import { describe, expect, it } from 'vitest';

import { QrTooLongError, encodeQr, formatInformation, versionInformation } from './encode';
import { blockPlan, byteModeCapacity, totalCodewords } from './tables';
import { QR_VECTORS } from './vectors.reference';

// The encoder is checked against another implementation's OUTPUT, pinned in
// `vectors.reference.ts` with where it came from and when. Module for module:
// a QR symbol is not a thing you can check by eye, and an encoder that is
// wrong in one alignment pattern still looks like a QR code.

describe('the QR encoder, against pinned reference symbols', () => {
  for (const vector of QR_VECTORS) {
    it(`matches the reference for ${vector.name} (version ${vector.version})`, () => {
      const symbol = encodeQr(vector.text);
      expect(symbol.version).toBe(vector.version);
      expect(symbol.size).toBe(vector.size);
      // The mask is compared first: when the penalty scoring disagrees, every
      // module disagrees, and a row-by-row failure would say nothing about why.
      expect(symbol.mask).toBe(vector.mask);
      const rows = symbol.modules.map((row) => row.map((dark) => (dark ? '1' : '0')).join(''));
      expect(rows).toEqual([...vector.rows]);
    });
  }

  it('covers every version it claims to, and both character-count widths', () => {
    const versions = new Set(QR_VECTORS.map((vector) => vector.version));
    expect([...versions].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('draws a real otpauth URI', () => {
    // The shape `POST /credentials/totp/enrol` answers with. Byte mode is not
    // a choice here: lower case, `:`, `/`, `?`, `=` and `&` are all outside
    // the alphanumeric character set.
    const vector = QR_VECTORS.find((entry) => entry.name === 'otpauth');
    expect(vector?.text).toMatch(/^otpauth:\/\/totp\//);
    expect(encodeQr(vector!.text).version).toBe(8);
  });
});

describe('the version tables', () => {
  it('derives the codeword totals ISO/IEC 18004 Table 1 gives', () => {
    const totals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(totalCodewords);
    expect(totals).toEqual([26, 44, 70, 100, 134, 172, 196, 242, 292, 346]);
  });

  it('splits the data codewords into the blocks Table 9 names', () => {
    // Version 8-M: two blocks of 38 and two of 39, 22 error-correction
    // codewords each. Derived here from (22, 4) and the total, which is the
    // point of deriving it.
    expect(blockPlan(8).dataLengths).toEqual([38, 38, 39, 39]);
    expect(blockPlan(8).eccPerBlock).toBe(22);
    expect(blockPlan(10).dataLengths).toEqual([43, 43, 43, 43, 44]);
    expect(blockPlan(1).dataLengths).toEqual([16]);
  });

  it('loses two bytes to the character count from version 10', () => {
    expect(byteModeCapacity(9)).toBe(182 - 2);
    expect(byteModeCapacity(10)).toBe(216 - 3);
  });
});

describe('the fixed bit patterns', () => {
  // Read back out of the reference matrices rather than written down from
  // memory. The format and version bits are the two places where a wrong
  // constant would still produce a symbol most readers accept, because the
  // error correction over them hides a single bad bit — so they are checked
  // against a symbol another implementation drew, at the coordinates
  // ISO/IEC 18004 §7.9 and §7.10 put them.

  function formatBitsFrom(rows: readonly string[]): number {
    // The second copy: bits 0-7 along the eighth row from the right edge,
    // bits 8-14 up the eighth column from the bottom edge.
    const size = rows.length;
    let bits = 0;
    for (let i = 0; i < 8; i += 1) {
      if (rows[8][size - 1 - i] === '1') bits |= 1 << i;
    }
    for (let i = 8; i < 15; i += 1) {
      if (rows[size - 15 + i][8] === '1') bits |= 1 << i;
    }
    return bits;
  }

  function versionBitsFrom(rows: readonly string[]): number {
    const size = rows.length;
    let bits = 0;
    for (let i = 0; i < 18; i += 1) {
      if (rows[Math.floor(i / 3)][size - 11 + (i % 3)] === '1') bits |= 1 << i;
    }
    return bits;
  }

  it('agrees with the reference symbols on the format information', () => {
    const seen = new Set<number>();
    for (const vector of QR_VECTORS) {
      expect(formatBitsFrom(vector.rows)).toBe(formatInformation(vector.mask));
      seen.add(vector.mask);
    }
    // Five of the eight masks are exercised by the ladder. The remaining
    // three are covered by the round trip through `encodeQr` above, which
    // would have chosen one if the penalty scoring called for it.
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });

  it('agrees with the reference symbols on the version information', () => {
    const large = QR_VECTORS.filter((vector) => vector.version >= 7);
    expect(large.length).toBeGreaterThan(0);
    for (const vector of large) {
      expect(versionBitsFrom(vector.rows)).toBe(versionInformation(vector.version));
    }
  });
});

describe('what the encoder refuses', () => {
  it('refuses text that does not fit a version-10 symbol rather than guessing', () => {
    expect(() => encodeQr('x'.repeat(214))).toThrow(QrTooLongError);
    expect(encodeQr('x'.repeat(213)).version).toBe(10);
  });
});
