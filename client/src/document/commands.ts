// Pure edits over a `Document` — each function returns a new `Document` and
// touches nothing else. Every write is `Origin::Hand`, `Confidence::Asserted`
// provenance (ADR-0036: nothing parses a rack), wrapped in one `Batch` per
// call so the op log stays a genuine record of what happened rather than a
// diff reconstructed after the fact.

import { connectorTokenOf } from './compat';
import type { CatalogueModel } from '../api/catalogue';
import {
  LOCAL_ACTOR,
  assertHand,
  edgesIn,
  edgesOut,
  findNode,
  formatEdgeId,
  formatNodeId,
  identifier,
  replaceEdge,
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
  type GraphEdge,
  type Op,
} from './model';
import { newUlid } from './ulid';

export class UnknownReferenceError extends Error {
  readonly id: string;
  readonly wanted: string;
  constructor(id: string, wanted: string) {
    super(`${wanted} "${id}" is not in this document`);
    this.name = 'UnknownReferenceError';
    this.id = id;
    this.wanted = wanted;
  }
}

export class RackRangeError extends Error {
  readonly rackId: string;
  readonly positionU: number;
  readonly heightU: number;
  readonly rackHeightU: number;
  constructor(rackId: string, positionU: number, heightU: number, rackHeightU: number) {
    super(
      `chassis at U${positionU}..U${positionU + heightU - 1} does not fit rack "${rackId}" (${rackHeightU}U)`,
    );
    this.name = 'RackRangeError';
    this.rackId = rackId;
    this.positionU = positionU;
    this.heightU = heightU;
    this.rackHeightU = rackHeightU;
  }
}

export class RackOverlapError extends Error {
  readonly rackId: string;
  readonly positionU: number;
  readonly heightU: number;
  constructor(rackId: string, positionU: number, heightU: number) {
    super(`U${positionU}..U${positionU + heightU - 1} in rack "${rackId}" is already occupied`);
    this.name = 'RackOverlapError';
    this.rackId = rackId;
    this.positionU = positionU;
    this.heightU = heightU;
  }
}

interface Actor {
  actor?: string;
  now?: number;
}

function resolve(opts: Actor | undefined): { actor: string; now: number } {
  return { actor: opts?.actor ?? LOCAL_ACTOR, now: opts?.now ?? Date.now() };
}

function setEntry(value: FieldEntry['value'], prov: string): FieldEntry {
  return { presence: 'set', prov, value };
}

/** One field, minted a fresh provenance record and (if the field already
 * carried a value) linked to it via `supersedes` — `11` §8.6's "edits never
 * overwrite" chain, the same rule the engine's own `set_field` enforces. */
function setField(
  working: Document,
  now: number,
  actor: string,
  elementId: string,
  existing: FieldEntry | undefined,
  key: string,
  value: FieldEntry['value'],
): { doc: Document; entry: FieldEntry; op: Op } {
  requireFieldName(key);
  const prov = assertHand(working, { assertedAt: now, assertedBy: actor, supersedes: existing?.prov });
  return {
    doc: prov.doc,
    entry: setEntry(value, prov.id),
    op: { type: 'set_field', element: elementId, key, presence: 'set', prov: prov.id },
  };
}

/** A field's numeric value, or `undefined` if the slot is simply absent — a
 * malformed value (present but not a number) is still an error, since that
 * can only mean this document's own writer got a scalar type wrong. */
function readNumber(entry: FieldEntry | undefined): number | undefined {
  if (!entry || entry.presence !== 'set') return undefined;
  if (typeof entry.value !== 'number') {
    throw new Error('expected a numeric field value');
  }
  return entry.value;
}

function occupiedRanges(doc: Document, rackId: string, exceptChassisId?: string): Array<[number, number]> {
  return edgesIn(doc, rackId, 'MountedIn')
    .filter((e) => e.from !== exceptChassisId)
    .map((e) => {
      const positionU = readNumber(e.fields['MountedIn.position_u']);
      if (positionU === undefined) {
        throw new Error(`MountedIn edge "${e.id}" has no MountedIn.position_u set`);
      }
      // Absent height renders as 1U and is MARKED unstated (ADR-0036) — the
      // conservative width for an overlap check when nobody has counted it.
      const heightU = readNumber(e.fields['MountedIn.height_u']) ?? 1;
      return [positionU, positionU + heightU - 1] as [number, number];
    });
}

function checkPlacement(
  doc: Document,
  rackId: string,
  rackHeight: number,
  positionU: number,
  heightU: number,
  exceptChassisId?: string,
): void {
  if (!Number.isInteger(positionU) || positionU < 1 || positionU + heightU - 1 > rackHeight) {
    throw new RackRangeError(rackId, positionU, heightU, rackHeight);
  }
  const top = positionU + heightU - 1;
  for (const [lo, hi] of occupiedRanges(doc, rackId, exceptChassisId)) {
    if (positionU <= hi && lo <= top) {
      throw new RackOverlapError(rackId, positionU, heightU);
    }
  }
}

