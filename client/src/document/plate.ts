// Where hand-typed ports sit on their faceplate (schema 0.19, `PhysicalPort.plate_x`/`plate_y`),
// and adding a saved set of ports to a box. Pure, one batch each, so one undo step each.
// Catalogue ports are never moved: a chassis with a model refuses, as `addSketchPort` does.

import { DuplicatePortLabelError, PortRangeTooLargeError, SketchOnCatalogueChassisError } from './commands';
import { PORT_CONNECTOR_VALUES, PORT_SERVICE_VALUES, type PortFace } from './compat';
import { FieldValueError } from './edit';
import { addEdge, addNode, begin, finish, setNodeField, type Build } from './freeform';
import {
  UnknownReferenceError,
  archiveField,
  assertHand,
  edgesOut,
  findNode,
  parseNodeId,
  readChassisFields,
  readPhysicalPortFields,
  text,
  token,
  uint,
  type Document,
  type FieldEntry,
  type GraphNode,
} from './model';

interface Actor {
  actor?: string;
  now?: number;
}

/** A plate coordinate runs 0..PLATE_SPAN: thousandths of the plate's width or height. */
export const PLATE_SPAN = 1000;

const MAX_PORTS_PER_BATCH = 256;

export interface PortPlace {
  portId: string;
  /** Thousandths of the plate's width and height, to the port's centre. */
  x: number;
  y: number;
}

/** One port as a template carries it: what it is and, if it was dragged, where it sat. */
export interface TemplatePort {
  label: string;
  connector: string;
  service?: string;
  face: PortFace;
  plate?: { x: number; y: number };
}

export function clampPlate(n: number): number {
  return Math.max(0, Math.min(PLATE_SPAN, Math.round(n)));
}

function requireSketchChassis(doc: Document, chassisId: string): GraphNode {
  const node = findNode(doc, chassisId);
  if (!node || node.absentSince !== undefined || parseNodeId(chassisId).kind !== 'Chassis') throw new UnknownReferenceError(chassisId, 'Chassis');
  if (readChassisFields(node).model !== undefined) throw new SketchOnCatalogueChassisError(chassisId);
  return node;
}

function livePortIds(doc: Document, chassisId: string): Set<string> {
  return new Set(
    edgesOut(doc, chassisId, 'HasPort')
      .filter((e) => {
        const n = findNode(doc, e.to);
        return n !== undefined && n.absentSince === undefined;
      })
      .map((e) => e.to),
  );
}

/** Moves hand-typed ports to new spots on their plate, one undo step. A port already there is skipped. */
export function placePorts(doc: Document, chassisId: string, places: readonly PortPlace[], opts?: Actor): Document {
  requireSketchChassis(doc, chassisId);
  const mine = livePortIds(doc, chassisId);
  const b = begin(doc, opts);
  for (const p of places) {
    if (!mine.has(p.portId)) throw new UnknownReferenceError(p.portId, 'a port on this box');
    const at = readPhysicalPortFields(findNode(b.doc, p.portId)!);
    const x = clampPlate(p.x);
    const y = clampPlate(p.y);
    if (at.plateX !== x) setNodeField(b, p.portId, 'PhysicalPort.plate_x', uint(x, 16));
    if (at.plateY !== y) setNodeField(b, p.portId, 'PhysicalPort.plate_y', uint(y, 16));
  }
  return finish(b, places.length === 1 ? 'move port' : 'move ports');
}

function clearField(b: Build, id: string, key: string): void {
  const node = findNode(b.doc, id);
  const existing = node?.fields[key];
  if (existing === undefined || existing.presence !== 'set') return;
  const prov = assertHand(b.doc, { assertedAt: b.now, assertedBy: b.actor, supersedes: existing.prov });
  b.doc = archiveField(prov.doc, id, key, existing);
  const absent: FieldEntry = { presence: 'absent', prov: prov.id };
  b.doc = { ...b.doc, nodes: b.doc.nodes.map((n) => (n.id === id ? { ...n, fields: { ...n.fields, [key]: absent } } : n)) };
  b.ops.push({ type: 'set_field', element: id, key, presence: 'absent', prov: prov.id });
}

/** Puts every dragged port on this box back in the computed layout, one undo step. */
export function resetPortPlaces(doc: Document, chassisId: string, opts?: Actor): Document {
  requireSketchChassis(doc, chassisId);
  const b = begin(doc, opts);
  for (const portId of livePortIds(doc, chassisId)) {
    clearField(b, portId, 'PhysicalPort.plate_x');
    clearField(b, portId, 'PhysicalPort.plate_y');
  }
  return finish(b, 'reset port layout');
}

/** Adds a template's ports to a hand-typed box in one batch (one undo step). Refuses, writing
 * nothing, on a catalogue box, an unknown connector or service, a label the box already has, or
 * more than 256 ports. */
export function addTemplatePorts(doc: Document, chassisId: string, ports: readonly TemplatePort[], opts?: Actor): Document {
  requireSketchChassis(doc, chassisId);
  if (ports.length > MAX_PORTS_PER_BATCH) throw new PortRangeTooLargeError(ports.length);
  const taken = new Set(
    [...livePortIds(doc, chassisId)].map((id) => readPhysicalPortFields(findNode(doc, id)!).label).filter((l): l is string => l !== undefined),
  );
  for (const p of ports) {
    if (!(PORT_CONNECTOR_VALUES as readonly string[]).includes(p.connector)) {
      throw new FieldValueError('PhysicalPort.connector', p.connector, `is not one of: ${PORT_CONNECTOR_VALUES.join(', ')}`);
    }
    if (p.service !== undefined && !(PORT_SERVICE_VALUES as readonly string[]).includes(p.service)) {
      throw new FieldValueError('PhysicalPort.service', p.service, `is not one of: ${PORT_SERVICE_VALUES.join(', ')}`);
    }
    if (taken.has(p.label)) throw new DuplicatePortLabelError(p.label);
    taken.add(p.label);
  }
  const b = begin(doc, opts);
  for (const p of ports) {
    const fields: Record<string, FieldEntry['value']> = {
      'PhysicalPort.label': text(p.label),
      'PhysicalPort.connector': token(p.connector),
      'PhysicalPort.face': token(p.face),
    };
    if (p.service !== undefined) fields['PhysicalPort.service'] = token(p.service);
    if (p.plate !== undefined) {
      fields['PhysicalPort.plate_x'] = uint(clampPlate(p.plate.x), 16);
      fields['PhysicalPort.plate_y'] = uint(clampPlate(p.plate.y), 16);
    }
    const portId = addNode(b, 'PhysicalPort', fields);
    addEdge(b, 'HasPort', chassisId, portId);
  }
  return finish(b, ports.length === 1 ? 'add port' : `add ${ports.length} ports`);
}
