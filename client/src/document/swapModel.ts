// Swapping a device's model and keeping its ports (sign-off r28-swap). The device stays: its
// name, addresses, notes, photo, firmware and history. Only the box changes. A port the new
// model has under the same name keeps its node, so its cable, interface tie and notes carry
// over untouched; a port it lacks goes, and its cable stays as a loose end for Missing links.
// A kept port that changed name (see `match`) takes the new label. One batch, so one undo
// restores the old box exactly.

import type { CatalogueModel, CataloguePort } from '../api/catalogue';
import { connectorTokenOf, type PortFace } from './compat';
import { addEdge, addNode, begin, finish, setNodeField, tombstone, type Build } from './freeform';
import {
  UnknownReferenceError,
  archiveField,
  assertHand,
  edgesIn,
  edgesOut,
  findNode,
  identifier,
  parseEdgeId,
  parseNodeId,
  readChassisFields,
  readMountedInFields,
  readPhysicalPortFields,
  readPowerSupplyFields,
  readRackFields,
  text,
  token,
  uint,
  type Document,
  type FieldEntry,
  type GraphEdge,
  type PhysicalPortFields,
} from './model';

interface Actor {
  actor?: string;
  now?: number;
}

/** One port slot the new model has, chassis-hosted (a faceplate port or a fixed inlet). */
interface Slot {
  label: string;
  face: PortFace;
  connector: string;
  service?: string;
  /** A plain numbered data port, the only kind the by-kind pass pairs onto (never a console). */
  numbered?: boolean;
}

export interface KeptPort {
  portId: string;
  label: string;
  /** The new model's name for it, when that differs (paired by kind, not name). */
  newLabel: string | null;
  cabled: boolean;
  /** The new model's connector differs: the cable stays, Checks may flag it. */
  connectorChanged: boolean;
}

export interface DroppedPort {
  portId: string;
  label: string;
  /** The cable left with a loose end, when one was plugged in. */
  cableId: string | null;
}

export interface SwapPlan {
  fromModel: string;
  toModel: string;
  kept: KeptPort[];
  /** Labels the new model adds. */
  added: string[];
  dropped: DroppedPort[];
  /** The serial the swap clears, when one was recorded. */
  serial: string | null;
  /** Rack units before and after, when the box sits in a rack and its height changes. */
  height: { from: number; to: number } | null;
}

/** The new box does not fit where the old one sat. */
export class SwapDoesNotFitError extends Error {
  constructor(model: string, positionU: number, heightU: number) {
    super(`${model} is ${heightU}U and does not fit from U${positionU}: move it or free the units above first.`);
    this.name = 'SwapDoesNotFitError';
  }
}

const norm = (s: string | undefined): string => (s ?? '').trim().toLowerCase();

function catalogueLabel(port: CataloguePort): string {
  return port.name ?? String(port.number);
}

function slotsOf(model: CatalogueModel): Slot[] {
  const slots: Slot[] = [];
  for (const plate of model.faceplates) {
    for (const port of plate.ports) {
      const numbered = port.name == null && port.role !== 'console' && port.role !== 'management';
      slots.push({ label: catalogueLabel(port), face: plate.face, connector: connectorTokenOf(port.kind), numbered });
    }
  }
  for (const psu of model.psuSlots) {
    if (!psu.hotSwap) slots.push({ label: psu.name, face: psu.face, connector: 'c14', service: 'power' });
  }
  return slots;
}

function liveTo(doc: Document, edges: GraphEdge[]): string[] {
  return edges.map((e) => e.to).filter((id) => findNode(doc, id)?.absentSince === undefined);
}

function cableOn(doc: Document, portId: string): string | null {
  return edgesIn(doc, portId, 'Terminates')[0]?.from ?? null;
}

interface Matching {
  kept: { portId: string; slot: Slot }[];
  added: Slot[];
  dropped: string[];
  supplies: { kept: string[]; added: CatalogueModel['psuSlots']; dropped: string[] };
}

/** Ports pair, each once, in four passes: same name and connector on the same face; then on
 * any face; then a numbered port left over onto the new model's next free numbered port of the
 * same connector and face, in label order (a 24-port switch's SFP+ uplinks land on a 48-port
 * switch's SFP+ cages whatever they are numbered); then same name whatever the connector. */
