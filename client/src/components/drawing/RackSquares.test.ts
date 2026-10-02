import { describe, expect, it } from 'vitest';

import { squareUnits } from './RackSquares';

const rack = (chassis: { id: string; positionU: number; heightU: number }[], shelves: { positionU: number; heightU: number }[] = []) => ({
  heightU: 10,
  chassis: chassis as never,
  shelves: shelves as never,
});

describe('squareUnits', () => {
  it('offers the free unit above and below a device', () => {
    expect(squareUnits(rack([{ id: 'c', positionU: 5, heightU: 2 }]), 'c')).toEqual([7, 4]);
  });
  it('leaves out a unit that is taken, off the rack, or by a shelf', () => {
    expect(squareUnits(rack([{ id: 'c', positionU: 1, heightU: 1 }, { id: 'd', positionU: 2, heightU: 1 }]), 'c')).toEqual([]);
    expect(squareUnits(rack([{ id: 'c', positionU: 9, heightU: 2 }]), 'c')).toEqual([8]);
    expect(squareUnits(rack([{ id: 'c', positionU: 5, heightU: 1 }], [{ positionU: 6, heightU: 1 }]), 'c')).toEqual([4]);
  });
});
