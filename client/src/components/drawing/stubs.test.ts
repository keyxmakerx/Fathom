import { describe, expect, it } from 'vitest';

import { axisToward, endOffScreen, stubRun, stubTagText, visibleRect } from './stubs';

describe('stubs', () => {
  it('is off screen only past the inset, and sticky at the edge', () => {
    const rect = visibleRect({ x: 0, y: 0, zoom: 1 }, { width: 1000, height: 600 });
    expect(endOffScreen({ x: 500, y: 300 }, rect, 1, false)).toBe(false);
    expect(endOffScreen({ x: 1020, y: 300 }, rect, 1, false)).toBe(false);
    expect(endOffScreen({ x: 1030, y: 300 }, rect, 1, false)).toBe(true);
    expect(endOffScreen({ x: 995, y: 300 }, rect, 1, true)).toBe(true);
    expect(endOffScreen({ x: 980, y: 300 }, rect, 1, true)).toBe(false);
  });
  it('maps the viewport to flow space', () => {
    expect(visibleRect({ x: -200, y: 100, zoom: 2 }, { width: 400, height: 400 })).toEqual({ x0: 100, y0: -50, x1: 300, y1: 150 });
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
