import { describe, expect, it } from 'vitest';

import type { OverlayView } from '../../document/overlays';
import { HUB_H, HUB_W, edgePoint, overlayShapes } from './overlayDraw';

const box = (id: string, x: number, y: number) => ({ id, x, y, w: 100, h: 50 });
const vpn = (id: string, chassis: string[][]): OverlayView => ({
  id,
  name: id,
  provider: 'tailscale',
  range: null,
  note: null,
  members: chassis.map((c, i) => ({ edgeId: `e${i}`, deviceId: `d${i}`, hostname: `h${i}`, chassisIds: c, address: null, exitNode: false, routes: [] })),
});

describe('overlayShapes', () => {
  it('stops a line at the edge of a box', () => {
    expect(edgePoint({ x: 0, y: 0, w: 100, h: 50 }, { x: 500, y: 25 })).toEqual({ x: 100, y: 25 });
    expect(edgePoint({ x: 0, y: 0, w: 100, h: 50 }, { x: 50, y: -200 })).toEqual({ x: 50, y: 0 });
  });

  it('draws two members as one arc, bowed off their straight line, its name at the top', () => {
    const [s] = overlayShapes([vpn('v', [['a'], ['b']])], [box('a', 0, 0), box('b', 300, 0)]);
    expect(s.hub).toBeNull();
    expect(s.spokes).toHaveLength(1);
    const { a, b, c } = s.spokes[0];
    expect(c).toEqual({ x: 200, y: 25 - 100 });
    // Each end leaves its box toward the bend, on the box's edge.
    expect(a.y).toBe(0);
    expect(b.y).toBe(0);
    expect(s.mid!.x).toBeCloseTo(200);
    expect(s.mid!.y).toBeLessThan(0);
  });

  it('draws three as a badge off every box, with a spoke to each', () => {
    const boxes = [box('a', 0, 0), box('b', 300, 0), box('c', 150, 150)];
    const [s] = overlayShapes([vpn('v', [['a'], ['b'], ['c']])], boxes);
    expect(s.hub).not.toBeNull();
    expect(s.spokes).toHaveLength(3);
    const hub = { x: s.hub!.x - HUB_W / 2, y: s.hub!.y - HUB_H / 2, w: HUB_W, h: HUB_H };
    for (const b of boxes) expect(hub.x < b.x + b.w && b.x < hub.x + hub.w && hub.y < b.y + b.h && b.y < hub.y + hub.h).toBe(false);
  });

  it('counts members with no box but draws no spoke to them, and two badges never sit together', () => {
    const boxes = [box('a', 0, 0), box('b', 300, 0)];
    const shapes = overlayShapes([vpn('v', [['a'], ['b'], ['gone']]), vpn('w', [['a'], ['b'], []])], boxes);
    expect(shapes.map((s) => [s.drawn, s.spokes.length])).toEqual([[2, 2], [2, 2]]);
    expect(shapes[0].hub!.y).not.toBe(shapes[1].hub!.y);
    expect(overlayShapes([vpn('x', [['gone']])], boxes)).toEqual([]);
  });
});
