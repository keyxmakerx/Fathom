/** Where a cable meets its ports, and how it leaves them: out of the port's
 * own top or bottom edge, toward the other end. Pure. */

import { CABLE_SAG_MAX_PX, cubicPath, laneBiasPx, type Cubic } from './geometry';
import type { CableKind } from './contract';

/** A port's box in flow space. */
export interface PortPoint {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0 top row, 1 bottom row; absent or -1 when the port has no row. */
  row?: number;
}

export interface Lead {
  x: number;
  y: number;
  /** +1 leaves downward, -1 upward. */
  dir: 1 | -1;
}

export interface Leads {
  a: Lead;
  b: Lead;
}

/** A port in a top row leaves upward and one in a bottom row downward, so a
 * cable never crosses the row beside it; a lone port leaves toward the other
 * end. A missing box (a tray, a shelf, an inlet) keeps the point React Flow gave. */
export function leadsFor(
  a: PortPoint | null,
  b: PortPoint | null,
  fallbackA: { x: number; y: number },
  fallbackB: { x: number; y: number },
): Leads {
  const ay = a != null ? a.y + a.h / 2 : fallbackA.y;
  const by = b != null ? b.y + b.h / 2 : fallbackB.y;
  const down = by - ay > 1;
  const up = ay - by > 1;
  const byRow = (box: PortPoint | null): 1 | -1 | null => (box?.row === 0 ? -1 : box?.row === 1 ? 1 : null);
  const da: 1 | -1 = byRow(a) ?? (up ? -1 : 1);
  const db: 1 | -1 = byRow(b) ?? (down ? -1 : 1);
  const point = (box: PortPoint | null, fb: { x: number; y: number }, dir: 1 | -1): Lead =>
    box != null ? { x: box.x + box.w / 2, y: dir === 1 ? box.y + box.h : box.y, dir } : { x: fb.x, y: fb.y, dir };
  return { a: point(a, fallbackA, da), b: point(b, fallbackB, db) };
}

/** A cable leaves each port straight along its edge's normal, then curves
 * to the other; a power lead keeps its own lane to the side. */
export function cableLeadPath(l: Leads, kind: CableKind = 'copper'): string {
  return cubicPath(cableLeadCubic(l, kind));
}

/** How far a long cable's slack reaches out of each port. Past `CABLE_SAG_MAX_PX` a run between
 * places drapes rather than cutting across the drawing in a straight line; still capped. */
export const CABLE_DRAPE_MAX_PX = 220;

/** `cableLeadPath`'s curve as points. A short hop bows by its height as before; a long run, across
 * as well as down, drapes out of each port by about a third of its length, so it leaves and
 * meets its ports square and swings between them instead of slicing across at an angle. An end
 * whose port faces away from the other end (a top-row port to a device below) keeps the short
 * bow, so it turns back at once rather than looping over the devices beside it. */
export function cableLeadCubic(l: Leads, kind: CableKind = 'copper'): Cubic {
  const run = Math.abs(l.b.y - l.a.y);
  const span = Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y);
  const bow = Math.min(CABLE_SAG_MAX_PX, Math.max(8, run * 0.4));
  const drape = Math.max(bow, Math.min(CABLE_DRAPE_MAX_PX, span * 0.32));
  const reachA = (l.b.y - l.a.y) * l.a.dir > 0 ? drape : bow;
  const reachB = (l.a.y - l.b.y) * l.b.dir > 0 ? drape : bow;
  const lane = laneBiasPx(kind) * 0.25;
  return {
    p0: { x: l.a.x, y: l.a.y },
    c1: { x: l.a.x + lane, y: l.a.y + l.a.dir * reachA },
    c2: { x: l.b.x + lane, y: l.b.y + l.b.dir * reachB },
    p3: { x: l.b.x, y: l.b.y },
  };
}

export interface LabelItem {
  key: string;
  x: number;
  y: number;
  dir: 1 | -1;
  text: string;
}

export interface PlacedLabel {
  dx: number;
  dy: number;
}

/** Offsets for port labels so none overlaps another: labels sharing a row of
 * the drawing and a side are packed left to right, and one that would touch
 * its neighbour steps one line further out. `fontPx` is the label size in flow px. */
export function placeLabels(items: readonly LabelItem[], fontPx: number): Map<string, PlacedLabel> {
  const out = new Map<string, PlacedLabel>();
  const groups = new Map<string, LabelItem[]>();
  for (const item of items) {
    const key = `${Math.round(item.y / 4)}|${item.dir}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const charW = fontPx * 0.62;
  for (const members of groups.values()) {
    const rights: number[] = [];
    for (const item of [...members].sort((p, q) => p.x - q.x)) {
      const w = item.text.length * charW + fontPx * 0.5;
      const left = item.x - w / 2;
      let level = rights.findIndex((r) => r <= left);
      if (level === -1) level = rights.length;
      rights[level] = left + w;
      out.set(item.key, { dx: 0, dy: item.dir * (fontPx * 0.9 + level * (fontPx + 1.5)) });
    }
  }
  return out;
}
