// A QR encoder: byte mode, error-correction level M, versions 1 to 40.
//
// ADR-0056 decision 5 — *"the enrolment screen draws the QR code itself, as
// inline SVG from a zero-dependency encoder, so `img-src` and the rest of the
// policy do not move"*. A password manager captures an authenticator secret
// by photographing the visible tab and decoding the QR out of it; text, copy
// buttons and an `otpauth://` link are invisible to it. So the code has to be
// on the page, and it has to be drawn by this client rather than fetched,
// because every other way of getting an image onto the page (`<img src=…>`, a
// `data:` URI, a canvas turned into one) would need `img-src` opened.
//
// **Scope, and why it is this shape.** Byte mode only: an `otpauth://` URI is
// not alphanumeric (lower case, `:`, `/`, `?`, `=`, `&` are all outside that
// character set), so the other modes would be code with no caller. Level M
// only, because that is the level ADR-0056 decision 5 names.
//
// **Every version, because the address decides the length and the server
// decides the address.** The first cut stopped at version 10, which holds 213
// bytes at level M; the URI is 110 bytes plus the percent-encoded address,
// and the server takes addresses of up to 320 characters, so an address of
// about a hundred characters threw `QrTooLongError` and the screen drew no
// code at all. 40-M holds 2,331 bytes. `encodeQr` still refuses rather than
// guessing past that, and `QrCode.tsx` says so in words if it ever happens.
//
// Everything here is written against ISO/IEC 18004, section by section, with
// the section named at each step; nothing is copied from another encoder
// (`docs/OPEN-QUESTIONS.md` A3 on borrowed code). What it is checked against
// is another implementation's OUTPUT, pinned in `vectors.reference.ts` — a
// different thing from taking its input. Two places where the standard's
// prose admits more than one reading, the mask penalty's finder-like feature
// and the format-information layout, were settled by that comparison and say
// so where they are written.
//
// Written 2026-09-22.

import { remainder } from './gf256';
import {
  ECC_LEVEL_M_INDICATOR,
  MAX_VERSION,
  MIN_VERSION,
  alignmentCentres,
  blockPlan,
  byteModeCapacity,
  characterCountBits,
  symbolSize,
} from './tables';

export interface QrSymbol {
  /** 1 to 40. */
  readonly version: number;
  /** Modules per side, `4 * version + 17`. */
  readonly size: number;
  /** The mask pattern chosen, 0 to 7 — kept because it is the one part of
   * the output no vector can be read back from by eye. */
  readonly mask: number;
  /** Row-major. `modules[y][x]` is true where the module is dark. */
  readonly modules: readonly (readonly boolean[])[];
}

/** Thrown when the text does not fit in a 40-M symbol — the largest QR symbol
 * there is at this level, 2,331 bytes. The caller decides what to say; this
 * module does not write user-facing sentences. */
export class QrTooLongError extends Error {
  readonly byteLength: number;

  constructor(byteLength: number) {
    super(`${byteLength} bytes does not fit a version-${MAX_VERSION} level-M QR symbol`);
    this.name = 'QrTooLongError';
    this.byteLength = byteLength;
  }
}

const MODE_BYTE = 0b0100;
const PAD_CODEWORDS = [0xec, 0x11];

/**
 * Encode `text` as a QR symbol.
 *
 * The text is UTF-8 encoded. ISO/IEC 18004 §7.3.5 makes ISO/IEC 8859-1 the
 * default interpretation for byte mode, and this encoder writes no ECI
 * designator, so a reader that honours the default will mis-read a non-ASCII
 * payload. Every URI this client draws is ASCII, where the two agree; that is
 * stated rather than guarded because a guard would refuse an address a server
 * has already accepted.
 */
export function encodeQr(text: string): QrSymbol {
  const data = new TextEncoder().encode(text);
  const version = chooseVersion(data.length);
  const codewords = interleave(version, buildCodewords(version, data));

  const canvas = new Canvas(version);
  canvas.drawFunctionPatterns();
  canvas.drawCodewords(codewords);
  const mask = canvas.applyBestMask();

  return { version, size: canvas.size, mask, modules: canvas.rows() };
}

/** The smallest version that holds `byteLength` bytes at level M. */
function chooseVersion(byteLength: number): number {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version += 1) {
    if (byteModeCapacity(version) >= byteLength) return version;
  }
  throw new QrTooLongError(byteLength);
}

// ---------------------------------------------------------------------------
// The bit stream and the codewords — ISO/IEC 18004 §7.4, §7.5, §7.6
// ---------------------------------------------------------------------------

class BitWriter {
  private readonly bytes: number[] = [];
  private partial = 0;
  private used = 0;

