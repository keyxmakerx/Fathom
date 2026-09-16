import { describe, expect, it } from 'vitest';

import {
  CAMERA_STOPS,
  MAX_GLYPH_TRUE_HEIGHT_PX,
  RACK_HEADER_PX,
  TEXT_FLOOR_PX,
  U_PX,
  cameraStopAt,
  counterScaledFontPx,
  counterScaledGlyphScale,
  glyphScaleFittingBudget,
  overlapsRack,
  portOpacity,
  rackAtPoint,
  snapDropToU,
  sortFreeRuns,
  uToOffsetPx,
} from './geometry';

describe('the rack stop fits the reference 42U rack', () => {
  it('42U at U_PX plus the header fits inside the drawing pane (819px, 1440x900)', () => {
    const DRAWING_PANE_PX = 819;
    expect(RACK_HEADER_PX + 42 * U_PX).toBeLessThan(DRAWING_PANE_PX);
  });

  it('the closet and faceplate stops read the approved boards exactly', () => {
    expect(U_PX * (CAMERA_STOPS.closet / 100)).toBeCloseTo(14, 5);
    expect(U_PX * (CAMERA_STOPS.faceplate / 100)).toBeCloseTo(32, 5);
  });
});

describe('counterScaledFontPx', () => {
  it('matches basePx once zoomed in enough that the floor is already cleared', () => {
    expect(counterScaledFontPx(10, 1)).toBe(10);
    expect(counterScaledFontPx(10, 2)).toBe(10);
  });

  it('grows the on-screen size above the floor as the camera zooms in', () => {
    const zoom = 2;
    expect(counterScaledFontPx(10, zoom) * zoom).toBe(20);
  });

  it('pins the on-screen size at the floor once zooming out would drop below it', () => {
    const zoom = CAMERA_STOPS.closet / 100; // 0.875
    const onScreen = counterScaledFontPx(10, zoom) * zoom;
    expect(onScreen).toBeCloseTo(TEXT_FLOOR_PX, 5);
  });

  it('never drops below the floor no matter how far out the camera goes', () => {
    const zoom = 0.1;
    const onScreen = counterScaledFontPx(10, zoom) * zoom;
    expect(onScreen).toBeGreaterThanOrEqual(TEXT_FLOOR_PX - 1e-9);
  });
});

describe('counterScaledGlyphScale', () => {
  it('is the true-size scale (1) at the rack stop', () => {
    expect(counterScaledGlyphScale(CAMERA_STOPS.rack / 100)).toBe(1);
  });

  it('halves at the faceplate stop, where the camera itself is 2x the rack stop', () => {
    expect(counterScaledGlyphScale(CAMERA_STOPS.faceplate / 100)).toBe(0.5);
  });

  it('renders at a constant true on-screen size at every zoom', () => {
    for (const zoom of [0.5, 1, 1.5, 2, 3]) {
      expect(counterScaledGlyphScale(zoom) * zoom).toBeCloseTo(1, 10);
    }
  });
});

describe('glyphScaleFittingBudget', () => {
  it('matches counterScaledGlyphScale when the row has room to spare', () => {
    const zoom = CAMERA_STOPS.faceplate / 100;
    expect(glyphScaleFittingBudget(zoom, 1000)).toBe(counterScaledGlyphScale(zoom));
  });

  it('shrinks below true size rather than overflow a too-small row', () => {
    const zoom = CAMERA_STOPS.faceplate / 100;
    const tightBudget = 10; // less than MAX_GLYPH_TRUE_HEIGHT_PX * counterScaledGlyphScale(zoom) = 10.5
    const scale = glyphScaleFittingBudget(zoom, tightBudget);
    expect(scale).toBeLessThan(counterScaledGlyphScale(zoom));
    expect(MAX_GLYPH_TRUE_HEIGHT_PX * scale).toBeCloseTo(tightBudget, 5);
  });

  it('never divides by zero when there is no room at all', () => {
    expect(() => glyphScaleFittingBudget(2, 0)).not.toThrow();
    expect(glyphScaleFittingBudget(2, 0)).toBe(0);
  });
});

describe('cameraStopAt', () => {
  it('reads the exact stops back', () => {
    expect(cameraStopAt(CAMERA_STOPS.closet)).toBe('closet');
    expect(cameraStopAt(CAMERA_STOPS.rack)).toBe('rack');
    expect(cameraStopAt(CAMERA_STOPS.faceplate)).toBe('faceplate');
  });

  it('picks the nearest stop off-exact', () => {
    // Written against `CAMERA_STOPS` rather than literal percentages so this
    // stays true however the three numbers are derived (session 4 rebased
    // them against the 42U reference rack, not a board's literal pixel size).
    expect(cameraStopAt(CAMERA_STOPS.closet - 20)).toBe('closet');
    expect(cameraStopAt((CAMERA_STOPS.closet + CAMERA_STOPS.rack) / 2 + 1)).toBe('rack');
    expect(cameraStopAt(CAMERA_STOPS.rack + (CAMERA_STOPS.faceplate - CAMERA_STOPS.rack) * 0.25)).toBe('rack');
    expect(cameraStopAt(CAMERA_STOPS.faceplate - 20)).toBe('faceplate');
  });

  it('clamps below the lowest and above the highest stop', () => {
    expect(cameraStopAt(0)).toBe('closet');
    expect(cameraStopAt(10000)).toBe('faceplate');
  });
});

