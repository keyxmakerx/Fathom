import { describe, expect, it } from 'vitest';

import { doubleClickAnswer, holderDoubleClick } from './doubleClick';

describe('a double-click goes in (r116)', () => {
  it('opens a device or a shelf, fits a rack, and opens the panel for a port or a cable', () => {
    expect(doubleClickAnswer('device')).toBe('open');
    expect(doubleClickAnswer('shelf')).toBe('open');
    expect(doubleClickAnswer('rack')).toBe('fit');
    expect(doubleClickAnswer('port')).toBe('panel');
    expect(doubleClickAnswer('cable')).toBe('panel');
  });
});

describe('a double-click on something that holds devices', () => {
  it('opens the device it lands on, on a shelf and on a wall alike', () => {
    expect(holderDoubleClick('shelf', 'nas-1')).toEqual({ open: 'device', id: 'nas-1' });
    expect(holderDoubleClick('surface', 'camera-1')).toEqual({ open: 'device', id: 'camera-1' });
  });

  it('steps into the shelf anywhere else on it, and goes into nothing anywhere else on a wall', () => {
    expect(holderDoubleClick('shelf', null)).toEqual({ open: 'shelf' });
    expect(holderDoubleClick('surface', null)).toBeNull();
    expect(holderDoubleClick('surface', '')).toBeNull();
  });
});
