// Cards and optics (ADR-0073, schema 0.28). A `Card` sits in a named slot of a
// chassis or of another card (`HasCard`); its ports stay owned by the chassis
// (`HasPort`) and point at the card (`OnCard`), so everything that walks a port
// up to its device is unchanged. An optic is a detail of its port:
// `PhysicalPort.transceiver`, set (fitted, `{}` when nothing more is known),
// absent (looked, the cage is empty) or unknown (nobody looked).
//
// Same shape as `supplies.ts`: pure, `Origin::Hand`, one `Batch` per call.

import { PORT_CONNECTOR_VALUES, type PortFace } from './compat';
import { UnknownReferenceError } from './commands';
import { FieldValueError } from './edit';
import {
  LOCAL_ACTOR,
  archiveField,
  assertHand,
  edgesIn,
  edgesOut,
  fieldValue,
  findNode,
  formatEdgeId,
  formatNodeId,
  identifier,
  parseNodeId,
  readPhysicalPortFields,
  replaceNode,
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
import type { CanonValue } from './canon';

interface Actor {
  actor?: string;
  now?: number;
}

function resolve(opts: Actor | undefined): { actor: string; now: number } {
  return { actor: opts?.actor ?? LOCAL_ACTOR, now: opts?.now ?? Date.now() };
}

function setField(
  working: Document,
  now: number,
  actor: string,
  elementId: string,
  existing: FieldEntry | undefined,
  key: string,
  value: CanonValue | undefined,
): { doc: Document; entry: FieldEntry; op: Op } {
  requireFieldName(key);
  const prov = assertHand(working, { assertedAt: now, assertedBy: actor, supersedes: existing?.prov });
  const archived = existing !== undefined ? archiveField(prov.doc, elementId, key, existing) : prov.doc;
  const entry: FieldEntry =
    value === undefined ? { presence: 'absent', prov: prov.id } : { presence: 'set', prov: prov.id, value };
  return {
    doc: archived,
    entry,
    op: { type: 'set_field', element: elementId, key, presence: value === undefined ? 'absent' : 'set', prov: prov.id },
  };
}

function identifierOrRefuse(field: string, value: string): CanonValue {
  try {
    return identifier(value);
  } catch (e) {
    throw new FieldValueError(field, value, e instanceof Error ? e.message : 'is not a valid identifier');
  }
}

const live = (doc: Document, id: string): GraphNode | undefined => {
  const n = findNode(doc, id);
  return n && n.absentSince === undefined ? n : undefined;
};

function requireLive(doc: Document, id: string, kinds: readonly string[]): GraphNode {
  const node = live(doc, id);
  if (!node || !kinds.includes(parseNodeId(id).kind)) throw new UnknownReferenceError(id, kinds.join(' or '));
  return node;
}

export class SlotTakenByCardError extends Error {
  readonly hostId: string;
  readonly slot: string;
  constructor(hostId: string, slot: string) {
    super(`slot "${slot}" already holds a card`);
    this.name = 'SlotTakenByCardError';
    this.hostId = hostId;
    this.slot = slot;
  }
}

export class CageTakenError extends Error {
  readonly portId: string;
  constructor(portId: string) {
    super('that cage already holds an optic');
    this.name = 'CageTakenError';
    this.portId = portId;
  }
}

// ---------------------------------------------------------------------------
// Reading

export interface CardView {
  id: string;
  slot: string;
  name: string | null;
  model: string | null;
  serial: string | null;
  /** Ports on this card's faceplate (`OnCard`), in label order. */
  portIds: string[];
  /** Cards in this card's own sub-slots. */
  cards: CardView[];
}

const str = (v: CanonValue | undefined): string | null => (typeof v === 'string' ? v : null);

function labelOf(doc: Document, portId: string): string {
  const n = findNode(doc, portId);
  return (n && readPhysicalPortFields(n).label) ?? '';
}

const byText = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

export function cardView(doc: Document, cardId: string): CardView | null {
  const node = live(doc, cardId);
  if (!node || parseNodeId(cardId).kind !== 'Card') return null;
  const f = node.fields;
  return {
    id: cardId,
    slot: str(fieldValue(f, 'Card.slot')) ?? '',
    name: str(fieldValue(f, 'Card.name')),
    model: str(fieldValue(f, 'Card.model')),
    serial: str(fieldValue(f, 'Card.serial')),
    portIds: edgesIn(doc, cardId, 'OnCard')
      .map((e) => e.from)
      .filter((p) => live(doc, p) !== undefined)
      .sort((a, b) => byText(labelOf(doc, a), labelOf(doc, b))),
    cards: cardsOf(doc, cardId),
  };
}

/** The live cards in `hostId`'s slots (a chassis, or a card's sub-slots), in slot order. */
export function cardsOf(doc: Document, hostId: string): CardView[] {
  return edgesOut(doc, hostId, 'HasCard')
    .map((e) => cardView(doc, e.to))
    .filter((c): c is CardView => c !== null)
    .sort((a, b) => byText(a.slot, b.slot));
}

/** The card a port is on, or `null` for a port fixed to the chassis. */
export function cardOfPort(doc: Document, portId: string): string | null {
  const e = edgesOut(doc, portId, 'OnCard').find((x) => live(doc, x.to) !== undefined);
  return e ? e.to : null;
}

/** The chassis a card is in, through any sub-slots. */
export function chassisOfCard(doc: Document, cardId: string): string | null {
  let at = cardId;
  for (let depth = 0; depth < 8; depth += 1) {
    const up = edgesIn(doc, at, 'HasCard')[0];
    if (!up) return null;
    if (parseNodeId(up.from).kind === 'Chassis') return up.from;
    at = up.from;
  }
  return null;
}

/** "slot 1", or "slot 1 · sub-slot 0" for a card in another card. */
export function slotPath(doc: Document, cardId: string): string {
  const parts: string[] = [];
  let at = cardId;
  for (let depth = 0; depth < 8; depth += 1) {
    const n = findNode(doc, at);
    if (!n || parseNodeId(at).kind !== 'Card') break;
    parts.unshift(str(fieldValue(n.fields, 'Card.slot')) ?? '?');
    const up = edgesIn(doc, at, 'HasCard')[0];
    if (!up) break;
    at = up.from;
  }
  return parts.map((s, i) => (i === 0 ? `slot ${s}` : `sub-slot ${s}`)).join(' · ');
}

// ---------------------------------------------------------------------------
// Optics

export interface Optic {
  type?: string;
  vendor?: string;
  part?: string;
  serial?: string;
  wavelengthNm?: number;
}

/** `undefined`: nobody looked. `null`: looked, the cage is empty. An `Optic`: fitted. */
export function opticOf(port: GraphNode): Optic | null | undefined {
  const entry = port.fields['PhysicalPort.transceiver'];
  if (!entry) return undefined;
  if (entry.presence === 'absent') return null;
  if (entry.presence !== 'set') return undefined;
  const v = entry.value;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const s = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined);
  const out: Optic = {};
  if (s(o.type)) out.type = s(o.type);
  if (s(o.vendor)) out.vendor = s(o.vendor);
  if (s(o.part)) out.part = s(o.part);
  if (s(o.serial)) out.serial = s(o.serial);
  if (typeof o.wavelength_nm === 'number') out.wavelengthNm = o.wavelength_nm;
  return out;
}

