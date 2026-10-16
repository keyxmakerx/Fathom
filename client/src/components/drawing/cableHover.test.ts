import { describe, expect, it } from 'vitest';

import { cablesUnder, cycle, hoverCablesAt, cableShapes, pickAfterMove, shapeOf } from './cableHover';
import { createLiveStore } from './liveStore';

// Three cables crossing near the origin: a horizontal, a vertical, and a diagonal a little off.
const shapes = new Map([
  ['h', shapeOf([{ x: -50, y: 0 }, { x: 50, y: 0 }])],
  ['v', shapeOf([{ x: 2, y: -50 }, { x: 2, y: 50 }])],
  ['far', shapeOf([{ x: 200, y: 200 }, { x: 300, y: 200 }])],
]);

describe('the cable under the pointer', () => {
  it('lists every cable within reach, nearest first', () => {
    expect(cablesUnder(shapes, { x: 0, y: 1 })).toEqual(['h', 'v']);
    expect(cablesUnder(shapes, { x: 2, y: 3 })).toEqual(['v', 'h']);
  });
  it('orders equal distances by id, never by drawing order', () => {
    const tied = new Map([...shapes].reverse());
    expect(cablesUnder(tied, { x: 1, y: 1 })).toEqual(cablesUnder(shapes, { x: 1, y: 1 }));
    expect(cablesUnder(shapes, { x: 1, y: 1 })).toEqual(['h', 'v']);
  });
  it('finds nothing in empty canvas', () => {
    expect(cablesUnder(shapes, { x: 100, y: 100 })).toEqual([]);
  });
});

describe('Tab where cables cross', () => {
  it('moves to the next and wraps, and Shift goes back', () => {
    expect(cycle(['a', 'b', 'c'], 'a')).toBe('b');
    expect(cycle(['a', 'b', 'c'], 'c')).toBe('a');
    expect(cycle(['a', 'b', 'c'], 'a', true)).toBe('c');
    expect(cycle([], 'a')).toBeNull();
  });
  it('keeps a Tabbed pick while the pointer stays on the same crossing', () => {
    expect(pickAfterMove(['h', 'v'], 'v', ['v', 'h'])).toBe('v');
  });
  it('goes back to the nearest when the crossing changes', () => {
    expect(pickAfterMove(['h'], 'v', ['v', 'h'])).toBe('h');
    expect(pickAfterMove(['h', 'x'], 'x', ['h', 'v'])).toBe('h');
  });
});

describe('hoverCablesAt', () => {
  it('lights the nearest cable and remembers the crossing', () => {
    const store = createLiveStore();
    for (const [id, s] of shapes) cableShapes(store).set(id, s);
    hoverCablesAt(store, { x: 2, y: 3 });
    expect(store.getState().hoveredCableId).toBe('v');
    expect(store.getState().hoverStack).toEqual(['v', 'h']);
    // Tab to the other, then a small move on the same crossing keeps it.
    store.setState({ hoveredCableId: cycle(store.getState().hoverStack, 'v') });
    hoverCablesAt(store, { x: 2, y: 2 });
    expect(store.getState().hoveredCableId).toBe('h');
    // Off every cable, nothing is lit.
    hoverCablesAt(store, { x: 120, y: 120 });
    expect(store.getState().hoveredCableId).toBeNull();
    expect(store.getState().hoverStack).toEqual([]);
  });
});