function rackHeightU(doc: Document, rackId: string): number {
  const rack = findNode(doc, rackId);
  if (!rack) throw new UnknownReferenceError(rackId, 'Rack');
  const height = readNumber(rack.fields['Rack.height_u']);
  if (height === undefined) {
    throw new Error(`rack "${rackId}" has no Rack.height_u set`);
  }
  return height;
}

// ---------------------------------------------------------------------------

export interface CreateRackOptions extends Actor {
  label: string;
  heightU: number;
  unitNumbering: 'ascending' | 'descending';
}

export function createRack(doc: Document, premisesId: string, opts: CreateRackOptions): Document {
  if (!findNode(doc, premisesId)) throw new UnknownReferenceError(premisesId, 'Premises');
  const { actor, now } = resolve(opts);

  let working = doc;
  const existence = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = existence.doc;
  const rackId = formatNodeId('Rack', newUlid(now));

  const label = setField(working, now, actor, rackId, undefined, 'Rack.label', text(opts.label));
  working = label.doc;
  const height = setField(working, now, actor, rackId, undefined, 'Rack.height_u', uint(opts.heightU, 8));
  working = height.doc;
  const numbering = setField(working, now, actor, rackId, undefined, 'Rack.unit_numbering', token(opts.unitNumbering));
  working = numbering.doc;

  working = withNode(working, {
    id: rackId,
    existence: existence.id,
    fields: {
      'Rack.label': label.entry,
      'Rack.height_u': height.entry,
      'Rack.unit_numbering': numbering.entry,
    },
  });

  const edgeProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = edgeProv.doc;
  const edgeId = formatEdgeId('HasRack', newUlid(now));
  working = withEdge(working, { id: edgeId, from: premisesId, to: rackId, prov: edgeProv.id, fields: {} });

  const batch: Batch = {
    id: newUlid(now),
    label: 'create rack',
    ops: [
      { type: 'add_node', node: rackId, prov: existence.id },
      label.op,
      height.op,
      numbering.op,
      { type: 'add_edge', edge: edgeId, from: premisesId, to: rackId, prov: edgeProv.id },
    ],
  };
  return withBatch(working, batch);
}

// ---------------------------------------------------------------------------

