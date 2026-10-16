import { describe, expect, it } from 'vitest';

import type { Leads } from './cableEnds';
import { distanceTo, shapeOf } from './cableHover';
import {
  FADE_STUB_PX,
  fadeTips,
  laneOffsetPx,
  planTies,
  pointAlong,
  polylineLength,
  polylinePath,
  squarePoints,
  SQUARE_LEAD_PX,
  swayAt,
  swayKick,
  SWAY_MAX_PX,
  SWAY_SETTLE_MS,
  throughTies,
  tiedPoints,
  type Pt,
} from './cableRoute';

const leads = (ax: number, ay: number, adir: 1 | -1, bx: number, by: number, bdir: 1 | -1): Leads => ({
  a: { x: ax, y: ay, dir: adir },
  b: { x: bx, y: by, dir: bdir },
});

function onlySquareCorners(points: readonly Pt[]) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    expect(a.x === b.x || a.y === b.y).toBe(true);
  }
}

describe('right-angle', () => {
  it('drops, crosses and drops between a port above and a port below', () => {
    const pts = squarePoints(leads(10, 0, 1, 110, 100, -1));
    expect(pts).toEqual([
      { x: 10, y: 0 },
      { x: 10, y: 50 },
      { x: 110, y: 50 },
      { x: 110, y: 100 },
    ]);
  });
  it('goes round when both ports face the same way', () => {
    const pts = squarePoints(leads(0, 0, 1, 50, 20, 1));
    onlySquareCorners(pts);
    expect(Math.max(...pts.map((p) => p.y))).toBe(20 + SQUARE_LEAD_PX);
  });
  it('takes two corners when the ports face apart', () => {
    const pts = squarePoints(leads(0, 0, -1, 80, 100, 1));
    onlySquareCorners(pts);
    expect(pts[1]).toEqual({ x: 0, y: -SQUARE_LEAD_PX });
    expect(pts[pts.length - 2]).toEqual({ x: 80, y: 100 + SQUARE_LEAD_PX });
  });
  it('leaves a straight drop as one segment', () => {
    expect(squarePoints(leads(5, 0, 1, 5, 100, -1))).toHaveLength(2);
  });
  it('steps two cables sharing a run apart, the same way every time', () => {
    expect(laneOffsetPx('01A', 'copper')).toBe(laneOffsetPx('01A', 'copper'));
    const offsets = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => laneOffsetPx(id, 'copper')));
    expect(offsets.size).toBeGreaterThan(1);
    expect(laneOffsetPx('a', 'power')).toBe(laneOffsetPx('a', 'copper') - 6);
  });
  it('writes a plain path', () => {
    expect(polylinePath([{ x: 0, y: 0 }, { x: 0, y: 1.234 }])).toBe('M 0 0 L 0 1.23');
  });
});

