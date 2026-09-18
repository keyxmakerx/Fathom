import { describe, expect, it } from 'vitest';

import type { ClosetView } from './contract';
import { liveTargetPortIds } from './liveTargets';

const VIEW: ClosetView = {
  premisesId: 'closet-1',
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
          id: 'chassis-1',
          deviceId: 'device-1',
          hostname: 'core-01',
          model: 'EX4300-48P',
          vendor: 'juniper',
          positionU: 38,
          heightU: 1,
          face: 'front',
          role: null,
          managementAddress: null,
          serial: null,
          psuInlets: [],
          singleFed: false,
          oneFitted: false,
          placement: { kind: 'rack', rackId: 'rack-1', positionU: 38, face: 'front' },
          sketch: false,
          ports: [
            { id: 'rj45-free', label: '1', connector: 'rj45', row: 0, column: 0, role: null, uplink: false, cable: null, face: 'front', passThroughId: null },
            { id: 'rj45-free-2', label: '2', connector: 'RJ45', row: 0, column: 1, role: null, uplink: false, cable: null, face: 'front', passThroughId: null },
            { id: 'rj45-cabled', label: '3', connector: 'rj45', row: 0, column: 2, role: null, uplink: false, cable: { cableId: 'cable-1', farPortId: 'far', farChassisId: 'far-c', outsideCloset: false }, face: 'front', passThroughId: null },
            { id: 'sfp-free', label: 'xe-0', connector: 'sfp_plus', row: 1, column: 0, role: null, uplink: true, cable: null, face: 'front', passThroughId: null },
            { id: 'lc-free', label: 'lc-1', connector: 'lc', row: 1, column: 1, role: null, uplink: false, cable: null, face: 'front', passThroughId: null },
          ],
        },
      ],
    },
  ],
  cables: [],
};

describe('liveTargetPortIds', () => {
  it('a free rj45 lights only the other free rj45 ports', () => {
    const live = liveTargetPortIds(VIEW, 'rj45-free');
    expect(live.has('rj45-free-2')).toBe(true); // free, compatible (case-insensitive): lights
    expect(live.has('rj45-cabled')).toBe(false); // already cabled: never a target
    expect(live.has('sfp-free')).toBe(false); // wrong kind
    expect(live.has('lc-free')).toBe(false); // wrong kind
    expect(live.size).toBe(1);
  });

  it('a free SFP+ cage lights nothing else on this fixture (no other cage)', () => {
    expect(liveTargetPortIds(VIEW, 'sfp-free').size).toBe(0);
  });

  it('an already-cabled origin lights nothing — starting a second cable from a full port is not offered', () => {
    expect(liveTargetPortIds(VIEW, 'rj45-cabled').size).toBe(0);
  });

  it('an unknown origin id lights nothing rather than throwing', () => {
    expect(liveTargetPortIds(VIEW, 'nope').size).toBe(0);
  });

  it('the origin port itself is never in its own live set', () => {
    expect(liveTargetPortIds(VIEW, 'rj45-free').has('rj45-free')).toBe(false);
  });
});
