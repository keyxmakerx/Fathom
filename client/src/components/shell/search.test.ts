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
});
