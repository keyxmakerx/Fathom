import { describe, expect, it } from 'vitest';

import { PORT_CLICK_DRAG_THRESHOLD_PX, isDragMovement } from './connectThreshold';

describe('isDragMovement — the click-versus-drag rule', () => {
  it('no movement at all is never a drag', () => {
    expect(isDragMovement(0, 0)).toBe(false);
  });

  it('movement at or under the threshold is still a click', () => {
    expect(isDragMovement(PORT_CLICK_DRAG_THRESHOLD_PX, 0)).toBe(false);
    expect(isDragMovement(0, PORT_CLICK_DRAG_THRESHOLD_PX)).toBe(false);
  });

  it('movement past the threshold, on either axis, is a drag', () => {
    expect(isDragMovement(PORT_CLICK_DRAG_THRESHOLD_PX + 1, 0)).toBe(true);
    expect(isDragMovement(0, PORT_CLICK_DRAG_THRESHOLD_PX + 1)).toBe(true);
  });

  it('diagonal movement is measured as a real distance, not per-axis', () => {
    // 3-4-5 triangle: at threshold 4, (3,4) is distance exactly 5 — over.
    expect(isDragMovement(3, 4, 4)).toBe(true);
    // A diagonal that stays within the same 4px radius is still a click.
    expect(isDragMovement(2, 2, 4)).toBe(false);
  });

  it('a smaller threshold (the library default, 1px) is honoured when passed explicitly', () => {
    expect(isDragMovement(1, 0, 1)).toBe(false);
    expect(isDragMovement(2, 0, 1)).toBe(true);
  });

  it('the chosen threshold is a few pixels, per the brief — not the library default of 1', () => {
    expect(PORT_CLICK_DRAG_THRESHOLD_PX).toBeGreaterThan(1);
    expect(PORT_CLICK_DRAG_THRESHOLD_PX).toBeLessThanOrEqual(10);
  });
});