  push(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i -= 1) {
      this.partial = (this.partial << 1) | ((value >>> i) & 1);
      this.used += 1;
      if (this.used === 8) {
        this.bytes.push(this.partial);
        this.partial = 0;
        this.used = 0;
      }
    }
  }

  /** Pad the last partial codeword with zeros — §7.4.10's first step after
   * the terminator. */
  finishByte(): void {
    if (this.used > 0) {
      this.bytes.push(this.partial << (8 - this.used));
      this.partial = 0;
      this.used = 0;
    }
  }

  get bitLength(): number {
    return this.bytes.length * 8 + this.used;
  }

  take(): number[] {
    return this.bytes;
  }
}

/** The data codewords of a whole symbol: mode, count, data, terminator, pad
 * (§7.4.1, §7.4.5, §7.4.9, §7.4.10). */
function buildCodewords(version: number, data: Uint8Array): number[] {
  const plan = blockPlan(version);
  const dataCodewords = plan.dataLengths.reduce((sum, length) => sum + length, 0);
  const capacityBits = dataCodewords * 8;

  const writer = new BitWriter();
  writer.push(MODE_BYTE, 4);
  writer.push(data.length, characterCountBits(version));
  for (const byte of data) writer.push(byte, 8);
  // The terminator is up to four zero bits, and fewer if the symbol is
  // nearly full (§7.4.9).
  writer.push(0, Math.min(4, capacityBits - writer.bitLength));
  writer.finishByte();

  const codewords = writer.take();
  for (let i = 0; codewords.length < dataCodewords; i += 1) {
    codewords.push(PAD_CODEWORDS[i % 2]);
  }
  return codewords;
}

/** Split into blocks, add each block's error correction, and interleave —
 * §7.6. The data codewords go out one per block in turn, then the error
 * correction codewords the same way. A short block has no codeword to
 * contribute in the last data round, and is skipped there. */
