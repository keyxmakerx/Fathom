/** The shapes behind the four cable styles (`cableStyle.ts`). Pure: every function here takes
 * points and returns points or path text, so each shape is tested without a canvas. */

import type { Leads, Lead } from './cableEnds';
import type { CableKind } from './contract';
import type { Cubic } from './geometry';

export interface Pt {
  x: number;
  y: number;
}

/** How far a square or tied cable runs straight out of its port before its first corner. */
export const SQUARE_LEAD_PX = 14;
/** The gap between two cables running side by side in a tied bundle. */
export const TIED_PITCH_PX = 4;
/** "About an inch shows at each end" of a faded cable, in flow pixels. */
export const FADE_STUB_PX = 32;

/** A small, steady sideways step from a cable's id, so two right-angle cables sharing a run sit
 * beside each other rather than on one line. */
export function laneOffsetPx(id: string, kind: CableKind): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const step = ((h % 5) - 2) * 3;
  // Power keeps its own lane, as in the other styles.
  return kind === 'power' ? step - 6 : step;
}

/** Plain points, with repeats and straight-through corners dropped. */
function dedupe(points: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const { x, y } of points) {
    const last = out[out.length - 1];
    if (last != null && Math.abs(last.x - x) <= 0.01 && Math.abs(last.y - y) <= 0.01) continue;
    const before = out[out.length - 2];
    if (before != null && last != null && ((before.x === last.x && last.x === x) || (before.y === last.y && last.y === y))) out.pop();
    out.push({ x, y });
  }
  return out;
}

