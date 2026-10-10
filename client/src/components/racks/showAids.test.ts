import { describe, expect, it } from 'vitest';

import { DEFAULT_AIDS } from '../drawing/canvasAids';
import { showAidsFor } from './showAids';

const none = () => {};

describe('showAidsFor', () => {
  it('offers the mini-map in both looks and the colour key only in Rack', () => {
    expect(showAidsFor(DEFAULT_AIDS, { rack: false, colours: 3 }, none).items.map((i) => i.id)).toEqual(['minimap']);
    expect(showAidsFor(DEFAULT_AIDS, { rack: true, colours: 3 }, none).items.map((i) => i.id)).toEqual(['minimap', 'colourKey']);
  });

  it('leaves the colour key off until there are two colours, and says why', () => {
    const one = showAidsFor(DEFAULT_AIDS, { rack: true, colours: 1 }, none).items[1]!;
    expect(one).toMatchObject({ on: false, note: 'needs two colours' });
    const two = showAidsFor(DEFAULT_AIDS, { rack: true, colours: 2 }, none).items[1]!;
    expect(two).toMatchObject({ on: true, note: undefined });
  });

  it('follows the person once they have chosen', () => {
    expect(showAidsFor({ minimap: false, colourKey: true }, { rack: true, colours: 1 }, none).items.map((i) => i.on)).toEqual([false, true]);
    expect(showAidsFor({ minimap: true, colourKey: false }, { rack: true, colours: 5 }, none).items[1]!.on).toBe(false);
  });
});
