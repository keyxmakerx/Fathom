import { describe, expect, it } from 'vitest';

import { doubleClickAnswer } from './doubleClick';

describe('a double-click goes in (r116)', () => {
  it('opens a device or a shelf, fits a rack, and opens the panel for a port or a cable', () => {
    expect(doubleClickAnswer('device')).toBe('open');
    expect(doubleClickAnswer('shelf')).toBe('open');
    expect(doubleClickAnswer('rack')).toBe('fit');
    expect(doubleClickAnswer('port')).toBe('panel');
    expect(doubleClickAnswer('cable')).toBe('panel');
  });
});