export function polylinePath(points: readonly Pt[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${round(p.x)} ${round(p.y)}`).join(' ');
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Right-angle: straight out of each port, square corners, one horizontal run between. A port
 * facing away from the other end takes two corners round it. */
export function squarePoints(l: Leads, lane = 0): Pt[] {
  const { a, b } = l;
  const facing = (a.dir === 1 && b.dir === -1 && b.y - a.y >= 2 * SQUARE_LEAD_PX) || (a.dir === -1 && b.dir === 1 && a.y - b.y >= 2 * SQUARE_LEAD_PX);
  if (facing) {
    const mid = (a.y + b.y) / 2 + lane;
    return dedupe([a, { x: a.x, y: mid }, { x: b.x, y: mid }, b]);
  }
  if (a.dir === b.dir) {
    const y = a.dir === 1 ? Math.max(a.y, b.y) + SQUARE_LEAD_PX + Math.abs(lane) : Math.min(a.y, b.y) - SQUARE_LEAD_PX - Math.abs(lane);
    return dedupe([a, { x: a.x, y }, { x: b.x, y }, b]);
  }
  // Facing apart, or too close to meet: out of each port, then across between them.
  const ya = a.y + a.dir * SQUARE_LEAD_PX;
  const yb = b.y + b.dir * SQUARE_LEAD_PX;
  const mx = (a.x + b.x) / 2 + lane;
  return dedupe([a, { x: a.x, y: ya }, { x: mx, y: ya }, { x: mx, y: yb }, { x: b.x, y: yb }, b]);
}

/** A tied cable's shared route: the trunk it joins beside its hub device, the riser it runs down
 * with the others, and the branch it leaves on toward its own far port. */
export interface TiedRoute {
  /** Which of the cable's two ends is at the hub. */
  hubEnd: 0 | 1;
  trunkY: number;
  riserX: number;
  branchY: number;
}

export function tiedPoints(l: Leads, r: TiedRoute): Pt[] {
  const h = r.hubEnd === 0 ? l.a : l.b;
  const f = r.hubEnd === 0 ? l.b : l.a;
  const pts = dedupe([h, { x: h.x, y: r.trunkY }, { x: r.riserX, y: r.trunkY }, { x: r.riserX, y: r.branchY }, { x: f.x, y: r.branchY }, f]);
  return r.hubEnd === 0 ? pts : pts.reverse();
}

/** A tie: a short bar across every cable in a bundle. */
export interface Tie {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface TieInput {
  id: string;
  chassis: [string, string];
  leads: Leads;
}

export interface TiePlan {
  routes: Map<string, TiedRoute>;
  /** Keyed by the id of the bundle's first cable, which draws them. */
  ties: Map<string, Tie[]>;
}

const TIE_OVERHANG_PX = 3;
const TIE_MIN_SPAN_PX = 10;

/**
 * Cable-tied: cables leaving one device toward the same side gather into one bundle. Each joins
 * a trunk beside the device, the bundle runs to a shared riser, and each cable branches off near
 * its own far port. The busier end of a cable is its hub. A lone cable gets no route here and
 * draws right-angle.
 */
export function planTies(cables: readonly TieInput[]): TiePlan {
  const count = new Map<string, number>();
  for (const c of cables) for (const ch of c.chassis) count.set(ch, (count.get(ch) ?? 0) + 1);

  type Member = { id: string; hubEnd: 0 | 1; h: Lead; f: Lead };
  const groups = new Map<string, Member[]>();
  for (const c of cables) {
    const [c0, c1] = c.chassis;
    const n0 = count.get(c0) ?? 0;
    const n1 = count.get(c1) ?? 0;
    const hubEnd: 0 | 1 = n0 > n1 ? 0 : n1 > n0 ? 1 : c0 <= c1 ? 0 : 1;
    const h = hubEnd === 0 ? c.leads.a : c.leads.b;
    const f = hubEnd === 0 ? c.leads.b : c.leads.a;
    const side = f.x >= h.x ? 'r' : 'l';
    const key = `${c.chassis[hubEnd]}|${h.dir}|${side}`;
    const list = groups.get(key) ?? [];
    list.push({ id: c.id, hubEnd, h, f });
    groups.set(key, list);
  }

  const routes = new Map<string, TiedRoute>();
  const ties = new Map<string, Tie[]>();
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const right = key.endsWith('|r');
    const dir = members[0]!.h.dir;
    // The port furthest from the riser takes the outermost trunk and the first riser, so the
    // drops out of the ports never cross another cable's trunk.
    members.sort((m, n) => (right ? m.h.x - n.h.x : n.h.x - m.h.x) || (m.id < n.id ? -1 : 1));
    const n = members.length;
    const hubYs = members.map((m) => m.h.y);
    const trunkBase = dir === 1 ? Math.max(...hubYs) + SQUARE_LEAD_PX : Math.min(...hubYs) - SQUARE_LEAD_PX;
    const mean = (f: (m: Member) => number) => members.reduce((s, m) => s + f(m), 0) / n;
    const centre = (mean((m) => m.h.x) + mean((m) => m.f.x)) / 2;
    const hubEdge = right ? Math.max(...members.map((m) => m.h.x)) : Math.min(...members.map((m) => m.h.x));
    const first = right
      ? Math.max(centre - (TIED_PITCH_PX * (n - 1)) / 2, hubEdge + SQUARE_LEAD_PX)
      : Math.min(centre + (TIED_PITCH_PX * (n - 1)) / 2, hubEdge - SQUARE_LEAD_PX);
    const step = right ? TIED_PITCH_PX : -TIED_PITCH_PX;
    members.forEach((m, i) => {
      routes.set(m.id, {
        hubEnd: m.hubEnd,
        trunkY: trunkBase + dir * TIED_PITCH_PX * (n - 1 - i),
        riserX: first + step * i,
        branchY: m.f.y + m.f.dir * (SQUARE_LEAD_PX + TIED_PITCH_PX * i),
      });
    });

    const rs = members.map((m) => routes.get(m.id)!);
    const xs = rs.map((r) => r.riserX);
    const ys = rs.map((r) => r.trunkY);
    const groupTies: Tie[] = [];
    // On the riser, where every cable runs down it together.
    const riserLo = Math.max(...rs.map((r) => Math.min(r.trunkY, r.branchY)));
    const riserHi = Math.min(...rs.map((r) => Math.max(r.trunkY, r.branchY)));
    if (riserHi - riserLo >= TIE_MIN_SPAN_PX) {
      const y = (riserLo + riserHi) / 2;
      groupTies.push({ x1: Math.min(...xs) - TIE_OVERHANG_PX, y1: y, x2: Math.max(...xs) + TIE_OVERHANG_PX, y2: y });
    }
    // On the trunk, where every cable runs along it together.
    const trunkLo = Math.max(...members.map((m, i) => Math.min(m.h.x, rs[i]!.riserX)));
    const trunkHi = Math.min(...members.map((m, i) => Math.max(m.h.x, rs[i]!.riserX)));
    if (trunkHi - trunkLo >= TIE_MIN_SPAN_PX) {
      const x = (trunkLo + trunkHi) / 2;
      groupTies.push({ x1: x, y1: Math.min(...ys) - TIE_OVERHANG_PX, x2: x, y2: Math.max(...ys) + TIE_OVERHANG_PX });
    }
    if (groupTies.length > 0) ties.set(members[0]!.id, groupTies);
  }
  return { routes, ties };
}

/** A curve as a polyline, for hit testing and measuring. */
export function cubicPoints(c: Cubic, segments = 20): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    const k0 = u * u * u;
    const k1 = 3 * u * u * t;
    const k2 = 3 * u * t * t;
    const k3 = t * t * t;
    out.push({
      x: k0 * c.p0.x + k1 * c.c1.x + k2 * c.c2.x + k3 * c.p3.x,
      y: k0 * c.p0.y + k1 * c.c1.y + k2 * c.c2.y + k3 * c.p3.y,
    });
  }
  return out;
}

export function polylineLength(points: readonly Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  return total;
}

/** The point `distance` along the line from its start. */
export function pointAlong(points: readonly Pt[], distance: number): Pt {
  let left = distance;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg >= left && seg > 0) {
      const t = left / seg;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= seg;
  }
  return points[points.length - 1] ?? { x: 0, y: 0 };
}

/** A faded cable's two visible tips: how long the line is, and where each tip's fade ends. A
 * line too short to fade (under about two and a half tips) draws whole. */
export function fadeTips(points: readonly Pt[], tip = FADE_STUB_PX): { total: number; tip: number; from: [Pt, Pt]; to: [Pt, Pt] } | null {
  const total = polylineLength(points);
  if (points.length < 2 || total < tip * 2.5) return null;
  const start = points[0]!;
  const end = points[points.length - 1]!;
  return { total, tip, from: [start, end], to: [pointAlong(points, tip), pointAlong(points, total - tip)] };
}

/** Physics: after a device moves, a cable's slack swings back past rest and settles. The
 * offset for the control points `ms` after a kick of `amp`; zero once settled. */
export const SWAY_SETTLE_MS = 1400;
const SWAY_DECAY_MS = 320;
const SWAY_PERIOD_MS = 620;
/** The largest swing, so a long drag never throws a cable across the drawing. */
export const SWAY_MAX_PX = 24;

export function swayAt(amp: Pt, ms: number): Pt {
  if (ms >= SWAY_SETTLE_MS) return { x: 0, y: 0 };
  const k = Math.exp(-ms / SWAY_DECAY_MS) * Math.cos((2 * Math.PI * ms) / SWAY_PERIOD_MS);
  return { x: amp.x * k, y: amp.y * k };
}

/** The kick a move gives: the slack lags behind the way its ends went, capped. */
export function swayKick(current: Pt, moved: Pt): Pt {
  const clamp = (v: number) => Math.max(-SWAY_MAX_PX, Math.min(SWAY_MAX_PX, v));
  return { x: clamp(current.x - moved.x * 0.4), y: clamp(current.y - moved.y * 0.4) };
}

export function offsetCubic(c: Cubic, off: Pt): Cubic {
  if (off.x === 0 && off.y === 0) return c;
  return {
    p0: c.p0,
    c1: { x: c.c1.x + off.x, y: c.c1.y + off.y },
    c2: { x: c.c2.x + off.x * 0.7, y: c.c2.y + off.y * 0.7 },
    p3: c.p3,
  };
}
