// What one save changed, and what restoring would change, read off two versions of a
// document in the browser (the server runs no checks). Used by the History panel.

import type { NodeKind } from '../../../schema/generated/ir_types';
import { isNodeOfKind, type Document, type GraphNode, type Op } from './model';

export interface SaveChange {
  /** One line: the labels of the changes this save carried. */
  summary: string;
  /** Element ids (nodes and cables) to outline on the canvas. */
  changed: string[];
}

function opElements(op: Op): string[] {
  switch (op.type) {
    case 'add_node':
      return [op.node];
    case 'add_edge':
      return [op.edge, op.from, op.to];
    case 'set_field':
    case 'tombstone':
    case 'revive':
      return [op.element];
  }
}

const isLive = (n: GraphNode) => n.absentSince === undefined;

/** The batches `after` has that `before` lacks. `before` is `null` for the first save. */
export function describeSave(before: Document | null, after: Document): SaveChange {
  const known = new Set((before?.batches ?? []).map((b) => b.id));
  const fresh = after.batches.filter((b) => !known.has(b.id));
  const changed = [...new Set(fresh.flatMap((b) => b.ops.flatMap(opElements)))];
  if (fresh.length === 0) {
    if (before === null) return { summary: 'Design created', changed: [] };
    return { summary: 'Saved with no drawn change', changed: [] };
  }
  const labels = fresh.map((b) => b.label);
  const shown = labels.slice(0, 2).join('; ');
  return { summary: labels.length > 2 ? `${shown}; +${labels.length - 2} more` : shown, changed };
}

const NOUN: Record<string, [string, string]> = {
  Chassis: ['device', 'devices'],
  Cable: ['cable', 'cables'],
  Rack: ['rack', 'racks'],
  Surface: ['board', 'boards'],
};

function fieldKey(n: GraphNode): string {
  return Object.keys(n.fields)
    .sort()
    .map((k) => {
      const f = n.fields[k]!;
      return `${k}=${f.presence}:${JSON.stringify(f.value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))}`;
    })
    .join('|');
}

function plural(n: number, noun: [string, string]): string {
  return `${n} ${n === 1 ? noun[0] : noun[1]}`;
}

/** The sentence for the Restore confirm: what restoring `past` over `current` would change. */
export function describeRestore(current: Document, past: Document): string {
  const live = (d: Document) => new Map(d.nodes.filter(isLive).map((n) => [n.id, n]));
  const now = live(current);
  const then = live(past);
  const parts: string[] = [];
  const count = (ids: string[], verb: string) => {
    for (const kind of Object.keys(NOUN)) {
      const n = ids.filter((id) => isNodeOfKind(id, kind as NodeKind)).length;
      if (n > 0) parts.push(`${verb} ${plural(n, NOUN[kind]!)}`);
    }
  };
  count([...then.keys()].filter((id) => !now.has(id)), 'bring back');
  count([...now.keys()].filter((id) => !then.has(id)), 'remove');
  const edited = [...then.keys()].filter((id) => now.has(id) && fieldKey(now.get(id)!) !== fieldKey(then.get(id)!)).length;
  if (edited > 0) parts.push(`put back ${edited} edited ${edited === 1 ? 'item' : 'items'}`);
  return parts.length === 0 ? 'Nothing drawn differs from now.' : `This will ${parts.join(', ')}.`;
}

/** The canvas elements an outline for `changed` lands on: a port or device change outlines the
 * chassis it belongs to (one hop along the document's edges). */
export function outlineIds(doc: Document, changed: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of changed) {
    out.add(id);
    if (isNodeOfKind(id, 'Device') || isNodeOfKind(id, 'PhysicalPort')) {
      for (const e of doc.edges) {
        if (e.from === id) out.add(e.to);
        else if (e.to === id) out.add(e.from);
      }
    }
  }
  return [...out];
}

/** Selectors for the React Flow elements drawing `ids`. */
export function outlineSelectors(ids: readonly string[]): string[] {
  const attr = (v: string) => `"${v.replace(/["\\]/g, '\\$&')}"`;
  return ids.flatMap((id) => [
    `[data-id=${attr(`chassis:${id}`)}]`,
    `[data-id=${attr(`rack:${id}`)}]`,
    `[data-id=${attr(`surface:${id}`)}]`,
    `[data-id=${attr(`shelf:${id}`)}]`,
    `[data-testid=${attr(`rf__edge-${id}`)}]`,
  ]);
}
