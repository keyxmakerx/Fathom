// Pure edits for `Cable`, `Terminates` and the outside-world `ExternalPeer` —
// the same shape `commands.ts` and `edit.ts` build: every write is
// `Origin::Hand`, `Confidence::Asserted` provenance (ADR-0036), one `Batch`
// per call.
//
// `HasCable` (`schema/schema.yaml`) reads `from: [root]` — but `root` here is
// not a node this document ever holds an id for. `crates/fathom-graph/src/graph.rs`'s
// `check_edge_l0` refuses ANY write of a `root_containment()` edge kind
// outright (`WriteError::RootContainment`), before it even looks at `from`/
// `to`; `crates/fathom-graph/tests/l0.rs::root_containment_edge_refused` is
// the proof, and `crates/fathom-ir/tests/edge_tables.rs::root_containment_is_the_five_root_edges`
// names `HasCable` as one of the five kinds this applies to (with `HasTenant`,
// `HasServiceType`, `HasTunnel`, `HasPremises`). A `root_containment` node is
// a forest root with no containment edge at all — `owner(cable) == None`,
// exactly like `Premises` itself (`HasPremises` is root-level too, which is
// why `view.ts`'s `viewOf` finds its Premises by scanning `doc.nodes` for the
// kind, never by following an edge). So: `connectPorts`/`connectToOutside`
// below add a `Cable` node and NO containment edge for it — writing one would
// only be refused downstream. `ClosetView.cables` (`view.ts`) finds cables the
// same way `viewOf` finds its Premises: a scan by kind.
//
// `HasExternalPeer`, by contrast, is an ordinary containment edge
// (`from: [Site, Premises]`, `in: "1"` required) — `connectToOutside` writes
// one, from this document's own (root-level, edge-less) Premises.

import type { CableKind, CableMedia } from './compat';
import { compatible } from './compat';
import { UnknownReferenceError } from './commands';
import { FieldValueError } from './edit';
import {
  LOCAL_ACTOR,
  archiveField,
  assertHand,
  edgesIn,
  edgesOut,
  findNode,
  formatEdgeId,
  formatNodeId,
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

export type { CableKind };

// ---------------------------------------------------------------------------
// The three closed vocabularies `cables.ts` writes — each one is
// `schema/schema.yaml`'s own enum, transcribed verbatim (never guessed; a
// value outside these lists is refused, `FieldValueError`, `edit.ts`'s own
// class reused rather than duplicated).

/** `Cable.sheath` (`schema/schema.yaml`) — the nine stock lead colours plus
 * the two TIA-598-C fibre-only additions (docs/UI-SPEC.md "Cables"). */
export const SHEATH_VALUES = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'orange',
  'purple',
  'black',
  'white',
  'aqua',
  'erika',
] as const;
export type Sheath = (typeof SHEATH_VALUES)[number];

export function isSheath(s: string): s is Sheath {
  return (SHEATH_VALUES as readonly string[]).includes(s);
}

/** `Cable.media` (`schema/schema.yaml`), verbatim; re-exported from
 * `compat.ts` so this module's own `MEDIA_VALUES` cannot drift from the
 * table `compatible()` derives a default from. */
export const MEDIA_VALUES = ['cat5e', 'cat6', 'cat6a', 'twinax', 'smf', 'mmf', 'coax', 'power', 'virtual', 'other'] as const;
export type { CableMedia };

export function isCableMedia(s: string): s is CableMedia {
  return (MEDIA_VALUES as readonly string[]).includes(s);
}

/** `Cable.ownership` (`schema/schema.yaml`). */
export const OWNERSHIP_VALUES = ['ours', 'provider', 'customer'] as const;
export type CableOwnership = (typeof OWNERSHIP_VALUES)[number];

