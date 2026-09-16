// The contract the drawing renders: a `Document` (plus the catalogue, for
// the facts the graph itself does not carry — a chassis's height in units
// and its faceplate layout) reduced to one premises's racks, each rack's
// mounted chassis, and each chassis's ports.

import { connectorTokenOf } from './compat';
import type { CatalogueFaceplate, CatalogueModel } from '../api/catalogue';
import { SHEATH_VALUES, type Sheath } from './cables';
import type { CableKind } from './compat';
import {
  edgesIn,
  edgesOut,
  findNode,
  parseNodeId,
  readChassisFields,
  readDeviceFields,
  readMountedInFields,
  readPhysicalPortFields,
  readRackFields,
  type Document,
  type GraphEdge,
  type GraphNode,
} from './model';

export type { CableKind, Sheath };

/** The far end of the cable filling a port, or `null` when the port is
 * free. `farPortId`/`farChassisId` are `null` when the far end is an
 * `ExternalPeer` (`connectToOutside`, `cables.ts`) rather than a
 * `PhysicalPort` — the modelling horizon (11 §6.3), same reading `outside`
 * gives `CableView.ends` below. `outsideCloset` is true whenever the far end
 * is not a port mounted in a rack this `ClosetView` itself carries (an
 * ExternalPeer, or a chassis racked at a different Premises). */
export interface CableEndView {
  cableId: string;
  farPortId: string | null;
  farChassisId: string | null;
  outsideCloset: boolean;
}

export interface PortView {
  id: string;
  label: string;
  connector: string;
  row: number;
  column: number;
  uplink: boolean;
  cable: CableEndView | null;
}

export interface ChassisView {
  id: string;
  deviceId: string;
  hostname: string;
  model: string;
  vendor: string;
  positionU: number;
  heightU: number;
  face: 'front' | 'rear';
  ports: PortView[];
  /** `Device.role`, `Device.management_address` and `Chassis.serial` —
   * `null` when the schema field is absent (UI-SPEC "Absent is drawn as
   * absent"; never an empty string standing in for unset). Read straight off
   * `node.fields` rather than through `readDeviceFields`/`readChassisFields`
   * (`document/model.ts`), which this session's brief does not extend. */
  role: string | null;
  managementAddress: string | null;
  serial: string | null;
  /** The chassis's `c14` PSU inlets (`cables.ts`'s `placeChassis` addition,
   * docs/UI-SPEC.md "Power") — kept out of `ports` above, which draws only
   * what the catalogue's own faceplate names. */
  psuInlets: PortView[];
  /** UI-SPEC "Power": true when this chassis has two or more PSU inlets and
   * exactly one of them is fed. A chassis with a single inlet, fed, is not
   * single-fed — it has no second inlet to be short of — it is simply fed;
   * neither is a chassis with two inlets both fed, or neither. */
  singleFed: boolean;
}

export interface RackView {
  id: string;
  label: string;
  heightU: number;
  unitNumbering: string;
  chassis: ChassisView[];
  freeRuns: Array<{ fromU: number; toU: number }>;
}

/** One end of a `Cable` (`view.ts`'s own reduction of `Terminates`): a port
 * this document can locate a rack for, or the outside world. */
export type CableEnd = { portId: string; chassisId: string; rackId: string } | { outside: true; label: string };

export interface CableView {
  id: string;
  kind: CableKind;
  media: string;
  sheath: Sheath | null;
  label: string | null;
  ends: CableEnd[];
}

export interface ClosetView {
  premisesId: string;
  racks: RackView[];
  cables: CableView[];
}

function rowNumber(row: 'top' | 'bottom' | 'single'): number {
  // A drawing-layer grid position, not the catalogue's own token: two rows
  // (`top`/`bottom`) for a paired layout, one for `single`.
  return row === 'bottom' ? 1 : 0;
}

function isLiveNode(n: GraphNode): boolean {
  return n.absentSince === undefined;
}

function catalogueMatch(catalogue: readonly CatalogueModel[], model: string): CatalogueModel | undefined {
  return catalogue.find((m) => m.model === model);
}

/** A field's string value straight off a node's `fields` map, or `null` when
 * it is absent or the node itself was not found — `document/model.ts`'s own
 * `fieldValue`/`asString` are private to that file, so this is a local,
 * read-only equivalent rather than a change to a module outside this
 * session's brief. */