function match(doc: Document, chassisId: string, model: CatalogueModel, oldModel: CatalogueModel | undefined): Matching {
  const portIds = liveTo(doc, edgesOut(doc, chassisId, 'HasPort'));
  const fields = new Map(portIds.map((id) => [id, readPhysicalPortFields(findNode(doc, id)!)]));
  const slots = slotsOf(model);
  const free = new Set(slots.map((_, i) => i));
  const pairs = new Map<string, number>();
  const natural = (a: string, z: string) => a.localeCompare(z, undefined, { numeric: true });
  const pass = (ids: string[], fits: (f: PhysicalPortFields, slot: Slot) => boolean) => {
    for (const id of ids) {
      if (pairs.has(id)) continue;
      const f = fields.get(id)!;
      const hit = [...free].filter((i) => fits(f, slots[i]!)).sort((a, z) => natural(slots[a]!.label, slots[z]!.label))[0];
      if (hit === undefined) continue;
      pairs.set(id, hit);
      free.delete(hit);
    }
  };
  const sameName = (f: PhysicalPortFields, slot: Slot) => norm(f.label) !== '' && norm(f.label) === norm(slot.label);
  const sameFace = (f: PhysicalPortFields, slot: Slot) => slot.face === (f.face ?? 'front');
  const sameConnector = (f: PhysicalPortFields, slot: Slot) => slot.connector === f.connector;
  pass(portIds, (f, slot) => sameName(f, slot) && sameConnector(f, slot) && sameFace(f, slot));
  pass(portIds, (f, slot) => sameName(f, slot) && sameConnector(f, slot));
  const numbered = portIds
    .filter((id) => fields.get(id)!.service !== 'power' && /^\d+$/.test((fields.get(id)!.label ?? '').trim()))
    .sort((a, z) => natural(fields.get(a)!.label ?? '', fields.get(z)!.label ?? ''));
  pass(numbered, (f, slot) => slot.numbered === true && sameConnector(f, slot) && sameFace(f, slot));
  pass(portIds, (f, slot) => sameName(f, slot) && sameFace(f, slot));
  pass(portIds, sameName);

  const supplyIds = liveTo(doc, edgesOut(doc, chassisId, 'FittedIn'));
  const hotSlots = model.psuSlots.filter((s) => s.hotSwap);
  const supplyKept: string[] = [];
  const supplyDropped: string[] = [];
  const taken = new Set<string>();
  for (const id of supplyIds) {
    const slot = norm(readPowerSupplyFields(findNode(doc, id)!).slot);
    if (hotSlots.some((s) => norm(s.name) === slot) && !taken.has(slot)) {
      supplyKept.push(id);
      taken.add(slot);
    } else {
      supplyDropped.push(id);
    }
  }
  // A slot the old model already had and someone left empty stays empty.
  const wasEmpty = new Set((oldModel?.psuSlots ?? []).filter((s) => s.hotSwap).map((s) => norm(s.name)));
  const supplyAdded = hotSlots.filter((s) => !taken.has(norm(s.name)) && !wasEmpty.has(norm(s.name)));

  return {
    kept: [...pairs].map(([portId, i]) => ({ portId, slot: slots[i]! })),
    added: slots.filter((_, i) => free.has(i)),
    dropped: portIds.filter((id) => !pairs.has(id)),
    supplies: { kept: supplyKept, added: supplyAdded, dropped: supplyDropped },
  };
}

function requireChassis(doc: Document, chassisId: string) {
  const node = findNode(doc, chassisId);
  if (!node || node.absentSince !== undefined || parseNodeId(chassisId).kind !== 'Chassis') throw new UnknownReferenceError(chassisId, 'Chassis');
  return node;
}

function rackFit(doc: Document, chassisId: string, heightU: number): { mounted: GraphEdge; from: number } | null {
  const mounted = edgesOut(doc, chassisId, 'MountedIn')[0];
  if (!mounted) return null;
  const f = readMountedInFields(mounted);
  const from = f.heightU ?? 1;
  if (from === heightU) return null;
  return { mounted, from };
}

function inletsOf(doc: Document, supplyId: string): string[] {
  return liveTo(doc, edgesOut(doc, supplyId, 'HasPort'));
}

/** What a swap would do, for the panel to show before anyone confirms. Writes nothing. */
export function planModelSwap(doc: Document, chassisId: string, model: CatalogueModel, catalogue: readonly CatalogueModel[] = []): SwapPlan {
  const node = requireChassis(doc, chassisId);
  const fromModel = readChassisFields(node).model ?? '';
  const m = match(doc, chassisId, model, catalogue.find((c) => c.model === fromModel));
  const label = (id: string) => readPhysicalPortFields(findNode(doc, id)!).label ?? '';
  const droppedPorts = [...m.dropped, ...m.supplies.dropped.flatMap((s) => inletsOf(doc, s))];
  const fit = rackFit(doc, chassisId, model.rackUnits);
  const byLabel = <T extends { label: string }>(a: T, z: T) => a.label.localeCompare(z.label, undefined, { numeric: true });
  return {
    fromModel,
    toModel: model.model,
    kept: m.kept.map(({ portId, slot }) => ({
      portId,
      label: label(portId),
      newLabel: slot.label !== label(portId) ? slot.label : null,
      cabled: cableOn(doc, portId) !== null,
      connectorChanged: (readPhysicalPortFields(findNode(doc, portId)!).connector ?? '') !== slot.connector,
    })).sort(byLabel),
    added: [...m.added.map((s) => s.label), ...m.supplies.added.map((s) => s.name)],
    dropped: droppedPorts.map((portId) => ({ portId, label: label(portId), cableId: cableOn(doc, portId) })).sort(byLabel),
    serial: readChassisFields(node).serial ?? null,
    height: fit ? { from: fit.from, to: model.rackUnits } : null,
  };
}

