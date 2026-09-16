import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../../api/catalogue';
import { paletteFromCatalogue } from './palette';

const MODEL: CatalogueModel = {
  vendor: 'juniper',
  model: 'EX4300-48P',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'cite', readOn: '2026-09-14' },
  psuInlets: { kind: 'C14', count: 2 },
  faceplates: [
    {
      face: 'front',
      portCount: 2,
      ports: [
        { kind: 'RJ45', number: 0, uplink: false, row: 'top', column: 0, groupGapBefore: false },
        { kind: 'RJ45', number: 1, uplink: false, row: 'bottom', column: 0, groupGapBefore: false },
      ],
    },
    {
      face: 'rear',
      portCount: 1,
      ports: [{ kind: 'QSFP+', number: 0, uplink: true, row: 'single', column: 0, groupGapBefore: false }],
    },
  ],
};

describe('paletteFromCatalogue', () => {
  it('derives vendor, model, rack units and a port-count summary from the catalogue model', () => {
    const [item] = paletteFromCatalogue([MODEL]);
    expect(item.vendor).toBe('juniper');
    expect(item.model).toBe('EX4300-48P');
    expect(item.rackUnits).toBe(1);
    expect(item.summary).toBe('2 RJ45 · 1 QSFP+');
  });

  it('names a model with no faceplate ports rather than showing an empty summary', () => {
    const noPorts: CatalogueModel = { ...MODEL, faceplates: [] };
    expect(paletteFromCatalogue([noPorts])[0].summary).toBe('No ports listed');
  });

  it('renders no sample rows for an empty catalogue', () => {
    expect(paletteFromCatalogue([])).toEqual([]);
  });
});
