import { describe, expect, it } from 'vitest';

import { NOTE_GAP_PX, paddingClearOf } from './emptyFit';

const pane = { top: 44, bottom: 900, height: 856 };

describe('the empty design fits its rack above the note', () => {
  it('keeps the plain padding when there is no note', () => {
    expect(paddingClearOf(pane, null)).toBe(0.1);
    expect(paddingClearOf(null, { top: 750, bottom: 843, height: 93 })).toBe(0.1);
  });

  it('takes the note and a gap off the bottom, in pixels', () => {
    const p = paddingClearOf(pane, { top: 750, bottom: 843, height: 93 });
    expect(p).toEqual({ top: '10%', right: '10%', left: '10%', bottom: `${900 - 750 + NOTE_GAP_PX}px` });
  });

  it('ignores a note outside the pane', () => {
    expect(paddingClearOf(pane, { top: 950, bottom: 1000, height: 50 })).toBe(0.1);
    expect(paddingClearOf(pane, { top: 0, bottom: 30, height: 30 })).toBe(0.1);
  });
});
