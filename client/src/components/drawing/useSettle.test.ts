import { describe, expect, it } from 'vitest';
import { findPlaced } from './useSettle';

const view = {
  racks: [
    { id: 'r1', chassis: [{ id: 'a', positionU: 1 }, { id: 'b', positionU: 5 }] },
    { id: 'r2', chassis: [{ id: 'c', positionU: 5 }] },
  ],
} as unknown as Parameters<typeof findPlaced>[0];

describe('findPlaced', () => {
  it('finds the new device at the unit, ignoring ones already there', () => {
    expect(findPlaced(view, 'r1', 5, new Set(['a']))).toBe('b');
    expect(findPlaced(view, 'r1', 5, new Set(['a', 'b']))).toBeNull();
  });
  it('looks only in the named rack', () => {
    expect(findPlaced(view, 'r2', 1, new Set())).toBeNull();
    expect(findPlaced(view, 'r2', 5, new Set())).toBe('c');
  });
});
