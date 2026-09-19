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
  const numberedPort = {
    kind: 'RJ45',
    number: 0,
    name: null,
    uplink: false,
    role: 'access',
    row: 'single',
    column: 0,
    group_gap_before: false,
  };
  const namedPort = {
    kind: 'RJ45',
    number: null,
    name: 'me0',
    uplink: false,
    role: 'management',
    row: 'single',
    column: 1,
    group_gap_before: false,
  };
  const wellFormed = {
    vendor: 'juniper',
    model: 'EX4300-48P',
    rack_units: 1,
    reviewed_by: 'reviewer',
    source: { cite: 'cite', read_on: '2026-09-14' },
    psu_slots: [
      {
        name: 'PSU0',
        hot_swap: true,
        face: 'rear',
        position: { row: 'single', column: 0 },
      },
    ],
    faceplates: [
      {
        face: 'front',
        port_count: 2,
        ports: [numberedPort, namedPort],
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
      psuSlots: [
        {
          name: 'PSU0',
          hotSwap: true,
          face: 'rear',
          position: { row: 'single', column: 0 },
        },
      ],
      faceplates: [
        {
          face: 'front',
          portCount: 2,
          ports: [
            {
              kind: 'RJ45',
              number: 0,
              name: null,
              uplink: false,
              role: 'access',
              row: 'single',
              column: 0,
              groupGapBefore: false,
            },
            {
              kind: 'RJ45',
              number: null,
              name: 'me0',
              uplink: false,
              role: 'management',
              row: 'single',
              column: 1,
              groupGapBefore: false,
            },
          ],
        },
      ],
    });
  });

  it('parses an empty psu_slots list', () => {
    const body = { ...wellFormed, psu_slots: [] };
    expect(parseCatalogueModel(bytesOf(body)).psuSlots).toEqual([]);
  });

  it('rejects a malformed body — not JSON', () => {
    expect(() => parseCatalogueModel(new TextEncoder().encode('{{{'))).toThrow(/not JSON/);
  });

  it('rejects a port row outside top / bottom / single', () => {
    const bad = {
      ...wellFormed,
      faceplates: [{ face: 'front', port_count: 1, ports: [{ ...numberedPort, row: 'middle' }] }],
    };
    expect(() => parseCatalogueModel(bytesOf(bad))).toThrow(/row/);
  });

  it('rejects a port role outside the four named roles', () => {
    const bad = {
      ...wellFormed,
      faceplates: [{ face: 'front', port_count: 1, ports: [{ ...numberedPort, role: 'trunk' }] }],
    };
    expect(() => parseCatalogueModel(bytesOf(bad))).toThrow(/role/);
  });

  it('rejects a missing vendor', () => {
    const { vendor: _dropped, ...rest } = wellFormed;
    expect(() => parseCatalogueModel(bytesOf(rest))).toThrow(/vendor/);
  });
});
