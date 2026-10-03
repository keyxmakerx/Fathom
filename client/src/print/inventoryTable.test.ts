import { describe, expect, it } from 'vitest';

import { buildInventorySheet, percentWidths, type InventoryPrintable } from './inventoryTable';

const printable: InventoryPrintable = {
  kindLabel: 'Devices',
  columns: [
    { key: 'name', label: 'Name', width: 200 },
    { key: 'serial', label: 'Serial', width: 100 },
    { key: 'mgmt', label: 'Mgmt address', width: 100 },
    { key: 'tags', label: 'Tags', width: 100 },
  ],
  rows: [
    { key: 'a', cells: { name: 'fw-01', serial: 'SN123', mgmt: '10.0.0.1', tags: 'edge, core' } },
    { key: 'b', cells: { name: 'sw-02', tags: '' } },
  ],
  filterWords: ['Tags: edge'],
};

describe('buildInventorySheet', () => {
  it('prints the columns and rows as shown, with a dash for an empty cell', () => {
    const sheet = buildInventorySheet(printable, false);
    expect(sheet.section).toBe('inventory');
    expect(sheet.columnHeader.cells).toEqual(['Name', 'Serial', 'Mgmt address', 'Tags']);
    expect(sheet.bodyRows.map((r) => r.row.cells)).toEqual([
      ['fw-01', 'SN123', '10.0.0.1', 'edge, core'],
      ['sw-02', '—', '—', '—'],
    ]);
    expect(sheet.heading).toEqual({ title: 'Inventory · Devices', detail: '2 rows · filtered: Tags: edge' });
  });

  it('leaves out serials and management addresses when asked', () => {
    const sheet = buildInventorySheet(printable, true);
    expect(sheet.columnHeader.cells).toEqual(['Name', 'Tags']);
    expect(JSON.stringify(sheet)).not.toContain('SN123');
    expect(JSON.stringify(sheet)).not.toContain('10.0.0.1');
  });

  it('always sums widths to 100', () => {
    for (const w of [[1], [200, 100, 100, 100], [33, 33, 33], Array.from({ length: 23 }, (_, i) => 40 + i)]) {
      expect(percentWidths(w).reduce((a, b) => a + b, 0)).toBe(100);
    }
  });
});
