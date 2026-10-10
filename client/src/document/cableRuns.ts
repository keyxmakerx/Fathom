// Cable runs and ties (schema 0.21, round 15 cable styles). A `CableRun` is a tray or lacing
// bar along one side of a rack or wall (`HasCableRun`); a `CableTie` is clipped somewhere along
// a run (`HasCableTie`, `CableTie.at` in thousandths of the run's length) and holds the cables
// it ties (`Ties`). Removing a run takes its ties; removing a cable drops it from any tie.

import { cascadeRemoval } from './cascade';
import {
  LOCAL_ACTOR,
  UnknownReferenceError,
  assertHand,
  edgesIn,
  edgesOut,
  findNode,
  formatEdgeId,
  formatNodeId,
  parseNodeId,
  replaceNode,
  requireFieldName,
  text,
  token,
  uint,
  withBatch,
  withEdge,
  withNode,
  archiveField,
  type Batch,
  type Document,
  type EdgeKind,
  type FieldEntry,
  type Op,
} from './model';
import { newUlid } from './ulid';

interface Actor {
  actor?: string;
  now?: number;
}

function resolve(opts: Actor | undefined): { actor: string; now: number } {
  return { actor: opts?.actor ?? LOCAL_ACTOR, now: opts?.now ?? Date.now() };
}

export const CABLE_RUN_FORMS = ['tray', 'lacing_bar'] as const;
export type CableRunForm = (typeof CABLE_RUN_FORMS)[number];
export const CABLE_RUN_SIDES = ['left', 'right', 'top', 'bottom'] as const;
export type CableRunSide = (typeof CABLE_RUN_SIDES)[number];

export const CABLE_RUN_FORM_LABEL: Record<CableRunForm, string> = { tray: 'Tray', lacing_bar: 'Lacing bar' };

/** A run along a left or right side runs up and down; along the top or bottom, across. */
export function runIsVertical(side: CableRunSide): boolean {
  return side === 'left' || side === 'right';
}

export interface CableTieView {
  id: string;
  /** Thousandths of the run's length from its top or left end. */
  at: number;
  cableIds: string[];
}

export interface CableRunView {
  id: string;
  hostId: string;
  form: CableRunForm;
  side: CableRunSide;
  label: string | null;
  ties: CableTieView[];
}

function isLive(doc: Document, id: string): boolean {
  const n = findNode(doc, id);
  return n != null && n.absentSince === undefined;
}

function liveOut(doc: Document, from: string, kind: EdgeKind) {
  return edgesOut(doc, from, kind).filter((e) => e.absentSince === undefined && isLive(doc, e.to));
}

function setValue(fields: Readonly<Record<string, FieldEntry>>, key: string): FieldEntry['value'] | undefined {
  const e = fields[key];
  return e && e.presence === 'set' ? e.value : undefined;
}

function clampAt(at: number): number {
  return Math.max(0, Math.min(1000, Math.round(at)));
}

/** Every live run on a rack or wall, each with its live ties, ties in order along the run. */
export function cableRunsOf(doc: Document, hostId: string): CableRunView[] {
  const out: CableRunView[] = [];
  for (const edge of liveOut(doc, hostId, 'HasCableRun')) {
    const node = findNode(doc, edge.to)!;
    const form = setValue(node.fields, 'CableRun.form');
    const side = setValue(node.fields, 'CableRun.side');
    const label = setValue(node.fields, 'CableRun.label');
    const ties: CableTieView[] = liveOut(doc, edge.to, 'HasCableTie').map((te) => {
      const tie = findNode(doc, te.to)!;
      const at = setValue(tie.fields, 'CableTie.at');
      return {
        id: te.to,
        at: typeof at === 'number' ? at : 500,
        cableIds: liveOut(doc, te.to, 'Ties').map((t) => t.to),
      };
    });
    ties.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    out.push({
      id: edge.to,
      hostId,
      form: form === 'tray' ? 'tray' : 'lacing_bar',
      side: side === 'left' || side === 'right' || side === 'top' || side === 'bottom' ? side : 'left',
      label: typeof label === 'string' ? label : null,
      ties,
    });
  }
  return out;
}

export interface AddCableRunOptions extends Actor {
  form: CableRunForm;
  side: CableRunSide;
  label?: string;
}

/** A run along one side of a rack or wall. Refuses a host that is not a live Rack or Surface. */
export function addCableRun(doc: Document, hostId: string, opts: AddCableRunOptions): Document {
  const kind = isLive(doc, hostId) ? parseNodeId(hostId).kind : null;
  if (kind !== 'Rack' && kind !== 'Surface') throw new UnknownReferenceError(hostId, 'a Rack or Surface');
  const { actor, now } = resolve(opts);
  let working = doc;
  const runId = formatNodeId('CableRun', newUlid(now));
  const existence = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = existence.doc;
  const fields: Record<string, FieldEntry> = {};
  const fieldOps: Op[] = [];
  const set = (key: string, value: FieldEntry['value']) => {
    requireFieldName(key);
    const prov = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = prov.doc;
    fields[key] = { presence: 'set', prov: prov.id, value };
    fieldOps.push({ type: 'set_field', element: runId, key, presence: 'set', prov: prov.id });
  };
  set('CableRun.form', token(opts.form));
  set('CableRun.side', token(opts.side));
  if (opts.label != null && opts.label.trim() !== '') set('CableRun.label', text(opts.label.trim()));
  working = withNode(working, { id: runId, existence: existence.id, fields });
  const edgeProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = edgeProv.doc;
  const edgeId = formatEdgeId('HasCableRun', newUlid(now));
  working = withEdge(working, { id: edgeId, from: hostId, to: runId, prov: edgeProv.id, fields: {} });
  const ops: Op[] = [
    { type: 'add_node', node: runId, prov: existence.id },
    ...fieldOps,
    { type: 'add_edge', edge: edgeId, from: hostId, to: runId, prov: edgeProv.id },
  ];
  const batch: Batch = { id: newUlid(now), label: 'add cable run', ops };
  return withBatch(working, batch);
}

