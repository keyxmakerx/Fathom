import { describe, expect, it } from 'vitest';

import type { RackView, RowView } from './contract';
import { layoutRow, mirroredRackX, rowKey } from './rows';

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

describe('mirroredRackX: a dragged rack\'s own position on a row flip — s6f #3', () => {
  const WIDTH = 200;
  const GAP = 50;

  it('a rack already sitting exactly on a bay slot lands on the same x the reversed bay order gives it', () => {
    // Three racks, bay 0/1/2 — `layoutRow`'s own reversed order puts bay b
    // at the slot bay `n-1-b` would ordinarily occupy.
    const n = 3;
    for (let bay = 0; bay < n; bay += 1) {
      const originalX = bay * (WIDTH + GAP);
      const wantX = (n - 1 - bay) * (WIDTH + GAP);
      expect(mirroredRackX(originalX, n, WIDTH, GAP)).toBe(wantX);
    }
  });

  it('a rack dragged off any slot mirrors across the row\'s own width, not to a fresh slot', () => {
    // Row width for 2 racks: (2-1)*(200+50)+200 = 450.
    expect(mirroredRackX(100, 2, WIDTH, GAP)).toBe(150);
    // Neither 100 nor 150 is a bay-index slot (0 or 250) — the point of the
    // rule: this rack never snaps to one.
    expect(mirroredRackX(100, 2, WIDTH, GAP)).not.toBe(0);
    expect(mirroredRackX(100, 2, WIDTH, GAP)).not.toBe(250);
  });

  it('a single-rack row leaves the rack exactly where it is — it spans the row\'s own full width', () => {
    expect(mirroredRackX(0, 1, WIDTH, GAP)).toBe(0);
  });

  it('mirroring is its own inverse: flipping back lands exactly where it started', () => {
    const once = mirroredRackX(73, 4, WIDTH, GAP);
    const twice = mirroredRackX(once, 4, WIDTH, GAP);
    expect(twice).toBe(73);
  });

  it('an empty row (no racks) is a no-op — nothing to mirror across', () => {
    expect(mirroredRackX(42, 0, WIDTH, GAP)).toBe(42);
  });
});
