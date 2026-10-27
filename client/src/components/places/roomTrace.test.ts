import { describe, expect, it } from 'vitest';

import { closesRoom, floorBox, labelAt, lengthWords, readDistance, snapPoint } from './roomTrace';

describe('tracing a room (ADR-0051: straight-line and right-angle snapping)', () => {
  it('squares the first wall to the plan and later walls to the last one', () => {
    expect(snapPoint([{ x: 0, y: 0 }], { x: 4000, y: 300 }, [], 50)).toEqual({ x: 4000, y: 0 });
    const draft = [{ x: 0, y: 0 }, { x: 4000, y: 0 }];
    expect(snapPoint(draft, { x: 4200, y: 3000 }, [], 50)).toEqual({ x: 4000, y: 3000 });
  });

  it('leaves a wall alone that is well off square, and lands on a corner already drawn', () => {
    expect(snapPoint([{ x: 0, y: 0 }], { x: 3000, y: 3000 }, [], 50)).toEqual({ x: 3000, y: 3000 });
    expect(snapPoint([{ x: 0, y: 0 }], { x: 3020, y: 2990 }, [{ x: 3000, y: 3000 }], 50)).toEqual({ x: 3000, y: 3000 });
  });

  it('closes on the first corner once there are three', () => {
    const draft = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    expect(closesRoom(draft.slice(0, 2), { x: 1, y: 1 }, 5)).toBe(false);
    expect(closesRoom(draft, { x: 1, y: 1 }, 5)).toBe(true);
  });

  it('frames the floor, labels a room in its middle, and reads distances as typed', () => {
    expect(floorBox([], null)).toEqual({ x: 0, y: 0, w: 20_000, h: 12_000 });
    expect(floorBox([{ x: 0, y: 0 }, { x: 10_000, y: 5000 }], null).w).toBeCloseTo(10_800);
    expect(labelAt([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }])).toEqual({ x: 5, y: 5 });
    expect(readDistance('4.2')).toBe(4200);
    expect(readDistance('4,2 m')).toBe(4200);
    expect(readDistance('850 mm')).toBe(850);
    expect(readDistance('wide')).toBeNull();
    expect(lengthWords(4200)).toBe('4.2 m');
    expect(lengthWords(850)).toBe('850 mm');
  });
});
