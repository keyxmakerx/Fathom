import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CABLE_STYLES, DEFAULT_CABLE_STYLE, isCableStyle, loadCableStyle, saveCableStyle } from './cableStyle';

function fakeStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('cable style preference', () => {
  beforeEach(() => vi.stubGlobal('localStorage', fakeStorage()));
  afterEach(() => vi.unstubAllGlobals());
  it('starts new people on physics', () => {
    expect(DEFAULT_CABLE_STYLE).toBe('physics');
    expect(loadCableStyle('acct-1')).toBe('physics');
  });
  it('keeps each person their own pick', () => {
    saveCableStyle('acct-1', 'faded');
    expect(loadCableStyle('acct-1')).toBe('faded');
    expect(loadCableStyle('acct-2')).toBe('physics');
  });
  it('ignores a stored value that is not a style', () => {
    localStorage.setItem('fathom.cableStyle.acct-1', 'wavy');
    expect(loadCableStyle('acct-1')).toBe('physics');
  });
  it('survives a missing store', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadCableStyle('acct-1')).toBe('physics');
    expect(() => saveCableStyle('acct-1', 'tied')).not.toThrow();
  });
  it('offers the four signed-off styles', () => {
    expect(CABLE_STYLES).toEqual(['physics', 'tied', 'square', 'faded']);
    expect(isCableStyle('square')).toBe(true);
  });
});
