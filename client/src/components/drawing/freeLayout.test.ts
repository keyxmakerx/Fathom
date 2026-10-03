import { describe, expect, it } from 'vitest';

import { alignRects, boundsOf, ghostSpot, groupRect, guidesFor, lineSides, nextFreeSpot, parseFreeNodeId, rectFromPoints, sidePoint, spreadRects, freeNodeId, labelNodeId, contains, overlaps } from './freeLayout';

const r = (x: number, y: number, w = 100, h = 50) => ({ x, y, w, h });

describe('align and spread', () => {
  const rects = [r(0, 0), r(150, 40, 60, 30), r(400, 100)];
  it('aligns edges and centres to the group bounds', () => {
    expect(alignRects(rects, 'left').map((p) => p.x)).toEqual([0, 0, 0]);
    expect(alignRects(rects, 'right').map((p) => p.x)).toEqual([400, 440, 400]);
    expect(alignRects(rects, 'top').map((p) => p.y)).toEqual([0, 0, 0]);
    expect(alignRects(rects, 'bottom').map((p) => p.y)).toEqual([100, 120, 100]);
    expect(alignRects(rects, 'centre').map((p) => p.x)).toEqual([200, 220, 200]);
    expect(alignRects(rects, 'middle').map((p) => p.y)).toEqual([50, 60, 50]);
  });
  it('spreads equal gaps and keeps the outer two', () => {
    const out = spreadRects(rects, 'x');
    expect(out[0]!.x).toBe(0);
    expect(out[2]!.x).toBe(400);
    expect(out[1]!.x - 100).toBeCloseTo(400 - (out[1]!.x + 60));
    expect(spreadRects(rects.slice(0, 2), 'x')).toEqual([{ x: 0, y: 0 }, { x: 150, y: 40 }]);
  });
  it('spread follows position, not input order', () => {
    const out = spreadRects([r(400, 0), r(0, 0), r(150, 0)], 'x');
    expect(out.map((p) => p.x)).toEqual([400, 0, expect.closeTo(200, 5)]);
  });
});

describe('guides', () => {
  it('snaps an edge within the threshold and reports a dotted line', () => {
    const g = guidesFor(r(103, 200), [r(100, 0)], 6);
    expect(g.dx).toBe(-3);
    expect(g.v.some((l) => l.x === 100)).toBe(true);
    expect(g.dy).toBe(0);
  });
  it('does nothing beyond the threshold', () => {
    const g = guidesFor(r(120, 300), [r(0, 0)], 6);
    expect(g).toMatchObject({ dx: 0, dy: 0, v: [], h: [] });
  });
  it('aligns centres', () => {
    const g = guidesFor(r(0, 0, 40, 40), [r(-30, 100, 100, 40)], 6);
    expect(g.dx).toBe(0); // centre 20 vs 20
    expect(g.v.some((l) => l.x === 20)).toBe(true);
  });
});

describe('lines and ghosts', () => {
  it('picks facing sides', () => {
    expect(lineSides(r(0, 0), r(300, 0))).toEqual({ a: 'r', b: 'l' });
    expect(lineSides(r(300, 0), r(0, 0))).toEqual({ a: 'l', b: 'r' });
    expect(lineSides(r(0, 0), r(0, 300))).toEqual({ a: 'b', b: 't' });
  });
  it('side points sit on the edge midpoints', () => {
    expect(sidePoint(r(10, 20), 'r')).toEqual({ x: 110, y: 45 });
    expect(sidePoint(r(10, 20), 't')).toEqual({ x: 60, y: 20 });
  });
  it('a ghost lands beside the box, on the grid', () => {
    expect(ghostSpot(r(0, 0, 128, 56), 'r')).toEqual({ x: 176, y: 0 });
    expect(ghostSpot(r(0, 0, 128, 56), 'b')).toEqual({ x: 0, y: 104 });
  });
});

describe('placing and ids', () => {
  it('finds the first free grid cell', () => {
    expect(nextFreeSpot([])).toEqual({ x: 40, y: 40 });
    expect(nextFreeSpot([r(40, 40, 128, 56)])).toEqual({ x: 200, y: 40 });
  });
  it('group rect wraps with padding and room for a title', () => {
    const g = groupRect([r(100, 100), r(300, 100)]);
    expect(contains(g, boundsOf([r(100, 100), r(300, 100)]))).toBe(true);
    expect(g.x % 4).toBe(0);
  });
  it('geometry helpers', () => {
    expect(rectFromPoints({ x: 10, y: 10 }, { x: 0, y: 30 })).toEqual({ x: 0, y: 10, w: 10, h: 20 });
    expect(overlaps(r(0, 0), r(50, 10))).toBe(true);
    expect(overlaps(r(0, 0), r(100, 0))).toBe(false);
  });
  it('node ids round-trip', () => {
    expect(parseFreeNodeId(freeNodeId('chassis:abc'))).toEqual({ kind: 'box', id: 'chassis:abc' });
    expect(parseFreeNodeId(labelNodeId('label:abc'))).toEqual({ kind: 'label', id: 'label:abc' });
    expect(parseFreeNodeId('rack:1')).toBeNull();
  });
});
