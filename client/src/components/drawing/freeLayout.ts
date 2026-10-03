// The geometry of the free layer (ADR-0060 step 7): boxes, labels and areas on the canvas.
// Pure, no React. Positions are top-left corners in flow space.

import { BOX_H, BOX_W, GRID, snap } from '../../document/freeform';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Side = 't' | 'r' | 'b' | 'l';
export type AlignMode = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom';

export { BOX_H, BOX_W, GRID, snap };

/** Flow node ids: one namespace per kind, like `nodeId.ts`. */
export const freeNodeId = (chassisId: string): string => `free:${chassisId}`;
export const labelNodeId = (labelId: string): string => `label:${labelId}`;
export const lineEdgeId = (lineId: string): string => `line:${lineId}`;

export function parseFreeNodeId(nodeId: string): { kind: 'box' | 'label'; id: string } | null {
  if (nodeId.startsWith('free:')) return { kind: 'box', id: nodeId.slice(5) };
  if (nodeId.startsWith('label:')) return { kind: 'label', id: nodeId.slice(6) };
  return null;
}

/** The kinds a new box can be, in menu order; `role` is `Device.role`. */
export const BOX_KINDS: readonly { label: string; role: string | null }[] = [
  { label: 'Switch', role: 'switch' },
  { label: 'Router', role: 'router' },
  { label: 'Firewall', role: 'firewall' },
  { label: 'Server', role: 'server' },
  { label: 'Access point', role: 'access_point' },
  { label: 'Any device', role: null },
];

const ROLE_CODES: Readonly<Record<string, string>> = {
  router: 'RTR',
  switch: 'SW',
  firewall: 'FW',
  load_balancer: 'LB',
  server: 'SRV',
  access_point: 'AP',
};

export function roleCode(role: string | null): string {
  return (role !== null && ROLE_CODES[role]) || 'DEV';
}

/** A text label's size before it has been measured. */
export function estimateLabelSize(text: string): { w: number; h: number } {
  return { w: Math.max(32, text.length * 7 + 12), h: 22 };
}

