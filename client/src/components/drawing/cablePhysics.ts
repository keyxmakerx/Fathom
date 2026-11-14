/** Cable physics: a cable is a length of rope hanging between its two ports under gravity.
 *
 * Every physics-style cable on the canvas, and any view that draws cables hanging from ports
 * (the shelf), takes its shape from `hangCable`. A cable is a little longer than the straight line
 * between its ends (`slack`), so it droops: a short patch lead dips a little, a long run to a desk
 * across the room hangs in a deep curve, both in proportion, the way real cable does. The shape is
 * a catenary, the curve a hanging chain takes, solved exactly. With `obstacles` (shelves, devices
 * a cable drapes over) a small rope solver relaxes that curve under gravity until it rests on them.
 *
 * Pure and deterministic: the same ends always give the same curve, so nothing jitters when a
 * cable re-renders. The settle-after-a-move swing is `useCableSway` (`cableShape.tsx`); its offset
 * comes in as `sway`. */

import { swayAt, swayKick, SWAY_MAX_PX, SWAY_SETTLE_MS } from './cableRoute';

export interface Pt {
  x: number;
  y: number;
}

/** A cable end: where it meets its port, and which way the plug points (+1 down, -1 up). */
export interface HangEnd extends Pt {
  dir?: 1 | -1;
}

/** Something a cable rests on rather than passing through, in the same flow units as the ends. */
export interface Obstacle {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HangInput {
  a: HangEnd;
  b: HangEnd;
  /** Extra length as a fraction of the distance between the ends. */
  slack?: number;
  /** Things the cable rests on or drapes over. */
  obstacles?: readonly Obstacle[];
  /** The swing's offset at the middle of the cable (`useCableSway`); the ends never move. */
  sway?: Pt;
  /** A short drop between plugs that point at each other (within one rack) is drawn stiff, as an S
   * (`plugToPlug`), rather than hung. */
  stiffDrop?: boolean;
}

export interface HangResult {
  /** The cable as points, end to end, for hit-testing and labels. */
  points: Pt[];
  /** A smooth SVG path through them. */
  d: string;
  /** How far the cable's lowest point hangs below its lower end, in flow units. */
  droop: number;
}

/** A real patch cable is about 6% longer than the straight line between its ports. */
export const CABLE_SLACK = 0.06;
/** Every cable has at least this much spare, so a hop between neighbouring ports still dips. */
export const CABLE_SLACK_MIN_PX = 10;
/** How far a plug holds its cable straight out of the port before the cable starts to hang. */
export const PLUG_LEAD_PX = 9;
/** Samples along the hanging part; enough for a smooth curve at the faceplate zoom. */
const SAMPLES = 40;

/** The cable's total length for ends this far apart. */
export function cableLength(span: number, slack = CABLE_SLACK): number {
  return span * (1 + slack) + CABLE_SLACK_MIN_PX;
}

/** Solve sinh(ξ)/ξ = r for ξ > 0 (r > 1): the catenary's shape for a given slack. */
function solveXi(r: number): number {
  // Start from the small-slack series (sinh ξ / ξ ≈ 1 + ξ²/6) or, for a lot of slack, from the log form.
  let xi = r < 3 ? Math.sqrt(6 * (r - 1)) : Math.log(2 * r) + Math.log(Math.log(2 * r) + 1);
  for (let i = 0; i < 40; i++) {
    const s = Math.sinh(xi);
    const f = s - r * xi;
    const df = Math.cosh(xi) - r;
    if (df === 0) break;
    const next = xi - f / df;
    if (!(next > 0)) xi /= 2;
    else if (Math.abs(next - xi) < 1e-10) return next;
    else xi = next;
  }
  return xi;
}

/** The hanging rope of `length` between p and q, as points from p to q (screen y grows downward). */
export function catenaryPoints(p: Pt, q: Pt, length: number, samples = SAMPLES): Pt[] {
  const h = Math.abs(q.x - p.x);
  const v = q.y - p.y;
  const chord = Math.hypot(h, v);
  const L = Math.max(length, chord + 1e-6);
  const out: Pt[] = [];
  // Nearly straight down: the spare length hangs below the lower end in a narrow loop.
  if (h < 1 || L * L - v * v <= h * h * 1.0000001) {
    if (h < 1) {
      const bottom = Math.max(p.y, q.y) + (L - Math.abs(v)) / 2;
      for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        // Down from p to the bottom, back up to q, as one smooth dip.
        const y = t < 0.5 ? p.y + (bottom - p.y) * Math.sin(Math.PI * t) : q.y + (bottom - q.y) * Math.sin(Math.PI * t);
        out.push({ x: p.x + (q.x - p.x) * t, y });
      }
      return out;
    }
    for (let i = 0; i <= samples; i++) out.push({ x: p.x + (q.x - p.x) * (i / samples), y: p.y + v * (i / samples) });
    return out;
  }
  // Work left to right with y up, then map back.
  const left = p.x <= q.x ? p : q;
  const right = p.x <= q.x ? q : p;
  const x1 = left.x;
  const y1 = -left.y;
  const x2 = right.x;
  const y2 = -right.y;
  const dy = y2 - y1;
  const r = Math.sqrt(L * L - dy * dy) / h;
  const xi = solveXi(r);
  const a = h / (2 * xi);
  const x0 = (x1 + x2) / 2 - a * Math.atanh(Math.max(-0.999999999, Math.min(0.999999999, dy / L)));
  const c = y1 - a * Math.cosh((x1 - x0) / a);
  for (let i = 0; i <= samples; i++) {
    const x = x1 + (h * i) / samples;
    out.push({ x, y: -(a * Math.cosh((x - x0) / a) + c) });
  }
  // Exact ends, whatever rounding did.
  out[0] = { x: left.x, y: left.y };
  out[samples] = { x: right.x, y: right.y };
  return p.x <= q.x ? out : out.reverse();
}

