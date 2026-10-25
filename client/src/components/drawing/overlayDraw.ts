/** Where the VPNs layer draws (sign-off r16-overlay): a VPN of three or more drawn members is one
 * badge beside them with a dashed spoke to each; a VPN of two is one dashed arc between them, its
 * name at the arc's top. Both stand off the cables' own straight runs, so a VPN never reads as a
 * cable. A member with no box on the canvas is counted on the badge but gets no spoke. Pure. */

import type { OverlayView } from '../../document/overlays';
import type { Rect } from './diagram';

export interface Point {
  x: number;
  y: number;
}

export interface OverlaySpoke {
  deviceId: string;
  a: Point;
  b: Point;
  /** A two-member line's bend: a quadratic curve through this control point. */
  c?: Point;
}

export interface OverlayShape {
  id: string;
  /** Which of the layer's colours, by the VPN's place in the list. */
  tone: number;
  /** A badge's centre, or null for a two-member line. */
  hub: Point | null;
  spokes: OverlaySpoke[];
  /** Where the line's name sits, for a two-member line. */
  mid: Point | null;
  /** Members with a box on the canvas. */
  drawn: number;
}

export const HUB_W = 112;
export const HUB_H = 36;
export const OVERLAY_TONES = 4;

const centre = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Where the segment from `r`'s centre toward `p` leaves `r`, so a spoke stops at the box's edge. */
export function edgePoint(r: Rect, p: Point): Point {
  const c = centre(r);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const sx = dx === 0 ? Infinity : r.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : r.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy, 1);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** How far beside its members a badge stands. */
export const HUB_GAP = 120;

/** A badge's spot: right of its members at their middle height, pushed down until it sits on no
 * box and no earlier badge. */
function placeHub(members: readonly Rect[], boxes: readonly Rect[], taken: Rect[]): Point {
  const right = Math.max(...members.map((r) => r.x + r.w));
  const at = { x: right + HUB_GAP + HUB_W / 2, y: members.reduce((s, r) => s + r.y + r.h / 2, 0) / members.length };
  for (let i = 0; i < 40; i += 1) {
    const r = { x: at.x - HUB_W / 2 - 8, y: at.y - HUB_H / 2 - 8, w: HUB_W + 16, h: HUB_H + 16 };
    const hit = [...boxes, ...taken].find((b) => overlaps(r, b));
    if (hit == null) break;
    at.y = hit.y + hit.h + HUB_H / 2 + 12;
  }
  taken.push({ x: at.x - HUB_W / 2, y: at.y - HUB_H / 2, w: HUB_W, h: HUB_H });
  return at;
}

export function overlayShapes(overlays: readonly OverlayView[], boxes: readonly (Rect & { id: string })[]): OverlayShape[] {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const taken: Rect[] = [];
  const out: OverlayShape[] = [];
  overlays.forEach((o, index) => {
    const placed = o.members
      .map((m) => ({ deviceId: m.deviceId, box: m.chassisIds.map((c) => byId.get(c)).find((b) => b != null) }))
      .filter((m): m is { deviceId: string; box: Rect & { id: string } } => m.box != null);
    const tone = index % OVERLAY_TONES;
    if (placed.length === 0) return;
    if (o.members.length === 2 && placed.length === 2) {
      const [p, q] = placed;
      const pc = centre(p.box);
      const qc = centre(q.box);
      // Bow out by a third of the line's length (at least 80): to the left, away from the badges
      // on the right, or up when the two sit side by side.
      const len = Math.hypot(qc.x - pc.x, qc.y - pc.y) || 1;
      const bow = Math.max(80, len / 3) + 40 * Math.floor(index / OVERLAY_TONES);
      let n = { x: (qc.y - pc.y) / len, y: -(qc.x - pc.x) / len };
      if (n.x > 0 || (n.x === 0 && n.y > 0)) n = { x: -n.x, y: -n.y };
      const c = { x: (pc.x + qc.x) / 2 + n.x * bow, y: (pc.y + qc.y) / 2 + n.y * bow };
      const a = edgePoint(p.box, c);
      const b = edgePoint(q.box, c);
      const mid = { x: 0.25 * a.x + 0.5 * c.x + 0.25 * b.x, y: 0.25 * a.y + 0.5 * c.y + 0.25 * b.y };
      out.push({ id: o.id, tone, hub: null, spokes: [{ deviceId: p.deviceId, a, b, c }], mid, drawn: 2 });
      return;
    }
    const hub = placeHub(placed.map((m) => m.box), boxes, taken);
    const hubRect = { x: hub.x - HUB_W / 2, y: hub.y - HUB_H / 2, w: HUB_W, h: HUB_H };
    const spokes = placed.map((m) => ({ deviceId: m.deviceId, a: edgePoint(hubRect, centre(m.box)), b: edgePoint(m.box, hub) }));
    out.push({ id: o.id, tone, hub, spokes, mid: null, drawn: placed.length });
  });
  return out;
}
