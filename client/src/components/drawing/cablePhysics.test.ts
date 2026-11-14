import { describe, expect, it } from 'vitest';

import {
  CABLE_SLACK,
  cableLength,
  CableSwings,
  catenaryPoints,
  hangCable,
  plugsFace,
  SWAY_REMOUNT_MS,
  type Pt,
} from './cablePhysics';
import { cableShape } from './cableShape';
import { SWAY_SETTLE_MS } from './cableRoute';
import { shelfChipBox } from './CableEdge';
import type { PortPoint } from './cableEnds';

const length = (ps: readonly Pt[]) => ps.slice(1).reduce((n, p, i) => n + Math.hypot(p.x - ps[i]!.x, p.y - ps[i]!.y), 0);
const lowest = (ps: readonly Pt[]) => Math.max(...ps.map((p) => p.y));

describe('a cable hangs like rope', () => {
  it('keeps its length: the catenary is as long as the cable', () => {
    for (const [p, q] of [
      [{ x: 0, y: 0 }, { x: 400, y: 0 }],
      [{ x: 0, y: 0 }, { x: 900, y: 600 }],
      [{ x: 500, y: 300 }, { x: 0, y: -200 }],
    ] as const) {
      const L = cableLength(Math.hypot(q.x - p.x, q.y - p.y));
      expect(length(catenaryPoints(p, q, L, 400))).toBeCloseTo(L, 0);
    }
  });

  it('meets both ports exactly', () => {
    const ps = catenaryPoints({ x: 10, y: 20 }, { x: 610, y: 220 }, 700);
    expect(ps[0]).toEqual({ x: 10, y: 20 });
    expect(ps.at(-1)).toEqual({ x: 610, y: 220 });
  });

  it('sags below a level run, deepest in the middle', () => {
    const ps = catenaryPoints({ x: 0, y: 0 }, { x: 600, y: 0 }, cableLength(600));
    const mid = ps[Math.floor(ps.length / 2)]!;
    expect(mid.y).toBeCloseTo(lowest(ps), 0);
    expect(mid.y).toBeGreaterThan(60);
  });

  it('hangs deeper the longer the run, in proportion', () => {
    const droop = (span: number) => hangCable({ a: { x: 0, y: 0 }, b: { x: span, y: 0 } }).droop;
    expect(droop(1200)).toBeGreaterThan(droop(600) * 1.7);
    expect(droop(600)).toBeGreaterThan(droop(100));
  });

  it('a straight drop leaves its spare length as a loop below the lower end', () => {
    const ps = catenaryPoints({ x: 0, y: 0 }, { x: 0, y: 300 }, 340);
    expect(lowest(ps)).toBeCloseTo(320, 0);
  });

  it('is the same curve every time, so a re-render never jitters', () => {
    const input = { a: { x: 3, y: 4, dir: -1 as const }, b: { x: 803, y: 404, dir: 1 as const } };
    expect(hangCable(input).d).toBe(hangCable(input).d);
  });

  it('leaves a port along its plug before it hangs', () => {
    const up = hangCable({ a: { x: 0, y: 100, dir: -1 }, b: { x: 600, y: 100 } }).points;
    expect(up[1]!.y).toBeLessThan(100);
    const down = hangCable({ a: { x: 0, y: 100, dir: 1 }, b: { x: 600, y: 100 } }).points;
    expect(down[1]!.y).toBeGreaterThan(100);
  });

  it('rests on what is under it instead of passing through', () => {
    const shelf = { x: 100, y: 60, w: 400, h: 80 };
    const free = hangCable({ a: { x: 0, y: 0 }, b: { x: 600, y: 0 } });
    expect(free.points.some((p) => p.x > shelf.x && p.x < shelf.x + shelf.w && p.y > shelf.y && p.y < shelf.y + shelf.h)).toBe(true);
    const rested = hangCable({ a: { x: 0, y: 0 }, b: { x: 600, y: 0 }, obstacles: [shelf] });
    const inside = rested.points.filter((p) => p.x > shelf.x + 1 && p.x < shelf.x + shelf.w - 1 && p.y > shelf.y + 1 && p.y < shelf.y + shelf.h - 1);
    expect(inside).toEqual([]);
    // It lies along the shelf's top.
    expect(rested.points.some((p) => p.x > 200 && p.x < 400 && Math.abs(p.y - shelf.y) < 2)).toBe(true);
  });

  it('swings in the middle and never at its ends', () => {
    const still = hangCable({ a: { x: 0, y: 0 }, b: { x: 600, y: 0 } });
    const swung = hangCable({ a: { x: 0, y: 0 }, b: { x: 600, y: 0 }, sway: { x: 20, y: -10 } });
    expect(swung.points[0]).toEqual(still.points[0]);
    expect(swung.points.at(-1)).toEqual(still.points.at(-1));
    const m = Math.floor(still.points.length / 2);
    expect(swung.points[m]!.x - still.points[m]!.x).toBeCloseTo(20, 0);
  });
});