/** Relax the rope under gravity until it rests on the obstacles: fixed ends, fixed segment lengths. */
function settleOnObstacles(points: Pt[], length: number, obstacles: readonly Obstacle[]): Pt[] {
  const n = points.length - 1;
  const rest = length / n;
  const ps = points.map((p) => ({ ...p }));
  const first = ps[0]!;
  const last = ps[n]!;
  const pushOut = (p: Pt) => {
    for (const o of obstacles) {
      if (p.x <= o.x || p.x >= o.x + o.w || p.y <= o.y || p.y >= o.y + o.h) continue;
      // Out by the nearest edge, with the top preferred: a cable lands on things.
      const up = p.y - o.y;
      const down = o.y + o.h - p.y;
      const l = p.x - o.x;
      const r = o.x + o.w - p.x;
      const m = Math.min(up * 0.5, down, l, r);
      if (m === up * 0.5) p.y = o.y;
      else if (m === down) p.y = o.y + o.h;
      else if (m === l) p.x = o.x;
      else p.x = o.x + o.w;
    }
  };
  const gravity = rest * 0.08;
  for (let iter = 0; iter < 160; iter++) {
    for (let i = 1; i < n; i++) ps[i]!.y += gravity;
    for (let pass = 0; pass < 6; pass++) {
      for (let i = 0; i < n; i++) {
        const p = ps[i]!;
        const q = ps[i + 1]!;
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const dist = Math.hypot(dx, dy) || 1e-9;
        const k = (dist - rest) / dist;
        const pFixed = i === 0;
        const qFixed = i + 1 === n;
        const wp = pFixed ? 0 : qFixed ? 1 : 0.5;
        const wq = qFixed ? 0 : pFixed ? 1 : 0.5;
        p.x += dx * k * wp;
        p.y += dy * k * wp;
        q.x -= dx * k * wq;
        q.y -= dy * k * wq;
      }
      for (let i = 1; i < n; i++) pushOut(ps[i]!);
    }
  }
  ps[0] = first;
  ps[n] = last;
  return ps;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** A smooth path through points: Catmull-Rom turned into cubic Béziers. */
export function smoothPath(points: readonly Pt[]): string {
  if (points.length === 0) return '';
  const p0 = points[0]!;
  if (points.length === 1) return `M ${r2(p0.x)} ${r2(p0.y)}`;
  const parts = [`M ${r2(p0.x)} ${r2(p0.y)}`];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i - 1] ?? points[i]!;
    const b = points[i]!;
    const c = points[i + 1]!;
    const d = points[i + 2] ?? c;
    const c1 = { x: b.x + (c.x - a.x) / 6, y: b.y + (c.y - a.y) / 6 };
    const c2 = { x: c.x - (d.x - b.x) / 6, y: c.y - (d.y - b.y) / 6 };
    parts.push(`C ${r2(c1.x)} ${r2(c1.y)}, ${r2(c2.x)} ${r2(c2.y)}, ${r2(c.x)} ${r2(c.y)}`);
  }
  return parts.join(' ');
}

