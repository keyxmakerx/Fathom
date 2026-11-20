// Where the camera goes for a pressed question: the devices and cables on its path and the marks that number
// them, whole, between the tool row and whatever floats over the pane's foot.
import { getViewportForBounds } from '@xyflow/react';
import type { Viewport } from '@xyflow/react';

import { FIT_PADDING, paddingClearOf } from '../drawing/geometry';

/** A box in the drawing's own pixels, the ones a node's position is in. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the pane has room for: its size, and how far the tool row reaches over it from the top and the zoom
 * buttons and the small map from the foot. */
export interface PathRoom {
  width: number;
  height: number;
  top: number;
  bottom: number;
}

/** A path is drawn no larger than this: the ceiling Show on a check uses. */
export const PATH_MAX_ZOOM = 1.25;
/** And no smaller than this. A path is better seen whole than cut at both ends, so it may go a little under the
 * zoom a first view stops at (`READABLE_ZOOM`); its marks keep their size on the screen, and wait below this. */
export const PATH_MIN_ZOOM = 0.5;

/** The smallest box round them all, or null for none. */
export function around(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The camera that shows `path` whole in `room`, as large as it goes up to `PATH_MAX_ZOOM`. A path too large to
 * show whole at `PATH_MIN_ZOOM` is shown at that zoom, its middle in the middle. */
export function pathCamera(path: Box, room: PathRoom): Viewport {
  // A box with no size (one device, read as a point) still needs something to divide by.
  const box = { ...path, width: Math.max(path.width, 1), height: Math.max(path.height, 1) };
  const pane = { width: room.width, height: room.height };
  const sides = paddingClearOf({ top: room.top, bottom: room.bottom, corner: null }, box, pane, PATH_MAX_ZOOM);
  return getViewportForBounds(box, room.width, room.height, PATH_MIN_ZOOM, PATH_MAX_ZOOM, sides ?? FIT_PADDING);
}

/** The same view, to the pixel: a camera nobody has moved since it was set. */
export function sameCamera(a: Viewport, b: Viewport): boolean {
  return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.zoom - b.zoom) <= 0.001;
}
