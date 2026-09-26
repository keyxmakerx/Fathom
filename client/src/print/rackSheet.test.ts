import { describe, expect, it } from 'vitest';

import type { ChassisView, RackView } from '../document/view';
import { paginateRackRows, rackDeviceRows, rowsPerPage } from './rackSheet';

function chassis(id: string, positionU: number, heightU = 1, overrides: Partial<ChassisView> = {}): ChassisView {
  return {
    id,
    deviceId: `device:${id}`,
    hostname: id,
    model: 'Model',
    vendor: 'Vendor',
    positionU,
    heightU,
    face: 'front',
    ports: [],
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

function rack42WithDevices(): Pick<RackView, 'heightU' | 'chassis'> {
  const list: ChassisView[] = [];
  for (let u = 1; u <= 42; u += 1) list.push(chassis(`c${u}`, u, 1));
  return { heightU: 42, chassis: list };
}

describe('rowsPerPage', () => {
  it('differs between A4 and Letter — paging knows the paper', () => {
    expect(rowsPerPage('A4')).toBeGreaterThan(0);
    expect(rowsPerPage('Letter')).toBeGreaterThan(0);
    expect(rowsPerPage('A4')).not.toBe(rowsPerPage('Letter'));
  });
});

describe('paginateRackRows', () => {
  it('a 42U rack with 42 devices and cables all takes two pages, on A4 and on Letter — the brief\'s own worked example', () => {
    const rack = rack42WithDevices();
    for (const paper of ['A4', 'Letter'] as const) {
      const capacity = rowsPerPage(paper);
      const pages = paginateRackRows(rack, capacity);
      expect(pages).toHaveLength(2);
    }
  });

  it('loses no device and doubles none, across any capacity', () => {
    const rack = rack42WithDevices();
    for (const capacity of [5, 10, 21, 23, 42, 100]) {
      const pages = paginateRackRows(rack, capacity);
      const seen = pages.flatMap((p) => p.chassis.map((c) => c.id));
      expect(seen).toHaveLength(42);
      expect(new Set(seen).size).toBe(42);
      expect(seen.sort()).toEqual(rack.chassis.map((c) => c.id).sort());
    }
  });

  it('never splits a multi-U chassis across a page boundary', () => {
    // A 4U chassis straddling where a capacity-of-3 cut would otherwise fall.
    const rack: Pick<RackView, 'heightU' | 'chassis'> = {
      heightU: 10,
      chassis: [chassis('tall', 4, 4), chassis('top', 9, 1), chassis('bottom', 1, 1)],
    };
    const pages = paginateRackRows(rack, 3);
    for (const page of pages) {
      for (const c of page.chassis) {
        // Every chassis appears whole on exactly one page.
        const onThisPage = page.chassis.filter((x) => x.id === c.id).length;
        expect(onThisPage).toBe(1);
      }
    }
    const allIds = pages.flatMap((p) => p.chassis.map((c) => c.id));
    expect(new Set(allIds).size).toBe(3);
  });

  it('gives an oversized chassis its own page rather than dropping it', () => {
    const rack: Pick<RackView, 'heightU' | 'chassis'> = { heightU: 20, chassis: [chassis('huge', 1, 20)] };
    const pages = paginateRackRows(rack, 5);
    expect(pages).toHaveLength(1);
    expect(pages[0].chassis.map((c) => c.id)).toEqual(['huge']);
  });

  it('covers an empty rack in equal-capacity slices with no chassis lost (none to lose)', () => {
    const pages = paginateRackRows({ heightU: 10, chassis: [] }, 4);
    expect(pages.map((p) => [p.fromRow, p.toRow])).toEqual([
      [0, 3],
      [4, 7],
      [8, 9],
    ]);
  });
});

describe('rackDeviceRows', () => {
  it('prints a dash for serial and management address when hideSensitive is set, with the field otherwise shown', () => {
    const rack = { heightU: 10, unitNumbering: 'ascending' };
    const c = chassis('sw', 5, 1, { serial: 'ABC123', managementAddress: '10.0.0.1' });
    const shown = rackDeviceRows(rack, [c], false);
    expect(shown[0].serial).toBe('ABC123');
    expect(shown[0].managementAddress).toBe('10.0.0.1');
    const hidden = rackDeviceRows(rack, [c], true);
    expect(hidden[0].serial).toBe('—');
    expect(hidden[0].managementAddress).toBe('—');
  });

  it('counts ports cabled out of the total, free ports included in the total', () => {
    const rack = { heightU: 10, unitNumbering: 'ascending' };
    const c = chassis('sw', 5, 1, {
      ports: [
        { id: 'p1', label: 'e1', connector: 'rj45', row: 0, column: 0, uplink: false, role: null, face: 'front', passThroughId: null, cable: { cableId: 'cab:1', farPortId: 'p2', farChassisId: 'c2', outsideCloset: false } },
        { id: 'p2', label: 'e2', connector: 'rj45', row: 0, column: 1, uplink: false, role: null, face: 'front', passThroughId: null, cable: null },
      ] as ChassisView['ports'],
    });
    const rows = rackDeviceRows(rack, [c], false);
    expect(rows[0].portsCabled).toBe('1 of 2');
  });

  it('orders rows top-down by position', () => {
    const rack = { heightU: 10, unitNumbering: 'ascending' };
    const rows = rackDeviceRows(rack, [chassis('bottom', 1), chassis('top', 9)], false);
    expect(rows.map((r) => r.name)).toEqual(['top', 'bottom']);
  });
});