export function placeChassis(
  doc: Document,
  rackId: string,
  model: CatalogueModel,
  positionU: number,
  face: 'front' | 'rear',
  opts?: Actor,
): Document {
  const heightU = model.rackUnits;
  checkPlacement(doc, rackId, rackHeightU(doc, rackId), positionU, heightU);
  const { actor, now } = resolve(opts);

  let working = doc;
  const ops: Op[] = [];

  const deviceExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = deviceExistence.doc;
  const deviceId = formatNodeId('Device', newUlid(now));
  // `Device.hostname` is deliberately left unset: nobody has typed a name for
  // this box yet, and inventing one would be exactly the fact CLAUDE.md rule
  // 4's neighbours warn against — a slot nobody asserted is absent, not
  // guessed.
  working = withNode(working, { id: deviceId, existence: deviceExistence.id, fields: {} });
  ops.push({ type: 'add_node', node: deviceId, prov: deviceExistence.id });

  const chassisExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = chassisExistence.doc;
  const chassisId = formatNodeId('Chassis', newUlid(now));
  const chassisModel = setField(working, now, actor, chassisId, undefined, 'Chassis.model', identifier(model.model));
  working = chassisModel.doc;
  working = withNode(working, {
    id: chassisId,
    existence: chassisExistence.id,
    fields: { 'Chassis.model': chassisModel.entry },
  });
  ops.push({ type: 'add_node', node: chassisId, prov: chassisExistence.id }, chassisModel.op);

  const hasChassisProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = hasChassisProv.doc;
  const hasChassisId = formatEdgeId('HasChassis', newUlid(now));
  working = withEdge(working, { id: hasChassisId, from: deviceId, to: chassisId, prov: hasChassisProv.id, fields: {} });
  ops.push({ type: 'add_edge', edge: hasChassisId, from: deviceId, to: chassisId, prov: hasChassisProv.id });

  for (const faceplate of model.faceplates) {
    for (const port of faceplate.ports) {
      const portExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
      working = portExistence.doc;
      const portId = formatNodeId('PhysicalPort', newUlid(now));
      const label = setField(working, now, actor, portId, undefined, 'PhysicalPort.label', text(String(port.number)));
      working = label.doc;
      // The schema's own token for the catalogue's port kind (`"RJ45"` is
      // written as `rj45`): `connectorTokenOf` in `compat.ts` says why, and
      // `view.ts` maps the same way when it finds the port on its faceplate.
      const connector = setField(working, now, actor, portId, undefined, 'PhysicalPort.connector', token(connectorTokenOf(port.kind)));
      working = connector.doc;
      working = withNode(working, {
        id: portId,
        existence: portExistence.id,
        fields: { 'PhysicalPort.label': label.entry, 'PhysicalPort.connector': connector.entry },
      });
      ops.push({ type: 'add_node', node: portId, prov: portExistence.id }, label.op, connector.op);

      const hasPortProv = assertHand(working, { assertedAt: now, assertedBy: actor });
      working = hasPortProv.doc;
      const hasPortId = formatEdgeId('HasPort', newUlid(now));
      working = withEdge(working, { id: hasPortId, from: chassisId, to: portId, prov: hasPortProv.id, fields: {} });
      ops.push({ type: 'add_edge', edge: hasPortId, from: chassisId, to: portId, prov: hasPortProv.id });
    }
  }

  // Power inlets (ADR-0050 §3): a model whose catalogue entry lists
  // `psu_slots` gets one `PhysicalPort` per slot here, labelled with the
  // slot's own name (PSU0, PEM A) —
  // `PhysicalPort.connector: c14` (the schema's own IEC 60320 token, not a
  // catalogue `PortKind` spelling to carry verbatim: these ports have no
  // faceplate entry to read one off), `PhysicalPort.service: power`,
  // A model whose faceplate ports are
  // themselves `c13` outlets (a PDU) already got them in the loop above and
  // needs nothing here. Still ordinary `HasPort` children of this chassis —
  // `view.ts`'s `ChassisView.psuInlets` is what keeps them out of the
  // faceplate `ports` array, not anything at this layer.
  {
    for (const slot of model.psuSlots) {
      const inletExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
      working = inletExistence.doc;
      const inletId = formatNodeId('PhysicalPort', newUlid(now));
      const inletLabel = setField(working, now, actor, inletId, undefined, 'PhysicalPort.label', text(slot.name));
      working = inletLabel.doc;
      const inletConnector = setField(working, now, actor, inletId, undefined, 'PhysicalPort.connector', token('c14'));
      working = inletConnector.doc;
      const inletService = setField(working, now, actor, inletId, undefined, 'PhysicalPort.service', token('power'));
      working = inletService.doc;
      working = withNode(working, {
        id: inletId,
        existence: inletExistence.id,
        fields: {
          'PhysicalPort.label': inletLabel.entry,
          'PhysicalPort.connector': inletConnector.entry,
          'PhysicalPort.service': inletService.entry,
        },
      });
      ops.push(
        { type: 'add_node', node: inletId, prov: inletExistence.id },
        inletLabel.op,
        inletConnector.op,
        inletService.op,
      );

      const hasInletProv = assertHand(working, { assertedAt: now, assertedBy: actor });
      working = hasInletProv.doc;
      const hasInletId = formatEdgeId('HasPort', newUlid(now));
      working = withEdge(working, { id: hasInletId, from: chassisId, to: inletId, prov: hasInletProv.id, fields: {} });
      ops.push({ type: 'add_edge', edge: hasInletId, from: chassisId, to: inletId, prov: hasInletProv.id });
    }
  }

  const mountedProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = mountedProv.doc;
  const mountedId = formatEdgeId('MountedIn', newUlid(now));
  const positionEntry = setField(working, now, actor, mountedId, undefined, 'MountedIn.position_u', uint(positionU, 8));
  working = positionEntry.doc;
  const heightEntry = setField(working, now, actor, mountedId, undefined, 'MountedIn.height_u', uint(heightU, 8));
  working = heightEntry.doc;
  const faceEntry = setField(working, now, actor, mountedId, undefined, 'MountedIn.face', token(face));
  working = faceEntry.doc;
  working = withEdge(working, {
    id: mountedId,
    from: chassisId,
    to: rackId,
    prov: mountedProv.id,
    fields: {
      'MountedIn.position_u': positionEntry.entry,
      'MountedIn.height_u': heightEntry.entry,
      'MountedIn.face': faceEntry.entry,
    },
  });
  ops.push(
    { type: 'add_edge', edge: mountedId, from: chassisId, to: rackId, prov: mountedProv.id },
    positionEntry.op,
    heightEntry.op,
    faceEntry.op,
  );

  const batch: Batch = { id: newUlid(now), label: 'place chassis', ops };
  return withBatch(working, batch);
}

// ---------------------------------------------------------------------------

