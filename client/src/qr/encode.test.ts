import { describe, expect, it } from 'vitest';

import { QrTooLongError, encodeQr, formatInformation, versionInformation } from './encode';
import { alignmentCentres, blockPlan, byteModeCapacity, totalCodewords } from './tables';
import { QR_BOUNDARY_VECTORS, QR_VECTORS, boundaryPayload } from './vectors.reference';

// The encoder is checked against another implementation's OUTPUT, pinned in
// `vectors.reference.ts` with where it came from and when. Module for module:
// a QR symbol is not a thing you can check by eye, and an encoder that is
// wrong in one alignment pattern still looks like a QR code.

/** The digest the boundary vectors are pinned by. WebCrypto rather than
 * `node:crypto`, because this client's TypeScript project takes no Node
 * types and a test is not the place to widen them. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

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

  it('draws the largest payload of every version 7 to 40, module for module', async () => {
    // Thirty-four boundary symbols, pinned by the SHA-256 of the reference
    // matrix rather than by a hundred thousand characters of zeros and ones
    // (`vectors.reference.ts` says where the digests came from and how they
    // were read back). This is where the rest of ISO/IEC 18004 Table 9 and
    // every row of Annex E is exercised: a wrong block plan or a misplaced
    // alignment centre changes the matrix, and the digest is a matrix.
    const covered = QR_BOUNDARY_VECTORS.map((vector) => vector.version);
    expect(covered).toEqual(Array.from({ length: 34 }, (_, i) => i + 7));

    for (const vector of QR_BOUNDARY_VECTORS) {
      const symbol = encodeQr(boundaryPayload(vector.bytes));
      expect({ version: symbol.version, size: symbol.size, mask: symbol.mask }).toEqual({
        version: vector.version,
        size: vector.size,
        mask: vector.mask,
      });
      const rows = symbol.modules.map((row) => row.map((dark) => (dark ? '1' : '0')).join(''));
      expect(await sha256Hex(rows.join('\n'))).toBe(vector.sha256);
    }
  });

  it('puts the capacity boundary where the reference puts it', () => {
    // The other half of the pinning: each vector's `bytes` is the most that
    // version holds, so one byte more must move up a version — and at 40
    // there is nowhere to move to. A capacity table wrong by one in either
    // direction fails here.
    for (const vector of QR_BOUNDARY_VECTORS) {
      expect(byteModeCapacity(vector.version)).toBe(vector.bytes);
      const oneMore = boundaryPayload(vector.bytes) + 'a';
      if (vector.version < 40) {
        expect(encodeQr(oneMore).version).toBe(vector.version + 1);
      } else {
        expect(() => encodeQr(oneMore)).toThrow(QrTooLongError);
      }
    }
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

describe('the address the server will actually hand it', () => {
  // The finding this range exists for. `operators.rs` takes an address of up
  // to 320 characters; `credentials.rs`'s `otpauth_uri` percent-encodes it
  // into a URI that is 122 bytes around an empty address, and a
  // percent-encoded character is three bytes. Version 10-M held 213, so an
  // address of about a hundred characters drew no code at all.
  function uriFor(address: string): string {
    const label = [...address]
      .map((c) => (/[A-Za-z0-9\-._~]/.test(c) ? c : `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
      .join('');
    return `otpauth://totp/Fathom:${label}?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Fathom&algorithm=SHA1&digits=6&period=30`;
  }

  it('draws the URI for the address that used to be refused', () => {
    const address = `${'a'.repeat(89)}@example.test`; // 102 characters
    expect(address).toHaveLength(102);
    const symbol = encodeQr(uriFor(address));
    expect(symbol.version).toBeGreaterThan(10);
    expect(symbol.version).toBeLessThanOrEqual(40);
  });

  it('draws the URI for the longest address the server will take, worst case', () => {
    // 320 characters, every one of them percent-encoded to three bytes:
    // longer than any address that will be typed, and the shape the encoder
    // has to survive rather than the shape it will usually see.
    const symbol = encodeQr(uriFor(' '.repeat(320)));
    expect(symbol.version).toBeLessThanOrEqual(40);
    expect(symbol.size).toBe(symbol.version * 4 + 17);
  });
});

describe('the version tables', () => {
  it('derives the codeword totals ISO/IEC 18004 Table 1 gives', () => {
    const totals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(totalCodewords);
    expect(totals).toEqual([26, 44, 70, 100, 134, 172, 196, 242, 292, 346]);
    // The two ends of Table 1: 26 codewords in a version-1 symbol, 3,706 in a
    // version-40 one, off the same geometry.
    expect(totalCodewords(40)).toBe(3706);
  });

  it('places the alignment patterns where Annex E does', () => {
    // Three rows worth stating: the version with none, a version whose
    // spacing the rule gets right, and version 32, the row the rule does not
    // produce. Versions 7 to 40 are exercised row by row by the boundary
    // symbols, which a decoder read back.
    expect(alignmentCentres(1)).toEqual([]);
    expect(alignmentCentres(7)).toEqual([6, 22, 38]);
    expect(alignmentCentres(32)).toEqual([6, 34, 60, 86, 112, 138]);
    expect(alignmentCentres(40)).toEqual([6, 30, 58, 86, 114, 142, 170]);
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
    // ISO/IEC 18004 Table 7's last level-M row, in bytes.
    expect(byteModeCapacity(40)).toBe(2331);
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
  it('refuses text that does not fit a version-40 symbol rather than guessing', () => {
    // 2,331 bytes is the largest byte-mode payload there is at level M; past
    // it there is no bigger symbol, so the refusal is the only honest answer
    // and `QrCode.tsx` turns it into a sentence about the setup key.
    expect(() => encodeQr('x'.repeat(2332))).toThrow(QrTooLongError);
    expect(encodeQr('x'.repeat(2331)).version).toBe(40);
    // The old ceiling, which the finding was about: 213 bytes is version 10,
    // and 214 is now version 11 rather than a refusal.
    expect(encodeQr('x'.repeat(213)).version).toBe(10);
    expect(encodeQr('x'.repeat(214)).version).toBe(11);
  });
});
