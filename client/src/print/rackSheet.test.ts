import { describe, expect, it } from 'vitest';

import type { ChassisView, OccupantView, PortView, ShelfView } from '../document/view';
import { contentHeightMm } from './paper';
import {
  dedupeCableLines,
  elevationCableLines,
  elevationHeightMm,
  elevationItemsOf,
  elevationRowMm,
  emptyUnitRows,
  faceplateGlyphRows,
  facePortGlyphs,
  paginateRackTableByHeight,
  rackDeviceRows,
  type ElevationCableLine,
  type RackDeviceRow,
} from './rackSheet';

function port(id: string, overrides: Partial<PortView> = {}): PortView {
  return {
    id,
    label: id,
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

describe('faceplateGlyphRows', () => {
  it('groups ports by row, ascending, each row by column', () => {
    const ports = [port('b', { row: 0, column: 1 }), port('a', { row: 0, column: 0 }), port('c', { row: 1, column: 0 })];
    const rows = faceplateGlyphRows(ports);
    expect(rows.map((r) => r.map((p) => p.id))).toEqual([['a', 'b'], ['c']]);
  });

  it('a sketch device\'s ports all share row 0, so they still draw as one row', () => {
    const ports = [port('eth0', { row: 0, column: 0 }), port('eth1', { row: 0, column: 1 })];
    expect(faceplateGlyphRows(ports)).toHaveLength(1);
  });
});

describe('facePortGlyphs', () => {
  it('one glyph per port, left to right within the body width', () => {
    const ports = [port('a', { column: 0 }), port('b', { column: 1 })];
    const glyphs = facePortGlyphs(ports, 70);
    expect(glyphs).toHaveLength(2);
    expect(glyphs[0].x).toBeLessThan(glyphs[1].x);
  });

  it('a C14 connector draws as the hex inlet shape, an RJ45 as a rectangle', () => {
    const glyphs = facePortGlyphs([port('p', { connector: 'c14' })], 70);
    expect(glyphs[0].shape).toBe('hex');
    expect(facePortGlyphs([port('p', { connector: 'rj45' })], 70)[0].shape).toBe('rect');
  });

  it('shrinks to fit rather than overflow the body, for a great many ports', () => {
    const ports = Array.from({ length: 48 }, (_, i) => port(`p${i}`, { column: i }));
    const glyphs = facePortGlyphs(ports, 70);
    const last = glyphs[glyphs.length - 1];
    expect(last.x + last.w).toBeLessThanOrEqual(70 - 2 + 0.01);
  });

  it('right-aligns a row when asked, for inlets at the body\'s far edge', () => {
    const glyphs = facePortGlyphs([port('p')], 70, { rightAlign: true });
    expect(glyphs[0].x).toBeGreaterThan(35);
  });

  it('stacks a later row below an earlier one via rowOffset', () => {
    const glyphs = facePortGlyphs([port('p')], 70, { rowOffset: 2 });
    const bare = facePortGlyphs([port('p')], 70)[0];
    expect(glyphs[0].y).toBeGreaterThan(bare.y);
  });
});

describe('emptyUnitRows', () => {
  it('every physical row nothing occupies, top-down index', () => {
    // A 4U rack, one 1U item at the very top (positionU 4) — rows 1,2,3
    // (physical, 0 = top) are empty.
    expect(emptyUnitRows(4, [{ positionU: 4, heightU: 1 }])).toEqual([1, 2, 3]);
  });

  it('nothing empty when every unit is covered', () => {
    expect(emptyUnitRows(2, [{ positionU: 1, heightU: 2 }])).toEqual([]);
  });
});

describe('elevationCableLines', () => {
  it('names both ends by hostname and port, for the "Cables:" hop list', () => {
    const a = chassis('a', 2, 1, { ports: [port('a-p0', { cable: { cableId: 'cbl-1', farPortId: 'b-p0', farChassisId: 'b', outsideCloset: false } })] });
    const b = chassis('b', 1, 1, { hostname: 'b-host', ports: [port('b-p0', { label: 'eth0' })] });
    const lines = elevationCableLines([a, b], 'front');
    expect(lines).toHaveLength(1);
    expect(lines[0].fromText).toBe('a a-p0');
    expect(lines[0].toText).toBe('b-host eth0');
  });
});

describe('dedupeCableLines', () => {
  it('keeps one line per cable id, first seen', () => {
    const line = (cableId: string, sheath: string | null = null): ElevationCableLine => ({
      fromChassisId: 'a',
      toChassisId: 'b',
      fromPortId: 'a-p',
      toPortId: 'b-p',
      fromText: 'a p',
      toText: 'b p',
      cableId,
      sheath,
    });
    const out = dedupeCableLines([line('c1'), line('c2'), line('c1')]);
    expect(out.map((l) => l.cableId)).toEqual(['c1', 'c2']);
  });
});
