/** A switch's port strip on the Diagram look (sign-off r109, item 4, borrowed from homelab-diagram's
 * grammar). A switch's box shows its data ports as a row of small cells along its bottom edge, in the
 * order its faceplate numbers them, and each cable leaves the box from its own port rather than from
 * the box edge. Two rows, staggered by half a cell, once there are more than STRIP_ONE_ROW ports, the
 * way a real switch puts odd ports over even ones.
 *
 * Pure: the view in, cell positions out. The box draws the cells and the router starts each line at
 * its cell, from the same numbers, so a line always meets the port it says. */

import type { ClosetView, PortView } from '../../document/view';
import type { FixtureView } from '../../document/view';
import { BOX_H, BOX_W } from './diagram';
import { isPowerConnector } from './power';

/** Up to this many ports go in one row; more take two. */
export const STRIP_ONE_ROW = 16;
/** The strip keeps this far in from the box's sides, and sits this far above its bottom edge. */
const SIDE_PAD = 8;
const BOTTOM_PAD = 4;
/** A cell is at most this wide, and this tall. */
const CELL_MAX_W = 11;
const CELL_H = 7;
const ROW_GAP = 2;
/** A cell this wide or wider has room for its port's number. */
export const CELL_LABEL_W = 10;

export interface StripCell {
  portId: string;
  label: string;
  /** From the box's top left corner. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Where its line leaves: the bottom edge of the box, under the cell's middle. */
  exitX: number;
  cabled: boolean;
}

/** The roles that show a strip. */
export function hasStrip(role: string | null | undefined): boolean {
  return role === 'switch';
}

/** The ports that go on the strip: data ports, not power or console, in faceplate order. */
export function stripPorts(ports: readonly PortView[]): PortView[] {
  return ports
    .filter((p) => p.service !== 'power' && p.service !== 'console' && p.role !== 'console' && !isPowerConnector(p.connector) && p.face !== 'rear')
    .sort((a, b) => a.column - b.column || a.row - b.row);
}

/** The cells for a box's strip, left to right; empty when there are no data ports. */
export function portStrip(ports: readonly PortView[], boxW = BOX_W, boxH = BOX_H): StripCell[] {
  const list = stripPorts(ports);
  if (list.length === 0) return [];
  const two = list.length > STRIP_ONE_ROW;
  const cols = two ? Math.ceil(list.length / 2) : list.length;
  // Two staggered rows need half a cell more room.
  const room = boxW - 2 * SIDE_PAD;
  const pitch = Math.min(CELL_MAX_W + 1, room / (cols + (two ? 0.5 : 0)));
  const w = Math.max(2, pitch - 1);
  const width = pitch * (cols + (two ? 0.5 : 0)) - 1;
  const x0 = (boxW - width) / 2;
  const bottomY = boxH - BOTTOM_PAD - CELL_H;
  return list.map((p, i) => {
    // Two rows: odd-numbered positions on top, even below, the second row half a cell along.
    const row = two ? i % 2 : 0;
    const col = two ? Math.floor(i / 2) : i;
    const x = x0 + col * pitch + (two && row === 1 ? pitch / 2 : 0);
    const y = two && row === 0 ? bottomY - CELL_H - ROW_GAP : bottomY;
    return { portId: p.id, label: p.label, x, y, w, h: CELL_H, exitX: x + w / 2, cabled: p.cable != null };
  });
}

/** Every device's ports in the view, by chassis id, wherever the device sits. */
export function portsByChassis(view: ClosetView): Map<string, PortView[]> {
  const out = new Map<string, PortView[]>();
  for (const rack of view.racks) {
    for (const c of rack.chassis) out.set(c.id, c.ports);
    for (const s of rack.shelves ?? []) for (const o of s.occupants) if (o.kind === 'chassis') out.set(o.id, o.ports);
  }
  const fixtures = (list: readonly FixtureView[]) => {
    for (const f of list) {
      if (f.kind === 'chassis') out.set(f.id, f.ports);
      fixtures(f.fixtures ?? []);
    }
  };
  for (const s of view.surfaces ?? []) fixtures(s.fixtures ?? []);
  for (const c of view.unplaced ?? []) if (!out.has(c.id)) out.set(c.id, c.ports);
  return out;
}

/** The strip of every switch box, by box id: each port's cell. */
export function diagramStrips(view: ClosetView, boxes: ReadonlyArray<{ id: string; role: string | null; w: number; h: number }>): Map<string, StripCell[]> {
  const ports = portsByChassis(view);
  const out = new Map<string, StripCell[]>();
  for (const b of boxes) {
    if (!hasStrip(b.role)) continue;
    const cells = portStrip(ports.get(b.id) ?? [], b.w, b.h);
    if (cells.length > 0) out.set(b.id, cells);
  }
  return out;
}
