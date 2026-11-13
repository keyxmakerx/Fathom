// Where a device with no rack spot goes on the canvas. A device whose U nobody knows is still a
// whole device (ports, cables, trace, addresses, plans): it stands on the open canvas beside the
// racks as a free box. Anything that makes such a device — an import row with no unit, a device
// added by name in Inventory, a device taken out of its rack — pins it here, so it is drawn and
// its cables have an end to draw to. Pure, no React.

import { BOX_H, BOX_W, moveFree } from '../../document/freeform';
import type { Document } from '../../document/model';
import { viewOf, type ClosetView } from '../../document/view';
import { nextFreeSpot } from '../drawing/freeLayout';
import { RACK_NODE_WIDTH, U_PX } from '../drawing/geometry';
import { closetRightPx } from '../drawing/rows';

type Actor = Parameters<typeof moveFree>[2];

/** `n` open spots for new boxes, each clear of the boxes and labels already there and of the
 * ones before it. With racks or surfaces drawn, the grid starts to their right. */
export function openCanvasSpots(view: Pick<ClosetView, 'free' | 'labels' | 'racks' | 'rows' | 'surfaces'>, n: number): { x: number; y: number }[] {
  const taken = [
    ...view.free.map((f) => ({ x: f.x, y: f.y, w: BOX_W, h: BOX_H })),
    ...view.labels.map((l) => ({ x: l.x, y: l.y, w: l.form === 'area' ? l.w : 64, h: l.form === 'area' ? l.h : 22 })),
  ];
  const right = view.racks.length > 0 || view.surfaces.length > 0 ? closetRightPx(view, RACK_NODE_WIDTH, U_PX) : 0;
  const spots: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i += 1) {
    const spot = right > 0 ? nextFreeSpot(taken, undefined, undefined, { x: right + 96, y: 0 }) : nextFreeSpot(taken);
    spots.push(spot);
    taken.push({ ...spot, w: BOX_W, h: BOX_H });
  }
  return spots;
}

/** The ids of every device that has no rack, shelf or wall AND no spot on the canvas: kept in
 * the design, listed in Inventory, but drawn nowhere. */
export function undrawnDevices(view: Pick<ClosetView, 'unplaced' | 'free'>): string[] {
  const drawn = new Set(view.free.map((f) => f.id));
  return view.unplaced.filter((c) => !drawn.has(c.id)).map((c) => c.id);
}

/** Pins each named chassis at the next open canvas spot. One batch; ids already drawn, or placed in a
 * rack, shelf or wall, are left alone. Returns `doc` itself when there is nothing to pin. */
export function pinOnCanvas(doc: Document, chassisIds: readonly string[], opts?: Actor): Document {
  const view = viewOf(doc, []);
  const want = new Set(undrawnDevices(view));
  const ids = chassisIds.filter((id) => want.has(id));
  if (ids.length === 0) return doc;
  const spots = openCanvasSpots(view, ids.length);
  return moveFree(doc, ids.map((id, i) => ({ id, ...spots[i]! })), opts);
}
