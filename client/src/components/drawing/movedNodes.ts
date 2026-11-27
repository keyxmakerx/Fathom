// A node that has moved and nothing else, handed to React Flow so that it does not measure the node again.
//
// React Flow measures a node's ports again whenever it is handed a new object for the node that does not carry
// its size, and until it has, every cable on that node is off the page. A dragged rack hands over a new object
// for each of its devices and shelves at every step, so their cables blinked while the rack moved and stayed
// away for as long as it was held at the pane's edge, where the view pans at every frame. A move changes no
// port's place in its node, so the copy made for it carries the size React Flow measured (`restyledNodes.ts`
// does the same for a change of class).
import { useMemo, useState } from 'react';
import { useStoreApi } from '@xyflow/react';
import type { InternalNode, Node } from '@xyflow/react';

/** A node as it was handed in and what was handed on for it. */
export interface Moved {
  base: Node;
  made: Node;
}

/** The same thing to draw: the same value, or two handlers, since one made afresh for a new place moves nothing. */
const sameField = (a: unknown, b: unknown): boolean => Object.is(a, b) || (typeof a === 'function' && typeof b === 'function');

function sameMembers(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || typeof b !== 'object' || a == null || b == null) return false;
  const [x, y] = [a as Record<string, unknown>, b as Record<string, unknown>];
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every((key) => key in y && sameField(x[key], y[key]));
}

/** True when `b` is `a` somewhere else: every field the same but where it is and the size it was measured at.
 * `data` and `style` are made afresh with each node, so they are compared member by member. */
export function onlyMoved(a: Node, b: Node): boolean {
  const [x, y] = [a as unknown as Record<string, unknown>, b as unknown as Record<string, unknown>];
  for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (key === 'position' || key === 'measured') continue;
    if (sameField(x[key], y[key])) continue;
    if ((key === 'data' || key === 'style') && sameMembers(x[key], y[key])) continue;
    return false;
  }
  return true;
}

/**
 * `node`, carrying the size React Flow measured for it when all that has changed is where it is.
 *
 * `was` is what the last pass made and `now` collects this pass, both by node id, so a node handed in again
 * unchanged is handed on as the same object. `held` is the node as React Flow has it. A node that is new, or
 * has changed in any other way, goes on as it came and is measured again as it always was.
 */
export function keepMeasure(was: ReadonlyMap<string, Moved>, now: Map<string, Moved>, held: Pick<InternalNode, 'measured' | 'internals'> | undefined, node: Node): Node {
  const had = was.get(node.id);
  if (had != null && had.base === node) {
    now.set(node.id, had);
    return had.made;
  }
  let made = node;
  const from = held?.internals.userNode;
  const size = held?.measured;
  if (node.measured == null && from != null && from !== node && held?.internals.handleBounds != null && size?.width != null && size.height != null && onlyMoved(from, node)) {
    made = { ...node, measured: { width: size.width, height: size.height } };
  }
  now.set(node.id, { base: node, made });
  return made;
}

/** `nodes` for React Flow, each one that has only moved carrying its measured size. The same array when none has. */
export function useMovedNodes(nodes: Node[]): Node[] {
  const flow = useStoreApi();
  const [kept] = useState(() => ({ nodes: new Map<string, Moved>() }));
  return useMemo(() => {
    const was = kept.nodes;
    const now = new Map<string, Moved>();
    kept.nodes = now;
    const held = flow.getState().nodeLookup;
    let any = false;
    const made = nodes.map((node) => {
      const next = keepMeasure(was, now, held.get(node.id), node);
      if (next !== node) any = true;
      return next;
    });
    return any ? made : nodes;
  }, [nodes, flow, kept]);
}
