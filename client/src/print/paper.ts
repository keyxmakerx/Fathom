// Paper geometry, in millimetres. Firefox has no page-margin boxes (citation in
// print.css), so every sheet is a fixed-size HTML block with its own title block.
export const PAPER_SIZES = {
  A4: { widthMm: 210, heightMm: 297 },
  Letter: { widthMm: 215.9, heightMm: 279.4 },
} as const;

export type PaperSize = keyof typeof PAPER_SIZES;

export const PAPER_SIZE_NAMES = Object.keys(PAPER_SIZES) as PaperSize[];

/** The blank margin on every edge of every printed page. */
export const PAGE_MARGIN_MM = 10;

/** The title block strip at the foot of every page. */
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

/** A CSS px is fixed at 96 per inch regardless of the real screen's DPI, so
 * this conversion is exact, not a measurement. */
export const CSS_PX_PER_MM = 96 / 25.4;

export function mmToPx(mm: number): number {
  return mm * CSS_PX_PER_MM;
}

export function pxToMm(px: number): number {
  return px / CSS_PX_PER_MM;
}
