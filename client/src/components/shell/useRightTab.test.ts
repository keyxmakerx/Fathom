import { describe, expect, it } from 'vitest';

import { rememberedTab, visibleTab } from './useRightTab';

const have = { hasDetails: true, historyOpen: false, trailOpen: false, hasTrail: true };

describe('visibleTab', () => {
  it('shows the chosen tab only when something is behind it', () => {
    expect(visibleTab('details', have)).toBe('details');
    expect(visibleTab('details', { ...have, hasDetails: false })).toBeNull();
    expect(visibleTab('history', have)).toBeNull();
    expect(visibleTab('history', { ...have, historyOpen: true })).toBe('history');
    expect(visibleTab('trail', { ...have, trailOpen: true })).toBe('trail');
    expect(visibleTab('trail', { ...have, trailOpen: true, hasTrail: false })).toBeNull();
    expect(visibleTab(null, have)).toBeNull();
  });
});

describe('rememberedTab', () => {
  it('does not bring History back, since it is a mode', () => {
    expect(rememberedTab('history')).toBeNull();
    expect(rememberedTab('trail')).toBe('trail');
    expect(rememberedTab('details')).toBe('details');
  });
});
