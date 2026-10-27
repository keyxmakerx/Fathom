// The room builder's graph (ADR-0051 "Blueprints", ADR-0074 decision 4, schema 0.29). A floor's
// picture is a `FloorPlan` (its bytes stored sealed as a doc file is, scaled as micrometres per
// pixel); a room is a `Room` with its outline as `RoomCorner`s in millimetres, joined in `seq`
// order. All of it hangs off the design's `Premises`. Pure, `Origin::Hand`, one batch per call.

import { createPremises } from '../components/racks/emptyDesign';
import { FieldValueError } from './edit';
import {
  UnknownReferenceError,
  archiveField,
  assertHand,
  edgesOut,
  fieldValue,
  findNode,
  identifier,
  parseNodeId,
  replaceNode,
  text,
  uint,
  type Document,
  type GraphNode,
} from './model';
import { addEdge, addNode, begin, finish, setNodeField, tombstone } from './freeform';
import type { CanonValue } from './canon';

interface Actor {
  actor?: string;
  now?: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface FloorPlanView {
  id: string;
  floor: string;
  name: string | null;
  fileId: string | null;
  sha256: string | null;
  widthPx: number | null;
  heightPx: number | null;
  /** Micrometres per image pixel; `null` until two points are marked. */
  umPerPx: number | null;
}

export interface RoomView {
  id: string;
  label: string;
  floor: string | null;
  /** Corners in millimetres, in outline order. */
  corners: Point[];
}

const live = (doc: Document, id: string): GraphNode | undefined => {
  const n = findNode(doc, id);
  return n && n.absentSince === undefined ? n : undefined;
};

const str = (v: CanonValue | undefined): string | null => (typeof v === 'string' ? v : null);
const num = (v: CanonValue | undefined): number | null => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null);

/** The design's first live Premises, or `null` when it has none yet. */
export function premisesOf(doc: Document): string | null {
  return doc.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Premises')?.id ?? null;
}

function children(doc: Document, from: string, edge: 'HasFloorPlan' | 'HasRoom' | 'HasRoomCorner'): GraphNode[] {
  return edgesOut(doc, from, edge)
    .filter((e) => e.absentSince === undefined)
    .map((e) => live(doc, e.to))
    .filter((n): n is GraphNode => n !== undefined);
}

export function floorPlansOf(doc: Document): FloorPlanView[] {
  const premises = premisesOf(doc);
  if (!premises) return [];
  return children(doc, premises, 'HasFloorPlan')
    .map((n) => ({
      id: n.id,
      floor: str(fieldValue(n.fields, 'FloorPlan.floor')) ?? '',
      name: str(fieldValue(n.fields, 'FloorPlan.name')),
      fileId: str(fieldValue(n.fields, 'FloorPlan.file_id')),
      sha256: str(fieldValue(n.fields, 'FloorPlan.sha256')),
      widthPx: num(fieldValue(n.fields, 'FloorPlan.width_px')),
      heightPx: num(fieldValue(n.fields, 'FloorPlan.height_px')),
      umPerPx: num(fieldValue(n.fields, 'FloorPlan.um_per_px')),
    }))
    .sort((a, b) => a.floor.localeCompare(b.floor, undefined, { numeric: true }));
}

