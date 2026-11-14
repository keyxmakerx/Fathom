/** Where the Diagram look's cable lines run. Every line is square-cornered and keeps to the empty space
 * between boxes: down the gap between two columns, or along the gap between two rows. A line never
 * passes through a box it does not end on, and no two lines share a run, so one device joined to many
 * reads as one device joined to many, not as a chain. Pure: boxes and lines in, one route per line out. */

import { BOX_H, BOX_W, COLUMN_PITCH, ROW_PITCH, type Rect } from './diagram';

export interface RouteEnd {
  x: number;
  y: number;
  /** The way the line leaves the box: one of dx, dy is 0, the other ±1. */
  dx: number;
  dy: number;
}

export interface Route {
  d: string;
  a: RouteEnd;
  b: RouteEnd;
  /** The middle of the line's longest run: where a word or a mark about the whole cable sits. */
  mid: { x: number; y: number; vertical: boolean };
}

export interface RouteLine {
  id: string;
  a: string;
  b: string;
  /** The port each end is plugged into, for a box that draws a port strip (sign-off r109). */
  portA?: string;
  portB?: string;
}

/** Where each port on a box's strip lets its line out: `exitX` from the box's left edge, on its bottom edge. */
export type StripExits = ReadonlyMap<string, ReadonlyArray<{ portId: string; exitX: number }>>;

/** A line leaving through a strip port drops this far below the box, at least, before it turns. */
const DROP_MIN = 6;
/** Its drops share this much of the gap under the box. */
const DROP_ROOM = 14;

/** Room between two lines that run side by side, and between two ends on one side of a box. */
export const TRACK_PX = 10;
const SLOT_PX = 10;
/** A run keeps this far from the boxes either side of its gap. */
const GAP_MARGIN = 18;

type Side = 'top' | 'bottom' | 'left' | 'right';
type Pt = { x: number; y: number };

interface Cell {
  rect: Rect;
  col: number;
  row: number;
}

const cellOf = (r: Rect): Cell => ({
  rect: r,
  col: Math.floor((r.x + r.w / 2) / COLUMN_PITCH),
  row: Math.floor((r.y + r.h / 2) / ROW_PITCH),
});

/** The middle of the gap to the right of column `g` (g = -1 is the gap left of the first column). */
const colGapMid = (g: number) => g * COLUMN_PITCH + (BOX_W + COLUMN_PITCH) / 2;
const COL_GAP_ROOM = COLUMN_PITCH - BOX_W - 2 * GAP_MARGIN;
/** The middle of the gap above row `k`. */
const rowGapMid = (k: number) => k * ROW_PITCH - (ROW_PITCH - BOX_H) / 2;
const ROW_GAP_ROOM = ROW_PITCH - BOX_H - 2 * GAP_MARGIN;

interface Plan {
  id: string;
  a: Cell;
  b: Cell;
  sideA: Side;
  sideB: Side;
  /** The column gap each end turns in (null: the line runs straight). */
  gapA: number | null;
  gapB: number | null;
  /** The row gap a long line crosses columns in (null: it does not). */
  rowGap: number | null;
}

/** Spread `n` ends along a side of length `len`, centred, `SLOT_PX` apart or closer when the side is full. */
function slots(n: number, len: number): number[] {
  const step = Math.min(SLOT_PX, len / (n + 1));
  return Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * step);
}

/** Where track `t` of `n` sits in a gap of width `room`: spread left to right about the middle. */
function trackOffset(t: number, n: number, room: number): number {
  const step = n <= 1 ? 0 : Math.min(TRACK_PX, room / (n - 1));
  return (t - (n - 1) / 2) * step;
}

interface Span {
  key: string;
  lo: number;
  hi: number;
  /** Lower sorts nearer the low side of the gap (left, or top). */
  order: number;
}

/** Give each run a track so none on one track overlap. Runs are placed in `order`, each on the lowest free
 * track, so the run that should sit nearest one side of the gap gets there first. */
function assignTracks(spans: Span[]): { track: Map<string, number>; count: number } {
  const sorted = [...spans].sort((p, q) => p.order - q.order || p.lo - q.lo || p.key.localeCompare(q.key));
  const used: Array<Array<[number, number]>> = [];
  const track = new Map<string, number>();
  for (const s of sorted) {
    let t = used.findIndex((iv) => iv.every(([lo, hi]) => s.hi < lo - TRACK_PX || s.lo > hi + TRACK_PX));
    if (t < 0) {
      t = used.length;
      used.push([]);
    }
    used[t]!.push([s.lo, s.hi]);
    track.set(s.key, t);
  }
  return { track, count: used.length };
}

