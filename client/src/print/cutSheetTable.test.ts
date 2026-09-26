import { describe, expect, it } from 'vitest';

import type { CutSheetDevice } from './cutSheet';
import { CUT_SHEET_COLUMNS, cutSheetBodyRows, cutSheetColumnHeaderRow, cutSheetTableRows, paginateCutSheetByHeight } from './cutSheetTable';

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
    expect(rows).toHaveLength(2);
    expect(rows[1].bold).toBe(true);
    expect(rows[1].cells[0]).toBe('bare');
  });

  it('gives every port its own row, not bold, free ports included', () => {
    const rows = cutSheetTableRows([deviceWith('sw', 3)]);
    expect(rows).toHaveLength(1 + 1 + 3);
    expect(rows.slice(2).every((r) => !r.bold)).toBe(true);
  });
});

function heightsOf(devices: CutSheetDevice[], rowHeightPx: number, headerHeightPx: number) {
  const columnHeader = { row: cutSheetColumnHeaderRow(), heightPx: headerHeightPx };
  const bodyRows = cutSheetBodyRows(devices).map((u) => ({ ...u, heightPx: u.isDeviceHeader ? headerHeightPx : rowHeightPx }));
  return { columnHeader, bodyRows };
}

describe('paginateCutSheetByHeight', () => {
  it('repeats the column header at the top of every page', () => {
    const devices = [deviceWith('big', 30)];
    const { columnHeader, bodyRows } = heightsOf(devices, 10, 10);
    const pages = paginateCutSheetByHeight(columnHeader, bodyRows, 60);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page[0].bold).toBe(true);
      expect(page[0].cells).toEqual([...CUT_SHEET_COLUMNS]);
    }
  });

  it('repeats a split device\'s own header row on the next page', () => {
    const devices = [deviceWith('sw', 20)];
    const { columnHeader, bodyRows } = heightsOf(devices, 10, 10);
    const pages = paginateCutSheetByHeight(columnHeader, bodyRows, 60);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages[1][1].cells[0]).toBe('sw');
    expect(pages[1][1].bold).toBe(true);
  });

  it('loses no port row and duplicates none, across a page split', () => {
    const devices = [deviceWith('a', 5), deviceWith('b', 25), deviceWith('c', 3)];
    const { columnHeader, bodyRows } = heightsOf(devices, 10, 10);
    const pages = paginateCutSheetByHeight(columnHeader, bodyRows, 60);
    const portRows = pages.flat().filter((r) => !r.bold);
    const expectedTotal = devices.reduce((sum, d) => sum + d.rows.length, 0);
    expect(portRows).toHaveLength(expectedTotal);
  });

  it('gives an oversized row its own page rather than dropping it', () => {
    const columnHeader = { row: cutSheetColumnHeaderRow(), heightPx: 10 };
    const bodyRows = [{ row: { cells: ['', '', '', 'x', '', 'huge value', '', '', ''], bold: false }, isDeviceHeader: false, heightPx: 500 }];
    const pages = paginateCutSheetByHeight(columnHeader, bodyRows, 60);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toHaveLength(2); // column header + the one oversized row
  });
});
