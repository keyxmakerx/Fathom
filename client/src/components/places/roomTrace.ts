// Tracing a room over a floor plan (ADR-0051 "Blueprints": "trace with snapping", straight-line and
// right-angle). Pure: every point is in millimetres on the floor, and every tolerance is given in
// millimetres by the caller, who knows how many a screen pixel is.

import type { Point } from '../../document/rooms';

/** A wall within this many degrees of square to the last one is made square. */
export const SQUARE_WITHIN_DEG = 10;

const dist = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * Where a click at `p` lands. In order: on an existing corner within `tolMm` (rooms that share a
 * wall share its corners); else, from the last corner, square to the last wall (or to the plan's
 * axes for the first wall) when within `SQUARE_WITHIN_DEG`; else where it was clicked. Rounded to
 * whole millimetres, which is what the graph holds.
 */
export function snapPoint(draft: readonly Point[], p: Point, corners: readonly Point[], tolMm: number): Point {
  const near = corners.find((c) => dist(c, p) <= tolMm);
  if (near) return { x: Math.round(near.x), y: Math.round(near.y) };
  const last = draft[draft.length - 1];
  if (!last) return { x: Math.round(p.x), y: Math.round(p.y) };
  const before = draft[draft.length - 2];
  const base = before ? Math.atan2(last.y - before.y, last.x - before.x) : 0;
  const len = dist(last, p);
  if (len === 0) return { x: Math.round(last.x), y: Math.round(last.y) };
  const angle = Math.atan2(p.y - last.y, p.x - last.x) - base;
  const quarter = Math.PI / 2;
  const nearest = Math.round(angle / quarter) * quarter;
  if (Math.abs(angle - nearest) > (SQUARE_WITHIN_DEG * Math.PI) / 180) return { x: Math.round(p.x), y: Math.round(p.y) };
  const along = base + nearest;
  // Keep the length the pointer gave along the squared direction.
  const projected = len * Math.cos(angle - nearest);
  return { x: Math.round(last.x + projected * Math.cos(along)), y: Math.round(last.y + projected * Math.sin(along)) };
}

/** A click near the first corner closes the room once it has three. */
export function closesRoom(draft: readonly Point[], p: Point, tolMm: number): boolean {
  return draft.length >= 3 && dist(draft[0]!, p) <= tolMm;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The floor's extent: the picture's and every room's, with a margin; a 20 m by 12 m floor when
 * there is nothing yet. */
export function floorBox(points: readonly Point[], picture: Box | null): Box {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  if (picture) {
    xs.push(picture.x, picture.x + picture.w);
    ys.push(picture.y, picture.y + picture.h);
  }
  if (xs.length === 0) return { x: 0, y: 0, w: 20_000, h: 12_000 };
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const w = Math.max(Math.max(...xs) - x0, 1000);
  const h = Math.max(Math.max(...ys) - y0, 1000);
  const m = Math.max(w, h) * 0.04;
  return { x: x0 - m, y: y0 - m, w: w + 2 * m, h: h + 2 * m };
}

/** Where a room's name goes: the middle of its corners. */
export function labelAt(corners: readonly Point[]): Point {
  const n = corners.length || 1;
  return { x: corners.reduce((s, c) => s + c.x, 0) / n, y: corners.reduce((s, c) => s + c.y, 0) / n };
}

/** "4.2 m" or "850 mm", for a wall being drawn. */
export function lengthWords(mm: number): string {
  return mm >= 1000 ? `${(mm / 1000).toFixed(mm >= 10_000 ? 1 : 2).replace(/\.?0+$/, '')} m` : `${Math.round(mm)} mm`;
}

/** Metres as typed ("4.2", "4,2 m", "4200 mm") to millimetres, or `null`. */
export function readDistance(typed: string): number | null {
  const t = typed.trim().toLowerCase().replace(',', '.');
  const m = /^(\d+(?:\.\d+)?)\s*(mm|cm|m)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const mm = m[2] === 'mm' ? n : m[2] === 'cm' ? n * 10 : n * 1000;
  return mm > 0 ? mm : null;
}
