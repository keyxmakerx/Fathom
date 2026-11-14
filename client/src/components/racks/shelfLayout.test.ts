import { describe, expect, it } from 'vitest';

import type { OccupantView, PortView } from '../../document/view';
import { SHELF_DEPTH_MM, SHELF_INSIDE_MM, depthSlide, depthSpot, dropOnPlan, dropSpot, estimateSizeMm, faceSpan, fromFace, hiddenBehind, layoutShelf, onFace, sizeOf } from './shelfLayout';

function ports(n: number, face: 'front' | 'rear' = 'front'): PortView[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, label: `${i + 1}`, connector: 'rj45', row: 0, column: i, uplink: false, role: null, cable: null, face, passThroughId: null }) as PortView);
}

function occ(id: string, slot: number, extra: Partial<OccupantView> = {}): OccupantView {
  return { id, kind: 'chassis', label: id, model: null, slot, ports: ports(8), sketch: false, ...extra };
}

describe('estimateSizeMm', () => {
  it('grows with the ports on its busier face', () => {
    expect(estimateSizeMm({ kind: 'chassis', ports: ports(8) }).wMm).toBeLessThan(estimateSizeMm({ kind: 'chassis', ports: ports(16) }).wMm);
    expect(estimateSizeMm({ kind: 'chassis', ports: ports(1, 'rear') }).wMm).toBeGreaterThanOrEqual(70);
  });
  it('never wider than the shelf', () => {
    expect(estimateSizeMm({ kind: 'chassis', ports: ports(52) }).wMm).toBeLessThanOrEqual(SHELF_INSIDE_MM);
  });
});

describe('layoutShelf', () => {
  it('keeps a placed thing where it was put and packs the rest by slot round it', () => {
    const items = layoutShelf([occ('b', 2), occ('a', 1, { xMm: 0 }), occ('c', 3)]);
    const [b, a, c] = items;
    expect(a).toMatchObject({ xMm: 0, placed: true });
    expect(b!.placed).toBe(false);
    expect(b!.xMm).toBeGreaterThanOrEqual(a!.xMm + a!.wMm);
    expect(c!.xMm).toBeGreaterThanOrEqual(b!.xMm + b!.wMm);
  });
  it('draws things sharing a slot side by side, not on top of each other', () => {
    const items = layoutShelf([occ('a', 0), occ('b', 0)]);
    expect(items[0]!.xMm).not.toBe(items[1]!.xMm);
  });
  it('marks what does not fit, past the right end', () => {
    const wide = { ports: ports(40) };
    const items = layoutShelf([occ('a', 1, wide), occ('b', 2, wide), occ('c', 3, wide)]);
    expect(items.some((it) => it.over && it.xMm >= SHELF_INSIDE_MM)).toBe(true);
  });
});

describe('dropSpot', () => {
  const others = [{ xMm: 100, wMm: 100 }];
  it('snaps to 10 mm steps', () => {
    expect(dropSpot([], 50, 33, true)).toBe(30);
    expect(dropSpot([], 50, 33, false)).toBe(33);
  });
  it('pulls flush against a neighbour', () => {
    expect(dropSpot(others, 50, 205, true)).toBe(200);
    expect(dropSpot(others, 50, 46, true)).toBe(50);
  });
  it('never overlaps: moves to the nearest gap it fits', () => {
    expect(dropSpot(others, 50, 120, false)).toBe(50);
    expect(dropSpot(others, 50, 180, false)).toBe(200);
  });
  it('stays inside the shelf', () => {
    expect(dropSpot([], 50, -20, false)).toBe(0);
    expect(dropSpot([], 50, 1000, false)).toBe(SHELF_INSIDE_MM - 50);
  });
  it('is null when it fits nowhere', () => {
    expect(dropSpot([{ xMm: 0, wMm: SHELF_INSIDE_MM }], 50, 10, false)).toBeNull();
  });
});

describe('sizeOf', () => {
  it('uses the catalogue size when the model has one, and says it is not a guess', () => {
    expect(sizeOf({ kind: 'chassis', ports: ports(8), sizeMm: { widthMm: 158, depthMm: 101, heightMm: 25 } })).toEqual({ wMm: 158, dMm: 101, hMm: 25, sized: true });
  });
  it('estimates otherwise, with a depth that fits on the shelf', () => {
    const s = sizeOf({ kind: 'chassis', ports: ports(8) });
    expect(s.sized).toBe(false);
    expect(s.dMm).toBeLessThan(SHELF_DEPTH_MM);
  });
});