export function isCableOwnership(s: string): s is CableOwnership {
  return (OWNERSHIP_VALUES as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------

export class PortAlreadyTerminatedError extends Error {
  readonly portId: string;
  readonly existingCableId: string;
  constructor(portId: string, existingCableId: string) {
    super(
      `port "${portId}" already terminates cable "${existingCableId}" — one cable per port ` +
        '(docs/UI-SPEC.md "Cables")',
    );
    this.name = 'PortAlreadyTerminatedError';
    this.portId = portId;
    this.existingCableId = existingCableId;
  }
}

export class IncompatibleConnectorError extends Error {
  readonly fromPortId: string;
  readonly toPortId: string;
  readonly reason: string;
  constructor(fromPortId: string, toPortId: string, reason: string) {
    super(`"${fromPortId}" -> "${toPortId}": ${reason}`);
    this.name = 'IncompatibleConnectorError';
    this.fromPortId = fromPortId;
    this.toPortId = toPortId;
    this.reason = reason;
  }
}

interface Actor {
  actor?: string;
  now?: number;
}

function resolve(opts: Actor | undefined): { actor: string; now: number } {
  return { actor: opts?.actor ?? LOCAL_ACTOR, now: opts?.now ?? Date.now() };
}

/** `commands.ts`'s private `setField`, mirrored here for the same reason
 * `edit.ts`'s `setFieldEntry` is not imported: it is private to its module.
 * ADR-0053 §2 — `existing`, when given, is archived into `doc.history` first
 * (`model.ts`'s `archiveField`), so an undo asking for the prior value finds
 * one. */
function setField(
  working: Document,
  now: number,
  actor: string,
  elementId: string,
  existing: FieldEntry | undefined,
  key: string,
  value: FieldEntry['value'] | undefined,
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

function requireLivePort(doc: Document, portId: string): GraphNode {
  const node = findNode(doc, portId);
  if (!node || node.absentSince !== undefined) throw new UnknownReferenceError(portId, 'PhysicalPort');
  const parsed = parseNodeId(portId); // throws IdParseError for a malformed id — left uncaught
  if (parsed.kind !== 'PhysicalPort') throw new UnknownReferenceError(portId, 'PhysicalPort');
  return node;
}

function refuseIfTerminated(doc: Document, portId: string): void {
  const existing = edgesIn(doc, portId, 'Terminates')[0];
  if (existing) throw new PortAlreadyTerminatedError(portId, existing.from);
}

/** This document's own (root-level, edge-less — see the module doc)
 * `Premises`; the owner `HasExternalPeer` needs. */
function findLivePremises(doc: Document): GraphNode {
  const premises = doc.nodes.find((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Premises');
  if (!premises) {
    throw new Error('connectToOutside: this document has no Premises to own the ExternalPeer');
  }
  return premises;
}

// ---------------------------------------------------------------------------

export interface ConnectPortsFields {
  sheath?: Sheath;
  label?: string;
  /** Overrides the media `compatible()` would otherwise pick — still checked
   * against `MEDIA_VALUES`. */
  media?: CableMedia;
}

/**
 * One `Cable` between two `PhysicalPort`s already in this document, plus two
 * `Terminates` edges (`end: 'a'` at `fromPortId`, `end: 'b'` at `toPortId`).
 * Refuses: either port unknown or already gone (`UnknownReferenceError`),
 * either port already terminating a live cable (`PortAlreadyTerminatedError`,
 * UI-SPEC "one cable per port"), or an incompatible connector pair
 * (`IncompatibleConnectorError`, `compat.ts`'s table).
 */
export function connectPorts(
  doc: Document,
  fromPortId: string,
  toPortId: string,
  fields: ConnectPortsFields,
  opts?: Actor,
): Document {
  const fromNode = requireLivePort(doc, fromPortId);
  const toNode = requireLivePort(doc, toPortId);
  refuseIfTerminated(doc, fromPortId);
  refuseIfTerminated(doc, toPortId);

  const fromConnector = readPhysicalPortFields(fromNode).connector ?? '';
  const toConnector = readPhysicalPortFields(toNode).connector ?? '';
  const compat = compatible(fromConnector, toConnector);
  if (!compat.ok) {
    throw new IncompatibleConnectorError(fromPortId, toPortId, compat.reason);
  }

  const media = fields.media ?? compat.media;
  if (!isCableMedia(media)) {
    throw new FieldValueError('Cable.media', media, `is not one of: ${MEDIA_VALUES.join(', ')}`);
  }
  if (fields.sheath !== undefined && !isSheath(fields.sheath)) {
    throw new FieldValueError('Cable.sheath', fields.sheath, `is not one of: ${SHEATH_VALUES.join(', ')}`);
  }

  const { actor, now } = resolve(opts);
  let working = doc;
  const ops: Op[] = [];

  // The Cable — root-level, no HasCable edge (module doc above).
  const cableExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = cableExistence.doc;
  const cableId = formatNodeId('Cable', newUlid(now));
  const cableFields: Record<string, FieldEntry> = {};

  const mediaField = setField(working, now, actor, cableId, undefined, 'Cable.media', token(media));
  working = mediaField.doc;
  cableFields['Cable.media'] = mediaField.entry;

  const built: Op[] = [mediaField.op];
  if (fields.sheath !== undefined) {
    const sheathField = setField(working, now, actor, cableId, undefined, 'Cable.sheath', token(fields.sheath));
    working = sheathField.doc;
    cableFields['Cable.sheath'] = sheathField.entry;
    built.push(sheathField.op);
  }
  if (fields.label !== undefined) {
    const labelField = setField(working, now, actor, cableId, undefined, 'Cable.label', text(fields.label));
    working = labelField.doc;
    cableFields['Cable.label'] = labelField.entry;
    built.push(labelField.op);
  }

  working = withNode(working, { id: cableId, existence: cableExistence.id, fields: cableFields });
  ops.push({ type: 'add_node', node: cableId, prov: cableExistence.id }, ...built);

  const terminate = (portId: string, end: 'a' | 'b'): void => {
    const prov = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = prov.doc;
    const edgeId = formatEdgeId('Terminates', newUlid(now));
    const endField = setField(working, now, actor, edgeId, undefined, 'Terminates.end', token(end));
    working = endField.doc;
    working = withEdge(working, {
      id: edgeId,
      from: cableId,
      to: portId,
      prov: prov.id,
      fields: { 'Terminates.end': endField.entry },
    });
    ops.push({ type: 'add_edge', edge: edgeId, from: cableId, to: portId, prov: prov.id }, endField.op);
  };
  terminate(fromPortId, 'a');
  terminate(toPortId, 'b');

  const batch: Batch = { id: newUlid(now), label: 'connect ports', ops };
  return withBatch(working, batch);
}

// ---------------------------------------------------------------------------

/** Tombstones the `Cable` and its live `Terminates` edges. Leaves any far-end
 * `ExternalPeer` node alone — it is a fact about the world, not about this
 * one cable. */
export function disconnect(doc: Document, cableId: string, opts?: Actor): Document {
  const node = findNode(doc, cableId);
  if (!node || node.absentSince !== undefined) throw new UnknownReferenceError(cableId, 'Cable');

  const terms = edgesOut(doc, cableId, 'Terminates');
  const { actor, now } = resolve(opts);

  const working: Document = {
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === cableId ? { ...n, absentSince: now } : n)),
    edges: doc.edges.map((e) => (terms.some((t) => t.id === e.id) ? { ...e, absentSince: now } : e)),
  };

  const ops: Op[] = [
    { type: 'tombstone', element: cableId, at: now, by: actor },
    ...terms.map((t): Op => ({ type: 'tombstone', element: t.id, at: now, by: actor })),
  ];
  const batch: Batch = { id: newUlid(now), label: 'disconnect cable', ops };
  return withBatch(working, batch);
}

// ---------------------------------------------------------------------------

export type CableFieldKey = 'label' | 'sheath' | 'media' | 'length_m' | 'ownership';

/** `Cable.label` (`Text`), `.sheath`/`.media`/`.ownership` (the enums above)
 * or `.length_m` (`u32`) on one live `Cable` — `value: null` clears the
 * field (UI-SPEC "Absent is drawn as absent"), the same shape `edit.ts`'s
 * `setDeviceField`/`setChassisField` use. */
export function setCableField(
  doc: Document,
  cableId: string,
  key: CableFieldKey,
  value: string | number | null,
  opts?: Actor,
): Document {
  const node = findNode(doc, cableId);
  if (!node || node.absentSince !== undefined) throw new UnknownReferenceError(cableId, 'Cable');
  const wireKey = `Cable.${key}`;

  let encoded: FieldEntry['value'] | undefined;
  if (value !== null) {
    switch (key) {
      case 'label':
        if (typeof value !== 'string') throw new FieldValueError(wireKey, String(value), 'must be text');
        encoded = text(value);
        break;
      case 'sheath':
        if (typeof value !== 'string' || !isSheath(value)) {
          throw new FieldValueError(wireKey, String(value), `is not one of: ${SHEATH_VALUES.join(', ')}`);
        }
        encoded = token(value);
        break;
      case 'media':
        if (typeof value !== 'string' || !isCableMedia(value)) {
          throw new FieldValueError(wireKey, String(value), `is not one of: ${MEDIA_VALUES.join(', ')}`);
        }
        encoded = token(value);
        break;
      case 'length_m':
        if (typeof value !== 'number') throw new FieldValueError(wireKey, String(value), 'must be a number');
        encoded = uint(value, 32);
        break;
      case 'ownership':
        if (typeof value !== 'string' || !isCableOwnership(value)) {
          throw new FieldValueError(wireKey, String(value), `is not one of: ${OWNERSHIP_VALUES.join(', ')}`);
        }
        encoded = token(value);
        break;
    }
  }

  const { actor, now } = resolve(opts);
  const built = setField(doc, now, actor, cableId, node.fields[wireKey], wireKey, encoded);
  const working = replaceNode(built.doc, cableId, (n) => ({ ...n, fields: { ...n.fields, [wireKey]: built.entry } }));
  const batch: Batch = { id: newUlid(now), label: `set ${wireKey}`, ops: [built.op] };
  return withBatch(working, batch);
}

// ---------------------------------------------------------------------------

export interface ConnectToOutsideFields {
  label: string;
  sheath?: Sheath;
}

/**
 * A cable whose far end leaves this document: a fresh `ExternalPeer` node
 * (`ExternalPeer.label` set to `fields.label`), owned by this document's
 * `Premises` through an ordinary `HasExternalPeer` edge (NOT root-level —
 * see the module doc's contrast with `HasCable`), then a `Cable` exactly
 * like `connectPorts` builds (again no `HasCable` edge) with its `end: 'a'`
 * `Terminates` at `fromPortId` and `end: 'b'` at the new peer.
 *
 * `Cable.media` is left unset here: the far end is unmodelled (11 §6.3), so
 * there is no second connector to derive a default from, and a single-ended
 * guess would be exactly the invented fact CLAUDE.md rule 4's neighbours
 * warn against. `setCableField` sets it afterward if the caller has it.
 */
export function connectToOutside(
  doc: Document,
  fromPortId: string,
  fields: ConnectToOutsideFields,
  opts?: Actor,
): Document {
  requireLivePort(doc, fromPortId);
  refuseIfTerminated(doc, fromPortId);
  const premises = findLivePremises(doc);

  const { actor, now } = resolve(opts);
  let working = doc;
  const ops: Op[] = [];

  const peerExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = peerExistence.doc;
  const peerId = formatNodeId('ExternalPeer', newUlid(now));
  const peerLabel = setField(working, now, actor, peerId, undefined, 'ExternalPeer.label', text(fields.label));
  working = peerLabel.doc;
  working = withNode(working, {
    id: peerId,
    existence: peerExistence.id,
    fields: { 'ExternalPeer.label': peerLabel.entry },
  });
  ops.push({ type: 'add_node', node: peerId, prov: peerExistence.id }, peerLabel.op);

  const hasPeerProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = hasPeerProv.doc;
  const hasPeerId = formatEdgeId('HasExternalPeer', newUlid(now));
  working = withEdge(working, { id: hasPeerId, from: premises.id, to: peerId, prov: hasPeerProv.id, fields: {} });
  ops.push({ type: 'add_edge', edge: hasPeerId, from: premises.id, to: peerId, prov: hasPeerProv.id });

  const cableExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = cableExistence.doc;
  const cableId = formatNodeId('Cable', newUlid(now));
  const cableFields: Record<string, FieldEntry> = {};

  if (fields.sheath !== undefined) {
    if (!isSheath(fields.sheath)) {
      throw new FieldValueError('Cable.sheath', fields.sheath, `is not one of: ${SHEATH_VALUES.join(', ')}`);
    }
    const sheathField = setField(working, now, actor, cableId, undefined, 'Cable.sheath', token(fields.sheath));
    working = sheathField.doc;
    cableFields['Cable.sheath'] = sheathField.entry;
    ops.push(sheathField.op);
  }

  working = withNode(working, { id: cableId, existence: cableExistence.id, fields: cableFields });
  ops.push({ type: 'add_node', node: cableId, prov: cableExistence.id });

  const terminate = (toId: string, end: 'a' | 'b'): void => {
    const prov = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = prov.doc;
    const edgeId = formatEdgeId('Terminates', newUlid(now));
    const endField = setField(working, now, actor, edgeId, undefined, 'Terminates.end', token(end));
    working = endField.doc;
    working = withEdge(working, {
      id: edgeId,
      from: cableId,
      to: toId,
      prov: prov.id,
      fields: { 'Terminates.end': endField.entry },
    });
    ops.push({ type: 'add_edge', edge: edgeId, from: cableId, to: toId, prov: prov.id }, endField.op);
  };
  terminate(fromPortId, 'a');
  terminate(peerId, 'b');

  const batch: Batch = { id: newUlid(now), label: 'connect to outside', ops };
  return withBatch(working, batch);
}
