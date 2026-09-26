import { describe, expect, it } from 'vitest';

import type { ClosetView } from './contract';
import { groupPortals, portalCountLabel } from './portals';

function view(overrides: Partial<ClosetView> = {}): ClosetView {
  return {
    premisesId: 'closet-1',
    unplaced: [],
    rows: [],
    surfaces: [],
    racks: [
      {
        id: 'rack-1',
        label: 'A-04',
        heightU: 42,
        unitNumbering: 'bottom-up',
        freeRuns: [],
        row: null,
        bay: null,
        shelves: [],
        chassis: [
          {
            id: 'chassis-top',
            deviceId: 'device-top',
            hostname: 'hq-fw-01',
            model: 'SRX340',
            vendor: 'juniper',
            positionU: 40, // upper half of a 42U rack
            heightU: 2,
            face: 'front',
            role: null,
            managementAddress: null,
            serial: null,
            psuInlets: [],
            singleFed: false,
            oneFitted: false,
            ports: [],
            placement: { kind: 'rack', rackId: 'rack-1', positionU: 40, face: 'front' },
            sketch: false,
          },
          {
            id: 'chassis-bottom',
            deviceId: 'device-bottom',
            hostname: 'pdu-a04',
            model: 'PDU',
            vendor: 'apc',
            positionU: 3, // lower half
            heightU: 1,
            face: 'front',
            role: null,
            managementAddress: null,
            serial: null,
            psuInlets: [],
            singleFed: false,
            oneFitted: false,
            ports: [],
            placement: { kind: 'rack', rackId: 'rack-1', positionU: 3, face: 'front' },
            sketch: false,
          },
        ],
      },
    ],
    cables: [],
    ...overrides,
  };
}

describe('groupPortals', () => {
  it('groups two cables to the same far label into one tray, above a top-half chassis', () => {
    const closet = view({
      cables: [
        {
          id: 'cable-1',
          kind: 'fibre',
          media: 'om4',
          sheath: 'aqua',
          label: null,
          ends: [
            { portId: 'port-1', chassisId: 'chassis-top', rackId: 'rack-1' },
            { outside: true, label: 'up the riser → MDF A-01' },
          ],
        },
        {
          id: 'cable-2',
          kind: 'copper',
          media: 'cat6',
          sheath: 'grey',
          label: null,
          ends: [
            { portId: 'port-2', chassisId: 'chassis-top', rackId: 'rack-1' },
            { outside: true, label: 'up the riser → MDF A-01' },
          ],
        },
      ],
    });

    const groups = groupPortals(closet);
    expect(groups).toHaveLength(1);
    expect(groups[0].side).toBe('above');
    expect(groups[0].label).toBe('up the riser → MDF A-01');
    expect(groups[0].cables).toHaveLength(2);
    expect(portalCountLabel(groups[0])).toBe('1 fibre · 1 copper');
  });

  it('a cable from a bottom-half chassis groups into a tray below', () => {
    const closet = view({
      cables: [
        {
          id: 'cable-3',
          kind: 'copper',
          media: 'cat6',
          sheath: 'grey',
          label: null,
          ends: [
            { portId: 'port-3', chassisId: 'chassis-bottom', rackId: 'rack-1' },
            { outside: true, label: 'down to floor 2 desks' },
          ],
        },
      ],
    });

    const groups = groupPortals(closet);
    expect(groups).toHaveLength(1);
    expect(groups[0].side).toBe('below');
  });

  it('a different far label makes a second tray even on the same side', () => {
    const closet = view({
      cables: [
        {
          id: 'cable-a',
          kind: 'copper',
          media: 'cat6',
          sheath: 'grey',
          label: null,
          ends: [
            { portId: 'port-a', chassisId: 'chassis-top', rackId: 'rack-1' },
            { outside: true, label: 'up the riser → MDF A-01' },
          ],
        },
        {
          id: 'cable-b',
          kind: 'copper',
          media: 'cat6',
          sheath: 'grey',
          label: null,
          ends: [
            { portId: 'port-b', chassisId: 'chassis-top', rackId: 'rack-1' },
            { outside: true, label: 'up the riser → MDF B-02' },
          ],
        },
      ],
    });

    expect(groupPortals(closet)).toHaveLength(2);
  });

  it('a cable with both ends inside the closet never makes a tray', () => {
    const closet = view({
      cables: [
        {
          id: 'cable-inside',
          kind: 'copper',
          media: 'cat6',
          sheath: 'grey',
          label: null,
          ends: [
            { portId: 'port-x', chassisId: 'chassis-top', rackId: 'rack-1' },
            { portId: 'port-y', chassisId: 'chassis-bottom', rackId: 'rack-1' },
          ],
        },
      ],
    });

    expect(groupPortals(closet)).toEqual([]);
  });

  it('skips a cable whose near end names a chassis this view does not carry, rather than drawing a floating tray', () => {
    const closet = view({
      cables: [
        {
          id: 'cable-stale',
          kind: 'copper',
          media: 'cat6',
          sheath: 'grey',
          label: null,
          ends: [
            { portId: 'port-z', chassisId: 'chassis-does-not-exist', rackId: 'rack-1' },
            { outside: true, label: 'up the riser' },
          ],
        },
      ],
    });

    expect(groupPortals(closet)).toEqual([]);
  });

  it('an absent cables list reads as no portals, not a crash', () => {
    const closet = view();
    delete (closet as { cables?: unknown }).cables;
    expect(groupPortals(closet)).toEqual([]);
  });
});

describe('portalCountLabel', () => {
  it('orders fibre, then copper, then power, and omits a kind with none crossing', () => {
    const group = {
      cables: [
        { cableId: '1', kind: 'copper' as const, nearPortId: 'p1' },
        { cableId: '2', kind: 'power' as const, nearPortId: 'p2' },
        { cableId: '3', kind: 'fibre' as const, nearPortId: 'p3' },
        { cableId: '4', kind: 'fibre' as const, nearPortId: 'p4' },
      ],
    };
    expect(portalCountLabel(group)).toBe('2 fibre · 1 copper · 1 power');
  });
});
