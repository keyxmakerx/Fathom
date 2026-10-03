// What one save changed, and what restoring would change, read off two versions of a
// document in the browser (the server runs no checks). Used by the History panel.

import type { NodeKind } from '../../../schema/generated/ir_types';
import { emptyDocument, isNodeOfKind, readDeviceFields, type Document, type GraphEdge, type GraphNode, type Op } from './model';

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
      return [op.edge, op.from];
    case 'set_field':
    case 'tombstone':
    case 'revive':
      return [op.element];
  }
}

const isLive = (n: GraphNode) => n.absentSince === undefined;

const fmtNames = (names: string[]) => (names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', '));
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "added nas-01, 1 cable": what changed between two versions, read off the live nodes. */
function summaryOf(before: Document, after: Document): string {
  const live = (d: Document) => new Map(d.nodes.filter(isLive).map((n) => [n.id, n]));
  const was = live(before);
  const now = live(after);
  const kindIds = (m: Map<string, GraphNode>, kind: NodeKind, other: Map<string, GraphNode>, inOther: boolean) =>
    [...m.keys()].filter((id) => isNodeOfKind(id, kind) && other.has(id) === inOther);
  const name = (d: Map<string, GraphNode>, id: string) => readDeviceFields(d.get(id)!).hostname || 'unnamed';
  const parts: string[] = [];

  const nouns: [NodeKind, string, string?][] = [['Cable', 'cable'], ['Rack', 'rack'], ['Surface', 'board']];
  for (const [verb, from, to] of [['added', was, now], ['removed', now, was]] as const) {
    const items = kindIds(to, 'Device', from, false).map((id) => name(to, id));
    for (const [kind, noun, plural] of nouns) {
      const n = kindIds(to, kind, from, false).length;
      if (n > 0) items.push(count(n, noun, plural));
    }
    if (items.length > 0) parts.push(`${verb} ${fmtNames(items)}`);
  }
  const renamed = [...now.keys()]
    .filter((id) => isNodeOfKind(id, 'Device') && was.has(id) && name(was, id) !== name(now, id))
    .map((id) => `${name(was, id)} \u2192 ${name(now, id)}`);
  if (renamed.length > 0) parts.push(`renamed ${fmtNames(renamed)}`);
  const edited = [...now.keys()].filter((id) => was.has(id) && fieldKey(was.get(id)!) !== fieldKey(now.get(id)!)).length - renamed.length;
  const edgeKey = (e: GraphEdge) => `${e.from}>${e.to}|${fieldKeyOf(e.fields)}`;
  const mounts = (d: Document) => new Map(d.edges.filter((e) => e.absentSince === undefined && e.id.startsWith('mounted-in:')).map((e) => [e.id, edgeKey(e)]));
  const mountsWas = mounts(before);
  const moved = [...mounts(after)].filter(([id, k]) => mountsWas.has(id) && mountsWas.get(id) !== k).length;
  if (moved > 0) parts.push(`moved ${count(moved, 'device')}`);
  if (edited > 0) parts.push(`edited ${count(edited, 'item')}`);
  return parts.join(', ');
}

/** The batches `after` has that `before` lacks. `before` is `null` for the first save. */
export function describeSave(before: Document | null, after: Document): SaveChange {
  const known = new Set((before?.batches ?? []).map((b) => b.id));
  const fresh = after.batches.filter((b) => !known.has(b.id));
  const changed = [...new Set(fresh.flatMap((b) => b.ops.flatMap(opElements)))];
  const restored = fresh.find((b) => b.label.startsWith('Restored the save'));
  if (restored) return { summary: restored.label, changed };
  const drawn = summaryOf(before ?? emptyDocument(), after);
  if (drawn !== '') return { summary: drawn, changed };
  if (fresh.length === 0) return { summary: before === null ? 'Design created' : 'Saved with no drawn change', changed: [] };
  const labels = fresh.map((b) => b.label);
  const shown = labels.slice(0, 2).join('; ');
  return { summary: labels.length > 2 ? `${shown}; +${labels.length - 2} more` : shown, changed };
}

function fieldKey(n: GraphNode): string {
  return fieldKeyOf(n.fields);
}

function fieldKeyOf(fields: GraphNode['fields']): string {
  return Object.keys(fields)
    .sort()
    .map((k) => {
      const f = fields[k]!;
      return `${k}=${f.presence}:${JSON.stringify(f.value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))}`;
    })
    .join('|');
}

/** The sentence for the Restore confirm: what restoring `past` over `current` would change. */
export function describeRestore(current: Document, past: Document): string {
  const changes = summaryOf(current, past);
  return changes === '' ? 'Nothing drawn differs from now.' : `Compared with now: ${changes}.`;
}
/** The canvas elements an outline for `changed` lands on: a port or device change outlines the
 * chassis it belongs to (one hop along the document's edges). */
export function outlineIds(doc: Document, changed: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of changed) {
    out.add(id);
    if (isNodeOfKind(id, 'Device') || isNodeOfKind(id, 'PhysicalPort') || isNodeOfKind(id, 'LayoutPin')) {
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
    `[data-id=${attr(`free:${id}`)}]`,
    `[data-id=${attr(`label:${id}`)}]`,
    `[data-testid=${attr(`rf__edge-${id}`)}]`,
    `[data-testid=${attr(`rf__edge-line:${id}`)}]`,
  ]);
}
