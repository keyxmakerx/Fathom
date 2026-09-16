import { describe, expect, it } from 'vitest';

import { parseCatalogueList, parseCatalogueModel } from './catalogue';

function bytesOf(v: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(v));
}

describe('parseCatalogueList', () => {
  it('parses a well-formed list', () => {
    const body = [{ vendor: 'juniper', model: 'EX4300-48P', rack_units: 1 }];
    expect(parseCatalogueList(bytesOf(body))).toEqual([
      { vendor: 'juniper', model: 'EX4300-48P', rackUnits: 1 },
    ]);
  });

  it('rejects a malformed body — not JSON', () => {
    expect(() => parseCatalogueList(new TextEncoder().encode('<<nope>>'))).toThrow(/not JSON/);
  });

  it('rejects a malformed body — not an array', () => {
    expect(() => parseCatalogueList(bytesOf({}))).toThrow(/malformed catalogue/);
  });

  it('rejects an entry missing rack_units', () => {
    expect(() => parseCatalogueList(bytesOf([{ vendor: 'juniper', model: 'x' }]))).toThrow(/rack_units/);
  });
});

describe('parseCatalogueModel', () => {
  const wellFormed = {
    vendor: 'juniper',
    model: 'EX4300-48P',
    rack_units: 1,
    reviewed_by: 'reviewer',
    source: { cite: 'cite', read_on: '2026-09-14' },
    psu_inlets: { kind: 'C14', count: 2 },
    faceplates: [
      {
        face: 'front',
        port_count: 1,
        ports: [{ kind: 'RJ45', number: 0, uplink: false, row: 'single', column: 0, group_gap_before: false }],
      },
    ],
  };

  it('parses a well-formed model', () => {
    expect(parseCatalogueModel(bytesOf(wellFormed))).toEqual({
      vendor: 'juniper',
      model: 'EX4300-48P',
      rackUnits: 1,
      reviewedBy: 'reviewer',
      source: { cite: 'cite', readOn: '2026-09-14' },
      psuInlets: { kind: 'C14', count: 2 },
      faceplates: [
        {
          face: 'front',
          portCount: 1,
          ports: [{ kind: 'RJ45', number: 0, uplink: false, row: 'single', column: 0, groupGapBefore: false }],
        },
      ],
    });
  });

  it('parses a null psu_inlets', () => {
    const body = { ...wellFormed, psu_inlets: null };
    expect(parseCatalogueModel(bytesOf(body)).psuInlets).toBeNull();
  });

  it('rejects a malformed body — not JSON', () => {
    expect(() => parseCatalogueModel(new TextEncoder().encode('{{{'))).toThrow(/not JSON/);
  });

  it('rejects a port row outside top / bottom / single', () => {
    const bad = {
      ...wellFormed,
      faceplates: [{ face: 'front', port_count: 1, ports: [{ ...wellFormed.faceplates[0].ports[0], row: 'middle' }] }],
    };
    expect(() => parseCatalogueModel(bytesOf(bad))).toThrow(/row/);
  });

  it('rejects a missing vendor', () => {
    const { vendor: _dropped, ...rest } = wellFormed;
    expect(() => parseCatalogueModel(bytesOf(rest))).toThrow(/vendor/);
  });
});
