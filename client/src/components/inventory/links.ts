// Where a link inside a page goes: the list kind and the row key (`kind:id`, the same key the
// list's rows carry), so opening it is a history entry like any other. Pure.

import type { Kind } from './kinds';

export interface LinkTarget {
  kind: Kind;
  open: string;
}

const KIND_OF: Readonly<Record<string, Kind>> = {
  chassis: 'devices',
  occupant: 'devices',
  fixture: 'devices',
  rack: 'racks',
  cable: 'cables',
  port: 'ports',
};

/** Null for a selection with no page in the Inventory (a shelf, a label, a line). */
export function linkTarget(sel: { kind: string; id: string }): LinkTarget | null {
  const kind = KIND_OF[sel.kind];
  return kind ? { kind, open: `${sel.kind}:${sel.id}` } : null;
}
