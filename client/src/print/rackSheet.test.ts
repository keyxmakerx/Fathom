import { describe, expect, it } from 'vitest';

import type { ChassisView, OccupantView, ShelfView } from '../document/view';
import { contentHeightMm } from './paper';
import { elevationHeightMm, elevationItemsOf, elevationRowMm, paginateRackTableByHeight, rackDeviceRows, type RackDeviceRow } from './rackSheet';

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

function occupant(id: string, label: string, overrides: Partial<OccupantView> = {}): OccupantView {
  return { id, kind: 'chassis', label, model: 'Occ Model', slot: 0, ports: [], sketch: false, ...overrides };
}

function shelf(id: string, positionU: number, heightU: number, occupants: OccupantView[]): ShelfView {
  return { id, label: `shelf-${id}`, positionU, heightU, occupants };
}

describe('elevationRowMm', () => {
  it('draws at the natural size when a rack fits one page whole', () => {
    expect(elevationRowMm(10, 'A4')).toBe(6);
  });

  it('a 42U rack fits A4 and Letter at their own scale, never split', () => {
    const a4 = elevationRowMm(42, 'A4');
    const letter = elevationRowMm(42, 'Letter');
    expect(a4 * 42).toBeLessThanOrEqual(297 - 20 - 16 - 9 + 0.01);
    expect(letter * 42).toBeLessThanOrEqual(279.4 - 20 - 16 - 9 + 0.01);
    expect(letter).toBeLessThanOrEqual(a4);
  });

  it('shrinks proportionally, never below what the page can hold', () => {
    const rowMm = elevationRowMm(100, 'A4');
    expect(rowMm * 100).toBeLessThanOrEqual(297 - 20 - 16 - 9 + 0.01);
  });
});

describe('elevationHeightMm', () => {
  it('the real drawn height (rows plus the caption) never exceeds the page content budget', () => {
    for (const paper of ['A4', 'Letter'] as const) {
      for (const heightU of [1, 10, 42, 48, 100]) {
        expect(elevationHeightMm(heightU, paper)).toBeLessThanOrEqual(contentHeightMm(paper) + 0.001);
      }
    }
  });
});

describe('rackDeviceRows', () => {
  const rack = { heightU: 10, unitNumbering: 'ascending', chassis: [] as ChassisView[], shelves: [] as ShelfView[] };

  it('lists a shelf\'s occupants, named, at the shelf\'s own unit', () => {
    const withShelf = { ...rack, shelves: [shelf('s1', 5, 1, [occupant('o1', 'nuc-01'), occupant('o2', 'ont-01')])] };
    const rows = rackDeviceRows(withShelf, false);
    expect(rows.map((r) => r.name)).toEqual(['nuc-01', 'ont-01']);
    expect(rows[0].unit).toBe('5');
  });

  it('interleaves chassis and shelf occupants by physical position', () => {
    const withBoth = {
      ...rack,
      chassis: [chassis('top', 9), chassis('bottom', 1)],
      shelves: [shelf('s1', 5, 1, [occupant('mid', 'nuc-01')])],
    };
    const rows = rackDeviceRows(withBoth, false);
    expect(rows.map((r) => r.name)).toEqual(['top', 'nuc-01', 'bottom']);
  });

  it('an occupant carries no serial or management address (never tracked at that level)', () => {
    const withShelf = { ...rack, shelves: [shelf('s1', 5, 1, [occupant('o1', 'nuc-01')])] };
    const rows = rackDeviceRows(withShelf, false);
    expect(rows[0].serial).toBe('—');
    expect(rows[0].managementAddress).toBe('—');
  });
});

describe('elevationItemsOf', () => {
  it('merges chassis and shelves, top to bottom', () => {
    const rack = { chassis: [chassis('top', 9), chassis('bottom', 1)], shelves: [shelf('s1', 5, 1, [])] };
    const items = elevationItemsOf(rack);
    expect(items.map((i) => (i.kind === 'chassis' ? i.chassis.id : i.shelf.id))).toEqual(['top', 's1', 'bottom']);
  });
});

describe('paginateRackTableByHeight', () => {
  function row(name: string): RackDeviceRow {
    return { unit: '1', name, model: 'M', serial: '—', managementAddress: '—', portsCabled: '0 of 0' };
  }

  it('fills the first page to its own (smaller) budget, then later pages to theirs', () => {
    const rows = ['a', 'b', 'c', 'd'].map((n) => ({ row: row(n), heightPx: 10 }));
    const pages = paginateRackTableByHeight(rows, 15, 25);
    expect(pages.map((p) => p.map((r) => r.name))).toEqual([['a'], ['b', 'c'], ['d']]);
  });

  it('loses no row and doubles none', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ row: row(`r${i}`), heightPx: 7 }));
    const pages = paginateRackTableByHeight(rows, 40, 60);
    const seen = pages.flat().map((r) => r.name);
    expect(seen).toHaveLength(50);
    expect(new Set(seen).size).toBe(50);
  });

  it('gives an oversized row its own page rather than dropping it', () => {
    const rows = [{ row: row('huge'), heightPx: 500 }];
    const pages = paginateRackTableByHeight(rows, 50, 50);
    expect(pages).toHaveLength(1);
    expect(pages[0].map((r) => r.name)).toEqual(['huge']);
  });

  it('with no rows, returns one empty page', () => {
    expect(paginateRackTableByHeight([], 50, 50)).toEqual([[]]);
  });

  it('leaves the first page empty rather than force a row where none fits', () => {
    const rows = ['a', 'b'].map((n) => ({ row: row(n), heightPx: 10 }));
    const pages = paginateRackTableByHeight(rows, 0, 25);
    expect(pages.map((p) => p.map((r) => r.name))).toEqual([[], ['a', 'b']]);
  });

  it('same, for a negative first-page budget', () => {
    const rows = ['a'].map((n) => ({ row: row(n), heightPx: 10 }));
    const pages = paginateRackTableByHeight(rows, -5, 25);
    expect(pages.map((p) => p.map((r) => r.name))).toEqual([[], ['a']]);
  });
});
