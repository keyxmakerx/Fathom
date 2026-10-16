import { describe, expect, it } from 'vitest';

import {
  BELL_ANGLES_DEG,
  BELL_CYCLE_S,
  BELL_SWING_FRACTION,
  CRAWL_PERIOD_PX,
  CRAWL_PERIOD_S,
  CRAWL_PX_PER_S,
  DASH_ACROSS_PX,
  DASH_PX,
  DASH_SKEW_DEG,
  GAP_PX,
  LOOSE_NODE_W,
  LOOSE_RUN_PX,
  LOOSE_SOLID_PX,
  LOOSE_STRETCH_PX,
  MISSING_CIRCLE_R,
  MISSING_MARK_PX,
  circleCentre,
  dashPoints,
  fadeStops,
  looseColumn,
  looseRect,
  stretchDashes,
  stretchRange,
} from './looseEnd';

describe('the numbers the owner gave', () => {
  it('has a last stretch of about 110px', () => {
    expect(LOOSE_STRETCH_PX).toBe(110);
    expect(LOOSE_SOLID_PX + LOOSE_STRETCH_PX).toBe(LOOSE_RUN_PX);
  });
  it('draws dashes ~4px wide, ~4px apart, ~6px tall, skewed about -35 degrees, crawling ~18px a second', () => {
    expect([DASH_PX, GAP_PX, DASH_ACROSS_PX, DASH_SKEW_DEG, CRAWL_PX_PER_S]).toEqual([4, 4, 6, -35, 18]);
    expect(CRAWL_PERIOD_PX).toBe(8);
    expect(CRAWL_PERIOD_S).toBeCloseTo(8 / 18, 6);
  });
  it('makes a circle of radius 12', () => {
    expect(MISSING_CIRCLE_R).toBe(12);
  });
  it('swings the ? 16, -14, 10, -6, 3 degrees and settles, every 3.2s, over the last 30% of the cycle', () => {
    expect(BELL_ANGLES_DEG).toEqual([16, -14, 10, -6, 3, 0]);
    expect(BELL_CYCLE_S).toBe(3.2);
    expect(BELL_SWING_FRACTION).toBe(0.3);
  });
  it('has one size for the ?', () => {
    expect(MISSING_MARK_PX).toBeGreaterThan(0);
  });
});

describe('where the loose end sits', () => {
  it('runs down from a lead that leaves downward, up from one that leaves upward', () => {
    expect(looseRect({ x: 100, y: 50, dir: 1 })).toEqual({ x: 100 - LOOSE_NODE_W / 2, y: 50, width: LOOSE_NODE_W, height: LOOSE_RUN_PX });
    expect(looseRect({ x: 100, y: 50, dir: -1 })).toEqual({ x: 100 - LOOSE_NODE_W / 2, y: 50 - LOOSE_RUN_PX, width: LOOSE_NODE_W, height: LOOSE_RUN_PX });
  });
  it('keeps the port at one end of the column and the tip at the other', () => {
    expect(looseColumn(1)).toMatchObject({ portY: 0, tipY: LOOSE_RUN_PX });
    expect(looseColumn(-1)).toMatchObject({ portY: LOOSE_RUN_PX, tipY: 0 });
  });
  it('puts the circle in the middle of the last stretch, whichever way it runs', () => {
    expect(circleCentre(1).y).toBe(LOOSE_SOLID_PX + LOOSE_STRETCH_PX / 2);
    expect(circleCentre(-1).y).toBe(LOOSE_RUN_PX - (LOOSE_SOLID_PX + LOOSE_STRETCH_PX / 2));
    for (const dir of [1, -1] as const) {
      const { top, bottom } = stretchRange(dir);
      expect(bottom - top).toBe(LOOSE_STRETCH_PX);
      expect(circleCentre(dir).y).toBeCloseTo((top + bottom) / 2, 6);
    }
  });
});

describe('the fade (Unknown)', () => {
  it('is full along the solid part, then a straight line down to nothing at the tip', () => {
    expect(fadeStops()).toEqual([
      { offset: 0, opacity: 1 },
      { offset: LOOSE_SOLID_PX / LOOSE_RUN_PX, opacity: 1 },
      { offset: 1, opacity: 0 },
    ]);
  });
});

describe('the dashes (Needs finishing)', () => {
  it('fill the stretch at one dash and one gap per period, with a spare period at each end', () => {
    const dashes = stretchDashes(1);
    expect(dashes.length).toBe(Math.ceil((LOOSE_STRETCH_PX + 2 * CRAWL_PERIOD_PX) / CRAWL_PERIOD_PX));
    expect(new Set(dashes).size).toBe(dashes.length);
  });
  it('are parallelograms: across the line, DASH_PX along it, their ends leaning', () => {
    const pts = dashPoints(24, 40)
      .split(' ')
      .map((p) => p.split(',').map(Number) as [number, number]);
    expect(pts).toHaveLength(4);
    // Top edge is DASH_ACROSS_PX wide, bottom edge the same, DASH_PX lower.
    expect(pts[1]![0] - pts[0]![0]).toBeCloseTo(DASH_ACROSS_PX, 1);
    expect(pts[2]![0] - pts[3]![0]).toBeCloseTo(DASH_ACROSS_PX, 1);
    expect(pts[3]![1] - pts[0]![1]).toBe(DASH_PX);
    // The lean is DASH_PX * tan(35 degrees), toward the left going down (a -35 degree skew).
    const lean = pts[3]![0] - pts[0]![0];
    expect(lean).toBeCloseTo(-DASH_PX * Math.tan((35 * Math.PI) / 180), 1);
  });
});
