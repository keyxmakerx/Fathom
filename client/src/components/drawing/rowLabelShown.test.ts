import { describe, expect, it } from 'vitest';

import { rowLabelShown } from './buildDrawingNodes';

describe('a row label at the closet stop', () => {
  it('is not drawn for a lone row with no name, which would only say "row"', () => {
    expect(rowLabelShown(null, 1)).toBe(false);
  });
  it('is drawn when the row has a name', () => {
    expect(rowLabelShown('A', 1)).toBe(true);
  });
  it('is drawn when there are rows to tell apart', () => {
    expect(rowLabelShown(null, 2)).toBe(true);
  });
});