/** `planModelSwap` for a model named by vendor and model, `null` when the catalogue lacks it or
 * the chassis is gone: the editor's preview, never a refusal. */
export function previewSwapIn(doc: Document, catalogue: readonly CatalogueModel[], chassisId: string, pick: { vendor: string; model: string }): SwapPlan | null {
  const model = catalogue.find((m) => m.vendor === pick.vendor && m.model === pick.model);
  if (!model) return null;
  try {
    return planModelSwap(doc, chassisId, model, catalogue);
  } catch {
    return null;
  }
}

function clearNodeField(b: Build, id: string, key: string): void {
  const existing = findNode(b.doc, id)?.fields[key];
  if (existing === undefined || existing.presence !== 'set') return;
  const prov = assertHand(b.doc, { assertedAt: b.now, assertedBy: b.actor, supersedes: existing.prov });
  b.doc = archiveField(prov.doc, id, key, existing);
  const absent: FieldEntry = { presence: 'absent', prov: prov.id };
  b.doc = { ...b.doc, nodes: b.doc.nodes.map((n) => (n.id === id ? { ...n, fields: { ...n.fields, [key]: absent } } : n)) };
  b.ops.push({ type: 'set_field', element: id, key, presence: 'absent', prov: prov.id });
}

function setEdgeField(b: Build, edge: GraphEdge, key: string, value: FieldEntry['value']): void {
  const existing = edge.fields[key];
  const prov = assertHand(b.doc, { assertedAt: b.now, assertedBy: b.actor, supersedes: existing?.prov });
  b.doc = existing !== undefined ? archiveField(prov.doc, edge.id, key, existing) : prov.doc;
  const entry: FieldEntry = { presence: 'set', prov: prov.id, value };
  b.doc = { ...b.doc, edges: b.doc.edges.map((e) => (e.id === edge.id ? { ...e, fields: { ...e.fields, [key]: entry } } : e)) };
  b.ops.push({ type: 'set_field', element: edge.id, key, presence: 'set', prov: prov.id });
}

/** Every live edge touching `portId`, and any cable left with no end at all. */
function portRemoval(doc: Document, portId: string, nodeIds: Set<string>, edgeIds: Set<string>): void {
  nodeIds.add(portId);
  for (const e of doc.edges) {
    if (e.absentSince === undefined && (e.from === portId || e.to === portId)) edgeIds.add(e.id);
  }
}

function addPort(b: Build, hostId: string, slot: Slot): string {
  const fields: Record<string, FieldEntry['value']> = {
    'PhysicalPort.label': text(slot.label),
    'PhysicalPort.connector': token(slot.connector),
    ...(slot.service !== undefined ? { 'PhysicalPort.service': token(slot.service) } : {}),
    'PhysicalPort.face': token(slot.face),
  };
  const portId = addNode(b, 'PhysicalPort', fields);
  addEdge(b, 'HasPort', hostId, portId);
  return portId;
}

/**
 * Gives a chassis a new catalogue model and keeps every port the new model has under the same
 * name (see `match`). A kept port takes the new model's connector and face and drops a
 * hand-dragged plate spot; everything attached to it stays. The serial is cleared: a different
 * model is a different box. In a rack the box keeps its bottom unit; if the new height will not
 * fit there it refuses with `SwapDoesNotFitError` and writes nothing.
 */
