import { describe, expect, it } from 'vitest';

import { panToShow } from './keepInView';

const pane = { left: 0, right: 1056 };

describe('panToShow', () => {
  it('leaves a box that already shows alone', () => {
    expect(panToShow(pane, { left: 400, right: 700 }, 16)).toBe(0);
  });

  it('pulls a box out from under a panel on the right', () => {
    // The shelf inset the camera opened at 952..1432 with the details panel taking the pane to 1056.
    expect(panToShow(pane, { left: 952, right: 1432 }, 16)).toBe(1040 - 1432);
  });

  it('pushes a box clipped on the left back in', () => {
    expect(panToShow(pane, { left: -50, right: 200 }, 16)).toBe(66);
  });

  it('keeps the left edge when the box is wider than the pane', () => {
    expect(panToShow(pane, { left: 300, right: 1600 }, 16)).toBe(-284);
  });
});
