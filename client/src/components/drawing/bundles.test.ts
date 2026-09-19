import { describe, expect, it } from 'vitest';

import type { CableView } from './contract';
import { bundleFor, fanOrder, groupBundles } from './bundles';

function cable(overrides: Partial<CableView> & Pick<CableView, 'id'>): CableView {
  return {
    kind: 'copper',
    media: 'cat6',
    sheath: 'grey',
    label: null,
    lengthM: null,
    ownership: null,
    ends: [
      { portId: `${overrides.id}-near`, chassisId: 'chassis-a', rackId: 'rack-1' },
      { portId: `${overrides.id}-far`, chassisId: 'chassis-b', rackId: 'rack-1' },
    ],
    ...overrides,
  };
}

describe('groupBundles', () => {
  it('three cables sharing both ends group into one bundle of three', () => {
    const cables = [cable({ id: 'c1' }), cable({ id: 'c2' }), cable({ id: 'c3' })];
    const bundles = groupBundles(cables);
    expect(bundles).toHaveLength(1);
    expect(bundles[0].members).toHaveLength(3);
    expect(bundles[0].members.map((m) => m.id).sort()).toEqual(['c1', 'c2', 'c3']);
  });

  it('the same two chassis in the opposite end order still bundle together', () => {
    const forward = cable({
      id: 'c1',
      ends: [
        { portId: 'p1', chassisId: 'chassis-a', rackId: 'rack-1' },
        { portId: 'p2', chassisId: 'chassis-b', rackId: 'rack-1' },
      ],
    });
    const backward = cable({
      id: 'c2',
      ends: [
        { portId: 'p3', chassisId: 'chassis-b', rackId: 'rack-1' },
        { portId: 'p4', chassisId: 'chassis-a', rackId: 'rack-1' },
      ],
    });
    expect(groupBundles([forward, backward])).toHaveLength(1);
  });

  it('a copper cable and a power cable between the same two chassis never share a band — different lanes', () => {
    const copper = cable({ id: 'c1', kind: 'copper' });
    const power = cable({ id: 'c2', kind: 'power' });
    const bundles = groupBundles([copper, power]);
    expect(bundles).toHaveLength(2);
  });

  it('a cable leaving to an outside end never bundles — nothing on the far side to share', () => {
    const outside = cable({
      id: 'c1',
      ends: [
        { portId: 'p1', chassisId: 'chassis-a', rackId: 'rack-1' },
        { outside: true, label: 'up the riser' },
      ],
    });
    expect(groupBundles([outside])).toEqual([]);
  });

  it('a single cable between two chassis is its own bundle of one', () => {
    const bundles = groupBundles([cable({ id: 'c1' })]);
    expect(bundles).toHaveLength(1);
    expect(bundles[0].members).toHaveLength(1);
  });

  it('cables between a different pair of chassis never join the same bundle', () => {
    const ab = cable({ id: 'c1' });
    const cd = cable({
      id: 'c2',
      ends: [
        { portId: 'p1', chassisId: 'chassis-c', rackId: 'rack-1' },
        { portId: 'p2', chassisId: 'chassis-d', rackId: 'rack-1' },
      ],
    });
    expect(groupBundles([ab, cd])).toHaveLength(2);
  });
});

describe('fanOrder', () => {
  it('orders members by their own port ids, independent of input order', () => {
    const c1 = cable({
      id: 'c1',
      ends: [
        { portId: 'z-port', chassisId: 'chassis-a', rackId: 'rack-1' },
        { portId: 'y-port', chassisId: 'chassis-b', rackId: 'rack-1' },
      ],
    });
    const c2 = cable({
      id: 'c2',
      ends: [
        { portId: 'a-port', chassisId: 'chassis-a', rackId: 'rack-1' },
        { portId: 'b-port', chassisId: 'chassis-b', rackId: 'rack-1' },
      ],
    });
    expect(fanOrder([c1, c2]).map((c) => c.id)).toEqual(['c2', 'c1']);
  });

  it('is total and stable: two members with identical port ids still order deterministically by cable id', () => {
    const c1 = cable({ id: 'c-two', ends: [{ portId: 'p', chassisId: 'chassis-a', rackId: 'rack-1' }, { portId: 'q', chassisId: 'chassis-b', rackId: 'rack-1' }] });
    const c2 = cable({ id: 'c-one', ends: [{ portId: 'p', chassisId: 'chassis-a', rackId: 'rack-1' }, { portId: 'q', chassisId: 'chassis-b', rackId: 'rack-1' }] });
    expect(fanOrder([c1, c2]).map((c) => c.id)).toEqual(['c-one', 'c-two']);
  });
});

describe('bundleFor', () => {
  it('finds the bundle a member cable id belongs to', () => {
    const cables = [cable({ id: 'c1' }), cable({ id: 'c2' })];
    const bundles = groupBundles(cables);
    expect(bundleFor(bundles, 'c2')?.members.map((m) => m.id).sort()).toEqual(['c1', 'c2']);
  });

  it('returns undefined for a cable id in no bundle', () => {
    expect(bundleFor([], 'nope')).toBeUndefined();
  });
});
