import { describe, expect, it } from 'vitest';

import { isLensLit, LENS_LABEL, LENSES } from './lens';

describe('LENSES', () => {
  it('is fixed in the order BRIEF.md names: Cables, Links, Routing, Power, Owner', () => {
    expect(LENSES).toEqual(['cables', 'links', 'routing', 'power', 'owner']);
  });

  it('has a display label for every lens', () => {
    for (const lens of LENSES) {
      expect(LENS_LABEL[lens]).toBeTruthy();
    }
    expect(LENS_LABEL.cables).toBe('Cables');
    expect(LENS_LABEL.owner).toBe('Owner');
  });
});

describe('isLensLit', () => {
  it('is lit only for the active lens', () => {
    expect(isLensLit('cables', 'cables')).toBe(true);
    expect(isLensLit('links', 'cables')).toBe(false);
  });

  it('never lights more than one lens at a time', () => {
    const active = 'routing';
    const litCount = LENSES.filter((lens) => isLensLit(lens, active)).length;
    expect(litCount).toBe(1);
  });
});
