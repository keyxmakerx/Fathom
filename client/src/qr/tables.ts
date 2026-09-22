// The per-version numbers a QR symbol is built from, for versions 1 to 40 at
// error-correction level M.
//
// **Why the whole range, when the first cut stopped at 10.** The address in an
// `otpauth://` URI is whatever the server accepted, and the server accepts an
// address of up to 320 characters; percent-encoded that is up to three bytes
// each, on top of the 110 bytes the rest of this product's URI takes. Version
// 10-M holds 213 bytes, so an address of about a hundred characters already
// threw `QrTooLongError` and the enrolment screen drew no code at all — the
// one thing ADR-0056 decision 5 exists to prevent, since a password manager
// reads the secret only out of a picture. Version 40-M holds 2,331 bytes,
// which covers every address the server will take with room over.
//
// Three of the four numbers are DERIVED rather than tabled, on purpose. The
// capacity of a version follows from where the function patterns are; the
// split of data codewords into blocks follows from the block count; and the
// alignment-pattern centres follow from one spacing rule. The only thing
// copied out of ISO/IEC 18004 Table 9 here is the pair (error-correction
// codewords per block, number of blocks). A table that can be computed is a
// table that can be wrong in one row and pass every test that does not touch
// it.
//
// Written 2026-09-22.

/** The versions this encoder covers — all of them (ISO/IEC 18004 §6.5.1). */
export const MIN_VERSION = 1;
export const MAX_VERSION = 40;

/** Level M — the level ADR-0056 decision 5 names. Its two-bit indicator in
 * the format information is `00` (ISO/IEC 18004 Table 12); the enum order in
 * that table is L, M, Q, H and is not the numeric order of the levels. */
export const ECC_LEVEL_M_INDICATOR = 0b00;

/**
 * ISO/IEC 18004 Table 9, level M rows, versions 1–40:
 * `[error-correction codewords per block, number of blocks]`.
 *
 * The one irreducible table in this file, and nothing in it is taken on
 * trust: every row is exercised by a symbol in `vectors.reference.ts`, and a
 * wrong pair changes that version's block plan, so the pinned symbol stops
 * matching and the independent decoder stops reading it.
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
  [30, 5], // 11-M
  [22, 8], // 12-M
  [22, 9], // 13-M
  [24, 9], // 14-M
  [24, 10], // 15-M
  [28, 10], // 16-M
  [28, 11], // 17-M
  [26, 13], // 18-M
  [26, 14], // 19-M
  [26, 16], // 20-M
  [26, 17], // 21-M
  [28, 17], // 22-M
  [28, 18], // 23-M
  [28, 20], // 24-M
  [28, 21], // 25-M
  [28, 23], // 26-M
  [28, 25], // 27-M
  [28, 26], // 28-M
  [28, 28], // 29-M
  [28, 29], // 30-M
  [28, 31], // 31-M
  [28, 33], // 32-M
  [28, 35], // 33-M
  [28, 37], // 34-M
  [28, 38], // 35-M
  [28, 40], // 36-M
  [28, 43], // 37-M
  [28, 45], // 38-M
  [28, 47], // 39-M
  [28, 49], // 40-M
];

export function symbolSize(version: number): number {
  return version * 4 + 17;
}

/**
 * Alignment-pattern centre coordinates, ISO/IEC 18004 Annex E — computed
 * rather than copied, because Annex E is forty rows of numbers that follow
 * one rule.
 *
 * The rule: version 1 has none; every other version has `floor(version/7) + 2`
 * centres on each axis, the first at 6 and the last at `size - 7`, the rest
 * evenly spaced with the spacing rounded **up** to an even number, and the
 * wider gap left next to the first. Counting down from the last centre is
 * what leaves it there.
 *
 * **Version 32 is the one row the rule does not produce** — it would give 28
 * and Annex E says 26 — so it is named here rather than smoothed over.
 * Checked two ways on 2026-09-22: the forty rows this returns were compared
 * against the positions another implementation carries (qrcodegen 1.8.0), and
 * every symbol in `vectors.reference.ts` was read back by a decoder that
 * looks for these patterns where the standard puts them. A centre in the
 * wrong place moves every data module after it.
 */
export function alignmentCentres(version: number): readonly number[] {
  if (version <= 1) return [];
  const count = Math.floor(version / 7) + 2;
  const last = symbolSize(version) - 7;
  const step = version === 32 ? 26 : 2 * Math.ceil((last - 6) / (2 * (count - 1)));
  const centres = [6];
  for (let i = count - 2; i >= 0; i -= 1) centres.push(last - step * i);
  return centres;
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

/** Total codewords in a version. The modules left over (0, 3, 4 or 7) are the
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
