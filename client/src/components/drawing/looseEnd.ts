/** Where a cable with one end connected is drawn, and the numbers of its two looks (round 26
 * point 6, round 27 point 1). The line leaves the port's own edge straight out, then either
 * fades away (Unknown) or turns to slanted amber dashes with a ? in a circle (Needs finishing).
 * Pure; the SVG is `LooseCableNode.tsx`. */

import type { Lead } from './cableEnds';

/** From the port's edge to the tip of the loose end. */
export const LOOSE_RUN_PX = 150;
/** The last stretch: where an Unknown line fades, and where Needs finishing draws its dashes. */
export const LOOSE_STRETCH_PX = 110;
/** The part of the run before the stretch: the cable as drawn, in its sheath colour. */
export const LOOSE_SOLID_PX = LOOSE_RUN_PX - LOOSE_STRETCH_PX;
/** The node is a column this wide, the line down its middle; room for the circle either side. */
export const LOOSE_NODE_W = 48;

/** Needs finishing: dashes ~4px long with ~4px gaps, ~6px across, skewed about -35 degrees,
 * crawling toward the far end at ~18px a second. */
export const DASH_PX = 4;
export const GAP_PX = 4;
export const DASH_ACROSS_PX = 6;
export const DASH_SKEW_DEG = -35;
export const CRAWL_PX_PER_S = 18;
/** One crawl cycle moves the dashes by one dash and one gap, then repeats. */
export const CRAWL_PERIOD_PX = DASH_PX + GAP_PX;
export const CRAWL_PERIOD_S = CRAWL_PERIOD_PX / CRAWL_PX_PER_S;

/** The circle in the middle of the stretch. */
export const MISSING_CIRCLE_R = 12;

/** Every ? that marks missing information is drawn at this one size (px), in this one class. */
export const MISSING_MARK_PX = 15;
export const MISSING_MARK_CLASS = 'missing-mark';

/** The ? swings like a bell once a cycle, over the last part of it: the keyframes are in
 * `missing-links.css`, which spends the last 30% of this on the swing. */
export const BELL_CYCLE_S = 3.2;
export const BELL_SWING_FRACTION = 0.3;
/** The swing's angles in order, then settle. */
export const BELL_ANGLES_DEG = [16, -14, 10, -6, 3, 0] as const;

export interface LooseRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The node's rectangle in flow space for a lead leaving a port: the column runs from the lead
 * out in the lead's direction (+1 down, -1 up). */
export function looseRect(lead: Lead): LooseRect {
  return {
    x: lead.x - LOOSE_NODE_W / 2,
    y: lead.dir === 1 ? lead.y : lead.y - LOOSE_RUN_PX,
    width: LOOSE_NODE_W,
    height: LOOSE_RUN_PX,
  };
}

/** The line's key y positions inside that rectangle. `along(d)` is d px out from the port. */
export function looseColumn(dir: 1 | -1): { portY: number; tipY: number; along: (d: number) => number; x: number } {
  const portY = dir === 1 ? 0 : LOOSE_RUN_PX;
  return {
    portY,
    tipY: dir === 1 ? LOOSE_RUN_PX : 0,
    along: (d) => portY + dir * d,
    x: LOOSE_NODE_W / 2,
  };
}

/** The stretch's y range (top < bottom) inside the rectangle. */
export function stretchRange(dir: 1 | -1): { top: number; bottom: number } {
  const a = looseColumn(dir).along(LOOSE_SOLID_PX);
  const b = looseColumn(dir).along(LOOSE_RUN_PX);
  return { top: Math.min(a, b), bottom: Math.max(a, b) };
}

/** The circle's centre, in the middle of the stretch. */
export function circleCentre(dir: 1 | -1): { x: number; y: number } {
  const col = looseColumn(dir);
  return { x: col.x, y: col.along(LOOSE_SOLID_PX + LOOSE_STRETCH_PX / 2) };
}

/** One slanted dash as an SVG polygon's points: `DASH_ACROSS_PX` across the line, `DASH_PX` along
 * it, its two ends leaning by the skew. `yTop` is the dash's upper edge; the line is at `x`. */
export function dashPoints(x: number, yTop: number): string {
  const lean = DASH_PX * Math.tan((-DASH_SKEW_DEG * Math.PI) / 180);
  const half = DASH_ACROSS_PX / 2;
  const pts: [number, number][] = [
    [x - half + lean / 2, yTop],
    [x + half + lean / 2, yTop],
    [x + half - lean / 2, yTop + DASH_PX],
    [x - half - lean / 2, yTop + DASH_PX],
  ];
  return pts.map(([px, py]) => `${round(px)},${round(py)}`).join(' ');
}

/** Every dash needed to fill the stretch, one extra period past each end so the crawl never
 * shows a bare patch. They are static; the crawl moves the whole group by one period. */
export function stretchDashes(dir: 1 | -1): string[] {
  const { top, bottom } = stretchRange(dir);
  const x = LOOSE_NODE_W / 2;
  const out: string[] = [];
  for (let y = top - CRAWL_PERIOD_PX; y < bottom + CRAWL_PERIOD_PX; y += CRAWL_PERIOD_PX) out.push(dashPoints(x, y));
  return out;
}

/** The opacity stops of an Unknown line: full along the solid part, then a straight fade to nothing
 * over the stretch. Offsets run 0 at the port to 1 at the tip. */
export function fadeStops(): { offset: number; opacity: number }[] {
  return [
    { offset: 0, opacity: 1 },
    { offset: LOOSE_SOLID_PX / LOOSE_RUN_PX, opacity: 1 },
    { offset: 1, opacity: 0 },
  ];
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