function plan(id: string, a: Cell, b: Cell, lastCol: number): Plan {
  const dc = b.col - a.col;
  const dr = b.row - a.row;
  if (dc === 0 && Math.abs(dr) === 1)
    return { id, a, b, sideA: dr > 0 ? 'bottom' : 'top', sideB: dr > 0 ? 'top' : 'bottom', gapA: null, gapB: null, rowGap: null };
  if (dr === 0 && Math.abs(dc) === 1)
    return { id, a, b, sideA: dc > 0 ? 'right' : 'left', sideB: dc > 0 ? 'left' : 'right', gapA: null, gapB: null, rowGap: null };
  // Same column, rows apart: out and back in on one side, the side that faces the rest of the drawing.
  if (dc === 0) {
    const side: Side = a.col === lastCol && a.col > 0 ? 'left' : 'right';
    const gap = side === 'right' ? a.col : a.col - 1;
    return { id, a, b, sideA: side, sideB: side, gapA: gap, gapB: gap, rowGap: null };
  }
  const toward: Side = dc > 0 ? 'right' : 'left';
  const back: Side = dc > 0 ? 'left' : 'right';
  const gapA = dc > 0 ? a.col : a.col - 1;
  const gapB = dc > 0 ? b.col - 1 : b.col;
  if (gapA === gapB) return { id, a, b, sideA: toward, sideB: back, gapA, gapB, rowGap: null };
  return { id, a, b, sideA: toward, sideB: back, gapA, gapB, rowGap: Math.max(a.row, b.row) };
}

function attachPoint(r: Rect, side: Side, offset: number): Pt {
  switch (side) {
    case 'top':
      return { x: r.x + r.w / 2 + offset, y: r.y };
    case 'bottom':
      return { x: r.x + r.w / 2 + offset, y: r.y + r.h };
    case 'left':
      return { x: r.x, y: r.y + r.h / 2 + offset };
    case 'right':
      return { x: r.x + r.w, y: r.y + r.h / 2 + offset };
  }
}

const DIR: Record<Side, { dx: number; dy: number }> = {
  top: { dx: 0, dy: -1 },
  bottom: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};

function finish(points: Pt[], sideA: Side, sideB: Side, downA = false, downB = false): Route {
  // Drop repeated and in-line points so the path is only its corners.
  const pts: Pt[] = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (last != null && last.x === p.x && last.y === p.y) continue;
    const prev = pts[pts.length - 2];
    if (last != null && prev != null && ((prev.x === last.x && last.x === p.x) || (prev.y === last.y && last.y === p.y))) pts[pts.length - 1] = p;
    else pts.push(p);
  }
  let best = 0;
  let mid = { x: pts[0]!.x, y: pts[0]!.y, vertical: false };
  for (let i = 1; i < pts.length; i += 1) {
    const [p, q] = [pts[i - 1]!, pts[i]!];
    const len = Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
    if (len > best) [best, mid] = [len, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, vertical: p.x === q.x }];
  }
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return {
    d: pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' '),
    a: { x: first.x, y: first.y, ...(downA ? DIR.bottom : DIR[sideA]) },
    b: { x: last.x, y: last.y, ...(downB ? DIR.bottom : DIR[sideB]) },
    mid,
  };
}