// "Your cables lost their physics again" (sign-off r120, 12 November 2026): a long cable drew as a nearly
// straight line. These pin the canvas's own physics cable to a hanging shape, whatever else changes.
describe('the canvas draws physics cables hanging', () => {
  const port = (x: number, y: number, row: 0 | 1) => ({ x, y, w: 8, h: 6, row });
  const shape = (a: ReturnType<typeof port>, b: ReturnType<typeof port>, kind: 'copper' | 'power' = 'copper') =>
    cableShape({ style: 'physics', id: 'c', kind, ends: [a, b], source: { x: 0, y: 0 }, target: { x: 0, y: 0 } });

  it('a long run from a rack to a desk across the room hangs well below the straight line', () => {
    const { points } = shape(port(0, 0, 1), port(1500, 600, 0));
    // The straight line's height at each x, and how far below it the cable hangs at its deepest.
    const below = Math.max(...points.map((p) => p.y - (p.x / 1500) * 606)); // 606: the far port's top edge
    expect(below).toBeGreaterThan(1500 * 0.08);
  });

  it('a run between two level ports dips below both', () => {
    const { points } = shape(port(0, 0, 1), port(800, 0, 1));
    expect(lowest(points) - 6).toBeGreaterThan(800 * 0.1);
  });

  it('power carries more slack than data, so the two never draw as one line', () => {
    expect(shape(port(0, 0, 1), port(800, 0, 1), 'power').d).not.toBe(shape(port(0, 0, 1), port(800, 0, 1)).d);
  });

  it('uses the slack a real patch cable has', () => {
    expect(CABLE_SLACK).toBeGreaterThanOrEqual(0.03);
  });
});

describe('the swing after a device moves', () => {
  const at = (ax: number) => ({ ax, ay: 0, bx: ax + 400, by: 0 });

  it('kicks when the ends move, then settles', () => {
    const s = new CableSwings();
    s.see('c', at(0), 0);
    expect(s.swinging('c', 0)).toBe(false);
    s.see('c', at(120), 10);
    expect(s.swinging('c', 20)).toBe(true);
    expect(Math.abs(s.offset('c', 20).x)).toBeGreaterThan(0);
    expect(s.swinging('c', 10 + SWAY_SETTLE_MS)).toBe(false);
    expect(s.offset('c', 10 + SWAY_SETTLE_MS)).toEqual({ x: 0, y: 0 });
  });

  // The regression: React Flow remakes a cable's edge in the moment a dropped rack lands. A remade
  // cable that forgot its old ends jumped to its new place without swinging.
  it('still swings when its edge is remade as the device lands', () => {
    const s = new CableSwings();
    s.see('c', at(0), 0);
    s.gone('c', 100);
    s.see('c', at(300), 105);
    expect(s.swinging('c', 120)).toBe(true);
  });

  it('carries a swing already under way across a remake', () => {
    const s = new CableSwings();
    s.see('c', at(0), 0);
    s.see('c', at(100), 10);
    s.gone('c', 30);
    s.see('c', at(100), 32);
    expect(s.swinging('c', 40)).toBe(true);
  });

  it('a cable that comes back much later, or unmoved, does not swing', () => {
    const s = new CableSwings();
    s.see('c', at(0), 0);
    s.gone('c', 100);
    s.see('c', at(300), 100 + SWAY_REMOUNT_MS + 1);
    expect(s.swinging('c', 100 + SWAY_REMOUNT_MS + 2)).toBe(false);
    const t = new CableSwings();
    t.see('d', at(0), 0);
    t.gone('d', 100);
    t.see('d', at(0), 101);
    expect(t.swinging('d', 102)).toBe(false);
  });

  it('never swings under reduced motion', () => {
    const s = new CableSwings();
    s.see('c', at(0), 0, false);
    s.see('c', at(300), 10, false);
    expect(s.swinging('c', 20)).toBe(false);
  });
});

