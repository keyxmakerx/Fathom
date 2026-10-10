// Free boxes, lines, labels and areas on the canvas (ADR-0060 step 7, schema 0.13).
// A free box is an unplaced sketch Device+Chassis with a LayoutPin; a Line joins two
// boxes through LineEnd edges; a Label is a text label or an area. All pure, one batch each.

import { cascadeRemoval } from './cascade';
import { createSketchDevice } from './commands';
import { setDeviceField } from './edit';
import {
  LOCAL_ACTOR,
  UnknownReferenceError,
  assertHand,
  archiveField,
  edgesIn,
  edgesOut,
  findNode,
  formatEdgeId,
  formatNodeId,
  parseNodeId,
  readLabelFields,
  readLayoutPinFields,
  readLineEndSide,
  readLineLabel,
  requireFieldName,
  text,
  token,
  uint,
  withBatch,
  withEdge,
  withNode,
  type Batch,
  type Document,
  type FieldEntry,
  type GraphNode,
  type Op,
} from './model';
import { newUlid } from './ulid';

interface Actor {
  actor?: string;
  now?: number;
}

/** A free box's size in scene units; the same for every kind. */
export const BOX_W = 128;
export const BOX_H = 56;
/** LayoutPin coordinates sit on this grid (schema: "on the 4 px grid"). */
export const GRID = 4;
/** An area's smallest size, and the size a fresh one gets. */
export const AREA_MIN_W = 96;
export const AREA_MIN_H = 64;
export const AREA_DEFAULT_W = 240;
export const AREA_DEFAULT_H = 160;

export const snap = (n: number): number => Math.round(n / GRID) * GRID;

function resolve(opts: Actor | undefined): { actor: string; now: number } {
  return { actor: opts?.actor ?? LOCAL_ACTOR, now: opts?.now ?? Date.now() };
}

/** Accumulates one batch: every helper returns nothing and mutates `b.doc`/`b.ops`. */
export interface Build {
  doc: Document;
  ops: Op[];
  now: number;
  actor: string;
}

export function begin(base: Document, opts: Actor | undefined): Build {
  const { actor, now } = resolve(opts);
  return { doc: base, ops: [], now, actor };
}

export function finish(b: Build, label: string): Document {
  if (b.ops.length === 0) return b.doc;
  const batch: Batch = { id: newUlid(b.now), label, ops: b.ops };
  return withBatch(b.doc, batch);
}

function entry(b: Build, id: string, key: string, value: FieldEntry['value'], existing?: FieldEntry): FieldEntry {
  requireFieldName(key);
  const prov = assertHand(b.doc, { assertedAt: b.now, assertedBy: b.actor, supersedes: existing?.prov });
  b.doc = existing !== undefined ? archiveField(prov.doc, id, key, existing) : prov.doc;
  b.ops.push({ type: 'set_field', element: id, key, presence: 'set', prov: prov.id });
  return { presence: 'set', prov: prov.id, value };
}

export function addNode(b: Build, kind: Parameters<typeof formatNodeId>[0], fields: Record<string, FieldEntry['value']>): string {
  const existence = assertHand(b.doc, { assertedAt: b.now, assertedBy: b.actor });
  b.doc = existence.doc;
  const id = formatNodeId(kind, newUlid(b.now));
  const built: Record<string, FieldEntry> = {};
  b.ops.push({ type: 'add_node', node: id, prov: existence.id });
  for (const [key, value] of Object.entries(fields)) built[key] = entry(b, id, key, value);
  b.doc = withNode(b.doc, { id, existence: existence.id, fields: built });
  return id;
}

export function addEdge(
  b: Build,
  kind: Parameters<typeof formatEdgeId>[0],
  from: string,
  to: string,
  fields: Record<string, FieldEntry['value']> = {},
): string {
  const prov = assertHand(b.doc, { assertedAt: b.now, assertedBy: b.actor });
  b.doc = prov.doc;
  const id = formatEdgeId(kind, newUlid(b.now));
  b.ops.push({ type: 'add_edge', edge: id, from, to, prov: prov.id });
  const built: Record<string, FieldEntry> = {};
  for (const [key, value] of Object.entries(fields)) built[key] = entry(b, id, key, value);
  b.doc = withEdge(b.doc, { id, from, to, prov: prov.id, fields: built });
  return id;
}

