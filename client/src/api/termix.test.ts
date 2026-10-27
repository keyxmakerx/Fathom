import { describe, expect, it } from 'vitest';

import { parseTermixUrl } from './termix';

const bytesOf = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

describe('parseTermixUrl', () => {
  it('reads the address or its absence', () => {
    expect(parseTermixUrl(bytesOf({ url: 'https://termix.example.lan' }))).toBe('https://termix.example.lan');
    expect(parseTermixUrl(bytesOf({ url: null }))).toBeNull();
  });

  it('refuses a body that is not an object', () => {
    expect(() => parseTermixUrl(bytesOf(['x']))).toThrow(/malformed termix/);
  });
});
