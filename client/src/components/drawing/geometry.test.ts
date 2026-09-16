import { describe, expect, it } from 'vitest';

import {
  CAMERA_STOPS,
  RACK_HEADER_PX,
  U_PX,
  cameraStopAt,
  overlapsRack,
  portOpacity,
  rackAtPoint,
  snapDropToU,
  sortFreeRuns,
  uToOffsetPx,
} from './geometry';

describe('cameraStopAt', () => {
  it('reads the exact stops back', () => {
    expect(cameraStopAt(CAMERA_STOPS.closet)).toBe('closet');
    expect(cameraStopAt(CAMERA_STOPS.rack)).toBe('rack');
    expect(cameraStopAt(CAMERA_STOPS.faceplate)).toBe('faceplate');
  });

  it('picks the nearest stop off-exact', () => {
    expect(cameraStopAt(60)).toBe('closet');
    expect(cameraStopAt(90)).toBe('rack');
    expect(cameraStopAt(150)).toBe('rack');
    expect(cameraStopAt(200)).toBe('faceplate');
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