function tombstoneAll(doc: Document, rootId: string, label: string, opts?: Actor): Document {
  const { nodeIds, edgeIds } = cascadeRemoval(doc, rootId);
  const { actor, now } = resolve(opts);
  const working: Document = {
    ...doc,
    nodes: doc.nodes.map((n) => (nodeIds.has(n.id) && n.absentSince === undefined ? { ...n, absentSince: now } : n)),
    edges: doc.edges.map((e) => (edgeIds.has(e.id) && e.absentSince === undefined ? { ...e, absentSince: now } : e)),
  };
  const ops: Op[] = [...nodeIds, ...edgeIds].map((element): Op => ({ type: 'tombstone', element, at: now, by: actor }));
  return withBatch(working, { id: newUlid(now), label, ops });
}

/** Takes the run off its rack or wall, with its ties. The cables stay. */
export function removeCableRun(doc: Document, runId: string, opts?: Actor): Document {
  if (!isLive(doc, runId) || parseNodeId(runId).kind !== 'CableRun') throw new UnknownReferenceError(runId, 'CableRun');
  return tombstoneAll(doc, runId, 'remove cable run', opts);
}

export interface AddCableTieOptions extends Actor {
  at: number;
  cableIds: readonly string[];
}

/** A tie clipped onto a run at `at`, holding the given live cables. */
export function addCableTie(doc: Document, runId: string, opts: AddCableTieOptions): Document {
  if (!isLive(doc, runId) || parseNodeId(runId).kind !== 'CableRun') throw new UnknownReferenceError(runId, 'CableRun');
  for (const c of opts.cableIds) {
    if (!isLive(doc, c) || parseNodeId(c).kind !== 'Cable') throw new UnknownReferenceError(c, 'Cable');
  }
  const { actor, now } = resolve(opts);
  let working = doc;
  const tieId = formatNodeId('CableTie', newUlid(now));
  const existence = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = existence.doc;
  requireFieldName('CableTie.at');
  const atProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = atProv.doc;
  working = withNode(working, {
    id: tieId,
    existence: existence.id,
    fields: { 'CableTie.at': { presence: 'set', prov: atProv.id, value: uint(clampAt(opts.at), 16) } },
  });
  const ops: Op[] = [
    { type: 'add_node', node: tieId, prov: existence.id },
    { type: 'set_field', element: tieId, key: 'CableTie.at', presence: 'set', prov: atProv.id },
  ];
  const link = (kind: EdgeKind, from: string, to: string) => {
    const prov = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = prov.doc;
    const id = formatEdgeId(kind, newUlid(now));
    working = withEdge(working, { id, from, to, prov: prov.id, fields: {} });
    ops.push({ type: 'add_edge', edge: id, from, to, prov: prov.id });
  };
  link('HasCableTie', runId, tieId);
  for (const c of new Set(opts.cableIds)) link('Ties', tieId, c);
  return withBatch(working, { id: newUlid(now), label: 'add cable tie', ops });
}

/** Slides a tie along its run. */
export function moveCableTie(doc: Document, tieId: string, at: number, opts?: Actor): Document {
  const node = findNode(doc, tieId);
  if (!node || node.absentSince !== undefined || parseNodeId(tieId).kind !== 'CableTie') throw new UnknownReferenceError(tieId, 'CableTie');
  const key = 'CableTie.at';
  const { actor, now } = resolve(opts);
  const existing = node.fields[key];
  const prov = assertHand(doc, { assertedAt: now, assertedBy: actor, supersedes: existing?.prov });
  const archived = existing !== undefined ? archiveField(prov.doc, tieId, key, existing) : prov.doc;
  const entry: FieldEntry = { presence: 'set', prov: prov.id, value: uint(clampAt(at), 16) };
  const working = replaceNode(archived, tieId, (n) => ({ ...n, fields: { ...n.fields, [key]: entry } }));
  const op: Op = { type: 'set_field', element: tieId, key, presence: 'set', prov: prov.id };
  return withBatch(working, { id: newUlid(now), label: 'move cable tie', ops: [op] });
}

/** Unclips a tie; its cables go back to their own route. */
export function removeCableTie(doc: Document, tieId: string, opts?: Actor): Document {
  if (!isLive(doc, tieId) || parseNodeId(tieId).kind !== 'CableTie') throw new UnknownReferenceError(tieId, 'CableTie');
  const owner = edgesIn(doc, tieId, 'HasCableTie').find((e) => e.absentSince === undefined);
  if (owner == null) throw new UnknownReferenceError(tieId, 'a CableTie on a run');
  return tombstoneAll(doc, tieId, 'remove cable tie', opts);
}
