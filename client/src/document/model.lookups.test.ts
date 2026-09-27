import { describe, expect, it } from 'vitest';

import {
  edgesIn,
  edgesOut,
  emptyDocument,
  findEdge,
  findNode,
  formatEdgeId,
  formatNodeId,
  parseEdgeId,
  replaceEdge,
  withEdge,
  withNode,
  type Document,
  type EdgeKind,
  type GraphEdge,
  type NodeKind,
} from './model';
import { newUlid } from './ulid';

let t = 1_700_000_000_000;
const ulid = () => newUlid((t += 1));

function node(doc: Document, kind: NodeKind): { doc: Document; id: string } {
  const id = formatNodeId(kind, ulid());
  return { doc: withNode(doc, { id, existence: 'p', fields: {} }), id };
}

function edge(doc: Document, kind: EdgeKind, from: string, to: string): { doc: Document; id: string } {
  const id = formatEdgeId(kind, ulid());
  return { doc: withEdge(doc, { id, from, to, prov: 'p', fields: {} }), id };
}

// What the lookups returned before they were indexed: a scan of every edge.
function scan(doc: Document, end: 'from' | 'to', id: string, kind: EdgeKind): GraphEdge[] {
  return doc.edges.filter((e) => e[end] === id && e.absentSince === undefined && parseEdgeId(e.id).kind === kind);
}

describe('lookups by id and by end', () => {
  it('match a scan of the whole document, in document order, and leave out removed edges', () => {
    let doc = emptyDocument();
    const chassis = node(doc, 'Chassis');
    doc = chassis.doc;
    const ports: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const p = node(doc, 'PhysicalPort');
      doc = edge(p.doc, 'HasPort', chassis.id, p.id).doc;
      ports.push(p.id);
    }
    const pass = edge(doc, 'PassThrough', ports[0], ports[1]);
    doc = pass.doc;
    const removed = edge(doc, 'HasPort', chassis.id, ports[2]);
    doc = replaceEdge(removed.doc, removed.id, (e) => ({ ...e, absentSince: 1 }));

    for (const kind of ['HasPort', 'PassThrough', 'MountedIn'] as const) {
      for (const id of [chassis.id, ...ports]) {
        expect(edgesOut(doc, id, kind)).toEqual(scan(doc, 'from', id, kind));
        expect(edgesIn(doc, id, kind)).toEqual(scan(doc, 'to', id, kind));
      }
    }
    expect(edgesOut(doc, chassis.id, 'HasPort').map((e) => e.to)).toEqual(ports);
    expect(findNode(doc, ports[1])?.id).toBe(ports[1]);
    expect(findEdge(doc, pass.id)?.from).toBe(ports[0]);
    expect(findNode(doc, formatNodeId('Chassis', ulid()))).toBeUndefined();
  });

  it('follow every write, and a document read before the write keeps its own answer', () => {
    const chassis = node(emptyDocument(), 'Chassis');
    const port = node(chassis.doc, 'PhysicalPort');
    const before = port.doc;
    expect(edgesOut(before, chassis.id, 'HasPort')).toEqual([]);

    const after = edge(before, 'HasPort', chassis.id, port.id).doc;
    expect(edgesOut(after, chassis.id, 'HasPort').map((e) => e.to)).toEqual([port.id]);
    expect(edgesIn(after, port.id, 'HasPort').map((e) => e.from)).toEqual([chassis.id]);
    expect(edgesOut(before, chassis.id, 'HasPort')).toEqual([]);
  });
});