export function setNodeField(b: Build, id: string, key: string, value: FieldEntry['value']): void {
  const node = b.doc.nodes.find((n) => n.id === id);
  if (!node) throw new UnknownReferenceError(id, parseNodeId(id).kind);
  const next = entry(b, id, key, value, node.fields[key]);
  b.doc = { ...b.doc, nodes: b.doc.nodes.map((n) => (n.id === id ? { ...n, fields: { ...n.fields, [key]: next } } : n)) };
}

export function tombstone(b: Build, nodeIds: Set<string>, edgeIds: Set<string>): void {
  b.doc = {
    ...b.doc,
    nodes: b.doc.nodes.map((n) => (nodeIds.has(n.id) ? { ...n, absentSince: b.now } : n)),
    edges: b.doc.edges.map((e) => (edgeIds.has(e.id) ? { ...e, absentSince: b.now } : e)),
  };
  for (const element of [...nodeIds, ...edgeIds]) b.ops.push({ type: 'tombstone', element, at: b.now, by: b.actor });
}

function int32(n: number): number {
  if (!Number.isInteger(n) || n < -(2 ** 31) || n > 2 ** 31 - 1) throw new RangeError(`i32: ${n} is out of range`);
  return n;
}

// ---------------------------------------------------------------------------
// Positions

/** Where `ownerId` is pinned, or `null`. */
export function pinOf(doc: Document, ownerId: string): { x: number; y: number } | null {
  const edge = edgesOut(doc, ownerId, 'HasLayoutPin')[0];
  const pin = edge ? findNode(doc, edge.to) : undefined;
  if (!pin) return null;
  const { x, y } = readLayoutPinFields(pin);
  return x === undefined || y === undefined ? null : { x, y };
}

function pinInto(b: Build, ownerId: string, x: number, y: number): void {
  const px = int32(snap(x));
  const py = int32(snap(y));
  const edge = edgesOut(b.doc, ownerId, 'HasLayoutPin')[0];
  const pin = edge ? findNode(b.doc, edge.to) : undefined;
  if (pin) {
    const at = readLayoutPinFields(pin);
    if (at.x !== px) setNodeField(b, pin.id, 'LayoutPin.x', px);
    if (at.y !== py) setNodeField(b, pin.id, 'LayoutPin.y', py);
    return;
  }
  const pinId = addNode(b, 'LayoutPin', { 'LayoutPin.x': px, 'LayoutPin.y': py });
  addEdge(b, 'HasLayoutPin', ownerId, pinId);
}

/** Moves every named box or label to its spot, one undo step. */
export function moveFree(doc: Document, moves: readonly { id: string; x: number; y: number }[], opts?: Actor): Document {
  const b = begin(doc, opts);
  for (const m of moves) {
    if (!findNode(b.doc, m.id)) throw new UnknownReferenceError(m.id, parseNodeId(m.id).kind);
    pinInto(b, m.id, m.x, m.y);
  }
  return finish(b, moves.length === 1 ? 'move' : 'move selection');
}

// ---------------------------------------------------------------------------
// Boxes

export interface CreateFreeBoxOptions extends Actor {
  role?: string;
  hostname?: string;
  x: number;
  y: number;
}

export interface CreateFreeBoxResult {
  doc: Document;
  chassisId: string;
  deviceId: string;
}

/** A sketch device pinned on the canvas, with no rack, shelf or wall. One undo step. */
export function createFreeBox(doc: Document, opts: CreateFreeBoxOptions): CreateFreeBoxResult {
  const before = new Set(doc.nodes.map((n) => n.id));
  const made = createSketchDevice(doc, opts.hostname !== undefined ? { actor: opts.actor, now: opts.now, hostname: opts.hostname } : opts);
  const fresh = made.nodes.filter((n) => !before.has(n.id));
  const chassis = fresh.find((n) => parseNodeId(n.id).kind === 'Chassis');
  const device = fresh.find((n) => parseNodeId(n.id).kind === 'Device');
  if (!chassis || !device) throw new Error('createSketchDevice made no chassis');
  let working = opts.role !== undefined ? setDeviceField(made, device.id, 'role', opts.role, opts) : made;
  const b = begin(working, opts);
  pinInto(b, chassis.id, opts.x, opts.y);
  working = finish(b, 'pin');
  return { doc: foldFrom(working, doc.batches.length), chassisId: chassis.id, deviceId: device.id };
}

