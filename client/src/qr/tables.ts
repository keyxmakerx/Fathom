// The per-version numbers a QR symbol is built from, for versions 1 to 10 at
// error-correction level M — which is all ADR-0056 decision 5 needs: an
// `otpauth://` URI for this product is about 130 bytes and version 10-M holds
// 214 of them.
//
// Two of the three numbers are DERIVED rather than tabled, on purpose. The
// capacity of a version follows from where the function patterns are, and the
// split of data codewords into blocks follows from the block count, so the
// only thing copied out of ISO/IEC 18004 Table 9 here is the pair
// (error-correction codewords per block, number of blocks). A table that can
// be computed is a table that can be wrong in one row and pass every test
// that does not touch it.
//
// Written 2026-09-22.

/** The versions this encoder covers. Beyond 10 the character-count indicator
 * and the alignment-pattern rule both change again, and nothing in this
 * product needs it. */
export const MIN_VERSION = 1;
export const MAX_VERSION = 10;

/** Level M — the level ADR-0056 decision 5 names. Its two-bit indicator in
 * the format information is `00` (ISO/IEC 18004 Table 12); the enum order in
 * that table is L, M, Q, H and is not the numeric order of the levels. */
export const ECC_LEVEL_M_INDICATOR = 0b00;

/**
 * ISO/IEC 18004 Table 9, level M rows, versions 1–10:
 * `[error-correction codewords per block, number of blocks]`.
 */
const ECC_M: ReadonlyArray<readonly [number, number]> = [
  [10, 1], // 1-M
  [16, 1], // 2-M
  [26, 1], // 3-M
  [18, 2], // 4-M
  [24, 2], // 5-M
  [16, 4], // 6-M
  [18, 4], // 7-M
  [22, 4], // 8-M
  [22, 5], // 9-M
  [26, 5], // 10-M
];

/** Alignment-pattern centre coordinates, ISO/IEC 18004 Annex E. Version 1 has
 * none; every other version has one at each pair of these. */
const ALIGNMENT_CENTRES: ReadonlyArray<readonly number[]> = [
  [], // 1
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50], // 10
];

export function symbolSize(version: number): number {
  return version * 4 + 17;
}

export function alignmentCentres(version: number): readonly number[] {
  return ALIGNMENT_CENTRES[version - 1];
}

/**
 * How many modules a version leaves for data and error correction, counted
 * off the geometry rather than read out of a table.
 *
 * Everything subtracted is a function pattern or a reserved area: the three
 * finder patterns with their separators (8x8 each), the two timing lines less
 * the part inside those corners, the alignment patterns, the two copies of
 * the format information, the one dark module, and — from version 7 — the two
 * copies of the version information. The alignment patterns that sit ON a
 * timing line have already had five of their modules counted out with it, so
 * those five come back.
 */
export function rawDataModules(version: number): number {
  const size = symbolSize(version);
  let count = size * size;
  count -= 3 * 64;
  count -= 2 * (size - 16);
  if (version >= 2) {
    const perAxis = Math.floor(version / 7) + 2;
    const patterns = perAxis * perAxis - 3; // three corners are finder patterns
    count -= 25 * patterns;
    count += 5 * (2 * (perAxis - 2)); // the ones straddling a timing line
  }
  count -= 2 * 15;
  count -= 1;
  if (version >= 7) count -= 2 * 18;
  return count;
}

/** Total codewords in a version. The modules left over (0 or 7 here) are the
 * remainder bits, which are placed as light and carry nothing. */
export function totalCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8);
}

export interface BlockPlan {
  /** Codewords in each block, in order. Short blocks come first, as
   * ISO/IEC 18004 §7.6 requires for the interleave to be unambiguous. */
  readonly dataLengths: readonly number[];
  /** Error-correction codewords per block — the same for every block. */
  readonly eccPerBlock: number;
  readonly totalCodewords: number;
}

/**
 * How a version's codewords are laid out at level M.
 *
 * The block lengths are not tabled: with `blocks` blocks and `data` data
 * codewords, every block holds `floor(data / blocks)` and the last
 * `data mod blocks` of them hold one more. That is exactly what Table 9's
 * two groups say, in the form that cannot disagree with the totals.
 */
export function blockPlan(version: number): BlockPlan {
  const [eccPerBlock, blocks] = ECC_M[version - 1];
  const total = totalCodewords(version);
  const data = total - eccPerBlock * blocks;
  const short = Math.floor(data / blocks);
  const longCount = data % blocks;
  const dataLengths: number[] = [];
  for (let i = 0; i < blocks; i += 1) {
    dataLengths.push(i < blocks - longCount ? short : short + 1);
  }
  return { dataLengths, eccPerBlock, totalCodewords: total };
}

/** Data capacity in bytes for byte mode: the data codewords, less the four
 * mode bits and the character-count indicator. */
export function byteModeCapacity(version: number): number {
  const plan = blockPlan(version);
  const dataCodewords = plan.totalCodewords - plan.eccPerBlock * plan.dataLengths.length;
  return dataCodewords - 1 - characterCountBits(version) / 8;
}

/** Bits in the character-count indicator for byte mode: 8 up to version 9,
 * 16 from version 10 (ISO/IEC 18004 Table 3). */
export function characterCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}
