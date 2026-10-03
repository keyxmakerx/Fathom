import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultLayers, layerOn, loadLayers, parseLayers, saveLayers } from './layers';

function fakeStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

afterEach(() => vi.unstubAllGlobals());

describe('layers', () => {
  it('starts with only Checks on', () => {
    expect(Object.entries(defaultLayers()).filter(([, on]) => on)).toEqual([['checks', true]]);
  });
  it('keeps a choice per account and design', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    saveLayers('a1', 'd1', { ...defaultLayers(), addresses: true });
    expect(loadLayers('a1', 'd1').addresses).toBe(true);
    expect(loadLayers('a2', 'd1').addresses).toBe(false);
  });
  it('ignores junk and survives a missing store', () => {
    expect(parseLayers({ tags: 'yes', vlans: true, nope: true })).toEqual({ ...defaultLayers(), vlans: true });
    expect(parseLayers(null)).toEqual(defaultLayers());
    vi.stubGlobal('localStorage', undefined);
    expect(loadLayers('a1', 'd1')).toEqual(defaultLayers());
    expect(() => saveLayers('a1', 'd1', defaultLayers())).not.toThrow();
  });
  it('Checks, Docs and Maintenance are listed', () => {
    expect(layerOn(defaultLayers(), 'checks')).toBe(true);
    expect(layerOn({ ...defaultLayers(), docs: true }, 'docs')).toBe(true);
    expect(layerOn({ ...defaultLayers(), maintenance: true }, 'maintenance')).toBe(true);
    expect(layerOn({ ...defaultLayers(), checks: false }, 'checks')).toBe(false);
  });
});