/** Folds the batches added after `from` into one undo step. */
export function foldFrom(doc: Document, from: number): Document {
  const added = doc.batches.slice(from);
  if (added.length < 2) return doc;
  const merged = { ...added[0]!, ops: added.flatMap((x) => x.ops) };
  return { ...doc, batches: [...doc.batches.slice(0, from), merged] };
}

// ---------------------------------------------------------------------------
// Labels and areas

/** `note` (schema 0.19): a sticky note pinned to the canvas, for teammates and for later. */
export type LabelForm = 'text' | 'area' | 'note';

export interface CreateLabelOptions extends Actor {
  text: string;
  form: LabelForm;
  x: number;
  y: number;
  w?: number;
  h?: number;
}

export function createLabel(doc: Document, opts: CreateLabelOptions): { doc: Document; id: string } {
  const b = begin(doc, opts);
  const fields: Record<string, FieldEntry['value']> = { 'Label.text': text(opts.text), 'Label.form': token(opts.form) };
  if (opts.form === 'area') {
    fields['Label.w'] = uint(Math.max(AREA_MIN_W, Math.round(opts.w ?? AREA_DEFAULT_W)), 16);
    fields['Label.h'] = uint(Math.max(AREA_MIN_H, Math.round(opts.h ?? AREA_DEFAULT_H)), 16);
  }
  const id = addNode(b, 'Label', fields);
  pinInto(b, id, opts.x, opts.y);
  return { doc: finish(b, opts.form === 'area' ? 'add area' : opts.form === 'note' ? 'add note' : 'add label'), id };
}

export function setLabel(doc: Document, id: string, patch: { text?: string; w?: number; h?: number }, opts?: Actor): Document {
  const node = findNode(doc, id);
  if (!node || parseNodeId(id).kind !== 'Label') throw new UnknownReferenceError(id, 'Label');
  const b = begin(doc, opts);
  if (patch.text !== undefined) setNodeField(b, id, 'Label.text', text(patch.text));
  if (patch.w !== undefined) setNodeField(b, id, 'Label.w', uint(Math.max(AREA_MIN_W, Math.round(patch.w)), 16));
  if (patch.h !== undefined) setNodeField(b, id, 'Label.h', uint(Math.max(AREA_MIN_H, Math.round(patch.h)), 16));
  return finish(b, 'edit label');
}

// ---------------------------------------------------------------------------
// Lines

/** Joins two boxes. Refuses a box to itself and a pair already joined. */
export function createLine(doc: Document, aChassisId: string, bChassisId: string, opts?: Actor): { doc: Document; id: string } {
  for (const id of [aChassisId, bChassisId]) {
    const node = findNode(doc, id);
    if (!node || node.absentSince !== undefined || parseNodeId(id).kind !== 'Chassis') throw new UnknownReferenceError(id, 'Chassis');
  }
  if (aChassisId === bChassisId) throw new RangeError('a line needs two different boxes');
  if (linesBetween(doc, aChassisId, bChassisId).length > 0) throw new RangeError('those boxes are already joined');
  const b = begin(doc, opts);
  const id = addNode(b, 'Line', {});
  addEdge(b, 'LineEnd', id, aChassisId, { 'LineEnd.end': token('a') });
  addEdge(b, 'LineEnd', id, bChassisId, { 'LineEnd.end': token('b') });
  return { doc: finish(b, 'draw line'), id };
}

