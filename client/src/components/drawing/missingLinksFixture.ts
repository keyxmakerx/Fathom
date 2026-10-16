/** A small closet for the Missing links tests: two switches and one cable of every kind. */

import type { CableView, ChassisView, ClosetView, PortView } from './contract';

function port(id: string, label: string, cable: PortView['cable'] = null): PortView {
  return { id, label, connector: 'rj45', row: 0, column: 0, role: null, uplink: false, cable, face: 'front', passThroughId: null };
}

const OPEN = { farPortId: null, farChassisId: null, outsideCloset: false } as const;

function chassis(id: string, hostname: string, ports: PortView[], positionU: number): ChassisView {
  return {
    id,
    deviceId: `device-${id}`,
    hostname,
    model: 'X',
    vendor: 'test',
    positionU,
    heightU: 1,
    face: 'front',
    role: null,
    managementAddress: null,
    serial: null,
    psuInlets: [],
    singleFed: false,
    oneFitted: false,
    placement: { kind: 'rack', rackId: 'rack-1', positionU, face: 'front' },
    sketch: false,
    ports,
  };
}

function cable(id: string, extra: Partial<CableView>): CableView {
  return { id, kind: 'copper', media: 'cat6', sheath: 'blue', label: null, lengthM: null, ownership: null, ends: [], ...extra };
}

const end = (portId: string, chassisId: string) => ({ portId, chassisId, rackId: 'rack-1' });

export const NEEDS_A = 'cable-needs-a';
export const NEEDS_B = 'cable-needs-b';
export const UNKNOWN_A = 'cable-unknown-a';
export const UNKNOWN_B = 'cable-unknown-b';
export const WHOLE = 'cable-whole';
export const OUTSIDE = 'cable-outside';

export function missingLinksView(): ClosetView {
  const sw1 = chassis(
    'ch-1',
    'sw-01',
    [
      port('p1-3', '3', { cableId: NEEDS_A, ...OPEN }),
      port('p1-4', '4', { cableId: UNKNOWN_A, ...OPEN }),
      port('p1-5', '5', { cableId: WHOLE, farPortId: 'p2-5', farChassisId: 'ch-2', outsideCloset: false }),
      port('p1-6', '6', { cableId: OUTSIDE, farPortId: null, farChassisId: null, outsideCloset: true }),
      port('p1-7', '7'),
    ],
    10,
  );
  const sw2 = chassis(
    'ch-2',
    'sw-02',
    [
      port('p2-1', '1', { cableId: UNKNOWN_B, ...OPEN }),
      port('p2-5', '5', { cableId: WHOLE, farPortId: 'p1-5', farChassisId: 'ch-1', outsideCloset: false }),
      port('p2-10', '10', { cableId: NEEDS_B, ...OPEN }),
    ],
    20,
  );
  return {
    premisesId: 'closet-1',
    unplaced: [],
    free: [],
    lines: [],
    labels: [],
    rows: [],
    surfaces: [],
    racks: [{ id: 'rack-1', label: 'R1', heightU: 42, unitNumbering: 'bottom-up', freeRuns: [], row: null, bay: null, shelves: [], chassis: [sw1, sw2] }],
    cables: [
      cable(NEEDS_A, { looseEnd: true, needsFinishing: true, label: 'to patch panel', ends: [end('p1-3', 'ch-1')] }),
      cable(NEEDS_B, { looseEnd: true, needsFinishing: true, ends: [end('p2-10', 'ch-2')] }),
      cable(UNKNOWN_A, { looseEnd: true, needsFinishing: false, ends: [end('p1-4', 'ch-1')] }),
      cable(UNKNOWN_B, { looseEnd: true, ends: [end('p2-1', 'ch-2')] }),
      // Both ends connected: a stale Needs finishing mark does not make it loose.
      cable(WHOLE, { looseEnd: false, needsFinishing: true, ends: [end('p1-5', 'ch-1'), end('p2-5', 'ch-2')] }),
      cable(OUTSIDE, { looseEnd: false, ends: [end('p1-6', 'ch-1'), { outside: true, label: 'ISP' }] }),
    ],
  };
}
