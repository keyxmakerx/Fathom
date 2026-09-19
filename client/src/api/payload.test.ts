import { describe, expect, it, vi } from 'vitest';

import { signedFetchWithHeaders } from './signedFetch';

vi.mock('./signedFetch', () => ({
  signedFetchWithHeaders: vi.fn(),
}));

import { SCHEMA_VERSION } from '../document/plain';
import { openDesign, saveDesign } from './payload';

const mockedFetch = vi.mocked(signedFetchWithHeaders);

// `SCHEMA_VERSION` is always `"0.<minor>"`; derived here too rather than
// hard-coded, so this test still holds after the next schema bump.
const EXPECTED_MINOR = Number.parseInt(SCHEMA_VERSION.slice('0.'.length), 10);

describe('openDesign', () => {
  it('reads the version and schema version off the response headers', async () => {
    mockedFetch.mockResolvedValueOnce({
      bytes: new Uint8Array([1, 2, 3]),
      headers: new Headers({ 'fathom-design-version': '7', 'fathom-payload-schema-version': '2' }),
    });
    const opened = await openDesign('org-1', 'design-1');
    expect(opened).toEqual({ bytes: new Uint8Array([1, 2, 3]), version: 7, schemaVersion: 2 });
    expect(mockedFetch).toHaveBeenCalledWith('GET', '/organisations/org-1/designs/design-1');
  });

  it('appends a version query parameter when one is given', async () => {
    mockedFetch.mockResolvedValueOnce({
      bytes: new Uint8Array(),
      headers: new Headers({ 'fathom-design-version': '3', 'fathom-payload-schema-version': '2' }),
    });
    await openDesign('org-1', 'design-1', 3);
    expect(mockedFetch).toHaveBeenCalledWith('GET', '/organisations/org-1/designs/design-1?version=3');
  });

  it('throws when a required header is missing', async () => {
    mockedFetch.mockResolvedValueOnce({ bytes: new Uint8Array(), headers: new Headers() });
    await expect(openDesign('org-1', 'design-1')).rejects.toThrow(/fathom-design-version/);
  });
});

describe('saveDesign', () => {
  it('frames the body as u32_le(schema minor) ++ bytes, exactly as save_design_handler reads it', async () => {
    mockedFetch.mockResolvedValueOnce({
      bytes: new TextEncoder().encode('9\n'),
      headers: new Headers(),
    });
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const version = await saveDesign('org-1', 'design-1', payload, 4);
    expect(version).toBe(9);

    const [, , sentBody] = mockedFetch.mock.calls[0];
    const body = sentBody as Uint8Array;
    // read_u32_le: little-endian u32, then the payload verbatim. Never a
    // literal 5 here — derived from the same SCHEMA_VERSION plain.ts uses.
    const view = new DataView(body.buffer, body.byteOffset, 4);
    expect(view.getUint32(0, true)).toBe(EXPECTED_MINOR);
    expect(Array.from(body.subarray(4))).toEqual(Array.from(payload));
    expect(mockedFetch.mock.calls[0][1]).toBe('/organisations/org-1/designs/design-1/versions?base=4');
  });

  it('appends the given base as a required query parameter, ADR-0054 §1', async () => {
    mockedFetch.mockResolvedValueOnce({ bytes: new TextEncoder().encode('11\n'), headers: new Headers() });
    await saveDesign('org-1', 'design-1', new Uint8Array(), 10);
    expect(mockedFetch.mock.calls[0][1]).toBe('/organisations/org-1/designs/design-1/versions?base=10');
  });

  it('throws when the response is not a decimal version number', async () => {
    mockedFetch.mockResolvedValueOnce({ bytes: new TextEncoder().encode('not-a-number\n'), headers: new Headers() });
    await expect(saveDesign('org-1', 'design-1', new Uint8Array(), 4)).rejects.toThrow(/decimal version number/);
  });
});