function interleave(version: number, dataCodewords: number[]): number[] {
  const plan = blockPlan(version);
  const dataBlocks: number[][] = [];
  const eccBlocks: number[][] = [];

  let offset = 0;
  for (const length of plan.dataLengths) {
    const block = dataCodewords.slice(offset, offset + length);
    offset += length;
    dataBlocks.push(block);
    eccBlocks.push(Array.from(remainder(Uint8Array.from(block), plan.eccPerBlock)));
  }

  const out: number[] = [];
  const longest = Math.max(...plan.dataLengths);
  for (let i = 0; i < longest; i += 1) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < plan.eccPerBlock; i += 1) {
    for (const block of eccBlocks) out.push(block[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The symbol — ISO/IEC 18004 §6.3, §7.7, §7.8, §7.9, §7.10
// ---------------------------------------------------------------------------

class Canvas {
  readonly size: number;
  private readonly version: number;
  private readonly dark: Uint8Array;
  /** 1 where a module belongs to a function pattern or a reserved area: no
   * data goes there and no mask touches it. */
  private readonly fixed: Uint8Array;

  constructor(version: number) {
    this.version = version;
    this.size = symbolSize(version);
    this.dark = new Uint8Array(this.size * this.size);
    this.fixed = new Uint8Array(this.size * this.size);
  }

  private set(x: number, y: number, dark: boolean, fixed = true): void {
    const at = y * this.size + x;
    this.dark[at] = dark ? 1 : 0;
    if (fixed) this.fixed[at] = 1;
  }

  private isDark(x: number, y: number): boolean {
    return this.dark[y * this.size + x] === 1;
  }

  drawFunctionPatterns(): void {
    const last = this.size - 7;
    this.drawFinder(0, 0);
    this.drawFinder(last, 0);
    this.drawFinder(0, last);

    // Timing patterns (§6.3.5): the sixth row and column, alternating from
    // the finder patterns, which fixes the parity.
    for (let i = 8; i < this.size - 8; i += 1) {
      const dark = i % 2 === 0;
      this.set(i, 6, dark);
      this.set(6, i, dark);
    }

    // Alignment patterns (§6.3.6), except the three whose centres fall in a
    // finder pattern.
    const centres = alignmentCentres(this.version);
    for (const cy of centres) {
      for (const cx of centres) {
        const corner =
          (cx === centres[0] && cy === centres[0]) ||
          (cx === centres[0] && cy === centres[centres.length - 1]) ||
          (cx === centres[centres.length - 1] && cy === centres[0]);
        if (!corner) this.drawAlignment(cx, cy);
      }
    }

    this.reserveFormatAreas();
    if (this.version >= 7) this.drawVersionInformation();
  }

  private drawFinder(x0: number, y0: number): void {
    // The 7x7 pattern and the separator around it, drawn together so the
    // separator cannot be forgotten: everything in the 9x9 neighbourhood is
    // light unless it is inside one of the two dark rings.
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) {
        const x = x0 + dx;
        const y = y0 + dy;
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
        // Ring 4 is the separator, and is light; inside the 7x7 pattern the
        // centre (0, 1) and the outer ring (3) are dark and ring 2 is light.
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        this.set(x, y, ring !== 2 && ring <= 3);
      }
    }
  }

  private drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        this.set(cx + dx, cy + dy, ring !== 1);
      }
    }
  }

  /** The two copies of the format information, and the dark module (§7.9).
   * Reserved now, written after the mask is chosen — the mask number is part
   * of what they say. */
  private reserveFormatAreas(): void {
    for (let i = 0; i < 9; i += 1) {
      // Index 6 is the timing pattern crossing the eighth row and column;
      // the format information steps over it and must not blank it.
      if (i === 6) continue;
      this.set(i, 8, false);
      this.set(8, i, false);
    }
    for (let i = 0; i < 8; i += 1) {
      this.set(this.size - 1 - i, 8, false);
      this.set(8, this.size - 1 - i, false);
    }
    // The module that is dark in every symbol (§7.9.1).
    this.set(8, this.size - 8, true);
  }

  private drawVersionInformation(): void {
    const bits = versionInformation(this.version);
    for (let i = 0; i < 18; i += 1) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = this.size - 11 + (i % 3);
      this.set(b, a, bit); // top right
      this.set(a, b, bit); // bottom left
    }
  }

  /** §7.7.3: two-module-wide columns, right to left, alternating up and
   * down, skipping the vertical timing column. */
  drawCodewords(codewords: number[]): void {
    let bit = 0;
    let upward = true;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // the timing column is not part of a pair
      for (let step = 0; step < this.size; step += 1) {
        const y = upward ? this.size - 1 - step : step;
        for (let col = 0; col < 2; col += 1) {
          const x = right - col;
          if (this.fixed[y * this.size + x] === 1) continue;
          // Past the end of the codewords are the remainder bits, which are
          // light and carry nothing (§7.7.3).
          const dark = bit < codewords.length * 8 && ((codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1) === 1;
          this.set(x, y, dark, false);
          bit += 1;
        }
      }
      upward = !upward;
    }
  }

  /** Try all eight masks, keep the one with the lowest penalty (§7.8.3), and
   * write the format information that names it. */
  applyBestMask(): number {
    let best = 0;
    let bestPenalty = Number.POSITIVE_INFINITY;
    for (let mask = 0; mask < 8; mask += 1) {
      this.applyMask(mask);
      this.drawFormatInformation(mask);
      const penalty = this.penalty();
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        best = mask;
      }
      this.applyMask(mask); // XOR is its own inverse
    }
    this.applyMask(best);
    this.drawFormatInformation(best);
    return best;
  }

  private applyMask(mask: number): void {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        const at = y * this.size + x;
        if (this.fixed[at] === 1) continue;
        if (maskCondition(mask, x, y)) this.dark[at] ^= 1;
      }
    }
  }

  private drawFormatInformation(mask: number): void {
    const bits = formatInformation(mask);
    for (let i = 0; i < 15; i += 1) {
      const bit = ((bits >>> i) & 1) === 1;
      // First copy, around the top-left finder: down the eighth column,
      // stepping over the timing row, then left along the eighth row.
      if (i < 6) this.set(8, i, bit);
      else if (i === 6) this.set(8, 7, bit);
      else if (i === 7) this.set(8, 8, bit);
      else if (i === 8) this.set(7, 8, bit);
      else this.set(14 - i, 8, bit);

      // Second copy: right along the eighth row from the far edge, then up
      // the eighth column from the bottom.
      if (i < 8) this.set(this.size - 1 - i, 8, bit);
      else this.set(8, this.size - 15 + i, bit);
    }
  }

  /** ISO/IEC 18004 §7.8.3, the four penalty features. */
  private penalty(): number {
    let score = 0;
    const n = this.size;

    // N1: a run of five or more modules of the same colour, in a row or a
    // column. Three points for the first five, one for each after.
    for (let i = 0; i < n; i += 1) {
      score += runPenalty(Array.from({ length: n }, (_, j) => this.isDark(j, i)));
      score += runPenalty(Array.from({ length: n }, (_, j) => this.isDark(i, j)));
    }

    // N2: every 2x2 block of one colour, three points.
    for (let y = 0; y < n - 1; y += 1) {
      for (let x = 0; x < n - 1; x += 1) {
        const first = this.isDark(x, y);
        if (
          this.isDark(x + 1, y) === first &&
          this.isDark(x, y + 1) === first &&
          this.isDark(x + 1, y + 1) === first
        ) {
          score += 3;
        }
      }
    }

    // N3: the 1:1:3:1:1 finder-like ratio with four light modules beside it,
    // forty points each, counted in both directions.
    for (let i = 0; i < n; i += 1) {
      const row = Array.from({ length: n }, (_, j) => this.isDark(j, i));
      const column = Array.from({ length: n }, (_, j) => this.isDark(i, j));
      score += 40 * finderLike(row, n);
      score += 40 * finderLike(column, n);
    }

    // N4: ten points for each 5% the dark proportion is away from half.
    let dark = 0;
    for (const module of this.dark) dark += module;
    const total = n * n;
    score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;

    return score;
  }

  rows(): boolean[][] {
    const out: boolean[][] = [];
    for (let y = 0; y < this.size; y += 1) {
      const row: boolean[] = [];
      for (let x = 0; x < this.size; x += 1) row.push(this.isDark(x, y));
      out.push(row);
    }
    return out;
  }
}

