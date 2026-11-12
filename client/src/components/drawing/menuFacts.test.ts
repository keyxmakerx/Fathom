import { describe, expect, it } from 'vitest';

import type { ClosetView } from './contract';
import { cableEndsOf, portFactsOf } from './menuFacts';

const port = (id: string, cable: { cableId: string; farPortId: string | null } | null) =>
  ({ id, label: id, connector: 'rj45', face: 'front', cable: cable == null ? null : { ...cable, farChassisId: null, outsideCloset: false } }) as never;

const chassis = (id: string, ports: unknown[]) => ({ id, deviceId: `d-${id}`, hostname: id, model: '', vendor: '', positionU: 1, heightU: 1, face: 'front', ports, psuInlets: [] }) as never;

const VIEW = {
  premisesId: 'p',
  racks: [
    {
      id: 'r1',
      label: 'Rack 1',
      heightU: 42,
      chassis: [chassis('c1', [port('p1', { cableId: 'k1', farPortId: 'p2' }), port('p3', null), port('p4', { cableId: 'k2', farPortId: null })]), chassis('c2', [port('p2', { cableId: 'k1', farPortId: 'p1' })])],
      shelves: [],
    },
  ],
  cables: [
    { id: 'k1', ends: [{ portId: 'p1', chassisId: 'c1', rackId: 'r1' }, { portId: 'p2', chassisId: 'c2', rackId: 'r1' }] },
    { id: 'k2', ends: [{ portId: 'p4', chassisId: 'c1', rackId: 'r1' }, { outside: true, label: 'Site B', far: { design: 'd2', element: 'port:7' } }] },
    { id: 'k3', ends: [{ portId: 'p9', chassisId: 'c9', rackId: null }] },
  ],
  surfaces: [],
  unplaced: [],
  free: [],
} as unknown as ClosetView;

describe('portFactsOf', () => {
  it('reads a cabled port: its cable, the far port and the device a trace starts from', () => {
    expect(portFactsOf(VIEW, 'p1')).toEqual({ cableId: 'k1', farPortId: 'p2', far: null, deviceId: 'c1' });
  });
  it('reads a free port as having no cable', () => {
    expect(portFactsOf(VIEW, 'p3')).toEqual({ cableId: null, farPortId: null, far: null, deviceId: 'c1' });
  });
  it('reads a link between sites as the far design and port', () => {
    expect(portFactsOf(VIEW, 'p4')).toEqual({ cableId: 'k2', farPortId: null, far: { design: 'd2', element: 'port:7' }, deviceId: 'c1' });
  });
  it('is null for a port this view does not carry', () => {
    expect(portFactsOf(VIEW, 'nope')).toBeNull();
  });
});

describe('cableEndsOf', () => {
  it('gives end A then end B, with the port to go to', () => {
    const [a, b] = cableEndsOf(VIEW, 'k1');
    expect(a).toEqual({ portId: 'p1', chassisId: 'c1', far: null });
    expect(b).toEqual({ portId: 'p2', chassisId: 'c2', far: null });
  });
  it('reads an outside end as a far site, or as nothing to go to', () => {
    expect(cableEndsOf(VIEW, 'k2')[1]).toEqual({ portId: null, chassisId: null, far: { design: 'd2', element: 'port:7' } });
  });
  it('has no end B on a cable with one end', () => {
    const [a, b] = cableEndsOf(VIEW, 'k3');
    expect(a?.portId).toBe('p9');
    expect(b).toBeNull();
  });
  it('has neither for a cable it does not hold', () => {
    expect(cableEndsOf(VIEW, 'nope')).toEqual([null, null]);
  });
});