export function swapModel(doc: Document, chassisId: string, model: CatalogueModel, opts: Actor & { catalogue?: readonly CatalogueModel[] } = {}): Document {
  const node = requireChassis(doc, chassisId);
  const fields = readChassisFields(node);
  const m = match(doc, chassisId, model, opts.catalogue?.find((c) => c.model === fields.model));

  const fit = rackFit(doc, chassisId, model.rackUnits);
  if (fit) {
    const mf = readMountedInFields(fit.mounted);
    const position = mf.positionU ?? 1;
    const top = position + model.rackUnits - 1;
    const rack = findNode(doc, fit.mounted.to);
    const rackHeight = rack ? readRackFields(rack).heightU : undefined;
    const clash = edgesIn(doc, fit.mounted.to, 'MountedIn').some((e) => {
      if (e.from === chassisId) return false;
      const o = readMountedInFields(e);
      const lo = o.positionU ?? 1;
      const hi = lo + (o.heightU ?? 1) - 1;
      return position <= hi && lo <= top;
    });
    if (clash || (rackHeight !== undefined && top > rackHeight)) throw new SwapDoesNotFitError(model.model, position, model.rackUnits);
  }

  const b = begin(doc, opts);
  setNodeField(b, chassisId, 'Chassis.model', identifier(model.model));
  clearNodeField(b, chassisId, 'Chassis.serial');
  if (fit) setEdgeField(b, fit.mounted, 'MountedIn.height_u', uint(model.rackUnits, 8));

  for (const { portId, slot } of m.kept) {
    const f = readPhysicalPortFields(findNode(b.doc, portId)!);
    if (f.connector !== slot.connector) setNodeField(b, portId, 'PhysicalPort.connector', token(slot.connector));
    if (f.face !== slot.face) setNodeField(b, portId, 'PhysicalPort.face', token(slot.face));
    if (f.label !== slot.label) setNodeField(b, portId, 'PhysicalPort.label', text(slot.label));
    clearNodeField(b, portId, 'PhysicalPort.plate_x');
    clearNodeField(b, portId, 'PhysicalPort.plate_y');
  }

  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const portId of m.dropped) portRemoval(b.doc, portId, nodeIds, edgeIds);
  for (const supplyId of m.supplies.dropped) {
    nodeIds.add(supplyId);
    for (const e of b.doc.edges) {
      if (e.absentSince === undefined && (e.from === supplyId || e.to === supplyId)) edgeIds.add(e.id);
    }
    for (const inlet of inletsOf(b.doc, supplyId)) portRemoval(b.doc, inlet, nodeIds, edgeIds);
  }
  // A cable whose ends were all on dropped ports would have none left: it goes too.
  const cables = new Set(b.doc.edges.filter((e) => edgeIds.has(e.id) && parseEdgeId(e.id).kind === 'Terminates').map((e) => e.from));
  for (const cableId of cables) {
    const ends = edgesOut(b.doc, cableId, 'Terminates');
    if (ends.every((e) => edgeIds.has(e.id))) {
      nodeIds.add(cableId);
      for (const e of b.doc.edges) {
        if (e.absentSince === undefined && (e.from === cableId || e.to === cableId)) edgeIds.add(e.id);
      }
    }
  }
  tombstone(b, nodeIds, edgeIds);

  const added = new Map<Slot, string>();
  for (const slot of m.added) added.set(slot, addPort(b, chassisId, slot));
  for (const psu of m.supplies.added) {
    const supplyId = addNode(b, 'PowerSupply', { 'PowerSupply.slot': text(psu.name) });
    addEdge(b, 'FittedIn', chassisId, supplyId);
    addPort(b, supplyId, { label: psu.name, face: psu.face, connector: 'c14', service: 'power' });
  }
  for (const supplyId of m.supplies.kept) {
    const psu = model.psuSlots.find((s) => norm(s.name) === norm(readPowerSupplyFields(findNode(b.doc, supplyId)!).slot));
    for (const inlet of inletsOf(b.doc, supplyId)) {
      if (psu && readPhysicalPortFields(findNode(b.doc, inlet)!).face !== psu.face) setNodeField(b, inlet, 'PhysicalPort.face', token(psu.face));
    }
  }

  // An outlet or panel pairs front-i to rear-i, the same hole; pair any new port that lacks one.
  const form = (model as CatalogueModel & { form?: string }).form;
  if (form === 'outlet' || form === 'panel') {
    const byFace = (face: PortFace) =>
      model.faceplates
        .filter((p) => p.face === face)
        .flatMap((p) => p.ports)
        .map((port) => {
          const label = norm(catalogueLabel(port));
          const kept = m.kept.find((k) => k.slot.face === face && norm(k.slot.label) === label);
          if (kept) return kept.portId;
          for (const [slot, id] of added) if (slot.face === face && norm(slot.label) === label) return id;
          return undefined;
        });
    const front = byFace('front');
    const rear = byFace('rear');
    for (let i = 0; i < Math.min(front.length, rear.length); i += 1) {
      const a = front[i];
      const z = rear[i];
      if (a === undefined || z === undefined) continue;
      const paired = edgesOut(b.doc, a, 'PassThrough').some((e) => e.to === z) || edgesOut(b.doc, z, 'PassThrough').some((e) => e.to === a);
      if (!paired) addEdge(b, 'PassThrough', a, z);
    }
  }

  return finish(b, 'swap model');
}
