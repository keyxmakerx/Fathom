// A node given another class and nothing else, handed to React Flow so that it does not measure the node again.
//
// React Flow measures a node's ports again whenever it is handed a new object for the node that does not carry
// its size, and until it has, every cable on that node is off the page: each one is a new element when it comes
// back, and an animation on it starts over. A change of class moves no port, so the copy made for it carries the
// size React Flow measured, and a node whose class has not changed keeps the copy it had.
import type { InternalNode, Node } from '@xyflow/react';

/** A node as it was handed in, the class it was last given, and the copy that carried it. */
export interface Restyled {
  base: Node;
  cls: string;
  made: Node;
}

/**
 * `node` with `cls` added to its class and `data` to its data.
 *
 * `was` is what the last pass made and `now` collects this pass, both by node id. `held` is the node as React
 * Flow has it. The size is carried only when React Flow's node came from this same `node` (the node itself, or
 * the last copy of it), so a node that has really changed is measured again as it always was.
 */
export function restyle(
  was: ReadonlyMap<string, Restyled>,
  now: Map<string, Restyled>,
  held: Pick<InternalNode, 'measured' | 'internals'> | undefined,
  node: Node,
  cls: string,
  data?: object,
): Node {
  const had = was.get(node.id);
  if (had != null && had.base === node && had.cls === cls) {
    now.set(node.id, had);
    return had.made;
  }
  let made: Node = {
    ...node,
    className: node.className ? `${node.className} ${cls}` : cls,
    ...(data ? { data: { ...node.data, ...data } } : {}),
  };
  const from = held?.internals.userNode;
  const same = from === node || (had != null && had.base === node && from === had.made);
  const size = held?.measured;
  if (same && node.measured == null && size?.width != null && size.height != null) {
    made = { ...made, measured: { width: size.width, height: size.height } };
  }
  now.set(node.id, { base: node, cls, made });
  return made;
}