function fieldString(node: GraphNode | undefined, key: string): string | null {
  const entry = node?.fields[key];
  if (!entry || entry.presence !== 'set') return null;
  return typeof entry.value === 'string' ? entry.value : null;
}

/** Whichever live `Terminates` edge lands on `portId` (UI-SPEC "one cable
 * per port" — the command layer, `cables.ts`, refuses a second one; this is
 * a read, so it simply takes the first if that invariant were ever
 * violated by a document from elsewhere), reduced to the far end.
 * `closetRackIds` is the set of rack ids the `ClosetView` being built
 * itself carries — a far port mounted in none of them is `outsideCloset`. */
function portCableView(doc: Document, portId: string, closetRackIds: ReadonlySet<string>): CableEndView | null {
  const near = edgesIn(doc, portId, 'Terminates')[0];
  if (!near) return null;
  const cableId = near.from;
  const far = edgesOut(doc, cableId, 'Terminates').find((e) => e.id !== near.id);
  if (!far) {
    // A one-ended cable (out: "0..2" — the far end may simply not exist yet).
    return { cableId, farPortId: null, farChassisId: null, outsideCloset: false };
  }
  if (parseNodeId(far.to).kind === 'ExternalPeer') {
    return { cableId, farPortId: null, farChassisId: null, outsideCloset: true };
  }
  const farPortId = far.to;
  const farHasPort = edgesIn(doc, farPortId, 'HasPort')[0];
  const farChassisId = farHasPort?.from ?? null;
  const farMounted = farChassisId ? edgesOut(doc, farChassisId, 'MountedIn')[0] : undefined;
  const outsideCloset = !farMounted || !closetRackIds.has(farMounted.to);
  return { cableId, farPortId, farChassisId, outsideCloset };
}

/** One port, positioned from the catalogue faceplate matching the chassis's
 * mounted face. A port whose (label, connector) is not on THAT faceplate
 * belongs to the chassis's other face and is not drawn here — `undefined` —
 * unless there is no catalogue model to consult at all, in which case the
 * port is shown undecorated rather than silently dropped (a real node this
 * document holds is never hidden for want of a catalogue lookup). */
function portView(
  doc: Document,
  portId: string,
  faceplate: CatalogueFaceplate | undefined,
  catalogueModelKnown: boolean,
  closetRackIds: ReadonlySet<string>,
): PortView | undefined {
  const node = findNode(doc, portId);
  const fields = node ? readPhysicalPortFields(node) : {};
  const label = fields.label ?? '';
  const connector = fields.connector ?? '';
  const cable = portCableView(doc, portId, closetRackIds);
  if (faceplate) {
    const match = faceplate.ports.find((p) => String(p.number) === label && connectorTokenOf(p.kind) === connector);
    if (!match) return undefined;
    return {
      id: portId,
      label,
      connector,
      row: rowNumber(match.row),
      column: match.column,
      uplink: match.uplink,
      cable,
    };
  }
  if (catalogueModelKnown) return undefined;
  return { id: portId, label, connector, row: 0, column: 0, uplink: false, cable };
}

/** A `c14` PSU inlet (`cables.ts`'s `placeChassis` addition) — no catalogue
 * faceplate entry to position it from, so `row`/`column` are simply the
 * inlet's own index; the drawing renders these off the left rail
 * (docs/UI-SPEC.md "Power"), not the faceplate grid. */
function psuInletView(doc: Document, portId: string, index: number, closetRackIds: ReadonlySet<string>): PortView {
  const node = findNode(doc, portId);
  const fields = node ? readPhysicalPortFields(node) : {};
  return {
    id: portId,
    label: fields.label ?? '',
    connector: fields.connector ?? '',
    row: 0,
    column: index,
    uplink: false,
    cable: portCableView(doc, portId, closetRackIds),
  };
}

