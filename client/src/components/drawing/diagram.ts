/** The Diagram look (ADR-0061 round 7): every rack chassis is a plain labelled
 * box, one column per rack, and every cable is a square-cornered line between
 * boxes. Pure: the view in, boxes and paths out. */

import type { CableView, ClosetView } from './contract';

export const BOX_W = 200;
export const BOX_H = 64;
export const COLUMN_PITCH = 420;
export const ROW_PITCH = 150;
/** Parallel cables between one pair sit this far apart. */
export const LANE_PX = 8;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiagramBox extends Rect {
  id: string;
  hostname: string;
  rackLabel: string | null;
}

/** One column per rack in the view's order, each rack's devices from its top unit down. */
export function layoutDiagram(view: ClosetView): DiagramBox[] {
  const boxes: DiagramBox[] = [];
  view.racks.forEach((rack, col) => {
    const ordered = [...rack.chassis].sort((a, b) => b.positionU - a.positionU || a.id.localeCompare(b.id));
    ordered.forEach((c, row) => {
      boxes.push({ id: c.id, hostname: c.hostname, rackLabel: rack.label, x: col * COLUMN_PITCH, y: row * ROW_PITCH, w: BOX_W, h: BOX_H });
    });
  });
  return boxes;
}

export interface Route {
  d: string;
  /** Where the line meets each box, and the unit direction it leaves along. */
  a: { x: number; y: number; dx: number; dy: number };
  b: { x: number; y: number; dx: number; dy: number };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A square-cornered route from `ra` to `rb`: straight when the boxes overlap
 * on an axis, otherwise out sideways, across and in. `lane` shifts it off the
 * centre so cables between the same pair do not lie on one another. */
export function orthRoute(ra: Rect, rb: Rect, lane = 0): Route {
  const ox0 = Math.max(ra.x, rb.x);
  const ox1 = Math.min(ra.x + ra.w, rb.x + rb.w);
  if (ox1 - ox0 > 8) {
    const x = clamp((ox0 + ox1) / 2 + lane, ox0 + 4, ox1 - 4);
    const down = ra.y < rb.y;
    const ya = down ? ra.y + ra.h : ra.y;
    const yb = down ? rb.y : rb.y + rb.h;
    const s = down ? 1 : -1;
    return { d: `M ${x} ${ya} L ${x} ${yb}`, a: { x, y: ya, dx: 0, dy: s }, b: { x, y: yb, dx: 0, dy: -s } };
  }
  const oy0 = Math.max(ra.y, rb.y);
  const oy1 = Math.min(ra.y + ra.h, rb.y + rb.h);
  if (oy1 - oy0 > 8) {
    const y = clamp((oy0 + oy1) / 2 + lane, oy0 + 4, oy1 - 4);
    const right = ra.x < rb.x;
    const xa = right ? ra.x + ra.w : ra.x;
    const xb = right ? rb.x : rb.x + rb.w;
    const s = right ? 1 : -1;
    return { d: `M ${xa} ${y} L ${xb} ${y}`, a: { x: xa, y, dx: s, dy: 0 }, b: { x: xb, y, dx: -s, dy: 0 } };
  }
  const right = ra.x < rb.x;
  const xa = right ? ra.x + ra.w : ra.x;
  const xb = right ? rb.x : rb.x + rb.w;
  const ya = ra.y + ra.h / 2 + lane;
  const yb = rb.y + rb.h / 2 + lane;
  const mid = (xa + xb) / 2 + lane;
  const s = right ? 1 : -1;
  return { d: `M ${xa} ${ya} L ${mid} ${ya} L ${mid} ${yb} L ${xb} ${yb}`, a: { x: xa, y: ya, dx: s, dy: 0 }, b: { x: xb, y: yb, dx: -s, dy: 0 } };
}

export interface DiagramLine {
  cable: CableView;
  a: string;
  b: string;
  /** Slot among the cables joining the same two boxes, centred on zero. */
  lane: number;
}

/** One line per cable with both ends on drawn boxes; a loop back to its own box is not drawn. */
export function diagramLines(view: ClosetView, boxIds: ReadonlySet<string>): DiagramLine[] {
  const pairs = new Map<string, CableView[]>();
  const ends = new Map<string, [string, string]>();
  for (const cable of view.cables) {
    const real = cable.ends.filter((e): e is { portId: string; chassisId: string; rackId: string | null } => 'portId' in e);
    if (real.length !== 2) continue;
    const [a, b] = [real[0]!.chassisId, real[1]!.chassisId];
    if (a === b || !boxIds.has(a) || !boxIds.has(b)) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    pairs.set(key, [...(pairs.get(key) ?? []), cable]);
    ends.set(cable.id, [a, b]);
  }
  const out: DiagramLine[] = [];
  for (const cables of pairs.values()) {
    cables.forEach((cable, i) => {
      const [a, b] = ends.get(cable.id)!;
      out.push({ cable, a, b, lane: (i - (cables.length - 1) / 2) * LANE_PX });
    });
  }
  return out;
}
