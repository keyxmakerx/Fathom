// Power supplies as parts (ADR-0050 §4): the commands `placeChassis`
// (`commands.ts`) does not cover — removing a fitted supply (recording a
// genuinely empty slot) and fitting one back. Same shape as every other
// module here: pure, `Origin::Hand`, one `Batch` per call (`disconnect`'s
// own batch aside — see `removeSupply`'s doc).

import { disconnect } from './cables';
import { UnknownReferenceError } from './commands';
import { FieldValueError } from './edit';
import {
  LOCAL_ACTOR,
  assertHand,
  edgesIn,
  edgesOut,
  findNode,
  formatEdgeId,
  formatNodeId,
  identifier,
  parseEdgeId,
  parseNodeId,
  readPhysicalPortFields,
  readPowerSupplyFields,
  requireFieldName,
  replaceNode,
  text,
  token,
  withBatch,
  withEdge,
  withNode,
  type Batch,
  type Document,
  type FieldEntry,
  type GraphEdge,
  type GraphNode,
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

/** `commands.ts`'s private `setField`, mirrored here for the same reason
 * `cables.ts`'s own copy is: it is private to its module. */
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
  const entry: FieldEntry =
    value === undefined ? { presence: 'absent', prov: prov.id } : { presence: 'set', prov: prov.id, value };
  return {
    doc: prov.doc,
    entry,
    op: { type: 'set_field', element: elementId, key, presence: value === undefined ? 'absent' : 'set', prov: prov.id },
  };
}

/** Refused: `slotName` names no slot this chassis has ever fitted (the
 * document carries no `FittedIn` — live or tombstoned — whose `PowerSupply.slot`
 * matches, and no fixed `c14` inlet of that name either). `fitSupply` takes
 * no catalogue model (its brief signature does not carry one), so it can
 * only refit a slot this document already knows about — the one
 * `placeChassis` itself created and a since-`removeSupply`'d fit emptied
 * (ADR-0050 §4: "the user removes one to record an empty slot"), never a
 * slot invented at this layer. */
export class UnknownSlotError extends Error {
  readonly chassisId: string;
  readonly slot: string;
  constructor(chassisId: string, slot: string) {
    super(`chassis "${chassisId}" has no slot named "${slot}"`);
    this.name = 'UnknownSlotError';
    this.chassisId = chassisId;
    this.slot = slot;
  }
}

export class SlotAlreadyFittedError extends Error {
  readonly chassisId: string;
  readonly slot: string;
  readonly supplyId: string;
  constructor(chassisId: string, slot: string, supplyId: string) {
    super(`chassis "${chassisId}" slot "${slot}" is already fitted (supply "${supplyId}")`);
    this.name = 'SlotAlreadyFittedError';
    this.chassisId = chassisId;
    this.slot = slot;
    this.supplyId = supplyId;
  }
}

/** Refused: `slotName` is a FIXED inlet (`hotSwap: false`, `placeChassis`) —
 * its `c14` port lives directly on the Chassis, never on a `PowerSupply`,
 * because there is no separate field-replaceable part to fit or remove
 * (ADR-0050 §4). */
export class FixedSlotError extends Error {
  readonly chassisId: string;
  readonly slot: string;
  constructor(chassisId: string, slot: string) {
    super(`chassis "${chassisId}" slot "${slot}" is a fixed supply — nothing to fit or remove`);
    this.name = 'FixedSlotError';
    this.chassisId = chassisId;
    this.slot = slot;
  }
}

function requireLiveChassis(doc: Document, chassisId: string): GraphNode {
  const node = findNode(doc, chassisId);
  if (!node || node.absentSince !== undefined) throw new UnknownReferenceError(chassisId, 'Chassis');
  if (parseNodeId(chassisId).kind !== 'Chassis') throw new UnknownReferenceError(chassisId, 'Chassis');
  return node;
}

function requireLiveSupply(doc: Document, supplyId: string): GraphNode {
  const node = findNode(doc, supplyId);
  if (!node || node.absentSince !== undefined) throw new UnknownReferenceError(supplyId, 'PowerSupply');
  if (parseNodeId(supplyId).kind !== 'PowerSupply') throw new UnknownReferenceError(supplyId, 'PowerSupply');
  return node;
}

