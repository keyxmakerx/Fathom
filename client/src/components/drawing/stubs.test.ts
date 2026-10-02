import { describe, expect, it } from 'vitest';

import { axisToward, isFarApart, stubRun, stubTagText, STUB_DISTANCE_PX } from './stubs';

describe('stubs', () => {
  it('is far only past the threshold', () => {
    expect(isFarApart({ x: 0, y: 0 }, { x: STUB_DISTANCE_PX, y: 0 })).toBe(false);
    expect(isFarApart({ x: 0, y: 0 }, { x: 600, y: 600 })).toBe(true);
  });
  it('names the far end and its rack', () => {
    expect(stubTagText('sw-09', 'R7')).toBe('→ sw-09 · in rack R7');
    expect(stubTagText('sw-09', null)).toBe('→ sw-09');
    expect(stubTagText('', 'R7', 3)).toBe('→ unnamed device · in rack R7 · ×3');
  });
  it('runs square along the dominant axis', () => {
    expect(axisToward({ x: 0, y: 0 }, { x: 500, y: 100 })).toEqual({ dx: 1, dy: 0 });
    expect(axisToward({ x: 0, y: 0 }, { x: 10, y: -500 })).toEqual({ dx: 0, dy: -1 });
    expect(stubRun({ x: 10, y: 20 }, 1, 0, 50)).toEqual({ d: 'M 10 20 L 60 20', end: { x: 60, y: 20 } });
  });
});
