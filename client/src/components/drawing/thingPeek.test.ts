import { describe, expect, it } from 'vitest';

import type { ChassisView, ClosetView } from './contract';
import { thingPeek } from './thingPeek';

const port = (id: string, label: string, cabled: boolean) =>
  ({ id, label, connector: 'rj45', face: 'front', cable: cabled ? { cableId: 'k1', farPortId: 'p9', farChassisId: 'c2', outsideCloset: false } : null }) as unknown as ChassisView['ports'][number];

const chassis = (id: string, hostname: string, positionU: number, ports: ChassisView['ports'], managementAddress: string | null = null) =>
  ({ id, deviceId: `d-${id}`, hostname, model: 'EX2300', vendor: 'juniper', positionU, heightU: 1, face: 'front', ports, role: null, managementAddress, serial: null, psuInlets: [], singleFed: false, oneFitted: false, placement: 'rack', sketch: false }) as unknown as ChassisView;

const VIEW = {
  premisesId: 'p',
  racks: [
    {
      id: 'r1',
      label: 'A-04',
      heightU: 12,
      unitNumbering: 'ascending',
      chassis: [chassis('c1', 'sw-01', 3, [port('p1', 'ge-0/0/1', true), port('p2', 'ge-0/0/2', false)], '10.0.0.2'), chassis('c2', 'fw-01', 6, [port('p9', 'eth0', true)])],
      shelves: [{ id: 's1', label: 'Shelf', positionU: 1, heightU: 1, occupants: [{ id: 'o1', kind: 'chassis', label: 'modem', model: null, slot: 0, ports: [], sketch: true }] }],
      freeRuns: [],
      row: null,
      bay: null,
    },
  ],
  cables: [{ id: 'k1', kind: 'patch', media: 'cat6', sheath: 'blue', label: 'core run', lengthM: 3, ends: [{ portId: 'p1', chassisId: 'c1', rackId: 'r1' }, { portId: 'p9', chassisId: 'c2', rackId: 'r1' }] }],
  rows: [],
  surfaces: [
    {
      id: 'w1',
      label: 'Outside wall',
      form: 'wall',
      widthMm: null,
      heightMm: null,
      fixtures: [
        { id: 'c7', kind: 'chassis', label: 'cam-01', model: 'G5', form: null, xMm: 0, yMm: 0, ports: [port('p7', 'eth0', true)], psuInlets: [], fixtures: [], chassis: chassis('c7', 'cam-01', 0, [port('p7', 'eth0', true)], '10.0.0.7') },
        { id: 'x1', kind: 'passive', label: 'outlet', model: null, form: 'outlet', xMm: 0, yMm: 0, ports: [], psuInlets: [], fixtures: [] },
      ],
    },
  ],
  unplaced: [],
  free: [],
  lines: [],
  labels: [],
} as unknown as ClosetView;

describe('thingPeek', () => {
  it('says what a device is, where, its address and how many ports are cabled', () => {
    const card = thingPeek(VIEW, { kind: 'device', id: 'c1' })!;
    expect(card.title).toBe('sw-01');
    expect(card.rows.map((r) => [r.key, r.value])).toEqual([
      ['Model', 'juniper EX2300'],
      ['Where', 'A-04 · U3'],
      ['Address', '10.0.0.2'],
      ['Ports', '1 of 2 cabled'],
    ]);
    expect(thingPeek(VIEW, { kind: 'device', id: 'c2' })!.rows.find((r) => r.key === 'Address')).toEqual({ key: 'Address', value: 'No address', empty: true });
  });

  it('says the same of a device on a wall, and leaves the address out for a thing that is not a device', () => {
    expect(thingPeek(VIEW, { kind: 'device', id: 'c7' })!.rows.map((r) => [r.key, r.value])).toEqual([
      ['Model', 'juniper EX2300'],
      ['Where', 'Outside wall'],
      ['Address', '10.0.0.7'],
      ['Ports', '1 of 1 cabled'],
    ]);
    expect(thingPeek(VIEW, { kind: 'device', id: 'x1' })!.rows.map((r) => [r.key, r.value])).toEqual([
      ['Model', 'No catalogue model'],
      ['Where', 'Outside wall'],
      ['Ports', 'No ports'],
    ]);
  });

  it('says how full a rack is', () => {
    const card = thingPeek(VIEW, { kind: 'rack', id: 'r1' })!;
    expect(card.title).toBe('A-04');
    expect(card.rows.find((r) => r.key === 'Used')!.value).toBe('3U used · 9U free');
    expect(card.rows.find((r) => r.key === 'Devices')!.value).toBe('3');
  });

  it("names what sits on a shelf, and a shelf's device by its own name", () => {
    expect(thingPeek(VIEW, { kind: 'shelf', id: 's1' })!.rows.find((r) => r.key === 'On it')!.value).toBe('modem');
    expect(thingPeek(VIEW, { kind: 'device', id: 'o1' })!.title).toBe('modem');
  });

  // "Typed by hand" once stood here, which read as the name of a model.
  it('says a box with no model has no catalogue model, as its panel does', () => {
    expect(thingPeek(VIEW, { kind: 'device', id: 'o1' })!.rows.find((r) => r.key === 'Model')).toEqual({ key: 'Model', value: 'No catalogue model', empty: true });
  });

  it('names both ends of a cable, its kind and length', () => {
    const card = thingPeek(VIEW, { kind: 'cable', id: 'k1' })!;
    expect(card.title).toBe('core run');
    expect(card.rows.map((r) => r.value)).toEqual(['sw-01 · ge-0/0/1', 'fw-01 · eth0', 'cat6 · blue', '3 m']);
  });

  it('gives nothing for an id the view does not hold', () => {
    expect(thingPeek(VIEW, { kind: 'device', id: 'nope' })).toBeNull();
    expect(thingPeek(VIEW, { kind: 'cable', id: 'nope' })).toBeNull();
  });
});
