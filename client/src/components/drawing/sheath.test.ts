import { describe, expect, it } from 'vitest';

import { COPPER_SHEATHS, FIBRE_SHEATHS, POWER_SHEATHS, needsHairlineOutline, sheathsFor } from './sheath';

describe('sheathsFor — the picker\'s list per kind', () => {
  it('copper lists the nine stock lead colours', () => {
    expect(sheathsFor('copper')).toEqual(COPPER_SHEATHS);
    expect(sheathsFor('copper')).toHaveLength(9);
  });

  it('fibre lists the four TIA-598-C jacket colours', () => {
    expect(sheathsFor('fibre')).toEqual(FIBRE_SHEATHS);
    expect(sheathsFor('fibre')).toHaveLength(4);
  });

  it('power lists one fixed grey', () => {
    expect(sheathsFor('power')).toEqual(POWER_SHEATHS);
    expect(sheathsFor('power')).toEqual(['grey']);
  });

  it('the three lists never overlap in a way that hides a kind change', () => {
    // fibre and copper legitimately share yellow/orange (UI-SPEC: "the pair
    // is what tells them apart," not the hue) — this only guards that the
    // lists themselves are the distinct arrays above, not aliases of one another.
    expect(sheathsFor('copper')).not.toBe(sheathsFor('fibre'));
  });
});

describe('needsHairlineOutline', () => {
  it('is true for white and black — the two sheaths that can blend into a page', () => {
    expect(needsHairlineOutline('white')).toBe(true);
    expect(needsHairlineOutline('black')).toBe(true);
  });

  it('is false for every other sheath', () => {
    for (const sheath of COPPER_SHEATHS) {
      if (sheath === 'white' || sheath === 'black') continue;
      expect(needsHairlineOutline(sheath)).toBe(false);
    }
  });
});
