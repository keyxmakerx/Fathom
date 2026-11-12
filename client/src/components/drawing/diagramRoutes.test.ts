import { describe, expect, it } from 'vitest';
import { BOX_H, BOX_W, COLUMN_PITCH, ROW_PITCH, type Rect } from './diagram';
import { routeDiagram, type Route } from './diagramRoutes';

type Box = Rect & { id: string };
const box = (id: string, col: number, row: number): Box => ({ id, x: col * COLUMN_PITCH, y: row * ROW_PITCH, w: BOX_W, h: BOX_H });

/** The corners of a route, read back from its path. */
function corners(r: Route): Array<{ x: number; y: number }> {
  const n = r.d.match(/-?\d+(\.\d+)?/g)!.map(Number);
  const out = [];
  for (let i = 0; i < n.length; i += 2) out.push({ x: n[i]!, y: n[i + 1]! });
  return out;
}
type Seg = { x1: number; y1: number; x2: number; y2: number };
const segments = (r: Route): Seg[] => {
  const c = corners(r);
  return c.slice(1).map((q, i) => ({ x1: c[i]!.x, y1: c[i]!.y, x2: q.x, y2: q.y }));
};
/** Does the segment pass through the inside of the box (touching its edge does not count)? */
function crosses(s: Seg, b: Rect): boolean {
  const [x0, x1] = [Math.min(s.x1, s.x2), Math.max(s.x1, s.x2)];
  const [y0, y1] = [Math.min(s.y1, s.y2), Math.max(s.y1, s.y2)];
  return x1 > b.x && x0 < b.x + b.w && y1 > b.y && y0 < b.y + b.h;
}
/** Do two segments lie on one line and share more than a point? */
function overlaps(s: Seg, t: Seg): boolean {
  if (s.x1 === s.x2 && t.x1 === t.x2 && s.x1 === t.x1)
    return Math.min(Math.max(s.y1, s.y2), Math.max(t.y1, t.y2)) > Math.max(Math.min(s.y1, s.y2), Math.min(t.y1, t.y2));
  if (s.y1 === s.y2 && t.y1 === t.y2 && s.y1 === t.y1)
    return Math.min(Math.max(s.x1, s.x2), Math.max(t.x1, t.x2)) > Math.max(Math.min(s.x1, s.x2), Math.min(t.x1, t.x2));
  return false;
}

// The sample home lab as the Diagram lays it out: a rack column, a desk column, a wall column, a ceiling one.
const boxes = [
  box('router', 0, 0), box('sw1', 0, 1), box('nas', 0, 2), box('server', 0, 3), box('pi', 0, 4),
  box('cam1', 1, 0), box('cam2', 1, 1),
  box('desktop', 2, 0), box('sw2', 2, 1), box('printer', 2, 2),
  box('ap', 3, 0),
];
const lines = [
  ['c1', 'router', 'sw1'], ['c2', 'router', 'sw1'], ['c3', 'sw1', 'nas'], ['c4', 'sw1', 'server'], ['c5', 'sw1', 'pi'],
  ['c6', 'sw1', 'ap'], ['c7', 'sw1', 'sw2'], ['c8', 'sw1', 'cam1'], ['c9', 'sw1', 'cam2'], ['c10', 'sw2', 'desktop'], ['c11', 'sw2', 'printer'],
].map(([id, a, b]) => ({ id: id!, a: a!, b: b! }));
const byId = new Map(boxes.map((b) => [b.id, b]));

describe('routeDiagram', () => {
  const routes = routeDiagram(boxes, lines);

  it('routes every line', () => {
    expect([...routes.keys()].sort()).toEqual(lines.map((l) => l.id).sort());
  });

  it('turns only at right angles', () => {
    for (const r of routes.values()) for (const s of segments(r)) expect(s.x1 === s.x2 || s.y1 === s.y2).toBe(true);
  });

  it('starts and ends on the edges of its own two boxes', () => {
    for (const l of lines) {
      const r = routes.get(l.id)!;
      const onEdge = (p: { x: number; y: number }, b: Rect) =>
        ((p.x === b.x || p.x === b.x + b.w) && p.y >= b.y && p.y <= b.y + b.h) || ((p.y === b.y || p.y === b.y + b.h) && p.x >= b.x && p.x <= b.x + b.w);
      expect(onEdge(r.a, byId.get(l.a)!)).toBe(true);
      expect(onEdge(r.b, byId.get(l.b)!)).toBe(true);
    }
  });

  it('never runs through a box, not even one of its own', () => {
    // Before: switch to server ran straight down through the NAS, so it read as a chain.
    for (const [id, r] of routes) for (const s of segments(r)) for (const b of boxes) expect(crosses(s, b), `${id} through ${b.id}`).toBe(false);
  });

  it('never shares a run with another line', () => {
    // Before: switch-1 to switch-2 ran up the middle of the cameras' column and read as camera to camera.
    const all = [...routes].flatMap(([id, r]) => segments(r).map((s) => ({ id, s })));
    for (const p of all) for (const q of all) if (p.id !== q.id) expect(overlaps(p.s, q.s), `${p.id} on ${q.id}`).toBe(false);
  });

  it('keeps two cables between one pair apart', () => {
    expect(routes.get('c1')!.a.x).not.toBe(routes.get('c2')!.a.x);
  });

  it('runs straight between neighbours', () => {
    expect(corners(routes.get('c3')!)).toHaveLength(2);
    expect(corners(routes.get('c9')!)).toHaveLength(2);
  });

  it('brackets on the side that faces the drawing in the last column', () => {
    const r = routeDiagram([box('a', 2, 0), box('b', 2, 2), box('c', 0, 0)], [{ id: 'x', a: 'a', b: 'b' }]).get('x')!;
    expect(r.a.dx).toBe(-1);
    expect(Math.min(...corners(r).map((p) => p.x))).toBeLessThan(2 * COLUMN_PITCH);
  });

  it('puts the middle on the longest run', () => {
    const r = routes.get('c5')!;
    expect(r.mid.vertical).toBe(true);
    expect(r.mid.y).toBeGreaterThan(byId.get('nas')!.y);
  });

  it('skips a loop and a line to a box that is not drawn', () => {
    expect(routeDiagram(boxes, [{ id: 'l', a: 'sw1', b: 'sw1' }, { id: 'z', a: 'sw1', b: 'gone' }]).size).toBe(0);
  });

  it('routes a thousand-device design quickly', () => {
    const many: Box[] = [];
    const ls: Array<{ id: string; a: string; b: string }> = [];
    for (let c = 0; c < 20; c += 1) for (let r = 0; r < 50; r += 1) many.push(box(`d${c}-${r}`, c, r));
    for (let c = 0; c < 20; c += 1) for (let r = 1; r < 50; r += 1) ls.push({ id: `l${c}-${r}`, a: `d${c}-0`, b: `d${c}-${r}` });
    for (let c = 1; c < 20; c += 1) ls.push({ id: `u${c}`, a: 'd0-0', b: `d${c}-0` });
    const t = performance.now();
    expect(routeDiagram(many, ls).size).toBe(ls.length);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
