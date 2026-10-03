import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_LOOK, isLook, loadLook, saveLook } from './look';

function fakeStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

afterEach(() => vi.unstubAllGlobals());

describe('look', () => {
  it('starts on Rack', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(loadLook('a1', 'd1')).toBe(DEFAULT_LOOK);
    expect(DEFAULT_LOOK).toBe('rack');
  });
  it('keeps a choice per account and design', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    saveLook('a1', 'd1', 'diagram');
    expect(loadLook('a1', 'd1')).toBe('diagram');
    expect(loadLook('a2', 'd1')).toBe('rack');
    expect(loadLook('a1', 'd2')).toBe('rack');
  });
  it('ignores junk and survives a missing store', () => {
    const s = fakeStorage();
    s.setItem('fathom.look.a1.d1', 'schematic');
    vi.stubGlobal('localStorage', s);
    expect(loadLook('a1', 'd1')).toBe('rack');
    vi.stubGlobal('localStorage', undefined);
    expect(loadLook('a1', 'd1')).toBe('rack');
    expect(() => saveLook('a1', 'd1', 'diagram')).not.toThrow();
    expect(isLook('diagram')).toBe(true);
  });
});