/** One route per line whose two boxes are both given. */
export function routeDiagram(boxes: ReadonlyArray<Rect & { id: string }>, lines: ReadonlyArray<RouteLine>, strips?: StripExits): Map<string, Route> {
  const cells = new Map(boxes.map((b) => [b.id, cellOf(b)]));
  const lastCol = Math.max(0, ...[...cells.values()].map((c) => c.col));
  const plans: Plan[] = [];
  // A strip port's exit, from the box's left edge, by line end ("<line id>|a").
  const portX = new Map<string, number>();
  for (const l of lines) {
    const a = cells.get(l.a);
    const b = cells.get(l.b);
    if (a == null || b == null || l.a === l.b) continue;
    plans.push(plan(l.id, a, b, lastCol));
    for (const [end, box, port] of [['a', l.a, l.portA], ['b', l.b, l.portB]] as const) {
      const x = port == null ? undefined : strips?.get(box)?.find((c) => c.portId === port)?.exitX;
      if (x != null) portX.set(`${l.id}|${end}`, x);
    }
  }

  // A line leaving a strip port sideways drops under its box first, then turns. Of the lines turning one
  // way, the one whose port is farthest that way drops least, so no drop crosses another's turn; lines
  // turning right take the even depths and lines turning left the odd ones, so none share a run.
  const dropY = new Map<string, number>();
  {
    const byBox = new Map<string, Array<{ key: string; x: number; right: boolean }>>();
    const boxOf = new Map<Cell, string>([...cells].map(([id, c]) => [c, id]));
    for (const p of plans)
      for (const end of ['a', 'b'] as const) {
        const key = `${p.id}|${end}`;
        const side = end === 'a' ? p.sideA : p.sideB;
        const x = portX.get(key);
        if (x == null || (side !== 'left' && side !== 'right')) continue;
        const box = boxOf.get(end === 'a' ? p.a : p.b)!;
        byBox.set(box, [...(byBox.get(box) ?? []), { key, x, right: side === 'right' }]);
      }
    for (const [box, ends] of byBox) {
      const r = cells.get(box)!.rect;
      const right = ends.filter((e) => e.right).sort((p, q) => q.x - p.x || p.key.localeCompare(q.key));
      const left = ends.filter((e) => !e.right).sort((p, q) => p.x - q.x || p.key.localeCompare(q.key));
      const levels = 2 * Math.max(right.length, left.length);
      const step = levels <= 1 ? 0 : Math.min(3, DROP_ROOM / (levels - 1));
      right.forEach((e, i) => dropY.set(e.key, r.y + r.h + DROP_MIN + 2 * i * step));
      left.forEach((e, i) => dropY.set(e.key, r.y + r.h + DROP_MIN + (2 * i + 1) * step));
    }
  }

  const BIG = 1e7;
  const centre = (c: Cell) => ({ x: c.rect.x + c.rect.w / 2, y: c.rect.y + c.rect.h / 2 });

  // Row gaps first: the height each long line crosses columns at.
  const rowSpans = new Map<number, Span[]>();
  for (const p of plans) {
    if (p.rowGap == null) continue;
    const [x1, x2] = [colGapMid(p.gapA!), colGapMid(p.gapB!)];
    const span = { key: p.id, lo: Math.min(x1, x2), hi: Math.max(x1, x2) };
    rowSpans.set(p.rowGap, [...(rowSpans.get(p.rowGap) ?? []), { ...span, order: -(span.hi - span.lo) }]);
  }
  const rowY = new Map<string, number>();
  for (const [k, spans] of rowSpans) {
    const { track, count } = assignTracks(spans);
    for (const [id, t] of track) rowY.set(id, rowGapMid(k) + trackOffset(t, count, ROW_GAP_ROOM));
  }

  // Column gaps: every vertical run gets its own track. Runs from the boxes left of a gap keep to its left
  // half and runs from the right to its right half, so two lines never meet end on; and of two runs from one
  // side the longer sits farther out, so neither crosses the other on its way in.
  const colSpans = new Map<number, Span[]>();
  const runs: Array<{ p: Plan; end: 'a' | 'b'; gap: number; from: number; to: number }> = [];
  for (const p of plans) {
    if (p.gapA == null) continue;
    const ya = dropY.get(`${p.id}|a`) ?? centre(p.a).y;
    const yb = dropY.get(`${p.id}|b`) ?? centre(p.b).y;
    if (p.rowGap == null) runs.push({ p, end: 'a', gap: p.gapA, from: ya, to: yb });
    else {
      runs.push({ p, end: 'a', gap: p.gapA, from: ya, to: rowY.get(p.id)! });
      runs.push({ p, end: 'b', gap: p.gapB!, from: yb, to: rowY.get(p.id)! });
    }
  }
  for (const r of runs) {
    const box = r.end === 'a' ? r.p.a : r.p.b;
    // A run that joins boxes either side of its gap belongs to the left one, whichever end the cable names first.
    const across = r.p.rowGap == null && r.p.a.col !== r.p.b.col;
    const boxOnLeft = across || box.rect.x < colGapMid(r.gap);
    const len = Math.abs(r.to - r.from);
    const span = { key: `${r.p.id}|${r.end}`, lo: Math.min(r.from, r.to), hi: Math.max(r.from, r.to), order: boxOnLeft ? len : BIG - len };
    colSpans.set(r.gap, [...(colSpans.get(r.gap) ?? []), span]);
  }
  const colX = new Map<string, number>();
  for (const [g, spans] of colSpans) {
    const { track, count } = assignTracks(spans);
    for (const [key, t] of track) colX.set(key, colGapMid(g) + trackOffset(t, count, COL_GAP_ROOM));
  }

  // Ends on each side of a box, in an order that keeps lines from crossing as they leave: those that turn
  // up take the top slots (nearest turn topmost), those that turn down the bottom ones, straight ones between.
  const sideEnds = new Map<string, Array<{ key: string; order: number }>>();
  const addEnd = (box: string, side: Side, key: string, order: number) => {
    const k = `${box}|${side}`;
    sideEnds.set(k, [...(sideEnds.get(k) ?? []), { key, order }]);
  };
  const boxId = new Map<Cell, string>([...cells].map(([id, c]) => [c, id]));
  for (const p of plans) {
    for (const end of ['a', 'b'] as const) {
      const [me, far, side] = end === 'a' ? [p.a, p.b, p.sideA] : [p.b, p.a, p.sideB];
      const key = `${p.id}|${end}`;
      let order: number;
      if (side === 'top' || side === 'bottom') order = centre(far).x;
      else if (p.gapA == null) order = centre(far).y - centre(me).y;
      else {
        const x = colX.get(p.rowGap == null ? `${p.id}|a` : key)!;
        const dist = Math.abs(x - (side === 'right' ? me.rect.x + me.rect.w : me.rect.x));
        const toY = p.rowGap == null ? centre(far).y : rowY.get(p.id)!;
        order = toY < centre(me).y ? -BIG + dist : BIG - dist;
      }
      addEnd(boxId.get(me)!, side, key, order);
    }
  }
  const offset = new Map<string, number>();
  for (const [k, ends] of sideEnds) {
    const [box, side] = k.split('|') as [string, Side];
    const r = cells.get(box)!.rect;
    ends.sort((p, q) => p.order - q.order || p.key.localeCompare(q.key));
    const s = slots(ends.length, side === 'top' || side === 'bottom' ? r.w : r.h);
    ends.forEach((e, i) => offset.set(e.key, s[i]!));
  }
  // An end on a strip port: a line from the box above meets the top edge over the port; any other leaves
  // through the port on the bottom edge, straight down.
  const isDown = (p: Plan, end: 'a' | 'b') => portX.has(`${p.id}|${end}`) && (end === 'a' ? p.sideA : p.sideB) !== 'top';
  const endPt = (p: Plan, end: 'a' | 'b'): Pt => {
    const [cell, side] = end === 'a' ? [p.a, p.sideA] : [p.b, p.sideB];
    const x = portX.get(`${p.id}|${end}`);
    if (x == null) return attachPoint(cell.rect, side, offset.get(`${p.id}|${end}`)!);
    return { x: cell.rect.x + x, y: side === 'top' ? cell.rect.y : cell.rect.y + cell.rect.h };
  };
  /** The points from the box to where the line runs on, and the height it runs on at. */
  const lead = (p: Plan, end: 'a' | 'b'): { pts: Pt[]; y: number } => {
    const at = endPt(p, end);
    const d = dropY.get(`${p.id}|${end}`);
    return d == null ? { pts: [at], y: at.y } : { pts: [at, { x: at.x, y: d }], y: d };
  };

  const out = new Map<string, Route>();
  for (const p of plans) {
    const la = lead(p, 'a');
    const lb = lead(p, 'b');
    const a = la.pts[0]!;
    const b = lb.pts[0]!;
    const tail = [...lb.pts].reverse();
    const onStrip = portX.has(`${p.id}|a`) || portX.has(`${p.id}|b`);
    let points: Pt[];
    if (p.gapA == null) {
      if (p.sideA === 'top' || p.sideA === 'bottom') {
        if (!onStrip) {
          // Straight: the two ends share the run's line, so meet them in the middle of their offsets.
          const x = (a.x + b.x) / 2;
          points = [{ x, y: a.y }, { x, y: b.y }];
        } else {
          // A strip end fixes its x: jog across halfway down the gap, each line at its own height.
          const y = (a.y + b.y) / 2 + offset.get(`${p.id}|a`)!;
          points = a.x === b.x ? [a, b] : [a, { x: a.x, y }, { x: b.x, y }, b];
        }
      } else if (!onStrip) {
        const y = (a.y + b.y) / 2;
        points = [{ x: a.x, y }, { x: b.x, y }];
      } else {
        // Side by side, one end on a strip: turn in the gap between the two boxes, each line on its own track.
        const left = p.sideA === 'right' ? p.a.rect : p.b.rect;
        const right = p.sideA === 'right' ? p.b.rect : p.a.rect;
        const x = (left.x + left.w + right.x) / 2 + offset.get(`${p.id}|a`)!;
        points = [...la.pts, { x, y: la.y }, { x, y: lb.y }, ...tail];
      }
    } else if (p.rowGap == null) {
      const x = colX.get(`${p.id}|a`)!;
      points = [...la.pts, { x, y: la.y }, { x, y: lb.y }, ...tail];
    } else {
      const xa = colX.get(`${p.id}|a`)!;
      const xb = colX.get(`${p.id}|b`)!;
      const y = rowY.get(p.id)!;
      points = [...la.pts, { x: xa, y: la.y }, { x: xa, y }, { x: xb, y }, { x: xb, y: lb.y }, ...tail];
    }
    out.set(p.id, finish(points, p.sideA, p.sideB, isDown(p, 'a'), isDown(p, 'b')));
  }
  return out;
}
