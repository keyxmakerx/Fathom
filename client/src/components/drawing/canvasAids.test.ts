import { describe, expect, it } from 'vitest';

import { DEFAULT_AIDS, colourKeyShown, parseAids } from './canvasAids';

describe('canvas aids', () => {
  it('starts with the mini-map allowed and the colour key automatic', () => {
    expect(parseAids(undefined)).toEqual(DEFAULT_AIDS);
    expect(DEFAULT_AIDS).toEqual({ minimap: true, colourKey: null });
  });

  it('keeps clear yes and no answers and drops the rest', () => {
    expect(parseAids({ minimap: false, colourKey: true })).toEqual({ minimap: false, colourKey: true });
    expect(parseAids({ minimap: 'no', colourKey: 3 })).toEqual(DEFAULT_AIDS);
    expect(parseAids('junk')).toEqual(DEFAULT_AIDS);
  });

  it('shows the colour key on its own only for two or more colours', () => {
    expect(colourKeyShown(null, 1)).toBe(false);
    expect(colourKeyShown(null, 2)).toBe(true);
    expect(colourKeyShown(false, 5)).toBe(false);
    expect(colourKeyShown(true, 1)).toBe(true);
  });
});