function chassisView(
  doc: Document,
  mountedEdgeId: string,
  catalogue: readonly CatalogueModel[],
  closetRackIds: ReadonlySet<string>,
): ChassisView | undefined {
  const mounted = doc.edges.find((e) => e.id === mountedEdgeId);
  if (!mounted) return undefined;
  const chassisId = mounted.from;
  const chassisNode = findNode(doc, chassisId);
  if (!chassisNode || !isLiveNode(chassisNode)) return undefined;

  const hasChassis = edgesIn(doc, chassisId, 'HasChassis')[0];
  const deviceId = hasChassis?.from ?? '';
  const deviceNode = deviceId ? findNode(doc, deviceId) : undefined;
  const hostname = deviceNode ? (readDeviceFields(deviceNode).hostname ?? '') : '';
  const role = fieldString(deviceNode, 'Device.role');
  const managementAddress = fieldString(deviceNode, 'Device.management_address');
  const serial = fieldString(chassisNode, 'Chassis.serial');

  const chassisFields = readChassisFields(chassisNode);
  const model = chassisFields.model ?? '';
  const catalogueModel = catalogueMatch(catalogue, model);

  const mountedFields = readMountedInFields(mounted);
  const face = mountedFields.face === 'rear' ? 'rear' : 'front';
  const heightU = catalogueModel?.rackUnits ?? mountedFields.heightU ?? 1;

  const faceplate = catalogueModel?.faceplates.find((f) => f.face === face);
  const hasPorts = edgesOut(doc, chassisId, 'HasPort');
  // `c14` PSU inlets (`cables.ts`'s `placeChassis` addition) are kept out of
  // the faceplate `ports` array below regardless of whether a catalogue
  // model is known — the same connector token a real faceplate could in
  // principle use, but these particular nodes never come from one.
  const inletEdges = hasPorts.filter((e) => {
    const portNode = findNode(doc, e.to);
    return portNode !== undefined && readPhysicalPortFields(portNode).connector === 'c14';
  });
  const otherEdges = hasPorts.filter((e) => !inletEdges.includes(e));

  const ports = otherEdges
    .map((e) => portView(doc, e.to, faceplate, catalogueModel !== undefined, closetRackIds))
    .filter((p): p is PortView => p !== undefined);
  const psuInlets = inletEdges.map((e, i) => psuInletView(doc, e.to, i, closetRackIds));
  const fedCount = psuInlets.filter((p) => p.cable !== null).length;
  const singleFed = psuInlets.length >= 2 && fedCount === 1;

  return {
    id: chassisId,
    deviceId,
    hostname,
    model,
    vendor: catalogueModel?.vendor ?? '',
    positionU: mountedFields.positionU ?? 1,
    heightU,
    face,
    ports,
    role,
    managementAddress,
    serial,
    psuInlets,
    singleFed,
  };
}

function freeRuns(rackHeightU: number, chassis: readonly ChassisView[]): Array<{ fromU: number; toU: number }> {
  const occupied = new Array<boolean>(rackHeightU + 1).fill(false); // 1-indexed
  for (const c of chassis) {
    for (let u = c.positionU; u < c.positionU + c.heightU && u <= rackHeightU; u += 1) {
      if (u >= 1) occupied[u] = true;
    }
  }
  const runs: Array<{ fromU: number; toU: number }> = [];
  let runStart: number | undefined;
  for (let u = 1; u <= rackHeightU; u += 1) {
    if (!occupied[u]) {
      if (runStart === undefined) runStart = u;
    } else if (runStart !== undefined) {
      runs.push({ fromU: runStart, toU: u - 1 });
      runStart = undefined;
    }
  }
  if (runStart !== undefined) runs.push({ fromU: runStart, toU: rackHeightU });
  return runs;
}

function rackView(
  doc: Document,
  rackId: string,
  catalogue: readonly CatalogueModel[],
  closetRackIds: ReadonlySet<string>,
): RackView | undefined {
  const node = findNode(doc, rackId);
  if (!node || !isLiveNode(node)) return undefined;
  const fields = readRackFields(node);
  const heightU = fields.heightU ?? 0;
  const chassis = edgesIn(doc, rackId, 'MountedIn')
    .map((e) => chassisView(doc, e.id, catalogue, closetRackIds))
    .filter((c): c is ChassisView => c !== undefined);
  return {
    id: rackId,
    label: fields.label ?? '',
    heightU,
    unitNumbering: fields.unitNumbering ?? '',
    chassis,
    freeRuns: freeRuns(heightU, chassis),
  };
}

