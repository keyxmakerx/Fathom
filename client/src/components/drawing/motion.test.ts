import { afterEach, describe, expect, it, vi } from 'vitest';
import { easeOut, glideOptions, GLIDE_MS } from './motion';

afterEach(() => vi.unstubAllGlobals());

describe('motion', () => {
  it('eases out: starts fast, ends at one', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
  });
  it('glides for the full time unless motion is reduced', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    expect(glideOptions().duration).toBe(GLIDE_MS);
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    expect(glideOptions().duration).toBe(0);
  });
});
