// Pure edits over a `Document` — each function returns a new `Document` and
// touches nothing else. Every write is `Origin::Hand`, `Confidence::Asserted`
// provenance (ADR-0036: nothing parses a rack), wrapped in one `Batch` per
// call so the op log stays a genuine record of what happened rather than a
// diff reconstructed after the fact.

import { connectorTokenOf, PORT_CONNECTOR_VALUES, PORT_SERVICE_VALUES } from './compat';
import type { CatalogueModel } from '../api/catalogue';
import { FieldValueError } from './edit';
import type { Placement } from './view';
import {
  LOCAL_ACTOR,
  UnknownReferenceError,
  assertHand,
  edgesIn,
  edgesOut,
  findNode,
  formatEdgeId,
  formatNodeId,
  identifier,
  parseEdgeId,
  parseNodeId,
  readChassisFields,
  readMountedInFields,
  readPassiveNodeFields,
  readSitsOnFields,
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
  type EdgeKind,
  type FieldEntry,
  type GraphEdge,
  type GraphNode,
  type Op,
} from './model';
import { newUlid } from './ulid';

// Re-exported so every existing `import { UnknownReferenceError } from
// './commands'` (`cables.ts`, `supplies.ts`, the test files) keeps working —
// see `model.ts`'s own doc on why the class itself lives there now.
export { UnknownReferenceError };

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

  // ADR-0051 §1 — one PhysicalPort id per faceplate slot, kept by face, so a
  // model whose catalogue `form` is `outlet` or `panel` (a fixed pairing —
  // the front jack a patch cord plugs into, the rear punchdown the
  // horizontal run lands on) can be paired front-i to rear-i by index below,
  // once every port exists.
  const portIdsByFace: Record<'front' | 'rear', string[]> = { front: [], rear: [] };

  for (const faceplate of model.faceplates) {
    for (const port of faceplate.ports) {
      const portExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
      working = portExistence.doc;
      const portId = formatNodeId('PhysicalPort', newUlid(now));
      portIdsByFace[faceplate.face].push(portId);
      // `CataloguePort` carries exactly one of `number`/`name` (`api/catalogue.ts`'s
      // module doc, ADR-0050 §5) — a numbered faceplate port labels as its
      // silkscreen number, a named one (a management/console port, e.g. `"me0"`)
      // as the vendor's own word. `String(port.number)` alone would write the
      // literal text "null" for every named port and break `view.ts`'s
      // (label, connector) faceplate match for it.
      const labelText = port.name ?? String(port.number);
      const label = setField(working, now, actor, portId, undefined, 'PhysicalPort.label', text(labelText));
      working = label.doc;
      // The schema's own token for the catalogue's port kind (`"RJ45"` is
      // written as `rj45`): `connectorTokenOf` in `compat.ts` says why, and
      // `view.ts` maps the same way when it finds the port on its faceplate.
      const connector = setField(working, now, actor, portId, undefined, 'PhysicalPort.connector', token(connectorTokenOf(port.kind)));
      working = connector.doc;
      // ADR-0051 §1 — `PhysicalPort.face` written straight from the
      // catalogue faceplate this port came off, for every port (not just
      // the ones the drawing later has to guess at — `view.ts`'s `portView`
      // still falls back to the faceplate match for a document some other
      // writer produced, but placement itself now always asserts it).
      const faceField = setField(working, now, actor, portId, undefined, 'PhysicalPort.face', token(faceplate.face));
      working = faceField.doc;
      working = withNode(working, {
        id: portId,
        existence: portExistence.id,
        fields: {
          'PhysicalPort.label': label.entry,
          'PhysicalPort.connector': connector.entry,
          'PhysicalPort.face': faceField.entry,
        },
      });
      ops.push({ type: 'add_node', node: portId, prov: portExistence.id }, label.op, connector.op, faceField.op);

      const hasPortProv = assertHand(working, { assertedAt: now, assertedBy: actor });
      working = hasPortProv.doc;
      const hasPortId = formatEdgeId('HasPort', newUlid(now));
      working = withEdge(working, { id: hasPortId, from: chassisId, to: portId, prov: hasPortProv.id, fields: {} });
      ops.push({ type: 'add_edge', edge: hasPortId, from: chassisId, to: portId, prov: hasPortProv.id });
    }
  }

  // ADR-0051 §1 — a model whose catalogue `form` is `outlet` or `panel` is a
  // fixed pairing: the front jack a patch cord plugs into and the rear
  // punchdown the horizontal run lands on are "the same hole"
  // (`PassThrough`'s own schema doc), paired front-i to rear-i by index.
  // `api/catalogue.ts` does not yet declare `CatalogueModel.form` — read
  // defensively (a cast, not a schema field access) so this activates the
  // moment it does, without this module owning that file.
  const catalogueForm = (model as CatalogueModel & { form?: string }).form;
  if (catalogueForm === 'outlet' || catalogueForm === 'panel') {
    const front = portIdsByFace.front;
    const rear = portIdsByFace.rear;
    const pairCount = Math.min(front.length, rear.length);
    for (let i = 0; i < pairCount; i += 1) {
      const passProv = assertHand(working, { assertedAt: now, assertedBy: actor });
      working = passProv.doc;
      const passId = formatEdgeId('PassThrough', newUlid(now));
      working = withEdge(working, { id: passId, from: front[i], to: rear[i], prov: passProv.id, fields: {} });
      ops.push({ type: 'add_edge', edge: passId, from: front[i], to: rear[i], prov: passProv.id });
    }
  }

  // Power inlets (ADR-0050 §3/§4). A model whose faceplate ports are
  // themselves `c13` outlets (a PDU) already got them in the loop above and
  // needs nothing here.
  //
  // Every OTHER catalogue slot gets an inlet here, placed as FITTED: placing
  // a model from the catalogue assumes every slot shipped populated, because
  // a new device ships with its supplies — a user who later pulls one to
  // record a genuinely empty bay does so through `supplies.ts`'s
  // `removeSupply`, which is the moment "empty" becomes a fact someone
  // asserted rather than a guess made here.
  //
  //   - `hotSwap: false` (a fixed, non-removable supply): the inlet stays a
  //     `PhysicalPort` directly on the CHASSIS, exactly as before this
  //     session — there is no separate field-replaceable part to record
  //     (ADR-0050 §4, schema.yaml's `PowerSupply` doc: "it never gets a
  //     PowerSupply node, because there is no separate part to record").
  //   - `hotSwap: true`: the inlet moves to a fresh `PowerSupply` node,
  //     seated in this chassis by `FittedIn` (containment — `schema/schema.yaml`'s
  //     `FittedIn` doc), because on a hot-swappable unit the socket is on the
  //     SUPPLY, not the chassis (`PowerSupply` joins the `PortHost` class for
  //     exactly this). `HasPort` from a `PowerSupply` to its inlet is legal
  //     as of `HasPort.from: [Chassis, PassiveNode, PowerSupply]`
  //     (`schema/schema.yaml`, ADR-0050 §4 follow-up, commit a68d1a1).
  //
  // Neither branch writes `PhysicalPort.position`: `PortPosition`
  // (`schema/schema.yaml`'s `position` field type) is, on the wire, a
  // field-less stub — `crates/fathom-ir/src/canon.rs`'s `unit_canon!` macro
  // round-trips it as nothing but an empty JSON object, so there is no slot/
  // column to carry through it yet. The slot's own position (row, column,
  // face) is carried instead by the catalogue itself and read back in
  // `view.ts`, which already has the slot name (`PhysicalPort.label` /
  // `PowerSupply.slot`) to join on.
  for (const slot of model.psuSlots) {
    if (!slot.hotSwap) {
      const inletExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
      working = inletExistence.doc;
      const inletId = formatNodeId('PhysicalPort', newUlid(now));
      const inletLabel = setField(working, now, actor, inletId, undefined, 'PhysicalPort.label', text(slot.name));
      working = inletLabel.doc;
      const inletConnector = setField(working, now, actor, inletId, undefined, 'PhysicalPort.connector', token('c14'));
      working = inletConnector.doc;
      const inletService = setField(working, now, actor, inletId, undefined, 'PhysicalPort.service', token('power'));
      working = inletService.doc;
      // ADR-0051 §1 — the inlet's own face, from the catalogue's PSU slot.
      const inletFace = setField(working, now, actor, inletId, undefined, 'PhysicalPort.face', token(slot.face));
      working = inletFace.doc;
      working = withNode(working, {
        id: inletId,
        existence: inletExistence.id,
        fields: {
          'PhysicalPort.label': inletLabel.entry,
          'PhysicalPort.connector': inletConnector.entry,
          'PhysicalPort.service': inletService.entry,
          'PhysicalPort.face': inletFace.entry,
        },
      });
      ops.push(
        { type: 'add_node', node: inletId, prov: inletExistence.id },
        inletLabel.op,
        inletConnector.op,
        inletService.op,
        inletFace.op,
      );

      const hasInletProv = assertHand(working, { assertedAt: now, assertedBy: actor });
      working = hasInletProv.doc;
      const hasInletId = formatEdgeId('HasPort', newUlid(now));
      working = withEdge(working, { id: hasInletId, from: chassisId, to: inletId, prov: hasInletProv.id, fields: {} });
      ops.push({ type: 'add_edge', edge: hasInletId, from: chassisId, to: inletId, prov: hasInletProv.id });
      continue;
    }

    // hotSwap: true — a PowerSupply, fitted in this slot, carries its own inlet.
    const supplyExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = supplyExistence.doc;
    const supplyId = formatNodeId('PowerSupply', newUlid(now));
    const supplySlot = setField(working, now, actor, supplyId, undefined, 'PowerSupply.slot', text(slot.name));
    working = supplySlot.doc;
    working = withNode(working, {
      id: supplyId,
      existence: supplyExistence.id,
      fields: { 'PowerSupply.slot': supplySlot.entry },
    });
    ops.push({ type: 'add_node', node: supplyId, prov: supplyExistence.id }, supplySlot.op);

    const fittedProv = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = fittedProv.doc;
    const fittedId = formatEdgeId('FittedIn', newUlid(now));
    working = withEdge(working, { id: fittedId, from: chassisId, to: supplyId, prov: fittedProv.id, fields: {} });
    ops.push({ type: 'add_edge', edge: fittedId, from: chassisId, to: supplyId, prov: fittedProv.id });

    const inletExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = inletExistence.doc;
    const inletId = formatNodeId('PhysicalPort', newUlid(now));
    const inletLabel = setField(working, now, actor, inletId, undefined, 'PhysicalPort.label', text(slot.name));
    working = inletLabel.doc;
    const inletConnector = setField(working, now, actor, inletId, undefined, 'PhysicalPort.connector', token('c14'));
    working = inletConnector.doc;
    const inletService = setField(working, now, actor, inletId, undefined, 'PhysicalPort.service', token('power'));
    working = inletService.doc;
    // ADR-0051 §1 — the inlet's own face, from the catalogue's PSU slot.
    const inletFace = setField(working, now, actor, inletId, undefined, 'PhysicalPort.face', token(slot.face));
    working = inletFace.doc;
    working = withNode(working, {
      id: inletId,
      existence: inletExistence.id,
      fields: {
        'PhysicalPort.label': inletLabel.entry,
        'PhysicalPort.connector': inletConnector.entry,
        'PhysicalPort.service': inletService.entry,
        'PhysicalPort.face': inletFace.entry,
      },
    });
    ops.push(
      { type: 'add_node', node: inletId, prov: inletExistence.id },
      inletLabel.op,
      inletConnector.op,
      inletService.op,
      inletFace.op,
    );

    const hasInletProv = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = hasInletProv.doc;
    const hasInletId = formatEdgeId('HasPort', newUlid(now));
    working = withEdge(working, { id: hasInletId, from: supplyId, to: inletId, prov: hasInletProv.id, fields: {} });
    ops.push({ type: 'add_edge', edge: hasInletId, from: supplyId, to: inletId, prov: hasInletProv.id });
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
  // ADR-0051 widened placement from MountedIn alone to MountedIn/SitsOn/
  // FixedTo — whichever is live must be tombstoned with the chassis, or the
  // shelf slot (or surface spot) it names stays occupied forever.
  const placement = livePlacementEdge(doc, chassisId);

  const { now } = resolve(opts);
  const nodeIds = new Set([deviceId, chassisId, ...ports.map((p) => p.to)]);
  const edgeIds = new Set([hasChassis.id, ...ports.map((p) => p.id), ...(placement ? [placement.id] : [])]);

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

// ===========================================================================
// ADR-0051 §1 — shelves, surfaces, the sketch: shapes schema 0.8 adds.
// `Placement` (`view.ts`) is this half's shared vocabulary: `movePlacement`
// below is its write-side mirror, and `view.ts`'s `placementOf` is the read
// side — the same union both ways, so a caller never has to translate.

export class NotAShelfError extends Error {
  readonly shelfId: string;
  constructor(shelfId: string) {
    super(`"${shelfId}" is not a PassiveNode of form shelf`);
    this.name = 'NotAShelfError';
    this.shelfId = shelfId;
  }
}

export class SlotTakenError extends Error {
  readonly shelfId: string;
  readonly slot: number;
  constructor(shelfId: string, slot: number) {
    super(`shelf "${shelfId}" slot ${slot} is already occupied`);
    this.name = 'SlotTakenError';
    this.shelfId = shelfId;
    this.slot = slot;
  }
}

/** Refused: `itemId` already has a live placement (`MountedIn`, `SitsOn` or
 * `FixedTo`) — `placeChassis`, `createShelf`, `placeOnShelf` and `fixTo` are
 * all FIRST placements; changing one already placed is `movePlacement`'s own
 * job (`schema/schema.yaml`'s `FixedTo` doc: "a Chassis or PassiveNode has
 * AT MOST ONE of MountedIn, SitsOn and FixedTo — one box is in one place"). */
export class AlreadyPlacedError extends Error {
  readonly itemId: string;
  constructor(itemId: string) {
    super(`"${itemId}" already has a placement — use movePlacement to change it`);
    this.name = 'AlreadyPlacedError';
    this.itemId = itemId;
  }
}

export class InvalidFixedToTargetError extends Error {
  readonly targetId: string;
  constructor(targetId: string) {
    super(`"${targetId}" is not a Surface or a PassiveNode of form board`);
    this.name = 'InvalidFixedToTargetError';
    this.targetId = targetId;
  }
}

/** Refused: `addSketchPort` on a chassis that already has a catalogue model
 * — its ports come from the faceplate, `placeChassis` wrote them already,
 * and typing one by hand on top would be a second, conflicting account of
 * the same faceplate (item 6's own contract: "a chassis with a model
 * refuses addSketchPort"). */
export class SketchOnCatalogueChassisError extends Error {
  readonly chassisId: string;
  constructor(chassisId: string) {
    super(`chassis "${chassisId}" has a catalogue model — its ports are not typed by hand`);
    this.name = 'SketchOnCatalogueChassisError';
    this.chassisId = chassisId;
  }
}

const PLACEMENT_EDGE_KINDS: readonly EdgeKind[] = ['MountedIn', 'SitsOn', 'FixedTo'];

/** The one live placement edge `itemId` (a Chassis or PassiveNode) carries,
 * if any — `schema/schema.yaml`'s own invariant: at most one of the three. */
function livePlacementEdge(doc: Document, itemId: string): GraphEdge | undefined {
  for (const kind of PLACEMENT_EDGE_KINDS) {
    const edge = edgesOut(doc, itemId, kind)[0];
    if (edge) return edge;
  }
  return undefined;
}

function refuseIfAlreadyPlaced(doc: Document, itemId: string): void {
  if (livePlacementEdge(doc, itemId)) throw new AlreadyPlacedError(itemId);
}

function requireLiveItem(doc: Document, itemId: string, wanted: string): GraphNode {
  const node = findNode(doc, itemId);
  if (!node || node.absentSince !== undefined) throw new UnknownReferenceError(itemId, wanted);
  return node;
}

function requireShelf(doc: Document, shelfId: string): GraphNode {
  const node = findNode(doc, shelfId);
  if (!node || node.absentSince !== undefined) throw new UnknownReferenceError(shelfId, 'a shelf');
  if (parseNodeId(shelfId).kind !== 'PassiveNode' || readPassiveNodeFields(node).form !== 'shelf') {
    throw new NotAShelfError(shelfId);
  }
  return node;
}

/** Every slot a LIVE `SitsOn` already occupies on `shelfId`, `exceptItemId`'s
 * own (if any) excluded — the same exclusion `checkPlacement`'s
 * `exceptChassisId` gives a rack move onto the run a chassis already
 * occupies. */
function occupiedSlots(doc: Document, shelfId: string, exceptItemId?: string): Set<number> {
  const out = new Set<number>();
  for (const edge of edgesIn(doc, shelfId, 'SitsOn')) {
    if (edge.from === exceptItemId) continue;
    // A live SitsOn whose occupant node is itself absent is a stale edge
    // (documents written before this tombstoned it with its chassis) — skip
    // so an old file self-heals instead of holding the slot forever.
    const occupant = findNode(doc, edge.from);
    if (!occupant || occupant.absentSince !== undefined) continue;
    const slot = readSitsOnFields(edge).slot;
    if (slot !== undefined) out.add(slot);
  }
  return out;
}

/** A `FixedTo` target: a live `Surface`, or a live `PassiveNode` of form
 * `board` standing in for one (`schema/schema.yaml`'s `FixedTo` doc: "the
 * schema cannot say the PassiveNode limb of `to:` is form board … the
 * client refuses"). */
function requireFixedToTarget(doc: Document, targetId: string): GraphNode {
  const node = findNode(doc, targetId);
  if (!node || node.absentSince !== undefined) throw new UnknownReferenceError(targetId, 'a Surface or board');
  const kind = parseNodeId(targetId).kind;
  if (kind === 'Surface') return node;
  if (kind === 'PassiveNode' && readPassiveNodeFields(node).form === 'board') return node;
  throw new InvalidFixedToTargetError(targetId);
}

// ---------------------------------------------------------------------------

export interface CreateShelfOptions extends Actor {
  positionU: number;
  /** Only `rackUnits` is read — a shelf has no ports/PSU slots of its own
   * (its OCCUPANTS carry those); `PassiveNode.model` is set when given, for
   * the same reason `placeChassis` sets `Chassis.model`. */
  model?: CatalogueModel;
}

/**
 * ADR-0051 §1 — a `PassiveNode` of form `shelf`, `MountedIn` `rackId` at
 * `positionU`; `heightU` from `opts.model.rackUnits` when given, else `1`
 * (the same "absent renders as 1U, marked unstated" rule `placeChassis`'s
 * own `MountedIn.height_u` follows). `PassiveNode.label` is deliberately
 * left unset — nobody has typed a name for this shelf yet, `placeChassis`'s
 * own reason for leaving `Device.hostname` unset. Refuses an out-of-range or
 * overlapping run exactly as `placeChassis` does (`checkPlacement`, shared).
 */
export function createShelf(doc: Document, rackId: string, opts: CreateShelfOptions): Document {
  const heightU = opts.model?.rackUnits ?? 1;
  checkPlacement(doc, rackId, rackHeightU(doc, rackId), opts.positionU, heightU);
  const { actor, now } = resolve(opts);

  let working = doc;
  const ops: Op[] = [];

  const shelfExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = shelfExistence.doc;
  const shelfId = formatNodeId('PassiveNode', newUlid(now));
  const formField = setField(working, now, actor, shelfId, undefined, 'PassiveNode.form', token('shelf'));
  working = formField.doc;
  const shelfFields: Record<string, FieldEntry> = { 'PassiveNode.form': formField.entry };
  const fieldOps: Op[] = [formField.op];
  if (opts.model) {
    const modelField = setField(working, now, actor, shelfId, undefined, 'PassiveNode.model', identifier(opts.model.model));
    working = modelField.doc;
    shelfFields['PassiveNode.model'] = modelField.entry;
    fieldOps.push(modelField.op);
  }
  working = withNode(working, { id: shelfId, existence: shelfExistence.id, fields: shelfFields });
  ops.push({ type: 'add_node', node: shelfId, prov: shelfExistence.id }, ...fieldOps);

  const mountedProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = mountedProv.doc;
  const mountedId = formatEdgeId('MountedIn', newUlid(now));
  const positionEntry = setField(working, now, actor, mountedId, undefined, 'MountedIn.position_u', uint(opts.positionU, 8));
  working = positionEntry.doc;
  const heightEntry = setField(working, now, actor, mountedId, undefined, 'MountedIn.height_u', uint(heightU, 8));
  working = heightEntry.doc;
  const faceEntry = setField(working, now, actor, mountedId, undefined, 'MountedIn.face', token('front'));
  working = faceEntry.doc;
  working = withEdge(working, {
    id: mountedId,
    from: shelfId,
    to: rackId,
    prov: mountedProv.id,
    fields: {
      'MountedIn.position_u': positionEntry.entry,
      'MountedIn.height_u': heightEntry.entry,
      'MountedIn.face': faceEntry.entry,
    },
  });
  ops.push(
    { type: 'add_edge', edge: mountedId, from: shelfId, to: rackId, prov: mountedProv.id },
    positionEntry.op,
    heightEntry.op,
    faceEntry.op,
  );

  const batch: Batch = { id: newUlid(now), label: 'create shelf', ops };
  return withBatch(working, batch);
}

// ---------------------------------------------------------------------------

/**
 * ADR-0051 §1 — `SitsOn`, seating `itemId` (a Chassis or PassiveNode) on
 * `shelfId` at `slot`. Refuses: `shelfId` is not a live PassiveNode of form
 * `shelf` (`NotAShelfError`), `itemId` unknown (`UnknownReferenceError`),
 * `slot` already occupied (`SlotTakenError`), or `itemId` already has a
 * placement elsewhere (`AlreadyPlacedError` — move it with `movePlacement`).
 */
export function placeOnShelf(doc: Document, itemId: string, shelfId: string, slot: number, opts?: Actor): Document {
  requireShelf(doc, shelfId);
  requireLiveItem(doc, itemId, 'a Chassis or PassiveNode');
  refuseIfAlreadyPlaced(doc, itemId);
  if (occupiedSlots(doc, shelfId).has(slot)) throw new SlotTakenError(shelfId, slot);

  const { actor, now } = resolve(opts);
  let working = doc;

  const prov = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = prov.doc;
  const edgeId = formatEdgeId('SitsOn', newUlid(now));
  const slotField = setField(working, now, actor, edgeId, undefined, 'SitsOn.slot', uint(slot, 8));
  working = slotField.doc;
  working = withEdge(working, { id: edgeId, from: itemId, to: shelfId, prov: prov.id, fields: { 'SitsOn.slot': slotField.entry } });

  const batch: Batch = {
    id: newUlid(now),
    label: 'place on shelf',
    ops: [{ type: 'add_edge', edge: edgeId, from: itemId, to: shelfId, prov: prov.id }, slotField.op],
  };
  return withBatch(working, batch);
}

// ---------------------------------------------------------------------------

/** `Surface.form` (`schema/schema.yaml`), verbatim — "deliberately no
 * `other`: a surface a person cannot name as one of these four is not yet a
 * surface worth fixing anything to." */
export const SURFACE_FORMS = ['wall', 'floor', 'desk', 'ceiling'] as const;
export type SurfaceForm = (typeof SURFACE_FORMS)[number];

export function isSurfaceForm(s: string): s is SurfaceForm {
  return (SURFACE_FORMS as readonly string[]).includes(s);
}

export interface CreateSurfaceOptions extends Actor {
  label: string;
  form: SurfaceForm;
  widthMm?: number;
  heightMm?: number;
}

/**
 * ADR-0051 §1 — a `Surface`, `HasSurface`'d off `premisesId`. Refuses an
 * unknown premises (`UnknownReferenceError`) or a `form` outside
 * `SURFACE_FORMS` (`FieldValueError`, `edit.ts`'s own class, reused rather
 * than duplicated — this module now imports it, see the module-level doc on
 * why `UnknownReferenceError` moved to `model.ts` to keep that import from
 * becoming a cycle).
 */
export function createSurface(doc: Document, premisesId: string, opts: CreateSurfaceOptions): Document {
  if (!findNode(doc, premisesId)) throw new UnknownReferenceError(premisesId, 'Premises');
  if (!isSurfaceForm(opts.form)) {
    throw new FieldValueError('Surface.form', opts.form, `is not one of: ${SURFACE_FORMS.join(', ')}`);
  }
  const { actor, now } = resolve(opts);
  let working = doc;
  const ops: Op[] = [];

  const existence = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = existence.doc;
  const surfaceId = formatNodeId('Surface', newUlid(now));

  const labelField = setField(working, now, actor, surfaceId, undefined, 'Surface.label', text(opts.label));
  working = labelField.doc;
  const formField = setField(working, now, actor, surfaceId, undefined, 'Surface.form', token(opts.form));
  working = formField.doc;
  const surfaceFields: Record<string, FieldEntry> = {
    'Surface.label': labelField.entry,
    'Surface.form': formField.entry,
  };
  const fieldOps: Op[] = [labelField.op, formField.op];
  if (opts.widthMm !== undefined) {
    const widthField = setField(working, now, actor, surfaceId, undefined, 'Surface.width_mm', uint(opts.widthMm, 32));
    working = widthField.doc;
    surfaceFields['Surface.width_mm'] = widthField.entry;
    fieldOps.push(widthField.op);
  }
  if (opts.heightMm !== undefined) {
    const heightField = setField(working, now, actor, surfaceId, undefined, 'Surface.height_mm', uint(opts.heightMm, 32));
    working = heightField.doc;
    surfaceFields['Surface.height_mm'] = heightField.entry;
    fieldOps.push(heightField.op);
  }
  working = withNode(working, { id: surfaceId, existence: existence.id, fields: surfaceFields });
  ops.push({ type: 'add_node', node: surfaceId, prov: existence.id }, ...fieldOps);

  const edgeProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = edgeProv.doc;
  const edgeId = formatEdgeId('HasSurface', newUlid(now));
  working = withEdge(working, { id: edgeId, from: premisesId, to: surfaceId, prov: edgeProv.id, fields: {} });
  ops.push({ type: 'add_edge', edge: edgeId, from: premisesId, to: surfaceId, prov: edgeProv.id });

  const batch: Batch = { id: newUlid(now), label: 'create surface', ops };
  return withBatch(working, batch);
}

// ---------------------------------------------------------------------------

export interface FixToFields {
  xMm?: number;
  yMm?: number;
}

/**
 * ADR-0051 §1 — `FixedTo`, fixing `itemId` (a Chassis or PassiveNode) to
 * `targetId` (a Surface, or a PassiveNode of form board). Refuses: `itemId`
 * unknown, `targetId` neither a Surface nor a board (`InvalidFixedToTargetError`),
 * or `itemId` already placed elsewhere (`AlreadyPlacedError`). `xMm`/`yMm`
 * are both optional — a surface fixed before it was measured has said
 * something true (`FixedTo`'s own schema doc).
 */
export function fixTo(doc: Document, itemId: string, targetId: string, fields: FixToFields = {}, opts?: Actor): Document {
  requireLiveItem(doc, itemId, 'a Chassis or PassiveNode');
  requireFixedToTarget(doc, targetId);
  refuseIfAlreadyPlaced(doc, itemId);

  const { actor, now } = resolve(opts);
  let working = doc;

  const prov = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = prov.doc;
  const edgeId = formatEdgeId('FixedTo', newUlid(now));
  const edgeFields: Record<string, FieldEntry> = {};
  const fieldOps: Op[] = [];
  if (fields.xMm !== undefined) {
    const x = setField(working, now, actor, edgeId, undefined, 'FixedTo.x_mm', uint(fields.xMm, 32));
    working = x.doc;
    edgeFields['FixedTo.x_mm'] = x.entry;
    fieldOps.push(x.op);
  }
  if (fields.yMm !== undefined) {
    const y = setField(working, now, actor, edgeId, undefined, 'FixedTo.y_mm', uint(fields.yMm, 32));
    working = y.doc;
    edgeFields['FixedTo.y_mm'] = y.entry;
    fieldOps.push(y.op);
  }
  working = withEdge(working, { id: edgeId, from: itemId, to: targetId, prov: prov.id, fields: edgeFields });

  const batch: Batch = {
    id: newUlid(now),
    label: 'fix to',
    ops: [{ type: 'add_edge', edge: edgeId, from: itemId, to: targetId, prov: prov.id }, ...fieldOps],
  };
  return withBatch(working, batch);
}

// ---------------------------------------------------------------------------

/**
 * ADR-0051 §1 — moves `itemId` (already placed or not) to `placement`.
 * Whichever of `MountedIn` / `SitsOn` / `FixedTo` is currently live for
 * `itemId` is tombstoned; `placement.kind`'s matching edge is written fresh
 * (`'none'` tombstones without writing a replacement — an item with no
 * placement at all). Exactly one survives at any moment
 * (`schema/schema.yaml`'s `FixedTo` doc: "one box is in one place").
 *
 * A move to `'rack'` carries forward the item's own last `MountedIn.height_u`
 * when it had one (the same "absent renders as 1U" default `moveChassis`
 * already uses — `movePlacement` takes no catalogue model, so it cannot
 * re-derive a height any other way) and is checked against the target rack's
 * run exactly as `placeChassis`/`moveChassis` are (`checkPlacement`,
 * shared). A move to `'shelf'` is checked against that shelf's own occupied
 * slots. A move to `'surface'`/`'board'` is checked against `requireFixedToTarget`.
 * "A chassis on a shelf or a surface has no unit" — no `MountedIn` edge is
 * written for either, so there is no `positionU`/`heightU` to read.
 */
export function movePlacement(doc: Document, itemId: string, placement: Placement, opts?: Actor): Document {
  requireLiveItem(doc, itemId, 'a Chassis or PassiveNode');
  const { actor, now } = resolve(opts);

  const existing = livePlacementEdge(doc, itemId);
  const priorHeightU =
    existing && parseEdgeId(existing.id).kind === 'MountedIn' ? (readMountedInFields(existing).heightU ?? 1) : undefined;

  let working = doc;
  const ops: Op[] = [];
  if (existing) {
    working = { ...working, edges: working.edges.map((e) => (e.id === existing.id ? { ...e, absentSince: now } : e)) };
    ops.push({ type: 'tombstone', element: existing.id, at: now, by: actor });
  }

  if (placement.kind === 'rack') {
    const heightU = priorHeightU ?? 1;
    checkPlacement(working, placement.rackId, rackHeightU(working, placement.rackId), placement.positionU, heightU, itemId);

    const mountedProv = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = mountedProv.doc;
    const mountedId = formatEdgeId('MountedIn', newUlid(now));
    const positionEntry = setField(working, now, actor, mountedId, undefined, 'MountedIn.position_u', uint(placement.positionU, 8));
    working = positionEntry.doc;
    const heightEntry = setField(working, now, actor, mountedId, undefined, 'MountedIn.height_u', uint(heightU, 8));
    working = heightEntry.doc;
    const faceEntry = setField(working, now, actor, mountedId, undefined, 'MountedIn.face', token(placement.face));
    working = faceEntry.doc;
    working = withEdge(working, {
      id: mountedId,
      from: itemId,
      to: placement.rackId,
      prov: mountedProv.id,
      fields: {
        'MountedIn.position_u': positionEntry.entry,
        'MountedIn.height_u': heightEntry.entry,
        'MountedIn.face': faceEntry.entry,
      },
    });
    ops.push(
      { type: 'add_edge', edge: mountedId, from: itemId, to: placement.rackId, prov: mountedProv.id },
      positionEntry.op,
      heightEntry.op,
      faceEntry.op,
    );
  } else if (placement.kind === 'shelf') {
    requireShelf(working, placement.shelfId);
    if (occupiedSlots(working, placement.shelfId, itemId).has(placement.slot)) {
      throw new SlotTakenError(placement.shelfId, placement.slot);
    }

    const prov = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = prov.doc;
    const edgeId = formatEdgeId('SitsOn', newUlid(now));
    const slotField = setField(working, now, actor, edgeId, undefined, 'SitsOn.slot', uint(placement.slot, 8));
    working = slotField.doc;
    working = withEdge(working, {
      id: edgeId,
      from: itemId,
      to: placement.shelfId,
      prov: prov.id,
      fields: { 'SitsOn.slot': slotField.entry },
    });
    ops.push({ type: 'add_edge', edge: edgeId, from: itemId, to: placement.shelfId, prov: prov.id }, slotField.op);
  } else if (placement.kind === 'surface' || placement.kind === 'board') {
    const targetId = placement.kind === 'surface' ? placement.surfaceId : placement.boardId;
    requireFixedToTarget(working, targetId);

    const prov = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = prov.doc;
    const edgeId = formatEdgeId('FixedTo', newUlid(now));
    const edgeFields: Record<string, FieldEntry> = {};
    const fieldOps: Op[] = [];
    if (placement.xMm !== null) {
      const x = setField(working, now, actor, edgeId, undefined, 'FixedTo.x_mm', uint(placement.xMm, 32));
      working = x.doc;
      edgeFields['FixedTo.x_mm'] = x.entry;
      fieldOps.push(x.op);
    }
    if (placement.yMm !== null) {
      const y = setField(working, now, actor, edgeId, undefined, 'FixedTo.y_mm', uint(placement.yMm, 32));
      working = y.doc;
      edgeFields['FixedTo.y_mm'] = y.entry;
      fieldOps.push(y.op);
    }
    working = withEdge(working, { id: edgeId, from: itemId, to: targetId, prov: prov.id, fields: edgeFields });
    ops.push({ type: 'add_edge', edge: edgeId, from: itemId, to: targetId, prov: prov.id }, ...fieldOps);
  }
  // 'none': nothing further to write — the tombstone above is the whole edit.

  const batch: Batch = { id: newUlid(now), label: 'move placement', ops };
  return withBatch(working, batch);
}

// ---------------------------------------------------------------------------

export interface AddSketchPortFields {
  label: string;
  connector: string;
  service?: string;
  face: 'front' | 'rear';
}

/**
 * ADR-0051 §1 — a `PhysicalPort`, typed by hand onto `chassisId` (`HasPort`),
 * the sketch's own faceplate vocabulary (`compat.ts`'s `PORT_CONNECTOR_VALUES`/
 * `PORT_SERVICE_VALUES`, the schema's own tokens). Refuses: `chassisId`
 * unknown, `connector`/`service` outside those vocabularies
 * (`FieldValueError`), or `chassisId` already has a catalogue model
 * (`SketchOnCatalogueChassisError` — a chassis with no model and at least
 * one port is what `view.ts` draws as `sketch: true`).
 */
export function addSketchPort(doc: Document, chassisId: string, fields: AddSketchPortFields, opts?: Actor): Document {
  const node = requireLiveItem(doc, chassisId, 'Chassis');
  if (parseNodeId(chassisId).kind !== 'Chassis') throw new UnknownReferenceError(chassisId, 'Chassis');
  if (readChassisFields(node).model !== undefined) throw new SketchOnCatalogueChassisError(chassisId);

  if (!(PORT_CONNECTOR_VALUES as readonly string[]).includes(fields.connector)) {
    throw new FieldValueError('PhysicalPort.connector', fields.connector, `is not one of: ${PORT_CONNECTOR_VALUES.join(', ')}`);
  }
  if (fields.service !== undefined && !(PORT_SERVICE_VALUES as readonly string[]).includes(fields.service)) {
    throw new FieldValueError('PhysicalPort.service', fields.service, `is not one of: ${PORT_SERVICE_VALUES.join(', ')}`);
  }

  const { actor, now } = resolve(opts);
  let working = doc;
  const ops: Op[] = [];

  const portExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = portExistence.doc;
  const portId = formatNodeId('PhysicalPort', newUlid(now));
  const labelField = setField(working, now, actor, portId, undefined, 'PhysicalPort.label', text(fields.label));
  working = labelField.doc;
  const connectorField = setField(working, now, actor, portId, undefined, 'PhysicalPort.connector', token(fields.connector));
  working = connectorField.doc;
  const faceField = setField(working, now, actor, portId, undefined, 'PhysicalPort.face', token(fields.face));
  working = faceField.doc;
  const portFields: Record<string, FieldEntry> = {
    'PhysicalPort.label': labelField.entry,
    'PhysicalPort.connector': connectorField.entry,
    'PhysicalPort.face': faceField.entry,
  };
  const fieldOps: Op[] = [labelField.op, connectorField.op, faceField.op];
  if (fields.service !== undefined) {
    const serviceField = setField(working, now, actor, portId, undefined, 'PhysicalPort.service', token(fields.service));
    working = serviceField.doc;
    portFields['PhysicalPort.service'] = serviceField.entry;
    fieldOps.push(serviceField.op);
  }
  working = withNode(working, { id: portId, existence: portExistence.id, fields: portFields });
  ops.push({ type: 'add_node', node: portId, prov: portExistence.id }, ...fieldOps);

  const hasPortProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = hasPortProv.doc;
  const hasPortId = formatEdgeId('HasPort', newUlid(now));
  working = withEdge(working, { id: hasPortId, from: chassisId, to: portId, prov: hasPortProv.id, fields: {} });
  ops.push({ type: 'add_edge', edge: hasPortId, from: chassisId, to: portId, prov: hasPortProv.id });

  const batch: Batch = { id: newUlid(now), label: 'add sketch port', ops };
  return withBatch(working, batch);
}

/**
 * ADR-0051 §1 — the reverse of `addSketchPort`: tombstones the port and its
 * `HasPort` edge. Follows `removeChassis`'s own precedent rather than
 * cascading into `cables.ts`'s `disconnect` (which would make this module
 * import `cables.ts`, and `cables.ts` already imports `UnknownReferenceError`
 * from here — a real cycle, not just an inconvenience): a live cable
 * terminating at the removed port is left as this document already leaves
 * one terminating at a chassis `removeChassis` tombstones.
 */
export function removeSketchPort(doc: Document, chassisId: string, portId: string, opts?: Actor): Document {
  requireLiveItem(doc, chassisId, 'Chassis');
  const hasPort = edgesOut(doc, chassisId, 'HasPort').find((e) => e.to === portId);
  if (!hasPort) throw new UnknownReferenceError(portId, 'a port on this chassis');

  const { actor, now } = resolve(opts);
  const working: Document = {
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === portId ? { ...n, absentSince: now } : n)),
    edges: doc.edges.map((e) => (e.id === hasPort.id ? { ...e, absentSince: now } : e)),
  };
  const ops: Op[] = [
    { type: 'tombstone', element: portId, at: now, by: actor },
    { type: 'tombstone', element: hasPort.id, at: now, by: actor },
  ];
  const batch: Batch = { id: newUlid(now), label: 'remove sketch port', ops };
  return withBatch(working, batch);
}
