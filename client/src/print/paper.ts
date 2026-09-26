// Paper geometry, one place, in millimetres — every sheet builder and the
// preview's page-sized blocks read these rather than each picking a margin.
//
// Firefox and @page (read 2026-09-26, raw.githubusercontent.com/mdn/browser-compat-data,
// main): the `@page` at-rule itself since Firefox 19 (css.at-rules.page),
// its `size` descriptor since Firefox 95 (css.at-rules.page.size), but the
// owner's own reading that day found Firefox ignores `@page size` in a
// SAVED PDF regardless — a behaviour gap this data does not capture, and
// the reason this file exists: every sheet is laid out as a fixed-size HTML
// block at the paper's own millimetre dimensions, never left to `@page` to
// size the output. Page-margin boxes (`@top-center` and its seven
// siblings) carry `"firefox": { "version_added": false }` in the same
// data — not used anywhere in this feature.
export const PAPER_SIZES = {
  A4: { widthMm: 210, heightMm: 297 },
  Letter: { widthMm: 215.9, heightMm: 279.4 },
} as const;

export type PaperSize = keyof typeof PAPER_SIZES;

export const PAPER_SIZE_NAMES = Object.keys(PAPER_SIZES) as PaperSize[];

/** The blank margin on every edge of every printed page. */
export const PAGE_MARGIN_MM = 10;

/** The title block strip at the foot of every page — brief item 2. */
export const TITLE_BLOCK_HEIGHT_MM = 16;

/** The sheet's own header line above the content (what this sheet is, e.g.
 * "Rack R1 · front and rear · cables: all"). */
export const SHEET_HEADER_HEIGHT_MM = 9;

export function pageWidthMm(paper: PaperSize): number {
  return PAPER_SIZES[paper].widthMm;
}

export function pageHeightMm(paper: PaperSize): number {
  return PAPER_SIZES[paper].heightMm;
}

export function contentWidthMm(paper: PaperSize): number {
  return pageWidthMm(paper) - 2 * PAGE_MARGIN_MM;
}

/** The vertical space left for a sheet's own drawing/table once the page
 * margins, the sheet header and the title block are taken out. */
export function contentHeightMm(paper: PaperSize): number {
  return pageHeightMm(paper) - 2 * PAGE_MARGIN_MM - TITLE_BLOCK_HEIGHT_MM - SHEET_HEADER_HEIGHT_MM;
}
