import { describe, expect, it } from 'vitest';

import { parseTermixAccess } from './termix';

const bytesOf = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

describe('parseTermixAccess', () => {
  it('reads the address or its absence', () => {
    expect(parseTermixAccess(bytesOf({ url: 'https://termix.example.lan', off: null }))).toEqual({ url: 'https://termix.example.lan', off: null });
    expect(parseTermixAccess(bytesOf({ url: null, off: null }))).toEqual({ url: null, off: null });
  });

  it('says who a steward turned it off for, and never hands out the address then', () => {
    expect(parseTermixAccess(bytesOf({ url: null, off: 'everyone' }))).toEqual({ url: null, off: 'everyone' });
    expect(parseTermixAccess(bytesOf({ url: 'https://termix.example.lan', off: 'you' }))).toEqual({ url: null, off: 'you' });
  });

  it('refuses a body that is not an object', () => {
    expect(() => parseTermixAccess(bytesOf(['x']))).toThrow(/malformed termix/);
  });
});