function fittedInEdges(doc: Document, chassisId: string): GraphEdge[] {
  return doc.edges.filter((e) => e.from === chassisId && parseEdgeId(e.id).kind === 'FittedIn');
}

function fixedInletFor(doc: Document, chassisId: string, slot: string): GraphEdge | undefined {
  return edgesOut(doc, chassisId, 'HasPort').find((e) => {
    const port = findNode(doc, e.to);
    if (!port || port.absentSince !== undefined) return false;
    const fields = readPhysicalPortFields(port);
    return fields.connector === 'c14' && fields.label === slot;
  });
}

// ---------------------------------------------------------------------------

/**
 * Tombstones the `PowerSupply` at `supplyId`, its own inlet `PhysicalPort`
 * (`HasPort` from the supply), the `FittedIn` seating it, and — through
 * `cables.ts`'s `disconnect` — any cable terminating at that inlet. Records
 * an empty slot: `view.ts`'s `psuInlets` reads a slot with no LIVE supply
 * fitted as `fitted: false`.
 *
 * Two batches, not one: `disconnect` is `cables.ts`'s own command, reused
 * rather than duplicated (its `Cable`/`Terminates` tombstones are a
 * complete, independently meaningful edit on their own), and this
 * function's own batch — the supply, its port, and `FittedIn` — follows it.
 * Both share one `now`/`actor` so they read as one moment in the history,
 * even though they are two `Op` groups.
 */
export function removeSupply(doc: Document, supplyId: string, opts?: Actor): Document {
  requireLiveSupply(doc, supplyId);
  const fittedIn = edgesIn(doc, supplyId, 'FittedIn')[0];
  if (!fittedIn) throw new UnknownReferenceError(supplyId, 'a PowerSupply fitted in a Chassis');
  const ports = edgesOut(doc, supplyId, 'HasPort');

  const { actor, now } = resolve(opts);
  let working = doc;

  for (const portEdge of ports) {
    const terminates = edgesIn(working, portEdge.to, 'Terminates')[0];
    if (terminates) working = disconnect(working, terminates.from, { actor, now });
  }

  const nodeIds = new Set([supplyId, ...ports.map((p) => p.to)]);
  const edgeIds = new Set([fittedIn.id, ...ports.map((p) => p.id)]);

  working = {
    ...working,
    nodes: working.nodes.map((n) => (nodeIds.has(n.id) ? { ...n, absentSince: now } : n)),
    edges: working.edges.map((e) => (edgeIds.has(e.id) ? { ...e, absentSince: now } : e)),
  };

  const ops: Op[] = [...nodeIds, ...edgeIds].map((element): Op => ({ type: 'tombstone', element, at: now, by: actor }));
  const batch: Batch = { id: newUlid(now), label: 'remove supply', ops };
  return withBatch(working, batch);
}

// ---------------------------------------------------------------------------

export interface FitSupplyFields {
  serial?: string;
  model?: string;
}

/**
 * Fits a fresh `PowerSupply` into `slotName` on `chassisId` — the reverse of
 * `removeSupply` — with a new inlet `PhysicalPort` (`c14`, `power`), seated
 * by a fresh `FittedIn`. Refuses: `slotName` is not one this chassis has
 * ever fitted (`UnknownSlotError` — see its own doc for why this function,
 * with no catalogue model in its signature, can only refit a known slot),
 * `slotName` is a fixed inlet (`FixedSlotError`), or `slotName` already
 * carries a LIVE supply (`SlotAlreadyFittedError`).
 */
