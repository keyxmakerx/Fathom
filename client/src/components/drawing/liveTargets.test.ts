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

// ADR-0051 §1/§2 — a drag's own live targets reach a shelf occupant's port
// and a surface fixture's (a board's nested fixture included), not only a
// rack chassis's.
describe('liveTargetPortIds — shelf occupants and surface fixtures (ADR-0051 §1/§2)', () => {
  const VIEW_WITH_PLACES: ClosetView = {
    ...VIEW,
    racks: [
      {
        ...VIEW.racks[0]!,
        shelves: [
          {
            id: 'shelf-1',
            label: 'shelf-a01',
            positionU: 20,
            heightU: 1,
            occupants: [
              {
                id: 'occupant-1',
                kind: 'chassis',
                label: 'nuc-01',
                model: null,
                slot: 1,
                sketch: true,
                ports: [
                  { id: 'occupant-rj45', label: 'eth0', connector: 'rj45', row: 0, column: 0, role: null, uplink: false, cable: null, face: 'front', passThroughId: null },
                ],
              },
            ],
          },
        ],
      },
    ],
    surfaces: [
      {
        id: 'wall-west',
        label: 'west wall',
        form: 'wall',
        widthMm: null,
        heightMm: null,
        fixtures: [
          {
            id: 'outlet-w1',
            kind: 'passive',
            label: 'outlet-w1',
            model: null,
            form: 'outlet',
            xMm: null,
            yMm: null,
            ports: [
              { id: 'outlet-rj45', label: '1', connector: 'rj45', row: 0, column: 0, role: null, uplink: false, cable: null, face: 'front', passThroughId: null },
            ],
            psuInlets: [],
            fixtures: [],
          },
        ],
      },
    ],
  };

  it('a drag started on a chassis port lights a compatible shelf occupant port', () => {
    expect(liveTargetPortIds(VIEW_WITH_PLACES, 'rj45-free').has('occupant-rj45')).toBe(true);
  });

  it('a drag started on a chassis port lights a compatible surface fixture port', () => {
    expect(liveTargetPortIds(VIEW_WITH_PLACES, 'rj45-free').has('outlet-rj45')).toBe(true);
  });

  it('a drag started on a shelf occupant port lights compatible targets everywhere, including the rack', () => {
    const live = liveTargetPortIds(VIEW_WITH_PLACES, 'occupant-rj45');
    expect(live.has('rj45-free')).toBe(true);
    expect(live.has('outlet-rj45')).toBe(true);
  });
});