/** The canonical `Transceiver` value: keys sorted, only the members given. */
export function encodeOptic(optic: Optic): CanonValue {
  const out: Record<string, CanonValue> = {};
  const t = (s: string | undefined): string | undefined => {
    const x = s?.trim();
    return x ? x : undefined;
  };
  const part = t(optic.part);
  const serial = t(optic.serial);
  const type = t(optic.type);
  const vendor = t(optic.vendor);
  if (part !== undefined) out.part = identifierOrRefuse('PhysicalPort.transceiver', part);
  if (serial !== undefined) out.serial = identifierOrRefuse('PhysicalPort.transceiver', serial);
  if (type !== undefined) out.type = text(type);
  if (vendor !== undefined) out.vendor = text(vendor);
  if (optic.wavelengthNm !== undefined) {
    try {
      out.wavelength_nm = uint(optic.wavelengthNm, 16);
    } catch {
      throw new FieldValueError('PhysicalPort.transceiver', String(optic.wavelengthNm), 'wavelength must be a whole number of nanometres');
    }
  }
  return out as CanonValue;
}

function requirePort(doc: Document, portId: string): GraphNode {
  return requireLive(doc, portId, ['PhysicalPort']);
}

/** Fit, change or take out the optic in a cage. `null` records an empty cage. */
export function setOptic(doc: Document, portId: string, optic: Optic | null, opts?: Actor): Document {
  const port = requirePort(doc, portId);
  const key = 'PhysicalPort.transceiver';
  const value = optic === null ? undefined : encodeOptic(optic);
  const { actor, now } = resolve(opts);
  const built = setField(doc, now, actor, portId, port.fields[key], key, value);
  const working = replaceNode(built.doc, portId, (n) => ({ ...n, fields: { ...n.fields, [key]: built.entry } }));
  const label = optic === null ? 'take out optic' : port.fields[key]?.presence === 'set' ? 'edit optic' : 'fit optic';
  return withBatch(working, { id: newUlid(now), label, ops: [built.op] });
}

