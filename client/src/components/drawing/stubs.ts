/** Automatic stubs (ADR-0061 round 7): a cable whose far end is off screen
 * draws a short run out of each end, fading, and ends in a tag naming the far
 * end; clicking the tag pans there. Not a setting. Pure. */

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

/** An end this far (screen px) outside the visible canvas still counts as visible. */
export const STUB_INSET_PX = 24;
/** A stubbed cable returns to a full line only once its end is this far inside the canvas. */
export const STUB_HYSTERESIS_PX = 12;

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The visible canvas in flow coordinates for a viewport and the pane's size. */
export function visibleRect(vp: { x: number; y: number; zoom: number }, size: { width: number; height: number }): Rect {
  return { x0: -vp.x / vp.zoom, y0: -vp.y / vp.zoom, x1: (size.width - vp.x) / vp.zoom, y1: (size.height - vp.y) / vp.zoom };
}

/** Whether `pt` is off screen; sticky, so a cable at the edge does not keep toggling. */
export function endOffScreen(pt: Pt, rect: Rect, zoom: number, wasStub: boolean): boolean {
  const m = (wasStub ? -STUB_HYSTERESIS_PX : STUB_INSET_PX) / zoom;
  return pt.x < rect.x0 - m || pt.x > rect.x1 + m || pt.y < rect.y0 - m || pt.y > rect.y1 + m;
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
