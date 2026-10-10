import { describe, expect, it } from 'vitest';

import { CANVAS_MIN, clampWidth, fitPanels, keyedWidth, PANEL_FLOOR, PANEL_MIN, panelCap, panelMax } from './panelSizing';

const base = { bodyWidth: 1440, windowWidth: 1440, stripsWidth: 56 };

describe('fitPanels', () => {
  it('draws a folded side as 0 and an open one as wanted', () => {
    expect(fitPanels({ ...base, left: null, right: 420 })).toEqual({ left: 0, right: 420 });
    expect(fitPanels({ ...base, left: 240, right: null })).toEqual({ left: 240, right: 0 });
  });

  it('holds a wanted width to the drag range', () => {
    expect(fitPanels({ ...base, left: null, right: 100 }).right).toBe(PANEL_MIN);
    expect(fitPanels({ ...base, left: null, right: 5000 }).right).toBe(panelCap(1440));
  });

  it('never lets the canvas drop below its minimum', () => {
    for (const bodyWidth of [900, 1000, 1200, 1440]) {
      const fit = fitPanels({ bodyWidth, windowWidth: bodyWidth, stripsWidth: 56, left: 400, right: 700 });
      expect(bodyWidth - 56 - fit.left - fit.right).toBeGreaterThanOrEqual(CANVAS_MIN);
    }
  });

  it('shrinks both panels together, not one to nothing', () => {
    const fit = fitPanels({ bodyWidth: 1000, windowWidth: 1000, stripsWidth: 56, left: 400, right: 500 });
    expect(fit.left).toBeGreaterThanOrEqual(PANEL_MIN);
    expect(fit.right).toBeGreaterThanOrEqual(PANEL_MIN);
  });

  it('goes below the minimum, to the floor, in a window too narrow', () => {
    const fit = fitPanels({ bodyWidth: 700, windowWidth: 700, stripsWidth: 56, left: 240, right: 316 });
    expect(fit.left).toBeGreaterThanOrEqual(PANEL_FLOOR);
    expect(fit.right).toBeGreaterThanOrEqual(PANEL_FLOOR);
    expect(fit.left + fit.right).toBeLessThan(556);
  });
});

describe('panelMax and keyedWidth', () => {
  it('is half the window, less what the canvas needs', () => {
    expect(panelMax(1440, 1440, 56, 0)).toBe(720);
    expect(panelMax(1440, 1000, 56, 316)).toBe(1000 - 56 - CANVAS_MIN - 316);
    expect(panelMax(300, 300, 56, 0)).toBe(PANEL_MIN);
  });

  it('moves by a step with the arrow that widens, and the other narrows', () => {
    expect(keyedWidth(316, 'ArrowLeft', false, 'ArrowLeft', 720)).toBe(332);
    expect(keyedWidth(316, 'ArrowRight', false, 'ArrowLeft', 720)).toBe(300);
    expect(keyedWidth(316, 'ArrowLeft', true, 'ArrowLeft', 720)).toBe(380);
  });

  it('stops at the limits, jumps with Home and End, ignores other keys', () => {
    expect(keyedWidth(250, 'ArrowRight', true, 'ArrowLeft', 720)).toBe(PANEL_MIN);
    expect(keyedWidth(300, 'Home', false, 'ArrowLeft', 720)).toBe(PANEL_MIN);
    expect(keyedWidth(300, 'End', false, 'ArrowLeft', 720)).toBe(720);
    expect(keyedWidth(300, 'a', false, 'ArrowLeft', 720)).toBeNull();
    expect(clampWidth(10_000, 600)).toBe(600);
  });
});
