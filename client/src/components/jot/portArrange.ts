// Dragging a hand-typed port to any spot on its faceplate (schema 0.20): the spot snaps to a
// grid, or to another port's line when it comes close, and the guides say which. Pure, so a
// vitest drives it. Plate units are the plate's own flow pixels; the document keeps thousandths.

import { PLATE_SPAN } from '../drawing/faceplate';

/** The plate grid, in plate pixels (a quarter of a rack unit). */
export const PLATE_GRID = 4;
/** How close, in plate pixels, a port must come to another's centre line to line up with it. */
export const ALIGN_PX = 3;

export interface PortCentre {
  id: string;
  cx: number;
  cy: number;
}

export interface SnappedPort {
  cx: number;
  cy: number;
  /** Plate x of each vertical guide, plate y of each horizontal one. */
  guides: { v: number[]; h: number[] };
}

function nearest(value: number, lines: readonly number[], within: number): number | null {
  let best: number | null = null;
  for (const l of lines) {
    const d = Math.abs(l - value);
    if (d <= within && (best === null || d < Math.abs(best - value))) best = l;
  }
  return best;
}

/**
 * Where a dragged port's centre settles. Another port's centre line within `within` wins (and
 * shows a guide); otherwise the grid. Always kept so the whole `w`×`h` port stays on the plate.
 */
export function snapPort(
  at: { cx: number; cy: number },
  size: { w: number; h: number },
  plate: { w: number; h: number },
  others: readonly PortCentre[],
  within: number = ALIGN_PX,
): SnappedPort {
  const keep = (v: number, half: number, span: number) => Math.max(half, Math.min(span - half, v));
  const vx = nearest(at.cx, others.map((o) => o.cx), within);
  const hy = nearest(at.cy, others.map((o) => o.cy), within);
  const cx = keep(vx ?? Math.round(at.cx / PLATE_GRID) * PLATE_GRID, size.w / 2, plate.w);
  const cy = keep(hy ?? Math.round(at.cy / PLATE_GRID) * PLATE_GRID, size.h / 2, plate.h);
  return { cx, cy, guides: { v: vx !== null && vx === cx ? [vx] : [], h: hy !== null && hy === cy ? [hy] : [] } };
}

/** A centre in plate pixels as the document keeps it: thousandths of the plate. */
export function toPlate(cx: number, cy: number, plate: { w: number; h: number }): { x: number; y: number } {
  const clamp = (n: number) => Math.max(0, Math.min(PLATE_SPAN, Math.round(n)));
  return { x: clamp((cx / plate.w) * PLATE_SPAN), y: clamp((cy / plate.h) * PLATE_SPAN) };
}
