import { describe, expect, it } from 'vitest';

import type { OccupantView, PortView } from '../../document/view';
import { SHELF_INSIDE_MM, dropSpot, estimateSizeMm, layoutShelf } from './shelfLayout';

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
