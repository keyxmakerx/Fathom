// A remove cascade driven by the schema's own edge classes
// (`schema/generated/schema.json`'s `class: containment`), never a hand-kept
// list of kinds. `Terminates`/`PassThrough` are excluded: the derivation
// already tolerates a dangling reference to a removed port (`portRemoved`).

import schemaJson from '../../../schema/generated/schema.json';
import { parseEdgeId, type Document, type EdgeKind, type GraphEdge } from './model';

interface SchemaEdgeEntry {
  edge: string;
  class: string;
}

const CONTAINMENT_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set(
  (schemaJson as unknown as { edges: SchemaEdgeEntry[] }).edges
    .filter((e) => e.class === 'containment')
    .map((e) => e.edge as EdgeKind),
);

const CASCADE_EXCLUDED_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set(['Terminates', 'PassThrough'] as EdgeKind[]);

export interface CascadeResult {
  nodeIds: Set<string>;
  edgeIds: Set<string>;
}

/** Every node reachable from `rootId` through a live containment edge, plus
 * every other live edge touching that set (the cable exception above). */
export function cascadeRemoval(doc: Document, rootId: string): CascadeResult {
  // Index live edges by `from` once, so the BFS below is O(nodes + edges)
  // rather than rescanning every edge for every node it reaches.
  const liveEdgesByFrom = new Map<string, GraphEdge[]>();
  for (const e of doc.edges) {
    if (e.absentSince !== undefined) continue;
    let bucket = liveEdgesByFrom.get(e.from);
    if (!bucket) {
      bucket = [];
      liveEdgesByFrom.set(e.from, bucket);
    }
    bucket.push(e);
  }

  const nodeIds = new Set<string>([rootId]);
  const containmentEdgeIds = new Set<string>();
  let frontier = [rootId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of liveEdgesByFrom.get(id) ?? []) {
        if (!CONTAINMENT_EDGE_KINDS.has(parseEdgeId(e.id).kind)) continue;
        containmentEdgeIds.add(e.id);
        if (!nodeIds.has(e.to)) {
          nodeIds.add(e.to);
          next.push(e.to);
        }
      }
    }
    frontier = next;
  }

  const edgeIds = new Set<string>(containmentEdgeIds);
  for (const e of doc.edges) {
    if (e.absentSince !== undefined) continue;
    if (!nodeIds.has(e.from) && !nodeIds.has(e.to)) continue;
    if (CASCADE_EXCLUDED_EDGE_KINDS.has(parseEdgeId(e.id).kind)) continue;
    edgeIds.add(e.id);
  }

  return { nodeIds, edgeIds };
}
