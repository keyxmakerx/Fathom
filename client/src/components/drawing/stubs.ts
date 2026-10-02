/** Automatic stubs (ADR-0061 round 7): a cable whose far end is a long way off
 * draws a short run out of each end, fading, and ends in a tag naming the far
 * end; clicking the tag pans there. Not a setting. Pure. */

/** Centre-to-centre distance, in flow px, past which a cable becomes stubs. */
export const STUB_DISTANCE_PX = 700;
/** How far a stub runs before it has faded out. */
export const STUB_RUN_PX = 56;

export interface Pt {
  x: number;
  y: number;
}

/** One end's stub: the tag it ends in, and the device it pans to. */
export interface StubEnd {
  text: string;
  /** Chassis id of the far end, for the pan. */
  panTo: string;
  /** The frame (header included) of the rack this stub starts in, flow y, so its tag sits clear of it. */
  frame?: { top: number; bottom: number };
}

export function isFarApart(a: Pt, b: Pt, threshold = STUB_DISTANCE_PX): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) > threshold;
}

/** "→ sw-09 · in rack R7"; the rack part is left out when the far end sits in none. */
export function stubTagText(hostname: string, rackLabel: string | null, count = 1): string {
  const name = hostname === '' ? 'unnamed device' : hostname;
  const where = rackLabel != null && rackLabel !== '' ? ` · in rack ${rackLabel}` : '';
  return `→ ${name}${where}${count > 1 ? ` · ×${count}` : ''}`;
}

/** A straight run of `len` px from `from` along the unit direction `(dx, dy)`. */
export function stubRun(from: Pt, dx: number, dy: number, len = STUB_RUN_PX): { d: string; end: Pt } {
  const end = { x: from.x + dx * len, y: from.y + dy * len };
  return { d: `M ${from.x} ${from.y} L ${end.x} ${end.y}`, end };
}

/** The unit direction from `a` toward `b`, snapped to the dominant axis so a stub
 * leaves square to the edge it starts from. */
export function axisToward(a: Pt, b: Pt): { dx: number; dy: number } {
  const ddx = b.x - a.x;
  const ddy = b.y - a.y;
  return Math.abs(ddx) >= Math.abs(ddy) ? { dx: ddx >= 0 ? 1 : -1, dy: 0 } : { dx: 0, dy: ddy >= 0 ? 1 : -1 };
}
