import { describe, expect, it } from 'vitest';

import { pageLinkHash, readPageLink } from './pageLink';

describe('pages with their own address (r71)', () => {
  it('reads #admin/firmware and #steward/firmware, and nothing else', () => {
    expect(readPageLink('#admin/firmware')).toEqual({ tab: 'admin', page: 'firmware' });
    expect(readPageLink('#steward/firmware')).toEqual({ tab: 'steward', page: 'firmware' });
    expect(readPageLink('#design/01JQZ')).toBeNull();
    expect(readPageLink('#admin/../x')).toBeNull();
    expect(readPageLink('')).toBeNull();
  });

  it('writes the same shape back', () => {
    expect(pageLinkHash({ tab: 'steward', page: 'firmware' })).toBe('#steward/firmware');
  });
});
