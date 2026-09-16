// The contract the drawing renders: a `Document` (plus the catalogue, for
// the facts the graph itself does not carry — a chassis's height in units
// and its faceplate layout) reduced to one premises's racks, each rack's
// mounted chassis, and each chassis's ports.

import { connectorTokenOf } from './compat';
import type {
  CataloguePort,
  CatalogueFaceplate,
  CatalogueModel,
  CataloguePsuSlot,
  CatalogueSlotPosition,
} from '../api/catalogue';
import { SHEATH_VALUES, type Sheath } from './cables';
import type { CableKind } from './compat';
import {
  edgesIn,
  edgesOut,
  findNode,
  parseEdgeId,
  parseNodeId,
  readChassisFields,
  readDeviceFields,
  readMountedInFields,
  readPhysicalPortFields,
  readPowerSupplyFields,
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

/** ADR-0050 §1: the FACEPLATE this port sits on — a device's own front or
 * rear panel — never to be confused with `ChassisView.face`, the face of the
 * RACK this chassis is mounted on. A rear-mounted chassis's front faceplate
 * still says `face: 'front'` here; it is the rack elevation, not this port
 * grouping, that decides which faceplate a viewer is looking at at any given
 * moment (ADR-0050 §1: "the rear faceplate of a front-mounted chassis, the
 * front faceplate of a rear-mounted one"). */
export interface PortView {
  id: string;
  label: string;
  connector: string;
  row: number;
  column: number;
  uplink: boolean;
  /** The catalogue's own `role` (`api/catalogue.ts`'s `CataloguePort.role`),
   * carried through when a faceplate match supplies one; `null` for a PSU
   * inlet, a port on no catalogue faceplate, or a chassis with no catalogue
   * entry at all. `uplink` above is derived from this when it is present
   * (`role === 'uplink'`), the catalogue's own `uplink` bit otherwise. */
  role: 'access' | 'uplink' | 'management' | 'console' | null;
  face: 'front' | 'rear';
  cable: CableEndView | null;
}

/** One PSU slot (ADR-0050 §3/§4), joining the catalogue's own `psuSlots`
 * entry with whatever this document has fitted there. `position`/`hotSwap`/
 * `face` are the catalogue's, never guessed: a chassis with no matching
 * catalogue model draws no `InletView`s at all rather than invent them
 * (`psuInletsOf` below). */
export interface InletView extends PortView {
  slot: string;
  hotSwap: boolean;
  /** A fixed slot (`hotSwap: false`) is always `fitted: true` — "no part,
   * nothing to fit or remove" (ADR-0050 §4). A hot-swap slot is `fitted:
   * false` when no LIVE `PowerSupply` occupies it — `supplyId`/`cable` are
   * then both `null` and `id` is a synthetic `slot:<chassisId>:<slotName>`,
   * never a real node's id, so the drawing has something to address the
   * empty bay by without inventing a `PhysicalPort` nobody asserted. */
  fitted: boolean;
  supplyId: string | null;
  /** `PowerSupply.serial`/`.model` — present only when `supplyId` is (a
   * fixed slot's inlet has no `PowerSupply` node to read them off). Not in
   * the brief's own `InletView` sketch, added because the editor
   * (`Editor.tsx`, this session's brief item 5: "serial editable") has
   * nothing else to read a supply's serial from. */
  serial: string | null;
  model: string | null;
  position: CatalogueSlotPosition;
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
  /** The chassis's PSU slots (ADR-0050 §3/§4), one per catalogue
   * `psuSlots` entry — kept out of `ports` above, which draws only what the
   * catalogue's own faceplate names. Empty when the chassis has no matching
   * catalogue model, or the model declares none. */
  psuInlets: InletView[];
  /** UI-SPEC "Power" / ADR-0050 §4: true when this chassis has two or more
   * FITTED inlets and exactly one of them is cabled. A chassis with a single
   * inlet, fed, is not single-fed — it has no second inlet to be short of —
   * it is simply fed; neither is a chassis with two inlets both fed, or
   * neither. */
  singleFed: boolean;
  /** ADR-0050 §4: true when this chassis has two or more PSU slots and at
   * least one of them is empty (no live supply fitted). */
  oneFitted: boolean;
}

export interface RackView {
  id: string;
  label: string;
  heightU: number;
  unitNumbering: string;
  chassis: ChassisView[];
  freeRuns: Array<{ fromU: number; toU: number }>;
  /** ADR-0050 §2 — `Rack.row`/`Rack.bay`, `null` when unset (a rack recorded
   * before its closet stop existed, or one whose row/bay nobody has typed
   * yet). */
  row: string | null;
  bay: number | null;
}

/** One row of the closet, as seen from the front (ADR-0050 §2): racks by
 * bay ascending. A rack with no `row` is its own `RowView`, `label: null`,
 * placed after every named row — never grouped with other unrowed racks,
 * which would assert a shared row nobody stated. The rear elevation's own
 * reversed bay order is a drawing-layer concern (ADR-0050 §2: "The flip is
 * one camera, never a page change"), not this view's — `rows` here is
 * always the one front-ascending order. */
export interface RowView {
  label: string | null;
  racks: RackView[];
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
  /** `racks` grouped into rows (ADR-0050 §2) — see `RowView`'s own doc. */
  rows: RowView[];
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

/** A `CataloguePort`'s own label: the silkscreen number, or the vendor's own
 * word for a named port (ADR-0050 §5; `commands.ts`'s `placeChassis` writes
 * the same choice to `PhysicalPort.label`) — a port carries exactly one of
 * `number`/`name` (`api/catalogue.ts`'s module doc). */
function catalogueLabelOf(port: CataloguePort): string {
  return port.name ?? String(port.number);
}

function faceplatePortMatch(faceplate: CatalogueFaceplate, label: string, connector: string): CataloguePort | undefined {
  return faceplate.ports.find((p) => catalogueLabelOf(p) === label && connectorTokenOf(p.kind) === connector);
}

/** A port's own faceplate role (`api/catalogue.ts`'s `CataloguePort.role`)
 * and the `uplink` bit it derives: `role === 'uplink'` when a role is
 * known, the catalogue's own `uplink` bit otherwise — ADR-0050 §5's
 * "the fuller picture uplink is one bit of". */
function roleAndUplinkOf(match: CataloguePort): { role: PortView['role']; uplink: boolean } {
  if (match.role) return { role: match.role, uplink: match.role === 'uplink' };
  return { role: null, uplink: match.uplink };
}

/** One port, matched against EVERY faceplate the catalogue model declares
 * (ADR-0050 §1: the rear elevation needs a chassis's rear faceplate ports
 * exactly as the front elevation needs its front ones, regardless of which
 * way the chassis is mounted) — tried in the model's own faceplate order,
 * first match wins. A port whose (label, connector) matches no faceplate at
 * all is not drawn here — `undefined` — unless there is no catalogue model
 * to consult, in which case the port is shown undecorated on `fallbackFace`
 * (the chassis's own mounting face, the only face this layer can guess at)
 * rather than silently dropped: a real node this document holds is never
 * hidden for want of a catalogue lookup. */
function portView(
  doc: Document,
  portId: string,
  faceplates: readonly CatalogueFaceplate[],
  catalogueModelKnown: boolean,
  fallbackFace: 'front' | 'rear',
  closetRackIds: ReadonlySet<string>,
): PortView | undefined {
  const node = findNode(doc, portId);
  const fields = node ? readPhysicalPortFields(node) : {};
  const label = fields.label ?? '';
  const connector = fields.connector ?? '';
  const cable = portCableView(doc, portId, closetRackIds);
  for (const faceplate of faceplates) {
    const match = faceplatePortMatch(faceplate, label, connector);
    if (match) {
      const { role, uplink } = roleAndUplinkOf(match);
      return {
        id: portId,
        label,
        connector,
        row: rowNumber(match.row),
        column: match.column,
        uplink,
        role,
        face: faceplate.face,
        cable,
      };
    }
  }
  if (catalogueModelKnown) return undefined;
  return { id: portId, label, connector, row: 0, column: 0, uplink: false, role: null, face: fallbackFace, cable };
}

/** Every LIVE `FittedIn` this chassis has, whichever slot each is in. */
function fittedSupplies(doc: Document, chassisId: string): GraphEdge[] {
  return doc.edges.filter(
    (e) => e.from === chassisId && e.absentSince === undefined && parseEdgeId(e.id).kind === 'FittedIn',
  );
}

/** One `InletView` for a FIXED slot (`hotSwap: false`) — its `c14` inlet is
 * a `PhysicalPort` directly on the chassis (`commands.ts`'s `placeChassis`),
 * matched by `label`. Always `fitted: true` (ADR-0050 §4: nothing to fit or
 * remove); a synthetic id only if the port itself is somehow missing (a
 * document this session's own writer never produces, but `view.ts` never
 * assumes it is the only writer). */
function fixedInletView(
  doc: Document,
  chassisId: string,
  hasPorts: readonly GraphEdge[],
  slot: CataloguePsuSlot,
  closetRackIds: ReadonlySet<string>,
): InletView {
  const edge = hasPorts.find((e) => {
    const p = findNode(doc, e.to);
    if (!p || !isLiveNode(p)) return false;
    const f = readPhysicalPortFields(p);
    return f.connector === 'c14' && f.label === slot.name;
  });
  const node = edge ? findNode(doc, edge.to) : undefined;
  const fields = node ? readPhysicalPortFields(node) : {};
  return {
    id: edge?.to ?? `slot:${chassisId}:${slot.name}`,
    label: fields.label ?? slot.name,
    connector: fields.connector ?? 'c14',
    row: rowNumber(slot.position.row),
    column: slot.position.column,
    uplink: false,
    role: null,
    face: slot.face,
    cable: edge ? portCableView(doc, edge.to, closetRackIds) : null,
    slot: slot.name,
    hotSwap: false,
    fitted: true,
    supplyId: null,
    serial: null,
    model: null,
    position: slot.position,
  };
}

/** One `InletView` for a HOT-SWAP slot (`hotSwap: true`) — a live
 * `PowerSupply`, `FittedIn` this chassis, whose `PowerSupply.slot` matches;
 * `fitted: false` (and a synthetic id) when `removeSupply` (`supplies.ts`)
 * has emptied it, or it was never fitted. */
function hotSwapInletView(
  doc: Document,
  chassisId: string,
  fitted: readonly GraphEdge[],
  slot: CataloguePsuSlot,
  closetRackIds: ReadonlySet<string>,
): InletView {
  const fittedEdge = fitted.find((e) => {
    const supply = findNode(doc, e.to);
    return supply !== undefined && readPowerSupplyFields(supply).slot === slot.name;
  });
  const base = {
    row: rowNumber(slot.position.row),
    column: slot.position.column,
    uplink: false,
    role: null,
    face: slot.face,
    slot: slot.name,
    hotSwap: true as const,
    position: slot.position,
  };
  if (!fittedEdge) {
    return {
      ...base,
      id: `slot:${chassisId}:${slot.name}`,
      label: slot.name,
      connector: 'c14',
      cable: null,
      fitted: false,
      supplyId: null,
      serial: null,
      model: null,
    };
  }
  const supplyId = fittedEdge.to;
  const supplyNode = findNode(doc, supplyId);
  const supplyFields = supplyNode ? readPowerSupplyFields(supplyNode) : {};
  const inletEdge = edgesOut(doc, supplyId, 'HasPort')[0];
  const inletNode = inletEdge ? findNode(doc, inletEdge.to) : undefined;
  const portFields = inletNode ? readPhysicalPortFields(inletNode) : {};
  return {
    ...base,
    id: inletEdge?.to ?? `slot:${chassisId}:${slot.name}`,
    label: portFields.label ?? slot.name,
    connector: portFields.connector ?? 'c14',
    cable: inletEdge ? portCableView(doc, inletEdge.to, closetRackIds) : null,
    fitted: true,
    supplyId,
    serial: supplyFields.serial ?? null,
    model: supplyFields.model ?? null,
  };
}

/** Every PSU slot the catalogue model declares, joined with what this
 * document has fitted (`fixedInletView`/`hotSwapInletView` above). Empty
 * when there is no catalogue model to read `psuSlots` from — `position`,
 * `hotSwap` and `face` all come from the catalogue, never guessed
 * (ADR-0050 §3: "the catalogue stops recording an inlet as a count"). */
function psuInletsOf(
  doc: Document,
  chassisId: string,
  catalogueModel: CatalogueModel | undefined,
  closetRackIds: ReadonlySet<string>,
): InletView[] {
  if (!catalogueModel) return [];
  const hasPorts = edgesOut(doc, chassisId, 'HasPort');
  const fitted = fittedSupplies(doc, chassisId);
  return catalogueModel.psuSlots.map((slot) =>
    slot.hotSwap
      ? hotSwapInletView(doc, chassisId, fitted, slot, closetRackIds)
      : fixedInletView(doc, chassisId, hasPorts, slot, closetRackIds),
  );
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

  const hasPorts = edgesOut(doc, chassisId, 'HasPort');
  // A fixed slot's `c14` inlet lives directly on the chassis (`psuInletsOf`
  // reads it back out below) — kept out of `ports` here regardless of
  // whether a catalogue model is known, the same connector token a real
  // faceplate could in principle use, but these particular nodes never come
  // from one. A hot-swap slot's inlet is never a `HasPort` child of the
  // chassis at all (it lives on the `PowerSupply`), so no filtering is
  // needed for those.
  const otherEdges = hasPorts.filter((e) => {
    const portNode = findNode(doc, e.to);
    return portNode === undefined || readPhysicalPortFields(portNode).connector !== 'c14';
  });

  const ports = otherEdges
    .map((e) => portView(doc, e.to, catalogueModel?.faceplates ?? [], catalogueModel !== undefined, face, closetRackIds))
    .filter((p): p is PortView => p !== undefined);

  const psuInlets = psuInletsOf(doc, chassisId, catalogueModel, closetRackIds);
  const fittedInlets = psuInlets.filter((p) => p.fitted);
  const fedCount = fittedInlets.filter((p) => p.cable !== null).length;
  const singleFed = fittedInlets.length >= 2 && fedCount === 1;
  const oneFitted = psuInlets.length >= 2 && psuInlets.some((p) => !p.fitted);

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
    oneFitted,
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
    row: fields.row ?? null,
    bay: fields.bay ?? null,
  };
}

/** `racks` grouped by `RackView.row`, front-ascending by `bay` within each
 * (ADR-0050 §2). Named rows sort by label, numerically aware so "Row 2"
 * precedes "Row 10" — the order a person expects, and a deterministic one:
 * creation order tied two racks made in the same millisecond to the random
 * half of their ulids, which made the row test flake on 2026-09-16. A rack
 * with no row is its own row, `label: null`, after every named one — never
 * grouped with other unrowed racks, which would assert a shared row nobody
 * stated. Two racks tied on `bay` (including two both `null`) order by
 * their own labels, the same way. */
function rowsOf(racks: readonly RackView[]): RowView[] {
  const named = new Map<string, RackView[]>();
  const namedOrder: string[] = [];
  const unrowed: RackView[] = [];
  for (const r of racks) {
    if (r.row !== null) {
      if (!named.has(r.row)) {
        named.set(r.row, []);
        namedOrder.push(r.row);
      }
      named.get(r.row)!.push(r);
    } else {
      unrowed.push(r);
    }
  }
  const byLabel = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  const byBayAscending = (a: RackView, b: RackView): number =>
    (a.bay ?? Number.POSITIVE_INFINITY) - (b.bay ?? Number.POSITIVE_INFINITY) || byLabel(a.label, b.label);
  const rows: RowView[] = [...namedOrder].sort(byLabel).map((label) => ({
    label,
    racks: [...named.get(label)!].sort(byBayAscending),
  }));
  for (const r of [...unrowed].sort((a, b) => byLabel(a.label, b.label))) rows.push({ label: null, racks: [r] });
  return rows;
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
    return { premisesId: '', racks: [], cables, rows: [] };
  }
  const rackEdges = edgesOut(doc, premises.id, 'HasRack');
  const closetRackIds = new Set(rackEdges.map((e) => e.to));
  const racks = rackEdges
    .map((e) => rackView(doc, e.to, catalogue, closetRackIds))
    .filter((r): r is RackView => r !== undefined);
  return { premisesId: premises.id, racks, cables, rows: rowsOf(racks) };
}
