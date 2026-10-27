import { describe, expect, it } from 'vitest';

import { CABLE_DRAPE_MAX_PX, cableLeadCubic, cableLeadPath, leadsFor, placeLabels } from './cableEnds';
import { CABLE_SAG_MAX_PX } from './geometry';

describe('leadsFor', () => {
  it('leaves each port from the edge facing the other end', () => {
    const a = { x: 10, y: 0, w: 8, h: 6 };
    const b = { x: 30, y: 100, w: 8, h: 6 };
    const l = leadsFor(a, b, { x: 0, y: 0 }, { x: 0, y: 0 });
    expect(l.a).toEqual({ x: 14, y: 6, dir: 1 });
    expect(l.b).toEqual({ x: 34, y: 100, dir: -1 });
    expect(cableLeadPath(l)).toMatch(/^M 14 6 C /);
  });
  it('keeps the given point for an end with no port box', () => {
    const l = leadsFor({ x: 0, y: 0, w: 4, h: 4 }, null, { x: 0, y: 0 }, { x: 50, y: 60 });
    expect(l.b).toEqual({ x: 50, y: 60, dir: -1 });
  });
});

describe('placeLabels', () => {
  it('steps a label out a line when it would touch its neighbour', () => {
    const items = [1, 2, 3].map((n) => ({ key: `k${n}`, x: n * 2, y: 10, dir: 1 as const, text: String(n) }));
    const placed = placeLabels(items, 4);
    const dys = items.map((i) => placed.get(i.key)!.dy);
    expect(new Set(dys).size).toBe(3);
  });
  it('leaves well separated labels on the same line', () => {
    const items = [0, 40].map((x) => ({ key: `k${x}`, x, y: 10, dir: 1 as const, text: '1' }));
    const placed = placeLabels(items, 4);
    expect(placed.get('k0')!.dy).toBe(placed.get('k40')!.dy);
  });
});

describe('cableLeadCubic', () => {
  it('drapes a long run out of each port instead of cutting straight across', () => {
    const c = cableLeadCubic({ a: { x: 0, y: 0, dir: 1 }, b: { x: 600, y: 800, dir: -1 } });
    expect(c.c1.y).toBeGreaterThan(CABLE_SAG_MAX_PX);
    expect(c.c1.y).toBeLessThanOrEqual(CABLE_DRAPE_MAX_PX);
    expect(800 - c.c2.y).toBeGreaterThan(CABLE_SAG_MAX_PX);
  });
  it('keeps a short bow on an end that faces away, so it never loops over its neighbours', () => {
    const c = cableLeadCubic({ a: { x: 0, y: 0, dir: -1 }, b: { x: 600, y: 800, dir: -1 } });
    expect(-c.c1.y).toBeLessThanOrEqual(CABLE_SAG_MAX_PX);
  });
  it('leaves a short hop as it was', () => {
    const c = cableLeadCubic({ a: { x: 0, y: 0, dir: 1 }, b: { x: 10, y: 20, dir: -1 } });
    expect(c.c1.y).toBe(8);
  });
});
