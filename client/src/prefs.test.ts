import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadJsonPref, readPref, saveJsonPref, writePref } from './prefs';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

function refusingStorage(): Storage {
  const no = () => {
    throw new DOMException('blocked', 'SecurityError');
  };
  return { length: 0, clear: no, getItem: no, key: no, removeItem: no, setItem: no };
}

afterEach(() => vi.unstubAllGlobals());

describe('prefs', () => {
  it('reads back what it wrote, and null forgets', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    writePref('k', 'v');
    expect(readPref('k')).toBe('v');
    writePref('k', null);
    expect(readPref('k')).toBeNull();
    saveJsonPref('j', { a: 1 });
    expect(loadJsonPref('j', (raw) => raw, null)).toEqual({ a: 1 });
  });

  it('gives the fallback for damaged JSON or a parser that throws', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    writePref('j', '{not json');
    expect(loadJsonPref('j', (raw) => raw, 'fallback')).toBe('fallback');
    writePref('j', '1');
    const throws = () => {
      throw new Error('bad shape');
    };
    expect(loadJsonPref('j', throws, 'fallback')).toBe('fallback');
  });

  it('never throws when the browser refuses storage', () => {
    vi.stubGlobal('localStorage', refusingStorage());
    expect(readPref('k')).toBeNull();
    expect(() => writePref('k', 'v')).not.toThrow();
    expect(() => writePref('k', null)).not.toThrow();
    expect(() => saveJsonPref('k', [1])).not.toThrow();
    expect(loadJsonPref('k', (raw) => raw, 'fallback')).toBe('fallback');
  });
});
