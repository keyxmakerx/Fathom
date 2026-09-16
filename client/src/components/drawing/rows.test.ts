import { describe, expect, it } from 'vitest';

import type { RackView, RowView } from './contract';
import { layoutRow, rowKey } from './rows';

function rack(id: string, bay: number): RackView {
  return {
    id,
    label: id,
    heightU: 42,
    unitNumbering: 'bottom-up',
    chassis: [],
    freeRuns: [],
    row: 'A',
    bay,
  };
}

describe('layoutRow: bay order and its mirror (ADR-0050 §2)', () => {
  const row: RowView = { label: 'A', racks: [rack('A-01', 1), rack('A-02', 2), rack('A-03', 3)] };

  it('front elevation keeps bay-ascending order, as the contract already hands it', () => {
    const layout = layoutRow(row, 'front');
    expect(layout.racks.map((r) => r.id)).toEqual(['A-01', 'A-02', 'A-03']);
    expect(layout.elevation).toBe('front');
  });

  it('rear elevation reverses the bay order — you have walked round', () => {
    const layout = layoutRow(row, 'rear');
    expect(layout.racks.map((r) => r.id)).toEqual(['A-03', 'A-02', 'A-01']);
  });

  it('never mutates the row it was handed', () => {
    layoutRow(row, 'rear');
    expect(row.racks.map((r) => r.id)).toEqual(['A-01', 'A-02', 'A-03']);
  });

  it('carries the row label through unchanged', () => {
    expect(layoutRow(row, 'front').label).toBe('A');
    expect(layoutRow({ label: null, racks: [] }, 'front').label).toBeNull();
  });
});

describe('rowKey: a stable key even for an unlabelled row', () => {
  it('uses the label when there is one', () => {
    expect(rowKey({ label: 'A' }, 0)).toBe('A');
  });

  it('falls back to the index — two unlabelled rows never collide', () => {
    expect(rowKey({ label: null }, 0)).not.toBe(rowKey({ label: null }, 1));
  });
});
