import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CABLE_VISIBILITY_OPTIONS,
  cableKindVisible,
  filterCablesByVisibility,
  loadCableVisibility,
  saveCableVisibility,
} from './cableVisibility';

describe('cableKindVisible — one lit at a time', () => {
  it('"all" shows every kind', () => {
    expect(cableKindVisible('all', 'copper')).toBe(true);
    expect(cableKindVisible('all', 'fibre')).toBe(true);
    expect(cableKindVisible('all', 'power')).toBe(true);
  });

  it('"none" hides every kind', () => {
    expect(cableKindVisible('none', 'copper')).toBe(false);
    expect(cableKindVisible('none', 'fibre')).toBe(false);
    expect(cableKindVisible('none', 'power')).toBe(false);
  });

  it('a single kind shows only itself', () => {
    expect(cableKindVisible('copper', 'copper')).toBe(true);
    expect(cableKindVisible('copper', 'fibre')).toBe(false);
    expect(cableKindVisible('copper', 'power')).toBe(false);
    expect(cableKindVisible('fibre', 'fibre')).toBe(true);
    expect(cableKindVisible('fibre', 'copper')).toBe(false);
    expect(cableKindVisible('power', 'power')).toBe(true);
    expect(cableKindVisible('power', 'copper')).toBe(false);
  });
});

describe('filterCablesByVisibility — the drawing rule', () => {
  const CABLES = [
    { id: 'c1', kind: 'copper' as const },
    { id: 'c2', kind: 'fibre' as const },
    { id: 'c3', kind: 'power' as const },
    { id: 'c4', kind: 'copper' as const },
  ];

  it('"all" keeps every cable', () => {
    expect(filterCablesByVisibility(CABLES, 'all').map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('"none" removes every cable from the list this drawing builds edges from', () => {
    expect(filterCablesByVisibility(CABLES, 'none')).toEqual([]);
  });

  it('a single kind keeps only its own cables, order preserved', () => {
    expect(filterCablesByVisibility(CABLES, 'copper').map((c) => c.id)).toEqual(['c1', 'c4']);
    expect(filterCablesByVisibility(CABLES, 'fibre').map((c) => c.id)).toEqual(['c2']);
    expect(filterCablesByVisibility(CABLES, 'power').map((c) => c.id)).toEqual(['c3']);
  });

  it('every declared option is covered by the rule (no fifth kind silently falls through)', () => {
    expect(CABLE_VISIBILITY_OPTIONS).toEqual(['all', 'copper', 'fibre', 'power', 'none']);
  });
});

/** A minimal `Storage`, in memory — this project's `vitest.config.ts` runs
 * in the plain `node` environment (no jsdom, no real `localStorage`
 * global), the same reason `Editor.render.test.ts`'s own file header gives
 * for using `renderToStaticMarkup` rather than a DOM testing library. Stubbed
 * onto `globalThis` per test so `cableVisibility.ts`'s own bare
 * `localStorage` reference (matching `theme.ts`'s own convention) resolves
 * to something real, and un-stubbed after so other test files never see it. */
class FakeStorage implements Partial<Storage> {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

describe('loadCableVisibility/saveCableVisibility — per browser, wrapped in try/catch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to "all" with no `localStorage` global at all — the try/catch catches a MISSING global too, not only a refusing one', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadCableVisibility()).toBe('all');
  });

  it('a save with no `localStorage` global never throws out of a click handler', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => saveCableVisibility('fibre')).not.toThrow();
  });

  it('round-trips a saved choice through a real (fake) Storage', () => {
    vi.stubGlobal('localStorage', new FakeStorage());
    saveCableVisibility('fibre');
    expect(loadCableVisibility()).toBe('fibre');
  });

  it('defaults to "all" with nothing stored', () => {
    vi.stubGlobal('localStorage', new FakeStorage());
    expect(loadCableVisibility()).toBe('all');
  });

  it('ignores a stored value outside the five options, never invents a sixth', () => {
    const storage = new FakeStorage();
    storage.setItem('fathom.drawing.cableVisibility', 'copper-and-fibre');
    vi.stubGlobal('localStorage', storage);
    expect(loadCableVisibility()).toBe('all');
  });

  it('a throwing localStorage.getItem falls back to "all" rather than throwing out of the render', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    expect(loadCableVisibility()).toBe('all');
  });

  it('a throwing localStorage.setItem is swallowed, never a document refusal', () => {
    vi.stubGlobal('localStorage', {
      setItem: () => {
        throw new Error('quota');
      },
    });
    expect(() => saveCableVisibility('power')).not.toThrow();
  });
});
