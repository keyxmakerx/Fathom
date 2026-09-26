import { describe, expect, it } from 'vitest';

import type { CutSheetDevice } from './cutSheet';
import { CUT_SHEET_COLUMNS, cutSheetRowsPerPage, cutSheetTableRows, paginateCutSheet } from './cutSheetTable';

function deviceWith(name: string, portCount: number): CutSheetDevice {
  return {
    key: name,
    name,
    model: 'Model',
    placement: 'Rack R1 · U1',
    rows: Array.from({ length: portCount }, (_, i) => ({
      port: `Et${i + 1}`,
      connector: 'rj45',
      farEnd: '— free',
      cable: '',
      colour: '',
      vlans: '',
    })),
  };
}

describe('cutSheetTableRows', () => {
  it('opens with the column-title row, bold', () => {
    const rows = cutSheetTableRows([]);
    expect(rows).toHaveLength(1);
    expect(rows[0].bold).toBe(true);
    expect(rows[0].cells).toEqual([...CUT_SHEET_COLUMNS]);
  });

  it('gives a device with no ports its own bold header row and nothing else', () => {
    const rows = cutSheetTableRows([deviceWith('bare', 0)]);
    expect(rows).toHaveLength(2); // column header + device header
    expect(rows[1].bold).toBe(true);
    expect(rows[1].cells[0]).toBe('bare');
  });

  it('gives every port its own row, not bold, free ports included', () => {
    const rows = cutSheetTableRows([deviceWith('sw', 3)]);
    expect(rows).toHaveLength(1 + 1 + 3);
    expect(rows.slice(2).every((r) => !r.bold)).toBe(true);
  });
});

describe('paginateCutSheet', () => {
  it('repeats the column header at the top of every page', () => {
    const capacity = cutSheetRowsPerPage('A4');
    const many = [deviceWith('big', capacity * 3)];
    const pages = paginateCutSheet(many, 'A4');
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page[0].bold).toBe(true);
      expect(page[0].cells).toEqual([...CUT_SHEET_COLUMNS]);
    }
  });

  it('repeats a split device\'s own header, marked continued, on the next page', () => {
    const capacity = cutSheetRowsPerPage('A4');
    const pages = paginateCutSheet([deviceWith('sw', capacity + 5)], 'A4');
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages[1][1].cells[0]).toBe('sw (continued)');
    expect(pages[1][1].bold).toBe(true);
  });

  it('loses no port row and duplicates none, across a page split', () => {
    const capacity = cutSheetRowsPerPage('A4');
    const devices = [deviceWith('a', capacity - 2), deviceWith('b', capacity + 4), deviceWith('c', 3)];
    const pages = paginateCutSheet(devices, 'A4');
    const portRows = pages.flat().filter((r) => r.cells[3] !== '' && !CUT_SHEET_COLUMNS.includes(r.cells[3] as (typeof CUT_SHEET_COLUMNS)[number]));
    const expectedTotal = devices.reduce((sum, d) => sum + d.rows.length, 0);
    expect(portRows).toHaveLength(expectedTotal);
  });

  it('never overflows a page beyond its own capacity', () => {
    const capacity = cutSheetRowsPerPage('Letter');
    const pages = paginateCutSheet([deviceWith('sw', capacity * 4)], 'Letter');
    for (const page of pages) {
      expect(page.length - 1).toBeLessThanOrEqual(capacity); // minus the repeated column header
    }
  });
});