export const centreOf = (r: Rect): { x: number; y: number } => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export function boundsOf(rects: readonly Rect[]): Rect {
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

export const containsPoint = (r: Rect, p: { x: number; y: number }): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

export function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

// ---------------------------------------------------------------------------
// Lines

export function sidePoint(r: Rect, side: Side): { x: number; y: number } {
  switch (side) {
    case 't':
      return { x: r.x + r.w / 2, y: r.y };
    case 'b':
      return { x: r.x + r.w / 2, y: r.y + r.h };
    case 'l':
      return { x: r.x, y: r.y + r.h / 2 };
    case 'r':
      return { x: r.x + r.w, y: r.y + r.h / 2 };
  }
}

/** Which sides of two boxes a line between them leaves and enters, by the way they face. */
export function lineSides(a: Rect, b: Rect): { a: Side; b: Side } {
  const ca = centreOf(a);
  const cb = centreOf(b);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  if (Math.abs(dx) * a.h >= Math.abs(dy) * a.w) return dx >= 0 ? { a: 'r', b: 'l' } : { a: 'l', b: 'r' };
  return dy >= 0 ? { a: 'b', b: 't' } : { a: 't', b: 'b' };
}

/** Where the ghost of a new box goes when its square on `side` of `from` is clicked. */
export function ghostSpot(from: Rect, side: Side, gap = 48): { x: number; y: number } {
  switch (side) {
    case 'r':
      return { x: snap(from.x + from.w + gap), y: from.y };
    case 'l':
      return { x: snap(from.x - gap - BOX_W), y: from.y };
    case 'b':
      return { x: from.x, y: snap(from.y + from.h + gap) };
    case 't':
      return { x: from.x, y: snap(from.y - gap - BOX_H) };
  }
}

// ---------------------------------------------------------------------------
// Align, spread, group

/** New top-left corners, in the order given, that line `rects` up. */
export function alignRects(rects: readonly Rect[], mode: AlignMode): { x: number; y: number }[] {
  const b = boundsOf(rects);
  return rects.map((r) => {
    switch (mode) {
      case 'left':
        return { x: b.x, y: r.y };
      case 'right':
        return { x: b.x + b.w - r.w, y: r.y };
      case 'centre':
        return { x: b.x + (b.w - r.w) / 2, y: r.y };
      case 'top':
        return { x: r.x, y: b.y };
      case 'bottom':
        return { x: r.x, y: b.y + b.h - r.h };
      case 'middle':
        return { x: r.x, y: b.y + (b.h - r.h) / 2 };
    }
  });
}

/** New top-left corners that give the gaps between `rects` along `axis` the same size; the two
 * outermost stay where they are. Needs three or more; fewer come back unchanged. */
export function spreadRects(rects: readonly Rect[], axis: 'x' | 'y'): { x: number; y: number }[] {
  const out = rects.map((r) => ({ x: r.x, y: r.y }));
  if (rects.length < 3) return out;
  const size = axis === 'x' ? 'w' : 'h';
  const order = rects.map((_, i) => i).sort((i, j) => rects[i]![axis] - rects[j]![axis]);
  const first = rects[order[0]!]!;
  const last = rects[order[order.length - 1]!]!;
  const span = last[axis] + last[size] - first[axis];
  const total = order.reduce((n, i) => n + rects[i]![size], 0);
  const gap = (span - total) / (order.length - 1);
  let at = first[axis];
  for (const i of order) {
    out[i]![axis] = at;
    at += rects[i]![size] + gap;
  }
  return out;
}

/** The rectangle an area drawn around `rects` takes, with room for its label. */
export function groupRect(rects: readonly Rect[], pad = 24): Rect {
  const b = boundsOf(rects);
  return { x: snap(b.x - pad), y: snap(b.y - pad - 16), w: Math.ceil((b.w + pad * 2) / GRID) * GRID, h: Math.ceil((b.h + pad * 2 + 16) / GRID) * GRID };
}

// ---------------------------------------------------------------------------
// Guides

export interface Guides {
  /** The offset that snaps the moving rectangle onto the nearest guide, per axis. */
  dx: number;
  dy: number;
  /** Vertical lines at these x (with their y extent) and horizontal lines at these y (x extent). */
  v: { x: number; y1: number; y2: number }[];
  h: { y: number; x1: number; x2: number }[];
}

/** Alignment guides for `moving` against `others`: where an edge or the middle lines up within
 * `threshold` flow units, the snap that makes it exact and the dotted lines to draw. */
export function guidesFor(moving: Rect, others: readonly Rect[], threshold: number): Guides {
  const xsOf = (r: Rect) => [r.x, r.x + r.w / 2, r.x + r.w];
  const ysOf = (r: Rect) => [r.y, r.y + r.h / 2, r.y + r.h];
  let dx = 0;
  let dy = 0;
  let bestX = threshold + 1;
  let bestY = threshold + 1;
  for (const o of others) {
    for (const a of xsOf(moving)) for (const b of xsOf(o)) if (Math.abs(b - a) < bestX) ((bestX = Math.abs(b - a)), (dx = b - a));
    for (const a of ysOf(moving)) for (const b of ysOf(o)) if (Math.abs(b - a) < bestY) ((bestY = Math.abs(b - a)), (dy = b - a));
  }
  if (bestX > threshold) dx = 0;
  if (bestY > threshold) dy = 0;
  const snapped: Rect = { ...moving, x: moving.x + dx, y: moving.y + dy };
  const v: Guides['v'] = [];
  const h: Guides['h'] = [];
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.5;
  for (const o of others) {
    for (const a of xsOf(snapped)) {
      if (xsOf(o).some((b) => near(a, b))) v.push({ x: a, y1: Math.min(snapped.y, o.y), y2: Math.max(snapped.y + snapped.h, o.y + o.h) });
    }
    for (const a of ysOf(snapped)) {
      if (ysOf(o).some((b) => near(a, b))) h.push({ y: a, x1: Math.min(snapped.x, o.x), x2: Math.max(snapped.x + snapped.w, o.x + o.w) });
    }
  }
  return { dx: bestX <= threshold ? dx : 0, dy: bestY <= threshold ? dy : 0, v, h };
}

// ---------------------------------------------------------------------------
// Placing

/** The first spot on a grid of box-sized cells, row by row, that overlaps none of `taken`. */
export function nextFreeSpot(taken: readonly Rect[], cols = 4, gap = 32, origin = { x: 40, y: 40 }): { x: number; y: number } {
  for (let i = 0; i < 400; i += 1) {
    const cell: Rect = { x: origin.x + (i % cols) * (BOX_W + gap), y: origin.y + Math.floor(i / cols) * (BOX_H + gap), w: BOX_W, h: BOX_H };
    if (!taken.some((t) => overlaps(cell, t))) return { x: cell.x, y: cell.y };
  }
  return origin;
}
