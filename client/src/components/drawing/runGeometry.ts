/** Where a cable run (schema 0.21) sits beside its rack, and where a tie on it is. Pure: the rack
 * node draws its runs from these, and the drawing finds the run a dragged tie lands on. */

import type { CableRunSide } from '../../document/cableRuns';
import type { Pt } from './cableRoute';

/** How far a run sits outside the rack's own edge. */
export const RUN_OFFSET_PX = 10;
/** A run's drawn thickness. */
export const RUN_THICK_PX = 6;
/** How close a dropped tie must land to a run to clip onto it. */
export const RUN_SNAP_PX = 18;

export interface RunSegment {
  runId: string;
  hostId: string;
  vertical: boolean;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface RackBox {
  x: number;
  y: number;
  width: number;
  /** The label row above the frame. */
  headerPx: number;
  frameHeight: number;
}

/** The centre line of a run on `side` of a rack. Vertical runs go top to bottom and horizontal
 * ones left to right, so `at` 0 is always the top or left end. */
export function rackRunLine(box: RackBox, side: CableRunSide): Omit<RunSegment, 'runId' | 'hostId'> {
  const top = box.y + box.headerPx;
  const bottom = top + box.frameHeight;
  switch (side) {
    case 'left':
      return { vertical: true, x1: box.x - RUN_OFFSET_PX, y1: top, x2: box.x - RUN_OFFSET_PX, y2: bottom };
    case 'right':
      return { vertical: true, x1: box.x + box.width + RUN_OFFSET_PX, y1: top, x2: box.x + box.width + RUN_OFFSET_PX, y2: bottom };
    case 'top':
      return { vertical: false, x1: box.x, y1: box.y - RUN_OFFSET_PX, x2: box.x + box.width, y2: box.y - RUN_OFFSET_PX };
    case 'bottom':
      return { vertical: false, x1: box.x, y1: bottom + RUN_OFFSET_PX, x2: box.x + box.width, y2: bottom + RUN_OFFSET_PX };
  }
}

/** The point `at` thousandths along a run. */
export function pointOnRun(seg: Pick<RunSegment, 'x1' | 'y1' | 'x2' | 'y2'>, at: number): Pt {
  const t = Math.max(0, Math.min(1000, at)) / 1000;
  return { x: seg.x1 + (seg.x2 - seg.x1) * t, y: seg.y1 + (seg.y2 - seg.y1) * t };
}

/** The `at` nearest to `p` along a run, and how far `p` is from the run. */
export function projectOntoRun(seg: Pick<RunSegment, 'x1' | 'y1' | 'x2' | 'y2'>, p: Pt): { at: number; distance: number } {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - seg.x1) * dx + (p.y - seg.y1) * dy) / len2));
  const q = { x: seg.x1 + dx * t, y: seg.y1 + dy * t };
  return { at: Math.round(t * 1000), distance: Math.hypot(p.x - q.x, p.y - q.y) };
}

/** The run a tie dropped at `p` clips onto: the nearest within reach, or none. */
export function runUnder(segments: readonly RunSegment[], p: Pt, reach = RUN_SNAP_PX): { run: RunSegment; at: number } | null {
  let best: { run: RunSegment; at: number; distance: number } | null = null;
  for (const run of segments) {
    const hit = projectOntoRun(run, p);
    if (hit.distance <= reach && (best == null || hit.distance < best.distance)) best = { run, ...hit };
  }
  return best == null ? null : { run: best.run, at: best.at };
}
