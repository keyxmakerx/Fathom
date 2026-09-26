import { describe, expect, it } from 'vitest';

import { emptyDocument } from '../document/model';
import type { CableView, ChassisView, ClosetView, FixtureView, PortView, SurfaceView } from '../document/view';
import { buildCutSheet } from './cutSheet';

function port(id: string, label: string, overrides: Partial<PortView> = {}): PortView {
  return {
    id,
    label,
    connector: 'rj45',
    row: 0,
    column: 0,
    uplink: false,
    role: null,
    face: 'front',
    passThroughId: null,
    cable: null,
    ...overrides,
  };
}

function chassis(id: string, positionU: number, ports: PortView[], overrides: Partial<ChassisView> = {}): ChassisView {
  return {
    id,
    deviceId: `device:${id}`,
    hostname: id,
    model: 'Model X',
    vendor: 'Vendor',
    positionU,
    heightU: 1,
    face: 'front',
    ports,
    role: null,
    managementAddress: null,
    serial: null,
    psuInlets: [],
    singleFed: false,
    oneFitted: false,
    placement: { kind: 'rack', rackId: 'rack:1', positionU, face: 'front' },
    sketch: false,
    ...overrides,
  };
}

const doc = emptyDocument();

function emptyView(overrides: Partial<ClosetView> = {}): ClosetView {
  return { premisesId: 'p', racks: [], cables: [], rows: [], surfaces: [], unplaced: [], ...overrides };
}

describe('buildCutSheet', () => {
  it('gives a device with no ports a row in both files (its block, with no port rows)', () => {
    const rack = { id: 'rack:1', label: 'R1', heightU: 4, unitNumbering: 'ascending', chassis: [chassis('bare', 1, [])], shelves: [], freeRuns: [], row: null, bay: null };
    const view = emptyView({ racks: [rack] });
    const devices = buildCutSheet(doc, view);
    expect(devices).toHaveLength(1);
    expect(devices[0].name).toBe('bare');
    expect(devices[0].rows).toEqual([]);
  });

  it('includes a free port as its own row, marked free', () => {
    const rack = { id: 'rack:1', label: 'R1', heightU: 4, unitNumbering: 'ascending', chassis: [chassis('sw', 1, [port('p1', 'Et1')])], shelves: [], freeRuns: [], row: null, bay: null };
    const devices = buildCutSheet(doc, emptyView({ racks: [rack] }));
    expect(devices[0].rows).toHaveLength(1);
    expect(devices[0].rows[0].farEnd).toContain('free');
    expect(devices[0].rows[0].cable).toBe('');
  });

  it('resolves the far end to the far device name and far port label', () => {
    const a = chassis('a', 2, [port('pa', 'Et1', { cable: { cableId: 'cab:1', farPortId: 'pb', farChassisId: 'b', outsideCloset: false } })]);
    const b = chassis('b', 1, [port('pb', 'Et1', { cable: { cableId: 'cab:1', farPortId: 'pa', farChassisId: 'a', outsideCloset: false } })]);
    const rack = { id: 'rack:1', label: 'R1', heightU: 4, unitNumbering: 'ascending', chassis: [a, b], shelves: [], freeRuns: [], row: null, bay: null };
    const cable: CableView = { id: 'cab:1', kind: 'copper', media: 'cat6', sheath: 'blue', label: 'C-01', ends: [] };
    const devices = buildCutSheet(doc, emptyView({ racks: [rack], cables: [cable] }));
    const aDevice = devices.find((d) => d.key === 'a')!;
    expect(aDevice.rows[0].farEnd).toBe('b Et1');
    expect(aDevice.rows[0].cable).toBe('C-01');
    expect(aDevice.rows[0].colour).toBe('blue');
  });

  it('marks an outside-closet cable "outside" when the far port is not in this view', () => {
    const a = chassis('a', 2, [port('pa', 'Et1', { cable: { cableId: 'cab:1', farPortId: null, farChassisId: null, outsideCloset: true } })]);
    const rack = { id: 'rack:1', label: 'R1', heightU: 4, unitNumbering: 'ascending', chassis: [a], shelves: [], freeRuns: [], row: null, bay: null };
    const devices = buildCutSheet(doc, emptyView({ racks: [rack] }));
    expect(devices[0].rows[0].farEnd).toBe('outside');
  });

  it('placement reads "Rack <label> · U<unit>" for a racked device', () => {
    const rack = { id: 'rack:1', label: 'R7', heightU: 10, unitNumbering: 'ascending', chassis: [chassis('sw', 5, [])], shelves: [], freeRuns: [], row: null, bay: null };
    const devices = buildCutSheet(doc, emptyView({ racks: [rack] }));
    expect(devices[0].placement).toBe('Rack R7 · U5');
  });

  it('placement reads the surface\'s own name for a fixture', () => {
    const fixture: FixtureView = { id: 'f1', kind: 'passive', label: 'UPS floor unit', model: null, form: 'outlet', xMm: null, yMm: null, ports: [], psuInlets: [], fixtures: [] };
    const surface: SurfaceView = { id: 's1', label: 'Floor 1', form: 'floor', widthMm: null, heightMm: null, fixtures: [fixture] };
    const devices = buildCutSheet(doc, emptyView({ surfaces: [surface] }));
    expect(devices[0].placement).toBe('Floor 1');
  });

  it('placement reads "not placed" for an unplaced device', () => {
    const devices = buildCutSheet(doc, emptyView({ unplaced: [chassis('loose', 0, [])] }));
    expect(devices[0].placement).toBe('not placed');
  });

  it('orders racked devices top-down by position', () => {
    const rack = { id: 'rack:1', label: 'R1', heightU: 10, unitNumbering: 'ascending', chassis: [chassis('bottom', 1, []), chassis('top', 9, [])], shelves: [], freeRuns: [], row: null, bay: null };
    const devices = buildCutSheet(doc, emptyView({ racks: [rack] }));
    expect(devices.map((d) => d.key)).toEqual(['top', 'bottom']);
  });
});
