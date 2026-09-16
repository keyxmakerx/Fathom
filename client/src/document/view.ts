// The contract the drawing renders: a `Document` (plus the catalogue, for
// the facts the graph itself does not carry — a chassis's height in units
// and its faceplate layout) reduced to one premises's racks, each rack's
// mounted chassis, and each chassis's ports.

import type { CatalogueFaceplate, CatalogueModel } from '../api/catalogue';
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
  type GraphNode,
} from './model';

export interface PortView {
  id: string;
  label: string;
  connector: string;
  row: number;
  column: number;
  uplink: boolean;
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
}

export interface RackView {
  id: string;
  label: string;
  heightU: number;
  unitNumbering: string;
  chassis: ChassisView[];
  freeRuns: Array<{ fromU: number; toU: number }>;
}

export interface ClosetView {
  premisesId: string;
  racks: RackView[];
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
): PortView | undefined {
  const node = findNode(doc, portId);
  const fields = node ? readPhysicalPortFields(node) : {};
  const label = fields.label ?? '';
  const connector = fields.connector ?? '';
  if (faceplate) {
    const match = faceplate.ports.find((p) => String(p.number) === label && p.kind === connector);
    if (!match) return undefined;
    return { id: portId, label, connector, row: rowNumber(match.row), column: match.column, uplink: match.uplink };
  }
  if (catalogueModelKnown) return undefined;
  return { id: portId, label, connector, row: 0, column: 0, uplink: false };
}

function chassisView(doc: Document, mountedEdgeId: string, catalogue: readonly CatalogueModel[]): ChassisView | undefined {
  const mounted = doc.edges.find((e) => e.id === mountedEdgeId);
  if (!mounted) return undefined;
  const chassisId = mounted.from;
  const chassisNode = findNode(doc, chassisId);
  if (!chassisNode || !isLiveNode(chassisNode)) return undefined;

  const hasChassis = edgesIn(doc, chassisId, 'HasChassis')[0];
  const deviceId = hasChassis?.from ?? '';
  const deviceNode = deviceId ? findNode(doc, deviceId) : undefined;
  const hostname = deviceNode ? (readDeviceFields(deviceNode).hostname ?? '') : '';

  const chassisFields = readChassisFields(chassisNode);
  const model = chassisFields.model ?? '';
  const catalogueModel = catalogueMatch(catalogue, model);

  const mountedFields = readMountedInFields(mounted);
  const face = mountedFields.face === 'rear' ? 'rear' : 'front';
  const heightU = catalogueModel?.rackUnits ?? mountedFields.heightU ?? 1;

  const faceplate = catalogueModel?.faceplates.find((f) => f.face === face);
  const ports = edgesOut(doc, chassisId, 'HasPort')
    .map((e) => portView(doc, e.to, faceplate, catalogueModel !== undefined))
    .filter((p): p is PortView => p !== undefined);

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

function rackView(doc: Document, rackId: string, catalogue: readonly CatalogueModel[]): RackView | undefined {
  const node = findNode(doc, rackId);
  if (!node || !isLiveNode(node)) return undefined;
  const fields = readRackFields(node);
  const heightU = fields.heightU ?? 0;
  const chassis = edgesIn(doc, rackId, 'MountedIn')
    .map((e) => chassisView(doc, e.id, catalogue))
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

/** The first live `Premises` this document carries, and every live `Rack`
 * `HasRack` hangs off it. A document with none is an empty closet, not a
 * refusal — nothing has been drawn yet. */
export function viewOf(doc: Document, catalogue: CatalogueModel[]): ClosetView {
  const premises = doc.nodes.find(
    (n) => isLiveNode(n) && parseNodeId(n.id).kind === 'Premises',
  );
  if (!premises) {
    return { premisesId: '', racks: [] };
  }
  const racks = edgesOut(doc, premises.id, 'HasRack')
    .map((e) => rackView(doc, e.to, catalogue))
    .filter((r): r is RackView => r !== undefined);
  return { premisesId: premises.id, racks };
}