function runPenalty(line: boolean[]): number {
  let score = 0;
  let run = 1;
  for (let i = 1; i < line.length; i += 1) {
    if (line[i] === line[i - 1]) {
      run += 1;
      if (run === 5) score += 3;
      else if (run > 5) score += 1;
    } else {
      run = 1;
    }
  }
  return score;
}

/**
 * How many finder-like patterns a row or column holds: ISO/IEC 18004 Table 11
 * feature three, *"1:1:3:1:1 ratio (dark:light:dark:light:dark) pattern
 * preceded or followed by light area 4 modules wide"*.
 *
 * Three things in that sentence are worth stating, because they are where
 * implementations differ and where this one was corrected against the
 * reference in `vectors.reference.ts`:
 *
 * - **Ratio, not size.** A run of 2:2:6:2:2 is the same ratio and counts.
 *   Only the proportions are fixed, so the scan is over runs, not over an
 *   eleven-module window.
 * - **The quiet zone counts as light area.** A pattern against the edge of
 *   the symbol has the quiet zone beyond it, so `quiet` light modules are
 *   modelled at each end of the line.
 * - **Preceded OR followed** is counted once for each side that qualifies, so
 *   a pattern with a wide light area on both sides scores twice. The other
 *   side still has to be light enough not to break the ratio.
 */
function finderLike(line: boolean[], quiet: number): number {
  const runs: { dark: boolean; length: number }[] = [{ dark: false, length: quiet }];
  for (const module of line) {
    const last = runs[runs.length - 1];
    if (last.dark === module) last.length += 1;
    else runs.push({ dark: module, length: 1 });
  }
  const tail = runs[runs.length - 1];
  if (tail.dark) runs.push({ dark: false, length: quiet });
  else tail.length += quiet;

  let found = 0;
  for (let i = 1; i + 5 < runs.length; i += 1) {
    if (!runs[i].dark) continue;
    const unit = runs[i].length;
    const core =
      runs[i + 1].length === unit &&
      runs[i + 2].length === unit * 3 &&
      runs[i + 3].length === unit &&
      runs[i + 4].length === unit;
    if (!core) continue;
    const before = runs[i - 1].length;
    const after = runs[i + 5].length;
    if (before >= unit * 4 && after >= unit) found += 1;
    if (after >= unit * 4 && before >= unit) found += 1;
  }
  return found;
}

/** ISO/IEC 18004 §7.8.2, Table 10. `x` is the column, `y` the row. */
function maskCondition(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (y + x) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (y + x) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((y * x) % 2) + ((y * x) % 3) === 0;
    case 6:
      return (((y * x) % 2) + ((y * x) % 3)) % 2 === 0;
    default:
      return (((y + x) % 2) + ((y * x) % 3)) % 2 === 0;
  }
}

/**
 * The fifteen format bits: two bits of error-correction level and three of
 * mask, with a (15,5) BCH code and the mask `101010000010010` XORed over the
 * result so the field is never all zero (§7.9.1).
 */
export function formatInformation(mask: number): number {
  const data = (ECC_LEVEL_M_INDICATOR << 3) | mask;
  return ((data << 10) | bch(data << 10, 0b101_0011_0111, 10)) ^ 0b101_0100_0001_0010;
}

/** The eighteen version bits: six of version and a (18,6) BCH code (§7.10).
 * Present from version 7 only. */
export function versionInformation(version: number): number {
  return (version << 12) | bch(version << 12, 0b1_1111_0010_0101, 12);
}

/** The remainder of `value` modulo `generator`, in GF(2)[x]. `degree` is the
 * generator's degree, which is also the width of the answer. */
function bch(value: number, generator: number, degree: number): number {
  let rest = value;
  for (let i = bitLength(rest) - 1; i >= degree; i -= 1) {
    if ((rest >>> i) & 1) rest ^= generator << (i - degree);
  }
  return rest;
}

function bitLength(value: number): number {
  let bits = 0;
  while (value >>> bits) bits += 1;
  return bits;
}