export function fitSupply(
  doc: Document,
  chassisId: string,
  slotName: string,
  fields: FitSupplyFields = {},
  opts?: Actor,
): Document {
  requireLiveChassis(doc, chassisId);

  if (fixedInletFor(doc, chassisId, slotName)) {
    throw new FixedSlotError(chassisId, slotName);
  }

  const known = fittedInEdges(doc, chassisId)
    .map((edge) => ({ edge, supply: findNode(doc, edge.to) }))
    .filter((x): x is { edge: GraphEdge; supply: GraphNode } => x.supply !== undefined)
    .filter((x) => readPowerSupplyFields(x.supply).slot === slotName);

  if (known.length === 0) throw new UnknownSlotError(chassisId, slotName);

  const live = known.find((x) => x.edge.absentSince === undefined && x.supply.absentSince === undefined);
  if (live) throw new SlotAlreadyFittedError(chassisId, slotName, live.supply.id);

  const { actor, now } = resolve(opts);
  let working = doc;
  const ops: Op[] = [];

  const supplyExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = supplyExistence.doc;
  const supplyId = formatNodeId('PowerSupply', newUlid(now));
  const supplyFields: Record<string, FieldEntry> = {};

  const slotField = setField(working, now, actor, supplyId, undefined, 'PowerSupply.slot', text(slotName));
  working = slotField.doc;
  supplyFields['PowerSupply.slot'] = slotField.entry;
  ops.push(slotField.op);

  if (fields.serial !== undefined) {
    const encoded = identifierOrRefuse('PowerSupply.serial', fields.serial);
    const serialField = setField(working, now, actor, supplyId, undefined, 'PowerSupply.serial', encoded);
    working = serialField.doc;
    supplyFields['PowerSupply.serial'] = serialField.entry;
    ops.push(serialField.op);
  }
  if (fields.model !== undefined) {
    const encoded = identifierOrRefuse('PowerSupply.model', fields.model);
    const modelField = setField(working, now, actor, supplyId, undefined, 'PowerSupply.model', encoded);
    working = modelField.doc;
    supplyFields['PowerSupply.model'] = modelField.entry;
    ops.push(modelField.op);
  }

  working = withNode(working, { id: supplyId, existence: supplyExistence.id, fields: supplyFields });
  ops.unshift({ type: 'add_node', node: supplyId, prov: supplyExistence.id });

  const fittedProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = fittedProv.doc;
  const fittedId = formatEdgeId('FittedIn', newUlid(now));
  working = withEdge(working, { id: fittedId, from: chassisId, to: supplyId, prov: fittedProv.id, fields: {} });
  ops.push({ type: 'add_edge', edge: fittedId, from: chassisId, to: supplyId, prov: fittedProv.id });

  const inletExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = inletExistence.doc;
  const inletId = formatNodeId('PhysicalPort', newUlid(now));
  const inletLabel = setField(working, now, actor, inletId, undefined, 'PhysicalPort.label', text(slotName));
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
  working = withEdge(working, { id: hasInletId, from: supplyId, to: inletId, prov: hasInletProv.id, fields: {} });
  ops.push({ type: 'add_edge', edge: hasInletId, from: supplyId, to: inletId, prov: hasInletProv.id });

  const batch: Batch = { id: newUlid(now), label: 'fit supply', ops };
  return withBatch(working, batch);
}

function identifierOrRefuse(field: string, value: string): FieldEntry['value'] {
  try {
    return identifier(value);
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'is not a valid identifier';
    throw new FieldValueError(field, value, reason);
  }
}

// ---------------------------------------------------------------------------

export type SupplyFieldKey = 'serial' | 'model';

/** `PowerSupply.serial` / `.model` (both `Identifier`, `0..1`) — the same
 * shape as `edit.ts`'s `setChassisField`. */
export function setSupplyField(
  doc: Document,
  supplyId: string,
  key: SupplyFieldKey,
  value: string | null,
  opts?: Actor,
): Document {
  const node = requireLiveSupply(doc, supplyId);
  const wireKey = `PowerSupply.${key}`;

  const encoded: FieldEntry['value'] | undefined = value !== null ? identifierOrRefuse(wireKey, value) : undefined;

  const { actor, now } = resolve(opts);
  const built = setField(doc, now, actor, supplyId, node.fields[wireKey], wireKey, encoded);
  const working = replaceNode(built.doc, supplyId, (n) => ({ ...n, fields: { ...n.fields, [wireKey]: built.entry } }));
  const batch: Batch = { id: newUlid(now), label: `set ${wireKey}`, ops: [built.op] };
  return withBatch(working, batch);
}
