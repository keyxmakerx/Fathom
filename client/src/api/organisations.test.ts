import { describe, expect, it } from 'vitest';

import { parseOrganisations } from './organisations';

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('parseOrganisations', () => {
  it('parses a well-formed array', () => {
    const body = JSON.stringify([
      { organisation_id: '01JQZ0000000000000000000AA', display_name: 'Northwind Logistics' },
      { organisation_id: '01JQZ0000000000000000000AB', display_name: 'Acme Dental' },
    ]);
    expect(parseOrganisations(bytesOf(body))).toEqual([
      { organisationId: '01JQZ0000000000000000000AA', displayName: 'Northwind Logistics' },
      { organisationId: '01JQZ0000000000000000000AB', displayName: 'Acme Dental' },
    ]);
  });

  it('accepts the empty array — an account that belongs to nothing', () => {
    expect(parseOrganisations(bytesOf('[]'))).toEqual([]);
  });

  it('rejects a body that is not JSON', () => {
    expect(() => parseOrganisations(bytesOf('not json'))).toThrow(/not JSON/);
  });

  it('rejects a body that is not an array', () => {
    expect(() => parseOrganisations(bytesOf('{"organisation_id":"x"}'))).toThrow(/not a JSON array/);
  });

  it('rejects an entry missing organisation_id', () => {
    const body = JSON.stringify([{ display_name: 'Northwind Logistics' }]);
    expect(() => parseOrganisations(bytesOf(body))).toThrow(/organisation_id/);
  });

  it('rejects an entry missing display_name', () => {
    const body = JSON.stringify([{ organisation_id: '01JQZ0000000000000000000AA' }]);
    expect(() => parseOrganisations(bytesOf(body))).toThrow(/display_name/);
  });

  it('rejects an entry that is not an object', () => {
    expect(() => parseOrganisations(bytesOf('["not an object"]'))).toThrow(/not an object/);
  });
});
