import { describe, expect, it } from 'vitest';

import type { RackView, RowView } from './contract';
import type { SurfaceView } from '../../document/view';
import {
  DEFAULT_PANEL_WIDTH_PX,
  FLOOR_BAND_HEIGHT_PX,
  SURFACE_GAP_PX,
  layoutRow,
  layoutSurfaces,
  mirroredRackX,
  mmRailTicks,
  mmToPx,
  pxPerMm,
  rowKey,
} from './rows';

function rack(id: string, bay: number, heightU = 42): RackView {
  return {
    id,
    label: id,
    heightU,
    unitNumbering: 'bottom-up',
    chassis: [],
    shelves: [],
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

function surface(id: string, form: SurfaceView['form'], widthMm: number | null = null): SurfaceView {
  return { id, label: id, form, widthMm, heightMm: null, fixtures: [] };
}

describe('the mm/px scale — 44.45 mm per U (ADR-0051 §1/§2, design/places/renders/Surfaces.png)', () => {
  const U_PX = 16;

  it('one U (44.45mm) converts to exactly one U_PX', () => {
    expect(mmToPx(44.45, U_PX)).toBeCloseTo(U_PX, 10);
  });

  it('pxPerMm is the same ratio U_PX/44.45 mmToPx uses internally', () => {
    expect(mmToPx(1000, U_PX)).toBeCloseTo(pxPerMm(U_PX) * 1000, 10);
  });
});

describe('layoutSurfaces — ADR-0051 §1: surfaces after the rows', () => {
  const U_PX = 16;
  const ROWS_WIDTH = 852; // three racks, RACK_NODE_WIDTH/RACK_GAP_PX-shaped, but as a plain number here
  const ROWS_HEIGHT = 688; // one row band's own height

  it('a wall panel sits to the right of the row block, at rowsWidthPx + the gap', () => {
    const layout = layoutSurfaces([surface('wall-1', 'wall')], ROWS_WIDTH, ROWS_HEIGHT, 688, U_PX);
    expect(layout.panels).toHaveLength(1);
    expect(layout.panels[0]!.x).toBe(ROWS_WIDTH + SURFACE_GAP_PX);
    expect(layout.panels[0]!.y).toBe(0);
  });

  it('a second panel stacks below the first, same x, panelHeightPx + gap down', () => {
    const layout = layoutSurfaces([surface('wall-1', 'wall'), surface('desk-1', 'desk')], ROWS_WIDTH, ROWS_HEIGHT, 688, U_PX);
    expect(layout.panels[1]!.x).toBe(layout.panels[0]!.x);
    expect(layout.panels[1]!.y).toBe(688 + SURFACE_GAP_PX);
  });

  it('every non-floor panel draws the same height — "the height of a rack," never its own heightMm', () => {
    const layout = layoutSurfaces([surface('wall-1', 'wall'), surface('ceiling-1', 'ceiling')], ROWS_WIDTH, ROWS_HEIGHT, 688, U_PX);
    expect(layout.panels[0]!.heightPx).toBe(688);
    expect(layout.panels[1]!.heightPx).toBe(688);
  });

  it('a panel with a measured width_mm scales it against the same ruler a rack elevation uses', () => {
    const layout = layoutSurfaces([surface('wall-1', 'wall', 2400)], ROWS_WIDTH, ROWS_HEIGHT, 688, U_PX);
    expect(layout.panels[0]!.widthPx).toBeCloseTo(mmToPx(2400, U_PX), 10);
  });

  it('an unmeasured panel falls back to the default width — never invented from nothing', () => {
    const layout = layoutSurfaces([surface('wall-1', 'wall')], ROWS_WIDTH, ROWS_HEIGHT, 688, U_PX);
    expect(layout.panels[0]!.widthPx).toBe(DEFAULT_PANEL_WIDTH_PX);
  });

  it('the floor spans beneath the rows AND the panels, whichever reaches further right/down', () => {
    const layout = layoutSurfaces([surface('wall-1', 'wall', 2400), surface('floor-1', 'floor')], ROWS_WIDTH, ROWS_HEIGHT, 688, U_PX);
    expect(layout.floor).not.toBeNull();
    expect(layout.floor!.x).toBe(0);
    expect(layout.floor!.widthPx).toBeGreaterThanOrEqual(ROWS_WIDTH);
    expect(layout.floor!.widthPx).toBeGreaterThanOrEqual(ROWS_WIDTH + SURFACE_GAP_PX + mmToPx(2400, U_PX));
    expect(layout.floor!.heightPx).toBe(FLOOR_BAND_HEIGHT_PX);
    // Beneath both the row block and the (taller, here) panel column.
    expect(layout.floor!.y).toBeGreaterThanOrEqual(ROWS_HEIGHT);
  });

  it('a view with no floor surface draws no floor band', () => {
    const layout = layoutSurfaces([surface('wall-1', 'wall')], ROWS_WIDTH, ROWS_HEIGHT, 688, U_PX);
    expect(layout.floor).toBeNull();
  });

  it('a view with no surfaces at all lays out nothing', () => {
    const layout = layoutSurfaces([], ROWS_WIDTH, ROWS_HEIGHT, 688, U_PX);
    expect(layout.panels).toEqual([]);
    expect(layout.floor).toBeNull();
  });

  it('positions are stable across a row flip: layoutSurfaces reads only the row block\'s own width/height, never a rack\'s order', () => {
    // A flip (`layoutRow`) reverses `RowLayout.racks` but changes neither
    // the row's rack count nor any rack's own height — so the row block's
    // own width/height a caller derives from it (`Drawing.tsx`'s own
    // `rowBandY` plus rack-count arithmetic) is identical before and after.
    // `layoutSurfaces` itself takes no rack order at all, only those two
    // numbers, so the same call before and after a flip is definitionally
    // the same call.
    const before = layoutSurfaces([surface('wall-1', 'wall', 2400), surface('floor-1', 'floor')], ROWS_WIDTH, ROWS_HEIGHT, 688, U_PX);
    const after = layoutSurfaces([surface('wall-1', 'wall', 2400), surface('floor-1', 'floor')], ROWS_WIDTH, ROWS_HEIGHT, 688, U_PX);
    expect(after).toEqual(before);
  });
});

describe('mmRailTicks', () => {
  const U_PX = 16;

  it('always starts at 0 — the floor', () => {
    expect(mmRailTicks(688, U_PX)[0]).toBe(0);
  });

  it('steps by 300mm by default, never past what the panel actually covers', () => {
    const ticks = mmRailTicks(mmToPx(900, U_PX), U_PX);
    expect(ticks).toEqual([0, 300, 600, 900]);
  });

  it('a zero-height panel still gives the floor tick, never an empty rail', () => {
    expect(mmRailTicks(0, U_PX)).toEqual([0]);
  });

  it('a custom step is honoured', () => {
    expect(mmRailTicks(mmToPx(1000, U_PX), U_PX, 500)).toEqual([0, 500, 1000]);
  });
});
