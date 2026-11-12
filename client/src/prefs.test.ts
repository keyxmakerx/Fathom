import { afterEach, describe, expect, it, vi } from 'vitest';

import { forgetPrefsStartingWith, loadJsonPref, readPref, saveJsonPref, writePref } from './prefs';
import { NAMES_PREFIX, loadNames, rememberNames } from './components/collab/changesSince';

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

describe('forgetPrefsStartingWith', () => {
  it('forgets every cached collaborator name and nothing else', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    rememberNames('acct-1', 'design-a', [{ account: 'u2', name: 'Priya Rao' }]);
    rememberNames('acct-1', 'design-b', [{ account: 'u3', name: 'Ben Okafor' }]);
    writePref('fathom.theme', 'dark');
    expect(loadNames('acct-1', 'design-a').get('u2')).toBe('Priya Rao');
    forgetPrefsStartingWith(NAMES_PREFIX);
    expect(loadNames('acct-1', 'design-a').size).toBe(0);
    expect(loadNames('acct-1', 'design-b').size).toBe(0);
    expect(readPref('fathom.theme')).toBe('dark');
  });

  it('does not throw when storage is refused', () => {
    vi.stubGlobal('localStorage', refusingStorage());
    expect(() => forgetPrefsStartingWith(NAMES_PREFIX)).not.toThrow();
  });
});