// r132, the wonky shelf cable: a cable from a shelf down into a bottom-row switch port sagged below
// the port and hooked back up into it, over the switch's other ports.
describe('a cable dropping from one port into another below it', () => {
  // Two ports in one rack: a shelf's "+3" chip above, a switch's bottom-row port 40 px below and 30 across.
  const chip: PortPoint = { x: 100, y: 10, w: 20, h: 12 };
  const bottomRow: PortPoint = { x: 126, y: 58, w: 8, h: 6, row: 1 };
  const shape = (style: 'physics' | 'square') =>
    cableShape({ style, id: 'c1', kind: 'copper', ends: [chip, bottomRow], source: { x: 0, y: 0 }, target: { x: 0, y: 0 } });

  it('leaves the chip from its bottom edge, not the middle of its name', () => {
    const { points } = shape('physics');
    expect(points[0]).toEqual({ x: 110, y: 22 });
    expect(points[1]!.y).toBeGreaterThan(22);
  });

  it('comes down into the bottom-row port from above and never sags below it', () => {
    const { points } = shape('physics');
    const end = points[points.length - 1]!;
    expect(end).toEqual({ x: 130, y: 58 });
    expect(lowest(points)).toBeLessThanOrEqual(58);
    // Falls the whole way: no hook back up anywhere along it.
    for (let i = 1; i < points.length; i++) expect(points[i]!.y).toBeGreaterThanOrEqual(points[i - 1]!.y - 1e-9);
  });

  it('keeps the row rule in the square style, and for a run between places', () => {
    const square = shape('square');
    expect(square.leads?.b.dir).toBe(1);
    const far: PortPoint = { ...bottomRow, x: 900 };
    const hung = cableShape({ style: 'physics', id: 'c1', kind: 'copper', ends: [chip, far], source: { x: 0, y: 0 }, target: { x: 0, y: 0 } });
    expect(hung.leads?.b.dir).toBe(1);
  });

  it('only when the plugs point at each other', () => {
    expect(plugsFace({ x: 0, y: 0, dir: 1 }, { x: 10, y: 50, dir: -1 })).toBe(true);
    expect(plugsFace({ x: 0, y: 0, dir: 1 }, { x: 10, y: 50, dir: 1 })).toBe(false);
    expect(plugsFace({ x: 0, y: 50, dir: -1 }, { x: 10, y: 0, dir: 1 })).toBe(true);
    expect(plugsFace({ x: 0, y: 0, dir: 1 }, { x: 10, y: 0, dir: -1 })).toBe(false);
  });
});

describe('shelfChipBox', () => {
  const node = (type: string, w: number, h: number) =>
    ({
      type,
      internals: { positionAbsolute: { x: 200, y: 300 }, handleBounds: { source: [{ id: 'p1', x: 40, y: 4, width: w, height: h }], target: null } },
    }) as unknown as Parameters<typeof shelfChipBox>[0];

  it('reads a compact shelf chip off the handle that covers it', () => {
    expect(shelfChipBox(node('shelf', 30, 12), 'p1')).toEqual({ x: 240, y: 304, w: 30, h: 12 });
  });

  it('is null for any other node, a missing handle, or a pin-sized handle', () => {
    expect(shelfChipBox(node('chassis', 30, 12), 'p1')).toBeNull();
    expect(shelfChipBox(node('shelf', 30, 12), 'p2')).toBeNull();
    expect(shelfChipBox(node('shelf', 1, 1), 'p1')).toBeNull();
    expect(shelfChipBox(undefined, 'p1')).toBeNull();
  });
});
