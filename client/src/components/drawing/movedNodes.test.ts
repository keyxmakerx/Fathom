import { describe, expect, it } from 'vitest';
import type { InternalNode, Node } from '@xyflow/react';

import { keepMeasure, onlyMoved, type Moved } from './movedNodes';

const ports = ['eth0', 'eth1'];
const chassis = { id: 'sw', name: 'switch-1' };
/** A device's node as the builder makes it: `data` and `style` afresh each time, with a handler of its own. */
const node = (x: number, extra: Partial<Node> = {}, data: Record<string, unknown> = {}): Node => ({
  id: 'chassis:sw',
  type: 'chassis',
  position: { x, y: 40 },
  draggable: true,
  width: 244,
  height: 16,
  style: { width: 244, height: 16 },
  data: { chassis, ports, onSelectPort: () => undefined, ...data },
  ...extra,
});

/** The node as React Flow would hold it once it has measured `userNode`. */
const held = (userNode: Node, size: { width?: number; height?: number } = { width: 244, height: 16 }, measuredPorts = true): Pick<InternalNode, 'measured' | 'internals'> => ({
  measured: size,
  internals: { positionAbsolute: { x: 0, y: 0 }, z: 0, userNode, handleBounds: measuredPorts ? { source: [], target: [] } : undefined },
});

describe('a node that has only moved', () => {
  it('is the same node somewhere else, its data and style made afresh and its handlers new', () => {
    expect(onlyMoved(node(0), node(120))).toBe(true);
    expect(onlyMoved(node(0), node(0))).toBe(true);
    // The copy React Flow holds carries the size it measured.
    expect(onlyMoved({ ...node(0), measured: { width: 244, height: 16 } }, node(120))).toBe(true);
  });

  it('is not one whose ports, size, class or kind has changed', () => {
    expect(onlyMoved(node(0), node(120, {}, { ports: ['eth0'] }))).toBe(false);
    expect(onlyMoved(node(0), node(120, {}, { rear: true }))).toBe(false);
    expect(onlyMoved(node(0), node(120, { style: { width: 244, height: 32 } }))).toBe(false);
    expect(onlyMoved(node(0), node(120, { height: 32 }))).toBe(false);
    expect(onlyMoved(node(0), node(120, { className: 'trace-faded' }))).toBe(false);
    expect(onlyMoved(node(0), node(120, { type: 'shelf' }))).toBe(false);
    expect(onlyMoved(node(0), node(120, { hidden: true }))).toBe(false);
    // A handler is only the same as another handler.
    expect(onlyMoved(node(0), node(120, {}, { onSelectPort: null }))).toBe(false);
  });
});

describe('keepMeasure', () => {
  it('hands a moved node on with the size React Flow measured, and leaves the node it was handed alone', () => {
    const [before, after] = [node(0), node(120)];
    const made = keepMeasure(new Map(), new Map(), held(before), after);
    expect(made).not.toBe(after);
    expect(made.measured).toEqual({ width: 244, height: 16 });
    expect(made.position).toEqual({ x: 120, y: 40 });
    expect(after.measured).toBeUndefined();
  });

  it('carries the size from one step of a drag to the next, since React Flow holds the last copy', () => {
    const first = new Map<string, Moved>();
    const one = keepMeasure(new Map(), first, held(node(0)), node(60));
    const two = keepMeasure(first, new Map(), held(one, { width: 250, height: 20 }), node(120));
    expect(two.measured).toEqual({ width: 250, height: 20 });
    expect(two.position.x).toBe(120);
  });

  it('is the same object while the node handed in is the same', () => {
    const after = node(120);
    const first = new Map<string, Moved>();
    const one = keepMeasure(new Map(), first, held(node(0)), after);
    const second = new Map<string, Moved>();
    expect(keepMeasure(first, second, held(one), after)).toBe(one);
    expect(second.get('chassis:sw')?.made).toBe(one);
  });

  it('hands on as it came a node that is new, unchanged, or changed in any other way', () => {
    const base = node(0);
    expect(keepMeasure(new Map(), new Map(), undefined, base)).toBe(base);
    expect(keepMeasure(new Map(), new Map(), held(base), base)).toBe(base);
    const grown = node(120, {}, { ports: ['eth0', 'eth1', 'eth2'] });
    expect(keepMeasure(new Map(), new Map(), held(base), grown)).toBe(grown);
  });

  it('carries no size React Flow has not measured, and none over a size the node brings', () => {
    const after = node(120);
    expect(keepMeasure(new Map(), new Map(), held(node(0), { width: 244 }), after)).toBe(after);
    expect(keepMeasure(new Map(), new Map(), held(node(0), { width: 244, height: 16 }, false), after)).toBe(after);
    const sized = node(120, { measured: { width: 10, height: 10 } });
    expect(keepMeasure(new Map(), new Map(), held(node(0)), sized)).toBe(sized);
  });
});