/** Where along the hanging curve a plug's stiff lead hands over to the rope, as a share of its points. */
const LEAD_SHARE = 0.18;

/** Bend the first stretch of a hanging curve so it leaves the port along the plug (`dir`) and meets the
 * rope smoothly: a cubic from the port, out along the plug, into the rope's own direction. */
function leadInto(hung: Pt[], dir: 1 | -1 | undefined, lead: number): Pt[] {
  if (dir == null || hung.length < 6) return hung;
  const p0 = hung[0]!;
  // A cable that has to turn back on itself (a top-row port whose rope falls away below) bends round
  // in a short, wide hook rather than standing up as a spike.
  const turnsBack = (hung[Math.min(hung.length - 1, 4)]!.y - p0.y) * dir < 0;
  const bootLen = turnsBack ? lead * 0.4 : lead;
  // The plug's rigid boot: straight out of the port.
  const boot = { x: p0.x, y: p0.y + dir * bootLen };
  // Hand over a few plug lengths along the rope, and never past a share of it.
  let k = 2;
  const most = Math.max(2, Math.round((hung.length - 1) * LEAD_SHARE));
  while (k < most && Math.hypot(hung[k]!.x - p0.x, hung[k]!.y - p0.y) < lead * 4) k++;
  const q = hung[k]!;
  const after = hung[k + 1]!;
  const tl = Math.hypot(after.x - q.x, after.y - q.y) || 1;
  const reach = Math.min(lead * (turnsBack ? 3 : 2), Math.hypot(q.x - boot.x, q.y - boot.y) / 2);
  const c1 = { x: boot.x, y: boot.y + dir * lead * (turnsBack ? 0.5 : 0.8) };
  const c2 = { x: q.x - ((after.x - q.x) / tl) * reach, y: q.y - ((after.y - q.y) / tl) * reach };
  const out: Pt[] = [p0];
  for (let i = 0; i < k; i++) {
    const t = i / k;
    const u = 1 - t;
    out.push({
      x: u * u * u * boot.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * q.x,
      y: u * u * u * boot.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * q.y,
    });
  }
  return [...out, ...hung.slice(k)];
}

/** True when the two plugs point at each other up and down: the upper one down, the lower one up (a
 * cable from a shelf down into a switch below it). */
export function plugsFace(a: HangEnd, b: HangEnd): boolean {
  if (a.dir == null || b.dir == null || a.dir === b.dir) return false;
  return (b.y - a.y) * a.dir > 1 && (a.y - b.y) * b.dir > 1;
}

/** A cable between plugs that point at each other up and down. Hung as rope it would sag below the
 * lower port and hook back up into it: the curl drawn over a switch's port grid. A patch lead is
 * stiff enough over that short a drop to come straight out of one port and down into the other in an
 * easy S, so it is drawn so: out along each plug, as far as half the drop. */
export function plugToPlug(a: HangEnd, b: HangEnd, samples = SAMPLES): Pt[] {
  const reach = Math.max(PLUG_LEAD_PX * 2, Math.abs(b.y - a.y) * 0.5);
  const c1 = { x: a.x, y: a.y + a.dir! * reach };
  const c2 = { x: b.x, y: b.y + b.dir! * reach };
  const out: Pt[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const u = 1 - t;
    out.push({
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
    });
  }
  return out;
}