export function roomsOf(doc: Document): RoomView[] {
  const premises = premisesOf(doc);
  if (!premises) return [];
  return children(doc, premises, 'HasRoom')
    .map((n) => ({
      id: n.id,
      label: str(fieldValue(n.fields, 'Room.label')) ?? '',
      floor: str(fieldValue(n.fields, 'Room.floor')),
      corners: children(doc, n.id, 'HasRoomCorner')
        .map((c) => ({
          seq: num(fieldValue(c.fields, 'RoomCorner.seq')) ?? 0,
          x: num(fieldValue(c.fields, 'RoomCorner.x_mm')) ?? 0,
          y: num(fieldValue(c.fields, 'RoomCorner.y_mm')) ?? 0,
        }))
        .sort((a, b) => a.seq - b.seq)
        .map(({ x, y }) => ({ x, y })),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

/** Micrometres per pixel from two points `px` apart that are `mm` millimetres apart on the ground. */
export function scaleFromPoints(a: Point, b: Point, mm: number): number {
  const px = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(px > 0) || !(mm > 0)) throw new FieldValueError('FloorPlan.um_per_px', String(mm), 'mark two different points and a distance above zero');
  const um = Math.round((mm * 1000) / px);
  if (um < 1 || um > 0xffffffff) throw new FieldValueError('FloorPlan.um_per_px', String(mm), 'that scale is out of range');
  return um;
}

/** The room's area in square metres (shoelace), for the room list. */
export function areaM2(corners: readonly Point[]): number {
  let twice = 0;
  for (let i = 0; i < corners.length; i += 1) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2 / 1_000_000;
}

const int32 = (n: number): number => {
  if (!Number.isInteger(n) || n < -(2 ** 31) || n > 2 ** 31 - 1) throw new FieldValueError('RoomCorner.x_mm', String(n), 'is out of range');
  return n;
};

function ensurePremises(doc: Document, opts: Actor | undefined): { doc: Document; premisesId: string } {
  const have = premisesOf(doc);
  return have ? { doc, premisesId: have } : createPremises(doc, opts);
}

export interface FloorPlanImage {
  name: string;
  fileId: string;
  sha256: string;
  widthPx: number;
  heightPx: number;
}

/** Puts `image` behind `floor`, replacing the picture a plan for that floor already had. Its scale
 * is cleared with it: a new picture has its own pixels. */
export function setFloorPlanImage(doc: Document, floor: string, image: FloorPlanImage, opts?: Actor): Document {
  const f = floor.trim();
  if (!f) throw new FieldValueError('FloorPlan.floor', floor, 'a floor needs a name, such as Ground or 2');
  const ensured = ensurePremises(doc, opts);
  const b = begin(ensured.doc, opts);
  const fields: Record<string, CanonValue> = {
    'FloorPlan.name': text(image.name),
    'FloorPlan.file_id': identifier(image.fileId),
    'FloorPlan.sha256': text(image.sha256),
    'FloorPlan.width_px': uint(image.widthPx, 32),
    'FloorPlan.height_px': uint(image.heightPx, 32),
  };
  const existing = floorPlansOf(ensured.doc).find((p) => p.floor === f);
  if (existing) {
    for (const [k, v] of Object.entries(fields)) setNodeField(b, existing.id, k, v);
    if (existing.umPerPx !== null) clearField(b, existing.id, 'FloorPlan.um_per_px');
  } else {
    const id = addNode(b, 'FloorPlan', { 'FloorPlan.floor': text(f), ...fields });
    addEdge(b, 'HasFloorPlan', ensured.premisesId, id);
  }
  return finish(b, `floor plan for ${f}`);
}

function clearField(b: ReturnType<typeof begin>, id: string, key: string): void {
  // An absent entry superseding the set one, the shape `cards.ts`'s `setField(…, undefined)` writes.
  const existing = b.doc.nodes.find((n) => n.id === id)?.fields[key];
  const prov = assertHand(b.doc, { assertedAt: b.now, assertedBy: b.actor, supersedes: existing?.prov });
  b.doc = existing !== undefined ? archiveField(prov.doc, id, key, existing) : prov.doc;
  b.doc = replaceNode(b.doc, id, (n) => ({ ...n, fields: { ...n.fields, [key]: { presence: 'absent', prov: prov.id } } }));
  b.ops.push({ type: 'set_field', element: id, key, presence: 'absent', prov: prov.id });
}

export function setFloorPlanScale(doc: Document, planId: string, umPerPx: number, opts?: Actor): Document {
  if (!live(doc, planId) || parseNodeId(planId).kind !== 'FloorPlan') throw new UnknownReferenceError(planId, 'FloorPlan');
  const b = begin(doc, opts);
  setNodeField(b, planId, 'FloorPlan.um_per_px', uint(umPerPx, 32));
  return finish(b, 'scale floor plan');
}

/** A room needs a name and at least three corners that enclose something. */
function checkRoom(label: string, corners: readonly Point[]): string {
  const l = label.trim();
  if (!l) throw new FieldValueError('Room.label', label, 'a room needs a name or number');
  if (corners.length < 3 || areaM2(corners) <= 0) throw new FieldValueError('Room.label', l, 'a room needs at least three corners around some floor');
  if (corners.length > 512) throw new FieldValueError('Room.label', l, 'a room has at most 512 corners');
  return l;
}

export function addRoom(doc: Document, room: { label: string; floor?: string | null; corners: readonly Point[] }, opts?: Actor): { doc: Document; roomId: string } {
  const label = checkRoom(room.label, room.corners);
  const ensured = ensurePremises(doc, opts);
  const b = begin(ensured.doc, opts);
  const fields: Record<string, CanonValue> = { 'Room.label': text(label) };
  if (room.floor?.trim()) fields['Room.floor'] = text(room.floor.trim());
  const roomId = addNode(b, 'Room', fields);
  addEdge(b, 'HasRoom', ensured.premisesId, roomId);
  room.corners.forEach((c, seq) => {
    const id = addNode(b, 'RoomCorner', {
      'RoomCorner.x_mm': int32(Math.round(c.x)),
      'RoomCorner.y_mm': int32(Math.round(c.y)),
      'RoomCorner.seq': uint(seq, 16),
    });
    addEdge(b, 'HasRoomCorner', roomId, id);
  });
  return { doc: finish(b, `add room ${label}`), roomId };
}

export function renameRoom(doc: Document, roomId: string, label: string, opts?: Actor): Document {
  if (!live(doc, roomId) || parseNodeId(roomId).kind !== 'Room') throw new UnknownReferenceError(roomId, 'Room');
  const l = label.trim();
  if (!l) throw new FieldValueError('Room.label', label, 'a room needs a name or number');
  const b = begin(doc, opts);
  setNodeField(b, roomId, 'Room.label', text(l));
  return finish(b, `rename room ${l}`);
}

/** Takes a room out: the room, its corners and the edges that held them. */
export function removeRoom(doc: Document, roomId: string, opts?: Actor): Document {
  if (!live(doc, roomId) || parseNodeId(roomId).kind !== 'Room') throw new UnknownReferenceError(roomId, 'Room');
  const nodes = new Set<string>([roomId]);
  const edges = new Set<string>();
  for (const e of doc.edges) {
    if (e.absentSince !== undefined) continue;
    if (e.to === roomId && parseNodeId(e.from).kind === 'Premises') edges.add(e.id);
    if (e.from === roomId) {
      edges.add(e.id);
      if (live(doc, e.to)) nodes.add(e.to);
    }
  }
  const b = begin(doc, opts);
  tombstone(b, nodes, edges);
  return finish(b, 'remove room');
}
