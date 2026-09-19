import { describe, expect, it } from 'vitest';

import type { PaletteItem } from './contract';
import { decodePaletteDrag, encodePaletteDrag } from './dnd';

const ITEM: PaletteItem = { vendor: 'juniper', model: 'EX4300-48P', rackUnits: 1, summary: '48-port access switch' };

describe('encodePaletteDrag / decodePaletteDrag', () => {
  it('round-trips a palette item, dropping the summary the drop does not need', () => {
    const decoded = decodePaletteDrag(encodePaletteDrag(ITEM));
    expect(decoded).toEqual({ vendor: 'juniper', model: 'EX4300-48P', rackUnits: 1 });
  });

  it('returns null for malformed JSON rather than throwing', () => {
    expect(decodePaletteDrag('not json')).toBeNull();
  });

  it('returns null for well-formed JSON of the wrong shape', () => {
    expect(decodePaletteDrag(JSON.stringify({ foo: 'bar' }))).toBeNull();
  });
});
