import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../../api/catalogue';
import {
  BOARD_PALETTE_ITEM,
  SKETCH_DEVICE_PALETTE_ITEM,
  isBoardPaletteItem,
  isSketchDevicePaletteItem,
  paletteFromCatalogue,
  paletteRows,
} from './palette';

const MODEL: CatalogueModel = {
  vendor: 'juniper',
  model: 'EX4300-48P',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'cite', readOn: '2026-09-14' },
  psuSlots: [
    { name: 'PSU0', hotSwap: true, face: 'rear', position: { row: 'single', column: 0 } },
    { name: 'PSU1', hotSwap: true, face: 'rear', position: { row: 'single', column: 1 } },
  ],
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

// This session's brief item 2 — the palette's own two rows beside the
// catalogue's models.
describe('paletteRows', () => {
  it('carries the catalogue rows, then the sketch-device row, then the board row', () => {
    const rows = paletteRows([MODEL]);
    expect(rows).toEqual([...paletteFromCatalogue([MODEL]), SKETCH_DEVICE_PALETTE_ITEM, BOARD_PALETTE_ITEM]);
  });

  it('carries the two sketch rows even for an empty catalogue', () => {
    expect(paletteRows([])).toEqual([SKETCH_DEVICE_PALETTE_ITEM, BOARD_PALETTE_ITEM]);
  });
});

describe('isSketchDevicePaletteItem / isBoardPaletteItem', () => {
  it('recognise their own sentinel items', () => {
    expect(isSketchDevicePaletteItem(SKETCH_DEVICE_PALETTE_ITEM)).toBe(true);
    expect(isBoardPaletteItem(BOARD_PALETTE_ITEM)).toBe(true);
  });

  it('never match a real catalogue entry — vendor is always non-empty there', () => {
    const [item] = paletteFromCatalogue([MODEL]);
    expect(isSketchDevicePaletteItem(item)).toBe(false);
    expect(isBoardPaletteItem(item)).toBe(false);
  });

  it('never confuse the two sentinels with each other', () => {
    expect(isSketchDevicePaletteItem(BOARD_PALETTE_ITEM)).toBe(false);
    expect(isBoardPaletteItem(SKETCH_DEVICE_PALETTE_ITEM)).toBe(false);
  });
});
