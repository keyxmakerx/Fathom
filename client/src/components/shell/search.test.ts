import { describe, expect, it } from 'vitest';

import type { ClosetView } from '../../document/view';
import { searchDesign } from './search';

type Racks = Pick<ClosetView, 'racks'>;

function port(id: string, label: string, cable: { farPortId: string | null; outsideCloset?: boolean } | null = null) {
  return { id, label, cable: cable && { cableId: `c-${id}`, farChassisId: null, outsideCloset: false, ...cable } };
}

const view = {
  racks: [
    {
      id: 'r1',
      label: 'A-04',
      heightU: 42,
      chassis: [
        { id: 'ch1', hostname: 'acc-01', model: 'EX2300-48P', serial: 'SN123', managementAddress: '10.0.0.5', positionU: 36, ports: [port('p1', '0', { farPortId: 'p3' }), port('p2', '6')] },
        { id: 'ch2', hostname: 'acc-02', model: 'EX2300-48P', serial: null, managementAddress: null, positionU: 35, ports: [] },
        { id: 'ch3', hostname: 'core-01', model: 'EX4300-48P', serial: null, managementAddress: null, positionU: 40, ports: [port('p3', '2', { farPortId: 'p1' })] },
      ],
    },
  ],
} as unknown as Racks;

describe('searchDesign — quick search over the open design', () => {
  it('finds nothing for an empty query', () => {
    expect(searchDesign(view, '   ')).toEqual([]);
  });

  it('matches devices by name, and not every port of them', () => {
    const hits = searchDesign(view, 'acc');
    expect(hits.map((h) => h.name)).toEqual(['acc-01', 'acc-02']);
    expect(hits[0].selection).toEqual({ kind: 'chassis', id: 'ch1' });
  });

  it('finds a device on a shelf or on a wall, desk or ceiling, not only in a rack unit', () => {
    const offRack = {
      racks: [{ id: 'r1', label: 'Rack 1', heightU: 12, chassis: [], shelves: [{ id: 's1', label: 'Shelf', positionU: 6, heightU: 1, occupants: [{ id: 'nas', kind: 'chassis', label: 'nas-1', model: 'DS224+', slot: 1, ports: [], sketch: false }] }] }],
      surfaces: [{ id: 'w1', label: 'Outside wall', form: 'wall', widthMm: 2000, heightMm: 2400, fixtures: [{ id: 'cam', kind: 'chassis', label: 'camera-1', model: null, form: null, xMm: 300, yMm: 2200, ports: [], psuInlets: [], fixtures: [] }] }],
    } as unknown as Pick<ClosetView, 'racks' | 'surfaces'>;
    expect(searchDesign(offRack, 'nas')[0]).toMatchObject({ group: 'Devices', name: 'nas-1', selection: { kind: 'occupant', id: 'nas' } });
    expect(searchDesign(offRack, 'camera')[0]).toMatchObject({ group: 'Devices', name: 'camera-1', where: 'Outside wall', selection: { kind: 'fixture', id: 'cam' } });
  });

  it('matches a device by serial or management address', () => {
    expect(searchDesign(view, 'sn123')[0].name).toBe('acc-01');
    expect(searchDesign(view, '10.0.0.5')[0].name).toBe('acc-01');
  });

  it('matches a port once the query reaches past the device name, naming its far end', () => {
    const hits = searchDesign(view, 'acc-01 · 0');
    expect(hits).toEqual([{ group: 'Ports', name: 'acc-01 · 0', why: 'cabled to core-01 · 2', selection: { kind: 'port', id: 'p1' } }]);
  });

  it('lists devices before racks before ports, and matches a rack by label', () => {
    expect(searchDesign(view, 'a-04').map((h) => h.group)).toEqual(['Racks']);
    expect(searchDesign(view, '0').map((h) => h.group)[0]).toBe('Devices');
  });

  it('finds a cable by its label or by a device at either end, and selects the cable', () => {
    const withCables = {
      ...view,
      cables: [
        { id: 'k1', label: 'UPLINK-7', ends: [{ portId: 'p1', chassisId: 'ch1', rackId: 'r1' }, { portId: 'p3', chassisId: 'ch3', rackId: 'r1' }] },
        { id: 'k2', label: null, ends: [{ portId: 'p2', chassisId: 'ch1', rackId: 'r1' }, { outside: true, label: 'ISP' }] },
      ],
    } as unknown as Pick<ClosetView, 'racks' | 'cables'>;
    const byLabel = searchDesign(withCables, 'uplink').filter((h) => h.group === 'Cables');
    expect(byLabel).toEqual([{ group: 'Cables', name: 'UPLINK-7', why: 'acc-01 ↔ core-01', selection: { kind: 'cable', id: 'k1' } }]);
    const byEnd = searchDesign(withCables, 'isp').filter((h) => h.group === 'Cables');
    expect(byEnd.map((h) => h.selection)).toEqual([{ kind: 'cable', id: 'k2' }]);
  });
});
