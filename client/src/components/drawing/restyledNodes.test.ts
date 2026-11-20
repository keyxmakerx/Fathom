import { describe, expect, it } from 'vitest';
import type { InternalNode, Node } from '@xyflow/react';

import { restyle, type Restyled } from './restyledNodes';

const node = (id: string, extra: Partial<Node> = {}): Node => ({ id, position: { x: 0, y: 0 }, data: { name: id }, ...extra });

/** The node as React Flow would hold it once it has measured `userNode`. */
const held = (userNode: Node, size: { width?: number; height?: number } = { width: 240, height: 16 }): Pick<InternalNode, 'measured' | 'internals'> => ({
  measured: size,
  internals: { positionAbsolute: { x: 0, y: 0 }, z: 0, userNode, handleBounds: { source: [], target: [] } },
});

describe('a node given another class', () => {
  it('adds the class and the data, and leaves the node it was handed alone', () => {
    const base = node('a', { className: 'plate' });
    const made = restyle(new Map(), new Map(), undefined, base, 'faded', { checksFaded: true });
    expect(made.className).toBe('plate faded');
    expect(made.data).toEqual({ name: 'a', checksFaded: true });
    expect(base.className).toBe('plate');
    expect(base.data).toEqual({ name: 'a' });
  });

  it('carries the size React Flow measured when React Flow holds this same node', () => {
    const base = node('a');
    const made = restyle(new Map(), new Map(), held(base), base, 'faded');
    expect(made.measured).toEqual({ width: 240, height: 16 });
  });

  it('is the same copy while the node and its class are unchanged', () => {
    const base = node('a');
    const first = new Map<string, Restyled>();
    const one = restyle(new Map(), first, held(base), base, 'faded');
    const second = new Map<string, Restyled>();
    const two = restyle(first, second, held(one), base, 'faded');
    expect(two).toBe(one);
    expect(second.get('a')?.made).toBe(one);
  });

  it('carries the size from one class to the next, since React Flow holds the last copy', () => {
    const base = node('a');
    const first = new Map<string, Restyled>();
    const faded = restyle(new Map(), first, held(base), base, 'faded');
    const lit = restyle(first, new Map(), held(faded, { width: 250, height: 20 }), base, 'lit');
    expect(lit).not.toBe(faded);
    expect(lit.className).toBe('lit');
    expect(lit.measured).toEqual({ width: 250, height: 20 });
  });

  it('carries no size for a node that has changed, so it is measured again', () => {
    const before = node('a');
    const first = new Map<string, Restyled>();
    const faded = restyle(new Map(), first, held(before), before, 'faded');
    const after = node('a', { data: { name: 'a', ports: 2 } });
    const made = restyle(first, new Map(), held(faded), after, 'faded');
    expect(made.measured).toBeUndefined();
    expect(made.data).toEqual({ name: 'a', ports: 2 });
  });

  it('carries no size React Flow has not measured, or when React Flow holds some other object', () => {
    const base = node('a');
    expect(restyle(new Map(), new Map(), held(base, {}), base, 'faded').measured).toBeUndefined();
    expect(restyle(new Map(), new Map(), held(node('a')), base, 'faded').measured).toBeUndefined();
    expect(restyle(new Map(), new Map(), undefined, base, 'faded').measured).toBeUndefined();
  });

  it('keeps a size the node already says for itself', () => {
    const base = node('a', { measured: { width: 10, height: 10 } });
    expect(restyle(new Map(), new Map(), held(base), base, 'faded').measured).toEqual({ width: 10, height: 10 });
  });
});