describe('depth on a shelf', () => {
  it('a placed thing keeps how far back it was set; an unplaced one sits at the front', () => {
    const [a, b] = layoutShelf([occ('a', 1, { xMm: 0, yMm: 120 }), occ('b', 2)]);
    expect(a!.yMm).toBe(120);
    expect(b!.yMm).toBe(0);
  });
  it('a thing set back does not push the front row along', () => {
    // a is set right back, so b can be packed in front of it at the left end.
    const [, b] = layoutShelf([occ('a', 1, { xMm: 0, yMm: 200, ports: ports(4) }), occ('b', 2, { ports: ports(4) })]);
    expect(b!.xMm).toBe(0);
  });
  it('depthSpot snaps to the front, the back and 10 mm steps, and never past the back', () => {
    expect(depthSpot(100, 5, true)).toBe(0);
    expect(depthSpot(100, 63, true)).toBe(60);
    expect(depthSpot(100, 195, true)).toBe(SHELF_DEPTH_MM - 100);
    expect(depthSpot(100, 999, false)).toBe(SHELF_DEPTH_MM - 100);
    expect(depthSpot(SHELF_DEPTH_MM + 50, 40, true)).toBe(0);
  });
  it('dropOnPlan lets one thing sit behind another but never on it', () => {
    const front = [{ xMm: 0, wMm: 100, yMm: 0, dMm: 100 }];
    // Behind it, the same spot along the shelf is free.
    expect(dropOnPlan(front, { wMm: 100, dMm: 100 }, 0, 150, true)).toEqual({ xMm: 0, yMm: 150 });
    // In its row, it is moved along to the nearest gap instead.
    expect(dropOnPlan(front, { wMm: 100, dMm: 100 }, 20, 0, true)).toEqual({ xMm: 100, yMm: 0 });
  });
});

describe('the four sides', () => {
  const box = { xMm: 100, wMm: 50, yMm: 20, dMm: 80 };

  it('sees a box from each side as you would standing there', () => {
    expect(onFace(box, 'front')).toEqual({ u: 100, uw: 50, v: 20, vd: 80 });
    expect(onFace(box, 'rear')).toEqual({ u: 300, uw: 50, v: 200, vd: 80 });
    // From the right end the front is on the left; from the left end, on the right.
    expect(onFace(box, 'right')).toEqual({ u: 20, uw: 80, v: 300, vd: 50 });
    expect(onFace(box, 'left')).toEqual({ u: 200, uw: 80, v: 100, vd: 50 });
    expect(faceSpan('left')).toEqual({ alongMm: 300, awayMm: 450 });
  });

  it('turns a move seen from a side back into one along and back on the shelf', () => {
    for (const face of ['front', 'right', 'rear', 'left'] as const) {
      const { dx, dy } = fromFace(face, 7, 3);
      const moved = onFace({ ...box, xMm: box.xMm + dx, yMm: box.yMm + dy }, face);
      const was = onFace(box, face);
      expect([moved.u - was.u, moved.v - was.v]).toEqual([7, 3]);
    }
  });

  it('slides front to back only among the things it shares width with', () => {
    const others = [
      { xMm: 0, wMm: 120, yMm: 100, dMm: 50 },
      { xMm: 300, wMm: 100, yMm: 0, dMm: 200 },
    ];
    // Wanting 90 mm back runs into the first; it is moved to the nearest gap.
    expect(depthSlide(others, { xMm: 50, wMm: 40, dMm: 60 }, 90, false)).toBe(40);
    // The second is not in its line, so it does not block.
    expect(depthSlide(others, { xMm: 200, wMm: 40, dMm: 60 }, 90, false)).toBe(90);
  });

  it('is behind when something nearer overlaps it from that side', () => {
    const front = { xMm: 0, wMm: 100, yMm: 0, dMm: 50 };
    const back = { xMm: 50, wMm: 100, yMm: 100, dMm: 50 };
    expect(hiddenBehind(back, [front], 'front')).toBe(true);
    expect(hiddenBehind(front, [back], 'front')).toBe(false);
    expect(hiddenBehind(front, [back], 'rear')).toBe(true);
    // From the right end the one further right is nearer, when they share depth.
    const right = { xMm: 200, wMm: 100, yMm: 20, dMm: 50 };
    expect(hiddenBehind(front, [right], 'right')).toBe(true);
    expect(hiddenBehind(front, [right], 'left')).toBe(false);
    expect(hiddenBehind(front, [back], 'right')).toBe(false);
  });
});
