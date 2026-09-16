import { describe, expect, it } from 'vitest';

import { pathToItems } from './path';

describe('pathToItems', () => {
  it('returns an empty list for an empty path (Home)', () => {
    expect(pathToItems([])).toEqual([]);
  });

  it('marks the single part of a one-item path current', () => {
    const items = pathToItems([{ label: 'Northwind' }]);
    expect(items).toEqual([{ label: 'Northwind', current: true }]);
  });

  it('marks only the last part current, matching BRIEF.md\'s four-part path', () => {
    const items = pathToItems([
      { label: 'Northwind' },
      { label: 'HQ' },
      { label: 'Building A' },
      { label: 'IDF-2' },
    ]);

    expect(items.map((item) => item.current)).toEqual([false, false, false, true]);
    expect(items.map((item) => item.label)).toEqual(['Northwind', 'HQ', 'Building A', 'IDF-2']);
  });

  it('preserves each part\'s own onSelect callback', () => {
    const onSelect = () => {};
    const items = pathToItems([{ label: 'HQ', onSelect }]);
    expect(items[0].onSelect).toBe(onSelect);
  });
});
