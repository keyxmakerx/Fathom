import { describe, expect, it } from 'vitest';

import type { ChassisView, ClosetView } from './contract';
import { quickCard, roleWord } from './quickCard';

const port = (id: string, cabled: boolean) =>
  ({ id, label: id, connector: 'rj45', face: 'front', cable: cabled ? { cableId: 'k1', farPortId: 'p9', farChassisId: 'c2', outsideCloset: false } : null }) as unknown as ChassisView['ports'][number];

const chassis = (id: string, hostname: string, role: string | null, managementAddress: string | null, ports: ChassisView['ports']) =>
  ({ id, deviceId: `d-${id}`, hostname, model: '7050SX3', vendor: 'arista', positionU: 10, heightU: 1, face: 'front', ports, role, managementAddress, serial: null, psuInlets: [], singleFed: false, oneFitted: false, placement: 'rack', sketch: false }) as unknown as ChassisView;

const VIEW = {
  premisesId: 'p',
  racks: [
    {
      id: 'r1',
      label: 'Rack 1',
      heightU: 42,
      unitNumbering: 'ascending',
      chassis: [chassis('c1', 'sweetch', 'switch', ' 10.0.0.2 ', [port('p1', true), port('p2', false)]), chassis('c2', 'painite', 'access_point', null, [port('p9', true)])],
      shelves: [],
      freeRuns: [],
      row: null,
      bay: null,
    },
  ],
  cables: [{ id: 'k1', kind: 'patch', media: 'cat6', sheath: 'blue', label: null, lengthM: 3, ends: [{ portId: 'p1', chassisId: 'c1', rackId: 'r1' }, { portId: 'p9', chassisId: 'c2', rackId: 'r1' }] }],
  rows: [],
  surfaces: [],
  unplaced: [],
  free: [{ id: 'f1', hostname: 'nas', role: null, model: '', x: 0, y: 0, portCount: 0 }],
  lines: [],
  labels: [],
} as unknown as ClosetView;

describe('quickCard', () => {
  it('gives a device its kind, name and address to copy, and keeps the address out of the rows', () => {
    const card = quickCard(VIEW, { kind: 'device', id: 'c1' })!;
    expect(card.kind).toBe('Switch');
    expect(card.title).toBe('sweetch');
    expect(card.address).toBe('10.0.0.2');
    expect(card.opens).toBe(true);
    expect(card.rows.map((r) => r.key)).toEqual(['Model', 'Where', 'Ports']);
  });

  it('has no address to copy when none is set, and names a role in words', () => {
    const card = quickCard(VIEW, { kind: 'device', id: 'c2' })!;
    expect(card.address).toBeNull();
    expect(card.kind).toBe('Access point');
  });

  it('calls a free box with no role a device', () => {
    expect(quickCard(VIEW, { kind: 'device', id: 'f1' })!.kind).toBe('Device');
  });

  it('says what a rack or a cable is, with nothing to open or copy', () => {
    expect(quickCard(VIEW, { kind: 'rack', id: 'r1' })).toMatchObject({ kind: 'Rack', title: 'Rack 1', address: null, opens: false });
    expect(quickCard(VIEW, { kind: 'cable', id: 'k1' })).toMatchObject({ kind: 'Cable', address: null, opens: false });
  });

  it('is nothing for a thing that is gone', () => {
    expect(quickCard(VIEW, { kind: 'device', id: 'gone' })).toBeNull();
  });

  it('words a role', () => {
    expect(roleWord('access_point')).toBe('Access point');
    expect(roleWord(null)).toBe('Device');
    expect(roleWord('  ')).toBe('Device');
  });
});
