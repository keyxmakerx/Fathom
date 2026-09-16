import { describe, expect, it } from 'vitest';

import type { ClosetView } from './contract';
import { findChassis, findPort, findRack } from './lookup';

const VIEW: ClosetView = {
  premisesId: 'closet-1',
  racks: [
    {
      id: 'rack-1',
      label: 'A-04',
      heightU: 42,
      unitNumbering: 'bottom-up',
      freeRuns: [],
      chassis: [
        {
          id: 'chassis-1',
          deviceId: 'device-1',
          hostname: 'core-01',
          model: 'EX4300-48P',
          vendor: 'juniper',
          positionU: 38,
          heightU: 1,
          face: 'front',
          ports: [
            { id: 'port-1', label: '0', connector: 'RJ45', row: 0, column: 0, uplink: false },
            { id: 'port-2', label: 'xe-0', connector: 'SFP+', row: 0, column: 1, uplink: true },
          ],
        },
      ],
    },
  ],
};

describe('findRack', () => {
  it('finds a rack by id', () => {
    expect(findRack(VIEW, 'rack-1')?.label).toBe('A-04');
  });

  it('returns undefined for an id this view does not carry', () => {
    expect(findRack(VIEW, 'nope')).toBeUndefined();
  });
});

describe('findChassis', () => {
  it('finds a chassis and the rack it sits in', () => {
    const found = findChassis(VIEW, 'chassis-1');
    expect(found?.rack.id).toBe('rack-1');
    expect(found?.chassis.hostname).toBe('core-01');
  });

  it('returns undefined for an id this view does not carry', () => {
    expect(findChassis(VIEW, 'nope')).toBeUndefined();
  });
});

describe('findPort', () => {
  it('finds a port and its chassis and rack', () => {
    const found = findPort(VIEW, 'port-2');
    expect(found?.rack.id).toBe('rack-1');
    expect(found?.chassis.id).toBe('chassis-1');
    expect(found?.port.uplink).toBe(true);
  });

  it('returns undefined for an id this view does not carry', () => {
    expect(findPort(VIEW, 'nope')).toBeUndefined();
  });
});
