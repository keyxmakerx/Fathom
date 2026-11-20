// Where a zoom stop lands. On what is selected; with nothing selected, on the middle of the view if something is
// drawn there, else on the nearest thing. A stop never leaves the person looking at empty paper while there is
// something to look at. Going in from the Closet stop, the Rack stop lands on a rack: the middle of a whole
// closet is as often a wall. Pure: boxes in pane pixels in, a camera out.

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

/** How far `p` is from `box`; 0 on it. */
function awayFrom(p: Point, box: Box): number {
  const dx = Math.max(box.left - p.x, 0, p.x - (box.left + box.width));
  const dy = Math.max(box.top - p.y, 0, p.y - (box.top + box.height));
  return Math.hypot(dx, dy);
}

/** The spot a stop brings to the middle of the view, in pane pixels. */
export function aimAt(pane: { width: number; height: number }, selected: Box | null, things: readonly Box[]): Point {
  if (selected != null) return { x: selected.left + selected.width / 2, y: selected.top + selected.height / 2 };
  const mid = { x: pane.width / 2, y: pane.height / 2 };
  let best: Point | null = null;
  let bestDistance = Infinity;
  for (const t of things) {
    const distance = awayFrom(mid, t);
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

/** How far what floats over the pane reaches into it from its top and from its foot, in pixels. */
export interface Reach {
  top: number;
  bottom: number;
}

/** A rack a stop lands on keeps this far from the top and the foot of the room it has. */
export const RACK_ROOM_PX = 16;

/**
 * The camera at `zoom` on the rack nearest the middle of the view; null with no rack. The rack stands in the
 * middle of the pane's width, and in the middle of the room left between what floats over the pane's top and its
 * foot. One too tall for that room has its top at the top of it, unless the middle of the view was already on
 * the rack: then that part of it stays in the middle, slid only as far as leaves no paper above the rack or
 * under it.
 */
export function cameraOntoRack(from: Camera, pane: { width: number; height: number }, racks: readonly Box[], zoom: number, reach: Reach = { top: 0, bottom: 0 }): Camera | null {
  const mid = { x: pane.width / 2, y: pane.height / 2 };
  let rack: Box | null = null;
  let nearest = Infinity;
  for (const r of racks) {
    const distance = awayFrom(mid, r);
    if (distance < nearest) {
      nearest = distance;
      rack = r;
    }
  }
  if (rack == null) return null;
  const k = zoom / from.zoom;
  const height = rack.height * k;
  const top = reach.top + RACK_ROOM_PX;
  const room = pane.height - reach.bottom - RACK_ROOM_PX - top;
  // Where the rack's top left corner goes, in pane pixels.
  const x = (pane.width - rack.width * k) / 2;
  let y = top + (room - height) / 2;
  if (height > room) y = nearest === 0 ? Math.min(top, Math.max(top + room - height, top + room / 2 - (mid.y - rack.top) * k)) : top;
  return { x: x - ((rack.left - from.x) / from.zoom) * zoom, y: y - ((rack.top - from.y) / from.zoom) * zoom, zoom };
}

/** What counts as selected on the drawing, in either look. */
export const SELECTED_SELECTOR = '.react-flow__viewport [class*="--selected"]';
/** The things a close stop (faceplate, inside) looks for: devices. */
export const DEVICE_SELECTOR = '.react-flow__node-chassis, [data-device-chassis], .react-flow__node-freeBox, .drawing-diagram-box';
/** The things a far stop (closet, rack) looks for: anything drawn. */
export const THING_SELECTOR = '.react-flow__node';
/** A rack. */
export const RACK_SELECTOR = '.react-flow__node-rack';

/**
 * Reads the pane and answers the camera for a stop at `zoom`; null when there is no drawing to read. With
 * `onRack` (what floats over the pane's top and its foot) and nothing selected, the stop lands on a rack when one
 * is drawn.
 */
export function cameraForStop(pane: Element | null, from: Camera, zoom: number, close: boolean, onRack: { top: Element | null; foot: Element | null } | null = null): Camera | null {
  if (pane == null) return null;
  const frame = pane.getBoundingClientRect();
  if (frame.width <= 0 || frame.height <= 0) return null;
  const boxes = (selector: string): Box[] =>
    Array.from(pane.querySelectorAll(selector), (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left - frame.left, top: r.top - frame.top, width: r.width, height: r.height };
    }).filter((b) => b.width > 0 && b.height > 0);
  const size = { width: frame.width, height: frame.height };
  const selected = unionBox(boxes(SELECTED_SELECTOR));
  if (onRack != null && selected == null) {
    // One that is not on the page has no box, and so no reach.
    const reach = (el: Element | null, foot: boolean): number => {
      const r = el?.getBoundingClientRect();
      if (r == null || r.width <= 0 || r.height <= 0) return 0;
      return Math.max(0, foot ? frame.bottom - r.top : r.bottom - frame.top);
    };
    const camera = cameraOntoRack(from, size, boxes(RACK_SELECTOR), zoom, { top: reach(onRack.top, false), bottom: reach(onRack.foot, true) });
    if (camera != null) return camera;
  }
  const at = aimAt(size, selected, boxes(close ? DEVICE_SELECTOR : THING_SELECTOR));
  return cameraOnto(from, size, at, zoom);
}