/** Move an optic from one cage to another (a drag): the source becomes an empty cage. One undo. */
export function moveOptic(doc: Document, fromPortId: string, toPortId: string, opts?: Actor): Document {
  if (fromPortId === toPortId) return doc;
  const from = requirePort(doc, fromPortId);
  const to = requirePort(doc, toPortId);
  const optic = opticOf(from);
  if (!optic) throw new UnknownReferenceError(fromPortId, 'a port with an optic in it');
  if (opticOf(to)) throw new CageTakenError(toPortId);
  const key = 'PhysicalPort.transceiver';
  const { actor, now } = resolve(opts);
  const setTo = setField(doc, now, actor, toPortId, to.fields[key], key, from.fields[key]!.value);
  let working = replaceNode(setTo.doc, toPortId, (n) => ({ ...n, fields: { ...n.fields, [key]: setTo.entry } }));
  const clearFrom = setField(working, now, actor, fromPortId, from.fields[key], key, undefined);
  working = replaceNode(clearFrom.doc, fromPortId, (n) => ({ ...n, fields: { ...n.fields, [key]: clearFrom.entry } }));
  return withBatch(working, { id: newUlid(now), label: 'move optic', ops: [setTo.op, clearFrom.op] });
}

// ---------------------------------------------------------------------------
// Cards

export interface CardPorts {
  /** Labels are `prefix` + n, `first`..`last`: "1/" + 1..24 gives "1/1".."1/24". */
  prefix: string;
  first: number;
  last: number;
  connector: string;
  face?: PortFace;
}

export interface FitCardFields {
  name?: string;
  model?: string;
  serial?: string;
  ports?: CardPorts;
}

const MAX_CARD_PORTS = 96;