export function moveChassis(
  doc: Document,
  chassisId: string,
  rackId: string,
  positionU: number,
  face: 'front' | 'rear',
  opts?: Actor,
): Document {
  const mounted: GraphEdge | undefined = edgesOut(doc, chassisId, 'MountedIn')[0];
  if (!mounted) throw new UnknownReferenceError(chassisId, 'a mounted Chassis');
  const heightU = readNumber(mounted.fields['MountedIn.height_u']) ?? 1;
  const sameRack = mounted.to === rackId;
  // `rackHeightU` throws `UnknownReferenceError` for a target rack this
  // document does not have — the same refusal `placeChassis` gives an
  // unknown rack. The overlap check excludes the moving chassis itself only
  // when the target is the rack it is already in; a move onto another rack
  // is checked against that rack's own occupants, none of which is this one.
  checkPlacement(doc, rackId, rackHeightU(doc, rackId), positionU, heightU, sameRack ? chassisId : undefined);

  const { actor, now } = resolve(opts);
  let working = doc;

  if (sameRack) {
    const position = setField(
      working,
      now,
      actor,
      mounted.id,
      mounted.fields['MountedIn.position_u'],
      'MountedIn.position_u',
      uint(positionU, 8),
    );
    working = position.doc;
    const faceEntry = setField(
      working,
      now,
      actor,
      mounted.id,
      mounted.fields['MountedIn.face'],
      'MountedIn.face',
      token(face),
    );
    working = faceEntry.doc;

    working = replaceEdge(working, mounted.id, (e) => ({
      ...e,
      fields: { ...e.fields, 'MountedIn.position_u': position.entry, 'MountedIn.face': faceEntry.entry },
    }));

    const batch: Batch = { id: newUlid(now), label: 'move chassis', ops: [position.op, faceEntry.op] };
    return withBatch(working, batch);
  }

  // A cross-rack move: `MountedIn.to` is fixed at creation like every other
  // edge this module writes (`model.ts`'s `withEdge`/`replaceEdge` never
  // rewrite `from`/`to`), so the old edge is retired and a new one minted to
  // the target rack — the same shape `placeChassis` builds — in this one
  // batch, rather than reaching for a rewrite this document's edges do not
  // support.
  working = { ...working, edges: working.edges.map((e) => (e.id === mounted.id ? { ...e, absentSince: now } : e)) };
  const tombstoneOp: Op = { type: 'tombstone', element: mounted.id, at: now, by: actor };

  const mountedProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = mountedProv.doc;
  const mountedId = formatEdgeId('MountedIn', newUlid(now));
  const positionEntry = setField(working, now, actor, mountedId, undefined, 'MountedIn.position_u', uint(positionU, 8));
  working = positionEntry.doc;
  const heightEntry = setField(working, now, actor, mountedId, undefined, 'MountedIn.height_u', uint(heightU, 8));
  working = heightEntry.doc;
  const faceEntry = setField(working, now, actor, mountedId, undefined, 'MountedIn.face', token(face));
  working = faceEntry.doc;
  working = withEdge(working, {
    id: mountedId,
    from: chassisId,
    to: rackId,
    prov: mountedProv.id,
    fields: {
      'MountedIn.position_u': positionEntry.entry,
      'MountedIn.height_u': heightEntry.entry,
      'MountedIn.face': faceEntry.entry,
    },
  });

  const batch: Batch = {
    id: newUlid(now),
    label: 'move chassis',
    ops: [
      tombstoneOp,
      { type: 'add_edge', edge: mountedId, from: chassisId, to: rackId, prov: mountedProv.id },
      positionEntry.op,
      heightEntry.op,
      faceEntry.op,
    ],
  };
  return withBatch(working, batch);
}

// ---------------------------------------------------------------------------

export function removeChassis(doc: Document, chassisId: string, opts?: Actor): Document {
  if (!findNode(doc, chassisId)) throw new UnknownReferenceError(chassisId, 'Chassis');
  const hasChassis = edgesIn(doc, chassisId, 'HasChassis')[0];
  if (!hasChassis) throw new UnknownReferenceError(chassisId, 'a chassis owned by a Device');
  const deviceId = hasChassis.from;
  const ports = edgesOut(doc, chassisId, 'HasPort');
  const mounted = edgesOut(doc, chassisId, 'MountedIn')[0];

  const { now } = resolve(opts);
  const nodeIds = new Set([deviceId, chassisId, ...ports.map((p) => p.to)]);
  const edgeIds = new Set([hasChassis.id, ...ports.map((p) => p.id), ...(mounted ? [mounted.id] : [])]);

  const working: Document = {
    ...doc,
    nodes: doc.nodes.map((n) => (nodeIds.has(n.id) ? { ...n, absentSince: now } : n)),
    edges: doc.edges.map((e) => (edgeIds.has(e.id) ? { ...e, absentSince: now } : e)),
  };

  const by = opts?.actor ?? LOCAL_ACTOR;
  const ops: Op[] = [...nodeIds, ...edgeIds].map((element): Op => ({ type: 'tombstone', element, at: now, by }));
  const batch: Batch = { id: newUlid(now), label: 'remove chassis', ops };
  return withBatch(working, batch);
}