/** The cable hanging between two ports. */
export function hangCable({ a, b, slack = CABLE_SLACK, obstacles, sway, stiffDrop = false }: HangInput): HangResult {
  const span = Math.hypot(b.x - a.x, b.y - a.y);
  const length = cableLength(span, slack);
  const facing = stiffDrop && plugsFace(a, b) && (obstacles == null || obstacles.length === 0);
  let hung = facing ? plugToPlug(a, b) : catenaryPoints(a, b, length);
  if (obstacles != null && obstacles.length > 0) hung = settleOnObstacles(hung, length, obstacles);
  if (sway != null && (sway.x !== 0 || sway.y !== 0)) {
    const n = hung.length - 1;
    hung = hung.map((p, i) => {
      const k = i === 0 || i === n ? 0 : Math.sin((Math.PI * i) / n);
      return { x: p.x + sway.x * k, y: p.y + sway.y * k };
    });
  }
  // Each plug holds its cable straight out of the port for a moment before it hangs.
  if (!facing) {
    hung = leadInto(hung, a.dir, PLUG_LEAD_PX);
    hung = leadInto([...hung].reverse(), b.dir, PLUG_LEAD_PX).reverse();
  }
  const lowest = Math.max(...hung.map((p) => p.y));
  return { points: hung, d: smoothPath(hung), droop: lowest - Math.max(a.y, b.y) };
}

/** A cable's two ends, as the swing tracks them. */
export interface SwingEnds {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/** A cable remade within this long of going away carries on from where it was. */
export const SWAY_REMOUNT_MS = 600;

/** How hard a move of `moved` (the mean of how far its two ends went) kicks a cable `span` long:
 * the slack lags behind the way its ends went, capped so a long drag never throws it across the room. */
export function swayKickFor(current: Pt, moved: Pt, span: number): Pt {
  return swayKick(current, moved, Math.max(SWAY_MAX_PX, Math.min(SWAY_MAX_PX * 3.5, span * 0.08)));
}

/** The swing of every cable, by id: where its ends were last seen and the kick it is settling from.
 *
 * Kept by id, outside any one component, on purpose. React Flow can drop and remake a cable's edge in
 * the very moment its device lands (a rack dropped in a new place does it), and a fresh edge with no
 * memory of where its ends were would jump to its new place without swinging: the physics silently
 * gone. A cable seen again within `SWAY_REMOUNT_MS` of going away carries on from where it was. */
export class CableSwings {
  private live = new Map<string, { ends: SwingEnds; kick: { amp: Pt; at: number } | null }>();
  private departed = new Map<string, { ends: SwingEnds; kick: { amp: Pt; at: number } | null; at: number }>();

  /** The cable's ends now. A move kicks it, when `moving` (off under reduced motion). */
  see(id: string, ends: SwingEnds, now: number, moving = true): void {
    let was = this.live.get(id);
    if (was == null) {
      const gone = this.departed.get(id);
      this.departed.delete(id);
      if (gone != null && now - gone.at < SWAY_REMOUNT_MS) was = { ends: gone.ends, kick: gone.kick };
    }
    let kick = was?.kick ?? null;
    if (kick != null && now - kick.at >= SWAY_SETTLE_MS) kick = null;
    if (moving && was != null) {
      const moved = { x: (ends.ax - was.ends.ax + (ends.bx - was.ends.bx)) / 2, y: (ends.ay - was.ends.ay + (ends.by - was.ends.by)) / 2 };
      if (Math.abs(moved.x) >= 0.5 || Math.abs(moved.y) >= 0.5) {
        const current = kick != null ? swayAt(kick.amp, now - kick.at) : { x: 0, y: 0 };
        kick = { amp: swayKickFor(current, moved, Math.hypot(ends.bx - ends.ax, ends.by - ends.ay)), at: now };
      }
    }
    if (!moving) kick = null;
    this.live.set(id, { ends, kick });
  }

  /** The cable's edge went away; it may be remade in a moment. */
  gone(id: string, now: number): void {
    const was = this.live.get(id);
    this.live.delete(id);
    if (was != null) this.departed.set(id, { ...was, at: now });
    for (const [key, d] of this.departed) if (now - d.at >= SWAY_REMOUNT_MS) this.departed.delete(key);
  }

  /** True while the cable is still swinging. */
  swinging(id: string, now: number): boolean {
    const k = this.live.get(id)?.kick;
    return k != null && now - k.at < SWAY_SETTLE_MS;
  }

  /** The swing's offset at the cable's middle now; zero once settled. */
  offset(id: string, now: number): Pt {
    const k = this.live.get(id)?.kick;
    return k != null ? swayAt(k.amp, now - k.at) : { x: 0, y: 0 };
  }
}

/** The canvas's one record of cable swings. */
export const cableSwings = new CableSwings();