describe('portOpacity', () => {
  it('is invisible at and below the rack stop', () => {
    expect(portOpacity(CAMERA_STOPS.rack)).toBe(0);
    expect(portOpacity(50)).toBe(0);
  });

  it('is fully opaque at and above the faceplate stop', () => {
    expect(portOpacity(CAMERA_STOPS.faceplate)).toBe(1);
    expect(portOpacity(500)).toBe(1);
  });

  it('ramps linearly between the two', () => {
    const mid = (CAMERA_STOPS.rack + CAMERA_STOPS.faceplate) / 2;
    expect(portOpacity(mid)).toBeCloseTo(0.5, 5);
  });
});

describe('snapDropToU / uToOffsetPx round-trip', () => {
  it('snaps a drop at the very top of the column to the topmost legal position', () => {
    expect(snapDropToU(42, 0, 2)).toBe(41);
  });

  it('snaps a drop at the very bottom of the column to U1', () => {
    expect(snapDropToU(42, 41 * U_PX, 1)).toBe(1);
  });

  it('clamps an over-the-bottom drop so the run stays inside the rack', () => {
    expect(snapDropToU(42, 100 * U_PX, 4)).toBe(1);
  });

  it('clamps an over-the-top drop so the run stays inside the rack', () => {
    expect(snapDropToU(42, -100, 4)).toBe(39);
  });

  it('rounds to the nearest U rather than always flooring', () => {
    // 10.6 U from the top rounds to 11, not 10.
    expect(snapDropToU(42, 10.6 * U_PX, 1)).toBe(42 - 11);
  });

  it('is the inverse of uToOffsetPx for an on-grid offset', () => {
    const rackHeightU = 42;
    const heightU = 2;
    const positionU = 30;
    const offset = uToOffsetPx(rackHeightU, positionU, heightU);
    expect(snapDropToU(rackHeightU, offset, heightU)).toBe(positionU);
  });
});

describe('overlapsRack', () => {
  const rack = {
    heightU: 42,
    chassis: [
      { id: 'a', positionU: 40, heightU: 2 },
      { id: 'b', positionU: 30, heightU: 1 },
    ],
  };

  it('is false for a run that fits in a gap', () => {
    expect(overlapsRack(rack, { positionU: 35, heightU: 2 })).toBe(false);
  });

  it('is true for a run overlapping an existing chassis', () => {
    expect(overlapsRack(rack, { positionU: 39, heightU: 2 })).toBe(true);
  });

  it('is true for a run that shares only one U with an existing chassis', () => {
    expect(overlapsRack(rack, { positionU: 29, heightU: 2 })).toBe(true);
  });

  it('excludes the candidate itself by id, so a chassis can move without colliding with its own slot', () => {
    expect(overlapsRack(rack, { id: 'b', positionU: 30, heightU: 1 })).toBe(false);
    expect(overlapsRack(rack, { id: 'b', positionU: 31, heightU: 1 })).toBe(false);
  });

  it('is true for a run that would run off the top of the rack', () => {
    expect(overlapsRack(rack, { positionU: 41, heightU: 4 })).toBe(true);
  });

  it('is true for a positionU below 1', () => {
    expect(overlapsRack(rack, { positionU: 0, heightU: 1 })).toBe(true);
  });
});

describe('sortFreeRuns', () => {
  it('orders top-down by the top of the run', () => {
    const runs = [
      { fromU: 1, toU: 3 },
      { fromU: 38, toU: 41 },
      { fromU: 20, toU: 25 },
    ];
    expect(sortFreeRuns(runs)).toEqual([
      { fromU: 38, toU: 41 },
      { fromU: 20, toU: 25 },
      { fromU: 1, toU: 3 },
    ]);
  });

  it('does not mutate the input array', () => {
    const runs = [
      { fromU: 1, toU: 3 },
      { fromU: 38, toU: 41 },
    ];
    const original = [...runs];
    sortFreeRuns(runs);
    expect(runs).toEqual(original);
  });

  it('breaks a tie at the same top by the bottom of the run, descending', () => {
    const runs = [
      { fromU: 10, toU: 15 },
      { fromU: 12, toU: 15 },
    ];
    expect(sortFreeRuns(runs)).toEqual([
      { fromU: 12, toU: 15 },
      { fromU: 10, toU: 15 },
    ]);
  });
});

describe('rackAtPoint', () => {
  const racks = [
    { id: 'a', heightU: 42 },
    { id: 'b', heightU: 24 },
  ];
  const positions = { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } };
  const width = 300;

  it('finds the rack a point falls inside', () => {
    expect(rackAtPoint(racks, positions, { x: 50, y: 100 }, width)?.id).toBe('a');
    expect(rackAtPoint(racks, positions, { x: 450, y: 100 }, width)?.id).toBe('b');
  });

  it('returns null for a point in the gap between racks', () => {
    expect(rackAtPoint(racks, positions, { x: 350, y: 100 }, width)).toBeNull();
  });

  it('returns null for a point below or above every rack', () => {
    expect(rackAtPoint(racks, positions, { x: 50, y: -10 }, width)).toBeNull();
    expect(rackAtPoint(racks, positions, { x: 50, y: RACK_HEADER_PX + 42 * U_PX + 1 }, width)).toBeNull();
  });

  it('skips a rack with no session position rather than throwing', () => {
    const sparse = { a: { x: 0, y: 0 } };
    expect(rackAtPoint(racks, sparse, { x: 450, y: 100 }, width)).toBeNull();
  });
});
