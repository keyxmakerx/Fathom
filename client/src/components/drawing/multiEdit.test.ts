import { describe, expect, it } from 'vitest';

import { deviceRows, planRackMove, selectionTitle, sharedValue, type DeviceRow } from './multiEdit';

const row = (id: string, heightU: number, rackId: string | null = null): DeviceRow => ({
  chassisId: id,
  deviceId: `d-${id}`,
  hostname: id,
  role: null,
  heightU,
  rackId,
  rackLabel: rackId,
});

const rack = (chassis: { positionU: number; heightU: number }[], heightU = 10) =>
  ({ id: 'r1', label: 'R1', heightU, chassis, shelves: [] }) as unknown as Parameters<typeof planRackMove>[0];

describe('planRackMove', () => {
  it('puts devices in the lowest free units, one after another', () => {
    const plan = planRackMove(rack([{ positionU: 1, heightU: 2 }]), [row('a', 1), row('b', 2)]);
    expect(plan).toEqual({ ok: true, moves: [{ itemId: 'a', rackId: 'r1', positionU: 3 }, { itemId: 'b', rackId: 'r1', positionU: 4 }], alreadyThere: 0 });
  });

  it('leaves a device already in the rack where it is', () => {
    const plan = planRackMove(rack([{ positionU: 1, heightU: 1 }]), [row('a', 1, 'r1'), row('b', 1)]);
    expect(plan).toMatchObject({ ok: true, alreadyThere: 1, moves: [{ itemId: 'b', positionU: 2 }] });
  });

  it('refuses plainly when there is not enough room, and moves nothing', () => {
    const plan = planRackMove(rack([{ positionU: 1, heightU: 9 }]), [row('a', 1), row('b', 1)]);
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.reason).toContain('1U free');
    expect(plan.ok === false && plan.reason).toContain('2U');
  });

  it('refuses when the gaps are too small for a tall device', () => {
    const plan = planRackMove(rack([{ positionU: 2, heightU: 1 }, { positionU: 4, heightU: 7 }], 10), [row('wide', 2)]);
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.reason).toContain('split up');
  });
});

describe('deviceRows and sharedValue', () => {
  it('reads racked and unplaced devices, in the order asked, skipping unknown ids', () => {
    const view = {
      racks: [{ id: 'r1', label: 'R1', chassis: [{ id: 'c1', deviceId: 'd1', hostname: 'one', role: 'switch', heightU: 2 }] }],
      unplaced: [{ id: 'c2', deviceId: 'd2', hostname: 'two', role: null, heightU: 4 }],
    } as unknown as Parameters<typeof deviceRows>[0];
    const rows = deviceRows(view, ['c2', 'gone', 'c1']);
    expect(rows.map((r) => r.chassisId)).toEqual(['c2', 'c1']);
    expect(rows[0]).toMatchObject({ heightU: 1, rackId: null });
    expect(rows[1]).toMatchObject({ heightU: 2, rackId: 'r1', rackLabel: 'R1' });
  });

  it('says shared or mixed', () => {
    expect(sharedValue(['a', 'a'])).toEqual({ kind: 'shared', value: 'a' });
    expect(sharedValue(['a', 'b'])).toEqual({ kind: 'mixed' });
    expect(sharedValue([])).toEqual({ kind: 'none' });
    expect(selectionTitle(3)).toBe('3 devices selected');
  });
});
