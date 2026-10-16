/** Which cable the pointer means where several cross (round 15, signed off 2026-10-10): the
 * nearest line wins, Tab moves to the next one under the pointer, and the one picked draws on
 * top while the rest dim. Each drawn cable registers its line here; the picking is pure. */

import type { LiveStore } from './liveStore';
import type { Pt } from './cableRoute';

/** Half the cable's invisible hit stroke (`CableEdge.tsx`), in flow pixels. */
export const CABLE_HIT_RADIUS_PX = 6;

export interface CableShape {
  points: readonly Pt[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function shapeOf(points: readonly Pt[]): CableShape {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { points, minX, minY, maxX, maxY };
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

export function distanceTo(p: Pt, shape: CableShape): number {
  const pts = shape.points;
  if (pts.length === 1) return Math.hypot(p.x - pts[0]!.x, p.y - pts[0]!.y);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, distToSegment(p, pts[i - 1]!, pts[i]!));
  return best;
}

/** Every cable within `radius` of the point, nearest first; equal distances in id order, so the
 * answer never depends on drawing order. */
export function cablesUnder(shapes: ReadonlyMap<string, CableShape>, p: Pt, radius = CABLE_HIT_RADIUS_PX): string[] {
  const hits: { id: string; d: number }[] = [];
  for (const [id, s] of shapes) {
    if (p.x < s.minX - radius || p.x > s.maxX + radius || p.y < s.minY - radius || p.y > s.maxY + radius) continue;
    const d = distanceTo(p, s);
    if (d <= radius) hits.push({ id, d });
  }
  hits.sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hits.map((h) => h.id);
}

/** The cable to light after the pointer moves: the nearest, unless the person has already Tabbed
 * to another that is still under the pointer, in which case their pick stays. */
export function pickAfterMove(stack: readonly string[], previous: string | null, previousStack: readonly string[]): string | null {
  if (stack.length === 0) return null;
  const sameCrossing = previous != null && stack.includes(previous) && sameMembers(stack, previousStack);
  return sameCrossing ? previous : stack[0]!;
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** Tab: the next cable under the pointer, wrapping; Shift+Tab goes back. */
export function cycle(stack: readonly string[], current: string | null, back = false): string | null {
  if (stack.length === 0) return null;
  const at = current == null ? -1 : stack.indexOf(current);
  if (at < 0) return stack[0]!;
  const n = stack.length;
  return stack[(at + (back ? n - 1 : 1)) % n]!;
}

const registries = new WeakMap<LiveStore, Map<string, CableShape>>();

/** The drawn cables' lines for one drawing. */
export function cableShapes(store: LiveStore): Map<string, CableShape> {
  let map = registries.get(store);
  if (map == null) {
    map = new Map();
    registries.set(store, map);
  }
  return map;
}

/** The pointer moved over cables at `p` (flow space): work out the stack and the pick, and write
 * both to the store. */
export function hoverCablesAt(store: LiveStore, p: Pt): void {
  const stack = cablesUnder(cableShapes(store), p);
  const s = store.getState();
  const pick = pickAfterMove(stack, s.hoveredCableId, s.hoverStack);
  if (pick === s.hoveredCableId && sameMembers(stack, s.hoverStack)) return;
  store.setState({ hoveredCableId: pick, hoverStack: stack });
}