/** `media` → `kind` (`compat.ts`'s `CableKind`, docs/UI-SPEC.md "Cables"):
 * `power` is power; `smf`/`mmf` are fibre; everything else (the copper
 * media, plus `virtual`/`other`/an unrecognised token) draws as copper. */
function cableKindOfMedia(media: string): CableKind {
  if (media === 'power') return 'power';
  if (media === 'smf' || media === 'mmf') return 'fibre';
  return 'copper';
}

/** One `Terminates` edge off a `Cable`, resolved: a live `PhysicalPort`
 * mounted somewhere becomes `{portId, chassisId, rackId}`; a live
 * `ExternalPeer` becomes `{outside: true, label}` (`ExternalPeer.label`,
 * `schema/schema.yaml`, card "1" — `''` only if that invariant is somehow
 * violated). Anything this document cannot resolve (a dangling `to`, or a
 * port not currently mounted) is left out of `CableView.ends` rather than
 * guessed. */
function cableEnd(doc: Document, edge: GraphEdge): CableEnd | undefined {
  const kind = parseNodeId(edge.to).kind;
  if (kind === 'ExternalPeer') {
    const peer = findNode(doc, edge.to);
    if (!peer || !isLiveNode(peer)) return undefined;
    return { outside: true, label: fieldString(peer, 'ExternalPeer.label') ?? '' };
  }
  const portId = edge.to;
  const portNode = findNode(doc, portId);
  if (!portNode || !isLiveNode(portNode)) return undefined;
  const hasPort = edgesIn(doc, portId, 'HasPort')[0];
  if (!hasPort) return undefined;
  const chassisId = hasPort.from;
  const mounted = edgesOut(doc, chassisId, 'MountedIn')[0];
  if (!mounted) return undefined;
  return { portId, chassisId, rackId: mounted.to };
}

/** One `Cable` node, reduced for the drawing — `kind` from `media`,
 * `sheath` only when it is one of `SHEATH_VALUES` (`cables.ts`; a document
 * holding anything else is a shape this session's writer never produces),
 * `ends` from whatever live `Terminates` edges this cable actually has
 * (0, 1 — a one-ended or planned cable, 19 §3.4 — or 2). */
function cableView(doc: Document, node: GraphNode): CableView {
  const media = fieldString(node, 'Cable.media') ?? '';
  const sheathRaw = fieldString(node, 'Cable.sheath');
  const sheath = sheathRaw !== null && (SHEATH_VALUES as readonly string[]).includes(sheathRaw) ? (sheathRaw as Sheath) : null;
  const ends = edgesOut(doc, node.id, 'Terminates')
    .map((e) => cableEnd(doc, e))
    .filter((e): e is CableEnd => e !== undefined);
  return {
    id: node.id,
    kind: cableKindOfMedia(media),
    media,
    sheath,
    label: fieldString(node, 'Cable.label'),
    ends,
  };
}

/** The first live `Premises` this document carries, and every live `Rack`
 * `HasRack` hangs off it. A document with none is an empty closet, not a
 * refusal — nothing has been drawn yet. `cables` is every live `Cable` this
 * document holds, regardless of premises: `Cable` is root-level
 * (`cables.ts`'s module doc — `HasCable`'s `from: [root]` is not a
 * containment edge this document ever writes), found the same way `premises`
 * above is, by scanning `doc.nodes` for the kind rather than following an
 * edge — "a cable spans two premises and cannot be contained by one"
 * (`schema/schema.yaml`'s own doc on `HasCable`). */
export function viewOf(doc: Document, catalogue: CatalogueModel[]): ClosetView {
  const premises = doc.nodes.find(
    (n) => isLiveNode(n) && parseNodeId(n.id).kind === 'Premises',
  );
  const cables = doc.nodes
    .filter((n) => isLiveNode(n) && parseNodeId(n.id).kind === 'Cable')
    .map((n) => cableView(doc, n));
  if (!premises) {
    return { premisesId: '', racks: [], cables };
  }
  const rackEdges = edgesOut(doc, premises.id, 'HasRack');
  const closetRackIds = new Set(rackEdges.map((e) => e.to));
  const racks = rackEdges
    .map((e) => rackView(doc, e.to, catalogue, closetRackIds))
    .filter((r): r is RackView => r !== undefined);
  return { premisesId: premises.id, racks, cables };
}