/** Fits a card into `slot` of `hostId` (a chassis, or a card's sub-slot), with its ports. */
export function fitCard(doc: Document, hostId: string, slot: string, fields: FitCardFields = {}, opts?: Actor): Document {
  requireLive(doc, hostId, ['Chassis', 'Card']);
  const slotName = slot.trim();
  if (!slotName) throw new FieldValueError('Card.slot', slot, 'a slot needs a name, such as 0 or FPC 2');
  if (cardsOf(doc, hostId).some((c) => c.slot === slotName)) throw new SlotTakenByCardError(hostId, slotName);

  const chassisId = parseNodeId(hostId).kind === 'Chassis' ? hostId : chassisOfCard(doc, hostId);
  if (!chassisId) throw new UnknownReferenceError(hostId, 'a card seated in a chassis');

  const labels: string[] = [];
  if (fields.ports) {
    const p = fields.ports;
    if (!(PORT_CONNECTOR_VALUES as readonly string[]).includes(p.connector)) {
      throw new FieldValueError('PhysicalPort.connector', p.connector, `is not one of: ${PORT_CONNECTOR_VALUES.join(', ')}`);
    }
    if (!Number.isInteger(p.first) || !Number.isInteger(p.last) || p.first < 0 || p.first > p.last) {
      throw new FieldValueError('PhysicalPort.label', `${p.first}-${p.last}`, 'is not a range of whole numbers, low to high');
    }
    if (p.last - p.first + 1 > MAX_CARD_PORTS) {
      throw new FieldValueError('PhysicalPort.label', `${p.first}-${p.last}`, `a card has at most ${MAX_CARD_PORTS} ports`);
    }
    for (let n = p.first; n <= p.last; n += 1) labels.push(`${p.prefix}${n}`);
    const taken = new Set(
      edgesOut(doc, chassisId, 'HasPort')
        .map((e) => live(doc, e.to))
        .filter((n): n is GraphNode => n !== undefined)
        .map((n) => readPhysicalPortFields(n).label),
    );
    const clash = labels.find((l) => taken.has(l));
    if (clash) throw new FieldValueError('PhysicalPort.label', clash, 'this device already has a port with that label');
  }

  const { actor, now } = resolve(opts);
  let working = doc;
  const ops: Op[] = [];

  const existence = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = existence.doc;
  const cardId = formatNodeId('Card', newUlid(now));
  const cardFields: Record<string, FieldEntry> = {};
  const fieldOps: Op[] = [];
  const put = (key: string, value: CanonValue): void => {
    const f = setField(working, now, actor, cardId, undefined, key, value);
    working = f.doc;
    cardFields[key] = f.entry;
    fieldOps.push(f.op);
  };
  put('Card.slot', text(slotName));
  if (fields.name?.trim()) put('Card.name', text(fields.name.trim()));
  if (fields.model?.trim()) put('Card.model', identifierOrRefuse('Card.model', fields.model.trim()));
  if (fields.serial?.trim()) put('Card.serial', identifierOrRefuse('Card.serial', fields.serial.trim()));
  working = withNode(working, { id: cardId, existence: existence.id, fields: cardFields });
  ops.push({ type: 'add_node', node: cardId, prov: existence.id }, ...fieldOps);

  const seat = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = seat.doc;
  const seatId = formatEdgeId('HasCard', newUlid(now));
  working = withEdge(working, { id: seatId, from: hostId, to: cardId, prov: seat.id, fields: {} });
  ops.push({ type: 'add_edge', edge: seatId, from: hostId, to: cardId, prov: seat.id });

  for (const label of labels) {
    const portExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = portExistence.doc;
    const portId = formatNodeId('PhysicalPort', newUlid(now));
    const l = setField(working, now, actor, portId, undefined, 'PhysicalPort.label', text(label));
    working = l.doc;
    const c = setField(working, now, actor, portId, undefined, 'PhysicalPort.connector', token(fields.ports!.connector));
    working = c.doc;
    const f = setField(working, now, actor, portId, undefined, 'PhysicalPort.face', token(fields.ports!.face ?? 'front'));
    working = f.doc;
    working = withNode(working, {
      id: portId,
      existence: portExistence.id,
      fields: { 'PhysicalPort.label': l.entry, 'PhysicalPort.connector': c.entry, 'PhysicalPort.face': f.entry },
    });
    ops.push({ type: 'add_node', node: portId, prov: portExistence.id }, l.op, c.op, f.op);

    const hp = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = hp.doc;
    const hpId = formatEdgeId('HasPort', newUlid(now));
    working = withEdge(working, { id: hpId, from: chassisId, to: portId, prov: hp.id, fields: {} });
    ops.push({ type: 'add_edge', edge: hpId, from: chassisId, to: portId, prov: hp.id });

    const on = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = on.doc;
    const onId = formatEdgeId('OnCard', newUlid(now));
    working = withEdge(working, { id: onId, from: portId, to: cardId, prov: on.id, fields: {} });
    ops.push({ type: 'add_edge', edge: onId, from: portId, to: cardId, prov: on.id });
  }

  const batch: Batch = { id: newUlid(now), label: `fit card in slot ${slotName}`, ops };
  return withBatch(working, batch);
}

