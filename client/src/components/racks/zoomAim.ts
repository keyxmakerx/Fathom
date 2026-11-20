// Where a zoom stop lands. On what is selected; with nothing selected, on the middle of the view if something is
// drawn there, else on the nearest thing. A stop never leaves the person looking at empty paper while there is
// something to look at. Pure: boxes in pane pixels in, a camera out.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface Point {
  x: number;
  y: number;
}

/** How far inside a large thing's edge the stop lands when it has to move to that thing. */
export const AIM_INSET_PX = 48;

/** One box around several (every selected thing), or null for none. */
export function unionBox(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((b) => b.left));
  const top = Math.min(...boxes.map((b) => b.top));
  const right = Math.max(...boxes.map((b) => b.left + b.width));
  const bottom = Math.max(...boxes.map((b) => b.top + b.height));
  return { left, top, width: right - left, height: bottom - top };
}

/** `v` kept inside `[from, from + size]`, `AIM_INSET_PX` in from each end (the middle, for a thing too small for that). */
function inside(v: number, from: number, size: number): number {
  const inset = Math.min(AIM_INSET_PX, size / 2);
  return Math.max(from + inset, Math.min(v, from + size - inset));
}

/** The spot a stop brings to the middle of the view, in pane pixels. */
export function aimAt(pane: { width: number; height: number }, selected: Box | null, things: readonly Box[]): Point {
  if (selected != null) return { x: selected.left + selected.width / 2, y: selected.top + selected.height / 2 };
  const mid = { x: pane.width / 2, y: pane.height / 2 };
  let best: Point | null = null;
  let bestDistance = Infinity;
  for (const t of things) {
    const dx = Math.max(t.left - mid.x, 0, mid.x - (t.left + t.width));
    const dy = Math.max(t.top - mid.y, 0, mid.y - (t.top + t.height));
    const distance = Math.hypot(dx, dy);
    // The middle is already on something: the stop zooms about the middle, as it always did.
    if (distance === 0) return mid;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { x: inside(mid.x, t.left, t.width), y: inside(mid.y, t.top, t.height) };
    }
  }
  return best ?? mid;
}

/** The camera at `zoom` with the pane spot `at` (as the camera `from` shows it) brought to the middle of the pane. */
export function cameraOnto(from: Camera, pane: { width: number; height: number }, at: Point, zoom: number): Camera {
  const fx = (at.x - from.x) / from.zoom;
  const fy = (at.y - from.y) / from.zoom;
  return { x: pane.width / 2 - fx * zoom, y: pane.height / 2 - fy * zoom, zoom };
}

/** What counts as selected on the drawing, in either look. */
export const SELECTED_SELECTOR = '.react-flow__viewport [class*="--selected"]';
/** The things a close stop (faceplate, inside) looks for: devices. */
export const DEVICE_SELECTOR = '.react-flow__node-chassis, [data-device-chassis], .react-flow__node-freeBox, .drawing-diagram-box';
/** The things a far stop (closet, rack) looks for: anything drawn. */
export const THING_SELECTOR = '.react-flow__node';

/** Reads the pane and answers the camera for a stop at `zoom`; null when there is no drawing to read. */
export function cameraForStop(pane: Element | null, from: Camera, zoom: number, close: boolean): Camera | null {
  if (pane == null) return null;
  const frame = pane.getBoundingClientRect();
  if (frame.width <= 0 || frame.height <= 0) return null;
  const boxes = (selector: string): Box[] =>
    Array.from(pane.querySelectorAll(selector), (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left - frame.left, top: r.top - frame.top, width: r.width, height: r.height };
    }).filter((b) => b.width > 0 && b.height > 0);
  const size = { width: frame.width, height: frame.height };
  const at = aimAt(size, unionBox(boxes(SELECTED_SELECTOR)), boxes(close ? DEVICE_SELECTOR : THING_SELECTOR));
  return cameraOnto(from, size, at, zoom);
}
