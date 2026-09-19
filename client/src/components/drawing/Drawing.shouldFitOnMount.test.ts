import { describe, expect, it } from 'vitest';

import { shouldFitOnMount } from './Drawing';

// This session's brief item 5 — "Show on rack must land at the faceplate
// stop with the device selected... make the focus win, once." No DOM
// testing library is installed in this project (`ColourPicker.render.test.ts`'s
// own header), so the rule itself — pulled out of the mount-time fit effect
// as a pure function, `Drawing.tsx`'s own doc on `shouldFitOnMount` — is
// what gets exercised here, rather than the effect or the `rf.fitView` call
// it guards.

describe('shouldFitOnMount', () => {
  it('skips the generic fit on the very first run when a chassis is already selected — the focus wins', () => {
    expect(shouldFitOnMount(true, { kind: 'chassis', id: 'chassis:x' })).toBe(false);
  });

  it('fits on the very first run when nothing is selected', () => {
    expect(shouldFitOnMount(true, null)).toBe(true);
  });

  it('fits on the very first run even with something selected, when that something is not a chassis', () => {
    expect(shouldFitOnMount(true, { kind: 'rack', id: 'rack:x' })).toBe(true);
    expect(shouldFitOnMount(true, { kind: 'port', id: 'physical-port:x' })).toBe(true);
  });

  it('always fits on every later run, regardless of what is selected — only the first run ever defers', () => {
    expect(shouldFitOnMount(false, { kind: 'chassis', id: 'chassis:x' })).toBe(true);
    expect(shouldFitOnMount(false, null)).toBe(true);
  });
});
