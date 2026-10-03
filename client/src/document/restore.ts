// "Restore this version": a new batch that puts the design back as it stood after a past save.
// Real ops (tombstone, revive, set_field), so under live co-editing it travels like any edit
// and a peer sees an ordinary change. Nothing is rewritten; the saves in between stay.

import {
  appendHistory,
  archiveField,
  assertHand,
  replaceEdge,
  replaceNode,
  withBatch,
  type Batch,
  type Document,
  type FieldEntry,
  type GraphEdge,
  type GraphNode,
  type Op,
} from './model';
import { newUlid } from './ulid';

const sameEntry = (a: FieldEntry | undefined, b: FieldEntry | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.presence === b.presence && JSON.stringify(a.value) === JSON.stringify(b.value));

/** `current` with a batch labelled `label` that puts every drawn thing and field back as in
 * `past`. `past` must be an earlier state of the same design. `current` itself when nothing differs. */
export function restoreTo(current: Document, past: Document, label: string, opts: { actor: string; now: number }): Document {
  const { actor, now } = opts;
  const live = (e: { absentSince?: number } | undefined): boolean => e !== undefined && e.absentSince === undefined;
  const pastNodes = new Map(past.nodes.map((n) => [n.id, n]));
  const pastEdges = new Map(past.edges.map((e) => [e.id, e]));

  const tombstones: Op[] = [];
  const nodeRevives: Op[] = [];
  const edgeRevives: Op[] = [];
  let working = current;

  const setAbsent = (id: string, isNode: boolean, at: number | undefined) => {
    working = isNode
      ? replaceNode(working, id, (n) => ({ ...n, absentSince: at }))
      : replaceEdge(working, id, (e) => ({ ...e, absentSince: at }));
  };
  for (const n of current.nodes) {
    const was = pastNodes.get(n.id);
    if (live(n) && !live(was)) {
      tombstones.push({ type: 'tombstone', element: n.id, at: now, by: actor });
      setAbsent(n.id, true, now);
    } else if (!live(n) && live(was)) {
      nodeRevives.push({ type: 'revive', element: n.id, at: now, by: actor });
      setAbsent(n.id, true, undefined);
    }
  }
  for (const e of current.edges) {
    const was = pastEdges.get(e.id);
    if (live(e) && !live(was)) {
      tombstones.push({ type: 'tombstone', element: e.id, at: now, by: actor });
      setAbsent(e.id, false, now);
    } else if (!live(e) && live(was)) {
      edgeRevives.push({ type: 'revive', element: e.id, at: now, by: actor });
      setAbsent(e.id, false, undefined);
    }
  }

  const fieldOps: Op[] = [];
  const putFields = (id: string, isNode: boolean, now_: GraphNode | GraphEdge, was: GraphNode | GraphEdge | undefined) => {
    if (!live(was)) return;
    const keys = new Set([...Object.keys(now_.fields), ...Object.keys(was!.fields)]);
    for (const key of keys) {
      const have = now_.fields[key];
      const want = was!.fields[key];
      if (sameEntry(have, want)) continue;
      const prov = assertHand(working, { assertedAt: now, assertedBy: actor, supersedes: have?.prov });
      working = prov.doc;
      if (have !== undefined) working = archiveField(working, id, key, have);
      const fields: Record<string, FieldEntry> = { ...now_.fields };
      if (want === undefined) {
        delete fields[key];
        working = appendHistory(working, id, key, { presence: 'unknown', prov: prov.id });
        fieldOps.push({ type: 'set_field', element: id, key, presence: 'unknown', prov: prov.id });
      } else {
        fields[key] = want.presence === 'set' ? { presence: 'set', prov: prov.id, value: want.value } : { presence: 'absent', prov: prov.id };
        fieldOps.push({ type: 'set_field', element: id, key, presence: want.presence, prov: prov.id });
      }
      now_ = { ...now_, fields };
      working = isNode ? replaceNode(working, id, (n) => ({ ...n, fields })) : replaceEdge(working, id, (e) => ({ ...e, fields }));
    }
  };
  for (const n of current.nodes) putFields(n.id, true, n, pastNodes.get(n.id));
  for (const e of current.edges) putFields(e.id, false, e, pastEdges.get(e.id));

  const ops = [...tombstones, ...nodeRevives, ...edgeRevives, ...fieldOps];
  if (ops.length === 0) return current;
  const batch: Batch = { id: newUlid(now), label, ops };
  return withBatch(working, batch);
}