describe('cable-tied', () => {
  // A switch at y 0 with three ports, and three devices below it to the right (the r15 drawing).
  const hub = (x: number) => ({ x, y: 10, dir: 1 as const });
  const far = (x: number, y: number) => ({ x, y, dir: -1 as const });
  const cables = [
    { id: 'blue', chassis: ['sw', 'nas'] as [string, string], leads: { a: hub(20), b: far(240, 200) } },
    { id: 'yellow', chassis: ['sw', 'ap'] as [string, string], leads: { a: hub(40), b: far(300, 220) } },
    { id: 'green', chassis: ['sw', 'router'] as [string, string], leads: { a: hub(60), b: far(380, 120) } },
  ];

  it('bundles cables leaving one device toward one side', () => {
    const plan = planTies(cables);
    expect([...plan.routes.keys()].sort()).toEqual(['blue', 'green', 'yellow']);
    const r = cables.map((c) => plan.routes.get(c.id)!);
    // The port furthest from the riser takes the outermost trunk and the first riser.
    expect(r[0]!.trunkY).toBeGreaterThan(r[1]!.trunkY);
    expect(r[1]!.trunkY).toBeGreaterThan(r[2]!.trunkY);
    expect(r[0]!.riserX).toBeLessThan(r[1]!.riserX);
    expect(r[1]!.riserX).toBeLessThan(r[2]!.riserX);
    // The riser clears every port on the hub.
    expect(r[0]!.riserX).toBeGreaterThanOrEqual(60 + SQUARE_LEAD_PX);
  });

  it('ties the bundle where its cables run together, drawn by its first cable', () => {
    const plan = planTies(cables);
    const ties = plan.ties.get('blue');
    expect(ties).toBeDefined();
    expect(ties!.length).toBeGreaterThan(0);
    expect(plan.ties.has('yellow')).toBe(false);
  });

  it('leaves a lone cable and cables heading the other way out of a bundle', () => {
    const plan = planTies([cables[0]!, { id: 'left', chassis: ['sw', 'pc'], leads: { a: hub(30), b: far(-200, 200) } }]);
    expect(plan.routes.size).toBe(0);
  });

  it('routes from whichever end is the hub', () => {
    const flipped = cables.map((c) => ({ ...c, chassis: [c.chassis[1], c.chassis[0]] as [string, string], leads: { a: c.leads.b, b: c.leads.a } }));
    const plan = planTies(flipped);
    const route = plan.routes.get('blue')!;
    expect(route.hubEnd).toBe(1);
    const pts = tiedPoints(flipped[0]!.leads, route);
    expect(pts[0]).toEqual({ x: 240, y: 200 });
    expect(pts[pts.length - 1]).toEqual({ x: 20, y: 10 });
    onlySquareCorners(pts);
  });
});

describe('faded', () => {
  const line = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }];
  it('shows about an inch at each end and fades toward the middle', () => {
    const tips = fadeTips(line)!;
    expect(tips.total).toBe(200);
    expect(tips.to[0]).toEqual({ x: 0, y: FADE_STUB_PX });
    expect(tips.to[1]).toEqual({ x: 100 - FADE_STUB_PX, y: 100 });
  });
  it('draws a short cable whole rather than fading it away', () => {
    expect(fadeTips([{ x: 0, y: 0 }, { x: 0, y: 60 }])).toBeNull();
  });
  it('measures and walks a line', () => {
    expect(polylineLength(line)).toBe(200);
    expect(pointAlong(line, 150)).toEqual({ x: 50, y: 100 });
    expect(pointAlong(line, 999)).toEqual({ x: 100, y: 100 });
  });
});

describe('physics sway', () => {
  it('lags behind a move, swings back past rest and settles', () => {
    const amp = swayKick({ x: 0, y: 0 }, { x: 20, y: 0 });
    expect(amp.x).toBeLessThan(0);
    expect(swayAt(amp, 0).x).toBe(amp.x);
    expect(swayAt(amp, 310).x).toBeGreaterThan(0);
    expect(swayAt(amp, SWAY_SETTLE_MS)).toEqual({ x: 0, y: 0 });
  });
  it('never throws a cable across the drawing, however far the drag', () => {
    expect(Math.abs(swayKick({ x: 0, y: 0 }, { x: 5000, y: -5000 }).x)).toBe(SWAY_MAX_PX);
  });
});

describe('through real ties', () => {
  it('runs along a lacing bar through its tie, square all the way', () => {
    const l = leads(100, 0, 1, 300, 200, -1);
    const pts = throughTies(l, [{ x: 20, y: 100, vertical: true }]);
    onlySquareCorners(pts);
    expect(distanceTo({ x: 20, y: 100 }, shapeOf(pts))).toBe(0);
    expect(pts[0]).toEqual({ x: 100, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 300, y: 200 });
  });
  it('drops to a tray and runs along it', () => {
    const pts = throughTies(leads(100, 50, -1, 300, 50, -1), [{ x: 200, y: -10, vertical: false }]);
    onlySquareCorners(pts);
    expect(distanceTo({ x: 200, y: -10 }, shapeOf(pts))).toBe(0);
  });
  it('without a tie is plain right-angle', () => {
    const l = leads(0, 0, 1, 50, 100, -1);
    expect(throughTies(l, [])).toEqual(squarePoints(l));
  });
});
