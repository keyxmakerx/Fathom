import { describe, expect, it } from 'vitest';

import { searchShouldCollapse } from './layout';

describe('searchShouldCollapse', () => {
  it('does not collapse when the container comfortably fits the expanded search box', () => {
    expect(
      searchShouldCollapse({ containerWidth: 1440, fixedWidth: 900, searchExpandedWidth: 180 }),
    ).toBe(false);
  });

  it('collapses when the container is exactly too narrow for the expanded box', () => {
    expect(
      searchShouldCollapse({ containerWidth: 1000, fixedWidth: 900, searchExpandedWidth: 180 }),
    ).toBe(true);
  });

  it('is exact at the boundary: equal widths do not collapse', () => {
    expect(
      searchShouldCollapse({ containerWidth: 1080, fixedWidth: 900, searchExpandedWidth: 180 }),
    ).toBe(false);
  });

  it('collapses one pixel under the boundary', () => {
    expect(
      searchShouldCollapse({ containerWidth: 1079, fixedWidth: 900, searchExpandedWidth: 180 }),
    ).toBe(true);
  });

  it('reflects BRIEF.md: a long path pushes fixedWidth up and forces the collapse at 1440', () => {
    // Estate.dc.html: path is one word ("Northwind"), search stays expanded.
    const shortPathFixedWidth = 1200;
    expect(
      searchShouldCollapse({ containerWidth: 1440, fixedWidth: shortPathFixedWidth, searchExpandedWidth: 180 }),
    ).toBe(false);

    // Main.dc.html: path is four parts ("Northwind › HQ › Building A ›
    // IDF-2"), wide enough that the full search box no longer fits 1440.
    const longPathFixedWidth = 1300;
    expect(
      searchShouldCollapse({ containerWidth: 1440, fixedWidth: longPathFixedWidth, searchExpandedWidth: 180 }),
    ).toBe(true);
  });
});