/** Every card under `cardId`, itself first. */
function cardTree(doc: Document, cardId: string): string[] {
  const out = [cardId];
  for (const e of edgesOut(doc, cardId, 'HasCard')) out.push(...cardTree(doc, e.to));
  return out;
}

/**
 * Takes a card out: the card, any card in its sub-slots, the ports on them, and the edges that
 * held them. A cable that was plugged into one of its ports stays, with that end loose, so the
 * Missing links list can find it when the replacement goes in (`removeSketchPort`'s rule).
 */
export function removeCard(doc: Document, cardId: string, opts?: Actor): Document {
  requireLive(doc, cardId, ['Card']);
  const cards = cardTree(doc, cardId).filter((id) => live(doc, id) !== undefined);
  const nodeIds = new Set<string>(cards);
  const edgeIds = new Set<string>();
  for (const id of cards) {
    for (const e of edgesIn(doc, id, 'HasCard')) edgeIds.add(e.id);
    for (const on of edgesIn(doc, id, 'OnCard')) {
      edgeIds.add(on.id);
      if (live(doc, on.from) === undefined) continue;
      nodeIds.add(on.from);
      for (const e of edgesIn(doc, on.from, 'HasPort')) edgeIds.add(e.id);
      for (const e of edgesIn(doc, on.from, 'Terminates')) edgeIds.add(e.id);
      for (const e of edgesOut(doc, on.from, 'PassThrough')) edgeIds.add(e.id);
      for (const e of edgesIn(doc, on.from, 'PassThrough')) edgeIds.add(e.id);
    }
  }
  const { actor, now } = resolve(opts);
  const working: Document = {
    ...doc,
    nodes: doc.nodes.map((n) => (nodeIds.has(n.id) ? { ...n, absentSince: now } : n)),
    edges: doc.edges.map((e) => (edgeIds.has(e.id) && e.absentSince === undefined ? { ...e, absentSince: now } : e)),
  };
  const ops: Op[] = [...nodeIds, ...edgeIds].map((element): Op => ({ type: 'tombstone', element, at: now, by: actor }));
  return withBatch(working, { id: newUlid(now), label: 'take out card', ops });
}

export type CardFieldKey = 'name' | 'model' | 'serial';

export function setCardField(doc: Document, cardId: string, key: CardFieldKey, value: string | null, opts?: Actor): Document {
  const node = requireLive(doc, cardId, ['Card']);
  const wireKey = `Card.${key}`;
  const v = value?.trim() ? value.trim() : null;
  const encoded = v === null ? undefined : key === 'name' ? text(v) : identifierOrRefuse(wireKey, v);
  const { actor, now } = resolve(opts);
  const built = setField(doc, now, actor, cardId, node.fields[wireKey], wireKey, encoded);
  const working = replaceNode(built.doc, cardId, (n) => ({ ...n, fields: { ...n.fields, [wireKey]: built.entry } }));
  return withBatch(working, { id: newUlid(now), label: `set ${wireKey}`, ops: [built.op] });
}