export function setLineLabel(doc: Document, lineId: string, label: string | null, opts?: Actor): Document {
  const node = findNode(doc, lineId);
  if (!node || parseNodeId(lineId).kind !== 'Line') throw new UnknownReferenceError(lineId, 'Line');
  const b = begin(doc, opts);
  if (label === null || label === '') {
    const existing = node.fields['Line.label'];
    if (existing === undefined) return doc;
    const prov = assertHand(b.doc, { assertedAt: b.now, assertedBy: b.actor, supersedes: existing.prov });
    b.doc = archiveField(prov.doc, lineId, 'Line.label', existing);
    const absent: FieldEntry = { presence: 'absent', prov: prov.id };
    b.doc = { ...b.doc, nodes: b.doc.nodes.map((n) => (n.id === lineId ? { ...n, fields: { ...n.fields, 'Line.label': absent } } : n)) };
    b.ops.push({ type: 'set_field', element: lineId, key: 'Line.label', presence: 'absent', prov: prov.id });
  } else {
    setNodeField(b, lineId, 'Line.label', text(label));
  }
  return finish(b, 'edit line');
}

/** The ids of the two boxes a line joins, in end order; `null` for an end that is gone. */
export function lineEnds(doc: Document, lineId: string): [string | null, string | null] {
  const ends: [string | null, string | null] = [null, null];
  for (const e of edgesOut(doc, lineId, 'LineEnd')) {
    const side = readLineEndSide(e);
    if (side === 'a') ends[0] = e.to;
    else if (side === 'b') ends[1] = e.to;
  }
  return ends;
}

export function linesBetween(doc: Document, a: string, b: string): string[] {
  return edgesIn(doc, a, 'LineEnd')
    .map((e) => e.from)
    .filter((lineId) => {
      const [x, y] = lineEnds(doc, lineId);
      return (x === a && y === b) || (x === b && y === a);
    });
}

// ---------------------------------------------------------------------------
// Removal

/** Removes boxes (with their device and everything it owns), labels, areas and lines in one
 * undo step. A line loses its ends with its box, so it goes too. */
export function removeFree(doc: Document, ids: readonly string[], opts?: Actor): Document {
  const b = begin(doc, opts);
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const add = (root: string): void => {
    const r = cascadeRemoval(b.doc, root);
    r.nodeIds.forEach((n) => nodeIds.add(n));
    r.edgeIds.forEach((e) => edgeIds.add(e));
  };
  for (const id of ids) {
    const node = findNode(doc, id);
    if (!node || node.absentSince !== undefined) continue;
    const kind = parseNodeId(id).kind;
    if (kind === 'Chassis') {
      const owner = edgesIn(doc, id, 'HasChassis')[0];
      if (!owner) throw new UnknownReferenceError(id, 'a chassis owned by a Device');
      add(owner.from);
    } else {
      add(id);
    }
  }
  // A removed box takes the lines on it.
  for (const n of [...nodeIds]) {
    if (parseNodeId(n).kind !== 'Chassis') continue;
    for (const e of edgesIn(b.doc, n, 'LineEnd')) add(e.from);
  }
  if (nodeIds.size === 0) return doc;
  tombstone(b, nodeIds, edgeIds);
  return finish(b, 'remove');
}

// ---------------------------------------------------------------------------
// Copy and paste

export interface CopiedBox {
  id: string;
  hostname: string | null;
  role: string | null;
  x: number;
  y: number;
  ports: { label: string; connector: string; face: 'front' | 'rear' }[];
}

export interface Clipboard {
  boxes: CopiedBox[];
  labels: { id: string; text: string; form: LabelForm; x: number; y: number; w?: number; h?: number }[];
  /** Pairs of copied box ids joined by a line, and the line's label. */
  lines: { a: string; b: string; label: string | null }[];
}

export function liveLabelNodes(doc: Document): GraphNode[] {
  return doc.nodes.filter((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Label');
}

export function liveLineNodes(doc: Document): GraphNode[] {
  return doc.nodes.filter((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Line');
}

export function labelView(doc: Document, node: GraphNode): { id: string; text: string; form: LabelForm; x: number; y: number; w: number; h: number } | null {
  const pin = pinOf(doc, node.id);
  const f = readLabelFields(node);
  if (!pin || f.text === undefined) return null;
  const form: LabelForm = f.form === 'area' ? 'area' : f.form === 'note' ? 'note' : 'text';
  return { id: node.id, text: f.text, form, x: pin.x, y: pin.y, w: f.w ?? AREA_DEFAULT_W, h: f.h ?? AREA_DEFAULT_H };
}

export function lineLabelOf(doc: Document, lineId: string): string | null {
  const node = findNode(doc, lineId);
  return (node && readLineLabel(node)) || null;
}
