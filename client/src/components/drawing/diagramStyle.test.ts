import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_DIAGRAM_STYLE, isDiagramStyle, loadDiagramStyle, saveDiagramStyle } from './diagramStyle';

function fakeStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

afterEach(() => vi.unstubAllGlobals());

describe('diagram style', () => {
  it('starts on Boxes and keeps a choice per account and design', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(DEFAULT_DIAGRAM_STYLE).toBe('boxes');
    saveDiagramStyle('a1', 'd1', 'icons');
    expect(loadDiagramStyle('a1', 'd1')).toBe('icons');
    expect(loadDiagramStyle('a2', 'd1')).toBe('boxes');
    expect(loadDiagramStyle('a1', 'd2')).toBe('boxes');
  });
  it('ignores junk and survives a missing store', () => {
    expect(isDiagramStyle('faceplates')).toBe(false);
    vi.stubGlobal('localStorage', undefined);
    expect(loadDiagramStyle('a1', 'd1')).toBe('boxes');
    expect(() => saveDiagramStyle('a1', 'd1', 'icons')).not.toThrow();
  });
});
