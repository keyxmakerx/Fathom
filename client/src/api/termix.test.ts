import { describe, expect, it } from 'vitest';

import { parseTermixAccess } from './termix';

const bytesOf = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

describe('parseTermixAccess', () => {
  it('reads the address or its absence', () => {
    expect(parseTermixAccess(bytesOf({ url: 'https://termix.example.lan', off: null }))).toEqual({ url: 'https://termix.example.lan', off: null, fetch: false });
    expect(parseTermixAccess(bytesOf({ url: null, off: null }))).toEqual({ url: null, off: null, fetch: false });
  });

  it('says who a steward turned it off for, and never hands out the address then', () => {
    expect(parseTermixAccess(bytesOf({ url: null, off: 'everyone' }))).toEqual({ url: null, off: 'everyone', fetch: false });
    expect(parseTermixAccess(bytesOf({ url: 'https://termix.example.lan', off: 'you' }))).toEqual({ url: null, off: 'you', fetch: false });
  });

  it('says Fetch from Termix is on only with an address to fetch through', () => {
    expect(parseTermixAccess(bytesOf({ url: 'https://termix.example.lan', off: null, fetch: true }))).toEqual({ url: 'https://termix.example.lan', off: null, fetch: true });
    expect(parseTermixAccess(bytesOf({ url: 'https://termix.example.lan', off: 'you', fetch: true }))).toEqual({ url: null, off: 'you', fetch: false });
    expect(parseTermixAccess(bytesOf({ url: 'https://termix.example.lan', off: null, fetch: 'yes' })).fetch).toBe(false);
  });

  it('refuses a body that is not an object', () => {
    expect(() => parseTermixAccess(bytesOf(['x']))).toThrow(/malformed termix/);
  });
});
