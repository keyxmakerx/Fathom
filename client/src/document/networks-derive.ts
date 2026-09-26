// The pure network derivation: a VLAN or subnet row is never stored, only
// read off the raw `Document` (ADR-0058 decision 1). Everything here is a
// function of `Document` alone — nothing from `view.ts`'s `ClosetView`
// (which carries no config layer at all, only the sketch/rack projection).
//
// `edgesIn`/`edgesOut` (model.ts) scan every edge in the document, called
// inside per-port loops — quadratic at scale. This module builds one
// `DocIndex` per derivation (nodes and edges by id, edges by from/to and
// kind, the last change per element) and never touches
// `doc.nodes`/`doc.edges` directly again below that point. `deriveNetworks`
// memoises its result on the `Document` object itself (a `WeakMap`), so a
// re-render that hands back the same reference costs one lookup.
//
// The layer-2 model:
//   1. Endpoints. A live Interface resolves to a live PhysicalPort through
//      Occupies, or, failing that, through name = port-label, marked
//      inferred (`resolvePortForInterface`). The same match runs in the
//      other direction, port to interface (`interfacesAtPort`).
//   2. Links. A live cable joins the two ports it terminates, through any
//      PassThrough. Dead nodes and edges never take part.
//   3. Bridging inside one device: a switch or access point with no VLAN
//      config at all bridges every one of its ports untagged, transparent
//      to whatever crosses it. Any other device bridges nothing on its own;
//      a numbered VLAN's carrier ports on one device join only each other,
//      only for that VLAN.
//   4. "Untagged meets access", precisely: starting only from a VLAN's
//      ACCESS-mode carrier ports (never a trunk — a trunk carries no
//      native, untagged VLAN in this schema), flood the port graph outward.
//      A leaf port with no VLAN config picks up implicit membership; a
//      port that already carries ANY explicit VLAN config is a boundary —
//      the flood stops there, and if that boundary is itself another
//      VLAN's ACCESS carrier, the two rows record a conflict rather than
//      silently merging or silently stealing each other's members.
//
// A VLAN row is one connected component of a numeric id's domain holding at
// least one live Vlan entity. A "subnet with no VLAN" row groups addresses
// by (prefix, base-graph component). A device with no role never bridges —
// two subnet rows that would join if a hand-drawn switch had its role set
// carry a hint naming that device, never a guess baked into the graph.
//
// Every lookup here checks liveness at BOTH ends of every edge it follows,
// and every numeric parse is guarded — an inet6 or otherwise unreadable
// Address must not take the whole list down, it is skipped.

import { ipv4NetworkOf, parseEdgeId, parseNodeId, type Document, type FieldEntry, type GraphEdge, type GraphNode } from './model';

function fieldValue(fields: Readonly<Record<string, FieldEntry>>, name: string): FieldEntry['value'] | undefined {
  const e = fields[name];
  return e && e.presence === 'set' ? e.value : undefined;
}

function asString(v: FieldEntry['value'] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** A prefix or host address string, parsed to its numeric network — never
 * throws: an inet6 literal or anything else IPv4 cannot read comes back
 * `undefined` rather than taking the caller down. */
function safeIpv4NetworkOf(text: string): { value: number; len: number } | undefined {
  try {
    return ipv4NetworkOf(text);
  } catch {
    return undefined;
  }
}

function formatMaskedIpv4(value: number, len: number): string {
  const a = (value >>> 24) & 255;
  const b = (value >>> 16) & 255;
  const c = (value >>> 8) & 255;
  const d = value & 255;
  return `${a}.${b}.${c}.${d}/${len}`;
}

// ---------------------------------------------------------------------------
// One index built per derivation. Every helper below takes this `DocIndex`,
// never `doc.nodes`/`doc.edges` directly — a lookup against a pre-built
// `Map` instead of a full-array scan.

interface DocIndex {
  nodeById: Map<string, GraphNode>; // live nodes only
  nodesByKind: Map<string, GraphNode[]>; // live nodes only, bucketed once by parseNodeId(n.id).kind
  outByKind: Map<string, GraphEdge[]>; // key `${from}\u0000${kind}`, live edges only
  inByKind: Map<string, GraphEdge[]>; // key `${to}\u0000${kind}`, live edges only
  passThroughByPort: Map<string, GraphEdge>; // live PassThrough, keyed by both its ends
  lastChangeByElement: Map<string, number>; // node/edge id -> latest assertedAt among its fields
}

function pushIndexed(map: Map<string, GraphEdge[]>, key: string, e: GraphEdge): void {
  const arr = map.get(key);
  if (arr) arr.push(e);
  else map.set(key, [e]);
}

function buildIndex(doc: Document): DocIndex {
  const nodeById = new Map<string, GraphNode>();
  const nodesByKind = new Map<string, GraphNode[]>();
  for (const n of doc.nodes) {
    if (n.absentSince !== undefined) continue;
    nodeById.set(n.id, n);
    const kind = parseNodeId(n.id).kind;
    const arr = nodesByKind.get(kind);
    if (arr) arr.push(n);
    else nodesByKind.set(kind, [n]);
  }

  const outByKind = new Map<string, GraphEdge[]>();
  const inByKind = new Map<string, GraphEdge[]>();
  const passThroughByPort = new Map<string, GraphEdge>();
  for (const e of doc.edges) {
    if (e.absentSince !== undefined) continue;
    const kind = parseEdgeId(e.id).kind;
    pushIndexed(outByKind, `${e.from}\u0000${kind}`, e);
    pushIndexed(inByKind, `${e.to}\u0000${kind}`, e);
    if (kind === 'PassThrough') {
      passThroughByPort.set(e.from, e);
      passThroughByPort.set(e.to, e);
    }
  }

  const provById = new Map(doc.provenance.map((p) => [p.id, p]));
  const lastChangeByElement = new Map<string, number>();
  function noteChanges(id: string, fields: Readonly<Record<string, FieldEntry>>): void {
    for (const key of Object.keys(fields)) {
      const rec = provById.get(fields[key].prov);
      if (!rec) continue;
      const prev = lastChangeByElement.get(id);
      if (prev === undefined || rec.assertedAt > prev) lastChangeByElement.set(id, rec.assertedAt);
    }
  }
  for (const n of doc.nodes) {
    if (n.absentSince !== undefined) continue;
    noteChanges(n.id, n.fields);
  }
  for (const e of doc.edges) {
    if (e.absentSince !== undefined) continue;
    noteChanges(e.id, e.fields);
  }

  return { nodeById, nodesByKind, outByKind, inByKind, passThroughByPort, lastChangeByElement };
}

function liveNode(idx: DocIndex, id: string | undefined): GraphNode | undefined {
  return id === undefined ? undefined : idx.nodeById.get(id);
}

function edgesOutIdx(idx: DocIndex, from: string, kind: string): readonly GraphEdge[] {
  return idx.outByKind.get(`${from}\u0000${kind}`) ?? EMPTY_EDGES;
}

function edgesInIdx(idx: DocIndex, to: string, kind: string): readonly GraphEdge[] {
  return idx.inByKind.get(`${to}\u0000${kind}`) ?? EMPTY_EDGES;
}

const EMPTY_EDGES: readonly GraphEdge[] = [];
const EMPTY_NODES: readonly GraphNode[] = [];

function deviceOfInterfaceLike(idx: DocIndex, interfaceLikeId: string): string | undefined {
  const hi = edgesInIdx(idx, interfaceLikeId, 'HasInterface')[0];
  return hi && liveNode(idx, hi.from) ? hi.from : undefined;
}

function unitContext(idx: DocIndex, unitId: string): { deviceId: string; interfaceId: string } | undefined {
  const hasUnit = edgesInIdx(idx, unitId, 'HasUnit')[0];
  if (!hasUnit || !liveNode(idx, hasUnit.from)) return undefined;
  const deviceId = deviceOfInterfaceLike(idx, hasUnit.from);
  if (!deviceId) return undefined;
  return { deviceId, interfaceId: hasUnit.from };
}

function firstAddressValue(idx: DocIndex, unitId: string): string | undefined {
  for (const ha of edgesOutIdx(idx, unitId, 'HasAddress')) {
    const n = liveNode(idx, ha.to);
    if (!n) continue;
    const v = asString(fieldValue(n.fields, 'Address.value'));
    if (v) return v;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Device role and bridging (model step 3).

const BRIDGING_ROLES = new Set(['switch', 'access_point']);

function deviceRole(idx: DocIndex, deviceId: string): string | undefined {
  const n = liveNode(idx, deviceId);
  return asString(fieldValue(n?.fields ?? {}, 'Device.role'));
}

function deviceOwnsAnyVlan(idx: DocIndex, deviceId: string): boolean {
  return edgesOutIdx(idx, deviceId, 'HasVlan').some((e) => liveNode(idx, e.to) !== undefined);
}

/** A device that bridges every one of its live ports together, untagged,
 * transparent to any VLAN or subnet crossing it. Routers, firewalls, hosts,
 * and a switch that DOES carry some VLAN, bridge nothing on their own; each
 * of their units is its own segment. A device with NO role at all never
 * bridges either, rather than guessed — `roleHintsForSubnets` below is
 * where a likely-missing role surfaces instead, as a hint. */
function isBlankBridge(idx: DocIndex, deviceId: string): boolean {
  const role = deviceRole(idx, deviceId);
  return role !== undefined && BRIDGING_ROLES.has(role) && !deviceOwnsAnyVlan(idx, deviceId);
}

function chassisPortsOf(idx: DocIndex, deviceId: string): string[] {
  const chassisEdge = edgesOutIdx(idx, deviceId, 'HasChassis')[0];
  const chassisId = chassisEdge && liveNode(idx, chassisEdge.to) ? chassisEdge.to : undefined;
  if (!chassisId) return [];
  return edgesOutIdx(idx, chassisId, 'HasPort')
    .map((e) => e.to)
    .filter((id) => liveNode(idx, id) !== undefined);
}

function ownerDeviceOfPort(idx: DocIndex, portId: string): string | undefined {
  const hp = edgesInIdx(idx, portId, 'HasPort')[0];
  if (!hp || !liveNode(idx, hp.from)) return undefined;
  const hc = edgesInIdx(idx, hp.from, 'HasChassis')[0];
  if (!hc || !liveNode(idx, hc.from)) return undefined;
  return hc.from;
}

// ---------------------------------------------------------------------------
// Model step 1 — endpoints, bilateral: interface -> port, and port ->
// interface, each with the same "name = label" fallback when nothing is
// drawn, marked `inferred` either way.

type PortResolution = { kind: 'live' | 'inferred'; portId: string } | { kind: 'port-removed' } | { kind: 'none' };

function resolvePortForInterface(idx: DocIndex, interfaceId: string): PortResolution {
  const occ = edgesOutIdx(idx, interfaceId, 'Occupies')[0];
  if (occ) {
    return liveNode(idx, occ.to) ? { kind: 'live', portId: occ.to } : { kind: 'port-removed' };
  }
  const iface = liveNode(idx, interfaceId);
  const name = asString(fieldValue(iface?.fields ?? {}, 'Interface.name'));
  if (!name) return { kind: 'none' };
  const deviceId = deviceOfInterfaceLike(idx, interfaceId);
  if (!deviceId) return { kind: 'none' };
  for (const portId of chassisPortsOf(idx, deviceId)) {
    const port = liveNode(idx, portId)!;
    if (asString(fieldValue(port.fields, 'PhysicalPort.label')) === name) return { kind: 'inferred', portId };
  }
  return { kind: 'none' };
}

function interfacesAtPort(idx: DocIndex, portId: string): Array<{ interfaceId: string; inferred: boolean }> {
  const real = edgesInIdx(idx, portId, 'Occupies')
    .filter((e) => liveNode(idx, e.from))
    .map((e) => ({ interfaceId: e.from, inferred: false }));
  if (real.length > 0) return real;

  const port = liveNode(idx, portId);
  const label = asString(fieldValue(port?.fields ?? {}, 'PhysicalPort.label'));
  const deviceId = port ? ownerDeviceOfPort(idx, portId) : undefined;
  if (!label || !deviceId) return [];
  const found: Array<{ interfaceId: string; inferred: boolean }> = [];
  for (const hi of edgesOutIdx(idx, deviceId, 'HasInterface')) {
    const iface = liveNode(idx, hi.to);
    if (!iface) continue;
    if (asString(fieldValue(iface.fields, 'Interface.name')) !== label) continue;
    const hasOwnOccupies = edgesOutIdx(idx, hi.to, 'Occupies').some((e) => liveNode(idx, e.to));
    if (!hasOwnOccupies) found.push({ interfaceId: hi.to, inferred: true });
  }
  return found;
}

function memberDisplay(idx: DocIndex, interfaceId: string, res: PortResolution): { label: string; isFallback: boolean; portRemoved: boolean } {
  const iface = liveNode(idx, interfaceId);
  const name = asString(fieldValue(iface?.fields ?? {}, 'Interface.name')) ?? interfaceId;
  if (res.kind === 'live' || res.kind === 'inferred') {
    const port = liveNode(idx, res.portId);
    const label = port ? asString(fieldValue(port.fields, 'PhysicalPort.label')) : undefined;
    return { label: label ?? name, isFallback: res.kind === 'inferred' || label === undefined, portRemoved: false };
  }
  if (res.kind === 'port-removed') return { label: name, isFallback: true, portRemoved: true };
  return { label: name, isFallback: true, portRemoved: false };
}

function unitsAtInterface(idx: DocIndex, interfaceId: string): string[] {
  return edgesOutIdx(idx, interfaceId, 'HasUnit')
    .map((e) => e.to)
    .filter((id) => liveNode(idx, id) !== undefined);
}

// ---------------------------------------------------------------------------
// Model step 2 — links: a live cable joins the two ports it terminates,
// through any PassThrough. `cabledFarPort` walks purely at the port level.

interface CablePartner {
  farPortId: string;
  cableIds: string[];
  viaPassiveHops: number;
}

function cabledFarPort(idx: DocIndex, startPortId: string): { farPortId?: string; cableIds: string[]; viaPassiveHops: number } {
  const cableIds: string[] = [];
  let port = startPortId;
  let hops = 0;
  const visited = new Set<string>();
  for (;;) {
    if (!liveNode(idx, port) || visited.has(port)) return { cableIds, viaPassiveHops: hops };
    visited.add(port);
    const near = edgesInIdx(idx, port, 'Terminates')[0];
    if (!near || !liveNode(idx, near.from)) return { cableIds, viaPassiveHops: hops };
    cableIds.push(near.from);
    const far = edgesOutIdx(idx, near.from, 'Terminates').find((e) => e.id !== near.id);
    if (!far || parseNodeId(far.to).kind !== 'PhysicalPort' || !liveNode(idx, far.to)) return { cableIds, viaPassiveHops: hops };
    const farPort = far.to;
    const pass = idx.passThroughByPort.get(farPort);
    if (pass) {
      const nextPort = pass.from === farPort ? pass.to : pass.from;
      if (!liveNode(idx, nextPort)) return { cableIds, viaPassiveHops: hops };
      port = nextPort;
      hops += 1;
      continue;
    }
    return { farPortId: farPort, cableIds, viaPassiveHops: hops };
  }
}

// ---------------------------------------------------------------------------
// Union-find.

class UnionFind {
  private readonly parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

// ---------------------------------------------------------------------------
// The one port graph — model steps 1-3, VLAN-id-independent. Built once per
// `deriveNetworks` call and shared by every VLAN row and every subnet row.
// `adjacency` is a real neighbour list (cable partner, plus — for a blank
// bridge device only — its other ports via a one-hub star, O(ports) not
// O(ports^2)), so a flood can walk it directly instead of re-deriving
// neighbours from a union-find root.

interface PortGraph {
  uf: UnionFind;
  adjacency: Map<string, string[]>;
  cablePartner: Map<string, CablePartner>;
  livePorts: Set<string>;
  /** A live port's owning device, only when that device is a blank bridge —
   * names the switch two VLANs meet through. */
  blankBridgeDeviceOfPort: Map<string, string>;
}

function addAdjacency(adjacency: Map<string, string[]>, a: string, b: string): void {
  const arr = adjacency.get(a);
  if (arr) arr.push(b);
  else adjacency.set(a, [b]);
}

function buildPortGraph(idx: DocIndex): PortGraph {
  const uf = new UnionFind();
  const adjacency = new Map<string, string[]>();
  const cablePartner = new Map<string, CablePartner>();
  const livePorts = new Set<string>();
  const blankBridgeDeviceOfPort = new Map<string, string>();

  for (const n of idx.nodeById.values()) {
    if (parseNodeId(n.id).kind === 'PhysicalPort') livePorts.add(n.id);
  }
  for (const portId of livePorts) {
    const walk = cabledFarPort(idx, portId);
    if (walk.farPortId && livePorts.has(walk.farPortId)) {
      cablePartner.set(portId, { farPortId: walk.farPortId, cableIds: walk.cableIds, viaPassiveHops: walk.viaPassiveHops });
      uf.union(portId, walk.farPortId);
      addAdjacency(adjacency, portId, walk.farPortId);
    }
  }
  for (const n of idx.nodeById.values()) {
    if (parseNodeId(n.id).kind !== 'Device' || !isBlankBridge(idx, n.id)) continue;
    const ports = chassisPortsOf(idx, n.id);
    for (const p of ports) blankBridgeDeviceOfPort.set(p, n.id);
    for (let i = 1; i < ports.length; i += 1) {
      uf.union(ports[0], ports[i]);
      addAdjacency(adjacency, ports[0], ports[i]);
      addAdjacency(adjacency, ports[i], ports[0]);
    }
  }
  return { uf, adjacency, cablePartner, livePorts, blankBridgeDeviceOfPort };
}

function farInfoFor(idx: DocIndex, base: PortGraph, res: PortResolution, ownDeviceId: string | undefined) {
  if (res.kind !== 'live' && res.kind !== 'inferred') {
    return { farDeviceId: undefined as string | undefined, farInterfaceLabel: undefined as string | undefined, farIsSameDevice: false, viaPassiveHops: 0, cableId: undefined as string | undefined };
  }
  const partner = base.cablePartner.get(res.portId);
  if (!partner) return { farDeviceId: undefined, farInterfaceLabel: undefined, farIsSameDevice: false, viaPassiveHops: 0, cableId: undefined };
  // Only when a far INTERFACE actually resolves (live Occupies, or the
  // inferred name = label match) — a bare cabled port with nothing drawn at
  // all shows "—", not a device name with no interface beside it.
  const farIfaces = interfacesAtPort(idx, partner.farPortId);
  const first = farIfaces[0];
  const farInterfaceId = first?.interfaceId;
  const farDeviceId = farInterfaceId ? deviceOfInterfaceLike(idx, farInterfaceId) : undefined;
  const farInterfaceLabel = farInterfaceId
    ? memberDisplay(idx, farInterfaceId, { kind: first.inferred ? 'inferred' : 'live', portId: partner.farPortId }).label
    : undefined;
  return { farDeviceId, farInterfaceLabel, farIsSameDevice: farDeviceId === ownDeviceId, viaPassiveHops: partner.viaPassiveHops, cableId: partner.cableIds[0] };
}

// ---------------------------------------------------------------------------
// VLAN carrying.

function unitVlanIdField(idx: DocIndex, unitId: string): number | undefined {
  const n = liveNode(idx, unitId);
  const s = asString(fieldValue(n?.fields ?? {}, 'LogicalUnit.vlan_id'));
  return s !== undefined ? Number(s) : undefined;
}

function unitCarries(idx: DocIndex, unitId: string, idValue: number, idSet: ReadonlySet<string>): { mode: 'access' | 'trunk' | undefined; vlanMemberEdgeId?: string } | undefined {
  for (const vm of edgesOutIdx(idx, unitId, 'VlanMember')) {
    if (!idSet.has(vm.to) || !liveNode(idx, vm.to)) continue;
    const mode = asString(fieldValue(vm.fields, 'VlanMember.mode'));
    return { mode: mode === 'access' || mode === 'trunk' ? mode : undefined, vlanMemberEdgeId: vm.id };
  }
  if (unitVlanIdField(idx, unitId) === idValue) return { mode: 'trunk' };
  return undefined;
}

/** Does `unitId` assert ANY VLAN config at all — any live `VlanMember`, or
 * a `vlan_id` field? An untagged flood must stop at such a unit rather than
 * flood past it or relabel it; "untagged meets access" only ever adds a
 * unit that asserts nothing. */
function unitHasAnyVlanConfig(idx: DocIndex, unitId: string): boolean {
  if (edgesOutIdx(idx, unitId, 'VlanMember').length > 0) return true;
  return unitVlanIdField(idx, unitId) !== undefined;
}

/** The OTHER numeric VLAN id `unitId` carries in ACCESS mode, if any — feeds
 * the conflict check ("A's access-10 port and B's access-20 port"). A
 * trunk boundary is not a conflict: a trunk legitimately carries many ids
 * by design. */
function accessVlanIdOf(idx: DocIndex, unitId: string): number | undefined {
  for (const vm of edgesOutIdx(idx, unitId, 'VlanMember')) {
    const vn = liveNode(idx, vm.to);
    if (!vn) continue;
    if (asString(fieldValue(vm.fields, 'VlanMember.mode')) !== 'access') continue;
    const id = vlanIdOfNode(vn);
    if (id !== undefined) return id;
  }
  return undefined;
}

/** Every `VlanMember` edge this unit itself makes, tagged mode, trunk only —
 * the board's "trunk · 10, 20" role text: every numeric VLAN id this one
 * unit trunks, sorted. Not part of the hot derivation path (called once
 * per open row's member on render), so this keeps using the plain `doc`
 * accessors rather than an index built just for it. */
export function trunkVlanIdsOf(doc: Document, unitId: string): number[] {
  const ids: number[] = [];
  for (const e of doc.edges) {
    if (e.absentSince !== undefined || e.from !== unitId || parseEdgeId(e.id).kind !== 'VlanMember') continue;
    const target = doc.nodes.find((n) => n.id === e.to && n.absentSince === undefined);
    if (!target) continue;
    if (asString(fieldValue(e.fields, 'VlanMember.mode')) !== 'trunk') continue;
    const id = vlanIdOfNode(target);
    if (id !== undefined) ids.push(id);
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

function vlanIdOfNode(n: GraphNode): number | undefined {
  const s = asString(fieldValue(n.fields, 'Vlan.vlan_id'));
  return s !== undefined ? Number(s) : undefined;
}

function allLiveVlanNodesWithId(idx: DocIndex, idValue: number): GraphNode[] {
  const result: GraphNode[] = [];
  for (const n of idx.nodeById.values()) {
    if (parseNodeId(n.id).kind !== 'Vlan' || vlanIdOfNode(n) !== idValue) continue;
    const hv = edgesInIdx(idx, n.id, 'HasVlan')[0];
    if (!hv || !liveNode(idx, hv.from)) continue;
    result.push(n);
  }
  return result;
}

/** Every live `LogicalUnit` that could carry EACH numeric VLAN id, in ONE
 * pass over the units, so `buildDomainUnionFind` and `buildVlanRow`'s
 * "vlan_id field only" pass never rescan every unit in the document once
 * per distinct id — quadratic at scale (many ids times many units each).
 * A unit that carries an id through both a `VlanMember` edge AND its
 * `vlan_id` field appears twice; every caller below already tolerates
 * that (`unitCarries` is idempotent, `buildVlanRow`'s Pass 1b is keyed by
 * unit id in `memberByUnit`). */
function buildVlanCarrierIndex(idx: DocIndex): Map<number, string[]> {
  const byId = new Map<number, string[]>();
  function note(id: number, unitId: string): void {
    const arr = byId.get(id);
    if (arr) arr.push(unitId);
    else byId.set(id, [unitId]);
  }
  for (const n of idx.nodeById.values()) {
    if (parseNodeId(n.id).kind !== 'LogicalUnit') continue;
    for (const vm of edgesOutIdx(idx, n.id, 'VlanMember')) {
      const vn = liveNode(idx, vm.to);
      const id = vn ? vlanIdOfNode(vn) : undefined;
      if (id !== undefined) note(id, n.id);
    }
    const fieldId = unitVlanIdField(idx, n.id);
    if (fieldId !== undefined) note(fieldId, n.id);
  }
  return byId;
}

/** Model step 3's domain union-find for numeric id `idValue`: seeded from
 * the base port graph's components (cable + blank-bridge, VLAN
 * independent), then joined further, per device, across every live port
 * whose unit is in `idValue`'s domain there — the one place per-VLAN
 * bridging happens. Used only to decide which VLAN NODES join into one row;
 * member gathering is `floodFromAccessCarriers`'s separate job.
 * `candidateUnitIds` is `idValue`'s slice of `buildVlanCarrierIndex`, never
 * the whole document's units. */
function buildDomainUnionFind(idx: DocIndex, base: PortGraph, idValue: number, idSet: ReadonlySet<string>, candidateUnitIds: readonly string[]): UnionFind {
  const uf = new UnionFind();
  const byDevice = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const unitId of candidateUnitIds) {
    if (seen.has(unitId)) continue;
    seen.add(unitId);
    const match = unitCarries(idx, unitId, idValue, idSet);
    if (!match) continue;
    const ctx = unitContext(idx, unitId);
    if (!ctx) continue;
    const res = resolvePortForInterface(idx, ctx.interfaceId);
    if (res.kind !== 'live' && res.kind !== 'inferred') continue;
    const root = base.uf.find(res.portId);
    const arr = byDevice.get(ctx.deviceId);
    if (arr) arr.push(root);
    else byDevice.set(ctx.deviceId, [root]);
  }
  for (const arr of byDevice.values()) for (let i = 1; i < arr.length; i += 1) uf.union(arr[0], arr[i]);
  return uf;
}

function domainKeyOfPort(base: PortGraph, domainUf: UnionFind, portId: string): string {
  return domainUf.find(base.uf.find(portId));
}

function nodeComponentKey(idx: DocIndex, base: PortGraph, domainUf: UnionFind, vn: GraphNode): string {
  for (const vm of edgesInIdx(idx, vn.id, 'VlanMember')) {
    if (!liveNode(idx, vm.from)) continue;
    const ctx = unitContext(idx, vm.from);
    if (!ctx) continue;
    const res = resolvePortForInterface(idx, ctx.interfaceId);
    if (res.kind === 'live' || res.kind === 'inferred') return domainKeyOfPort(base, domainUf, res.portId);
  }
  return `island:${vn.id}`;
}

function lastChangeMsOf(idx: DocIndex, elementIds: readonly string[]): number | null {
  let latest: number | null = null;
  for (const id of elementIds) {
    const at = idx.lastChangeByElement.get(id);
    if (at !== undefined && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

// ---------------------------------------------------------------------------
// The untagged flood. Starts ONLY at a VLAN's ACCESS-mode carrier ports
// (never a trunk: "untagged meets access, not trunk"). Stops at any
// boundary port whose unit asserts ANY VLAN config — never floods past it,
// never relabels it — and records a conflict when that boundary is another
// VLAN's access carrier.

interface FloodResult {
  implicit: Array<{ unitId: string; deviceId: string; interfaceId: string }>;
  conflicts: Array<{ otherVlanId: number; viaDeviceId?: string }>;
}

function floodFromAccessCarriers(idx: DocIndex, base: PortGraph, idValue: number, seedPorts: readonly string[]): FloodResult {
  const implicit: FloodResult['implicit'] = [];
  const conflicts: FloodResult['conflicts'] = [];
  const seenUnits = new Set<string>();
  const visited = new Set<string>(seedPorts);
  const queue: string[] = [...seedPorts];
  while (queue.length > 0) {
    const port = queue.shift()!;
    for (const neighbor of base.adjacency.get(port) ?? []) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      const first = interfacesAtPort(idx, neighbor)[0];
      if (!first) {
        queue.push(neighbor); // nothing drawn here at all -- pure wire, keep flooding
        continue;
      }
      const units = unitsAtInterface(idx, first.interfaceId);
      const configuredUnit = units.find((u) => unitHasAnyVlanConfig(idx, u));
      if (configuredUnit) {
        const otherAccessId = accessVlanIdOf(idx, configuredUnit);
        if (otherAccessId !== undefined && otherAccessId !== idValue) {
          conflicts.push({ otherVlanId: otherAccessId, viaDeviceId: base.blankBridgeDeviceOfPort.get(port) });
        }
        continue; // a configured boundary -- never flooded past, never relabelled
      }
      const deviceId = deviceOfInterfaceLike(idx, first.interfaceId);
      if (deviceId && units.length === 1 && !seenUnits.has(units[0])) {
        seenUnits.add(units[0]);
        implicit.push({ unitId: units[0], deviceId, interfaceId: first.interfaceId });
      }
      queue.push(neighbor);
    }
  }
  return { implicit, conflicts };
}

// ---------------------------------------------------------------------------
// Public row shapes

export interface VlanMemberRow {
  unitId: string;
  deviceId: string;
  interfaceId: string;
  vlanMemberEdgeId?: string;
  interfaceLabel: string;
  interfaceLabelIsFallback: boolean;
  portRemoved: boolean;
  mode: 'access' | 'trunk' | undefined;
  address?: string;
  isGateway: boolean;
  farDeviceId?: string;
  farInterfaceLabel?: string;
  farIsSameDevice: boolean;
  viaPassiveHops: number;
  cableId?: string;
  /** Set only for a synthetic member folded in from a macvlan/ipvlan Docker
   * container on this segment — it carries no `VlanMember` edge of its own. */
  container?: { containerId: string; name: string };
}

export interface VlanRow {
  key: string;
  vlanId: number;
  name?: string;
  description?: string;
  vlanNodeIds: string[];
  devices: string[];
  members: VlanMemberRow[];
  cidr?: string;
  joined: boolean;
  lastChangeMs: number | null;
  /** Another numeric VLAN id whose ACCESS carrier this row's flood reached
   * through a boundary it should never have crossed — a real
   * misconfiguration, worth teaching rather than hiding. */
  conflicts: Array<{ otherVlanId: number; viaDeviceId?: string }>;
}

export interface SubnetMemberRow {
  unitId: string;
  deviceId: string;
  interfaceId: string;
  interfaceLabel: string;
  interfaceLabelIsFallback: boolean;
  portRemoved: boolean;
  addressNodeId: string;
  address: string;
  description?: string;
  /** `VlanMemberRow.container`'s own twin for a subnet row — `addressNodeId`
   * is a placeholder here; no real `Address` node backs a folded container. */
  container?: { containerId: string; name: string };
}

export interface SubnetRow {
  key: string;
  prefix: string;
  label: string;
  addressNodeIds: string[];
  members: SubnetMemberRow[];
  lastChangeMs: number | null;
  /** A live, no-role device that sits directly between this row and
   * another same-prefix row — set its role to bridge them, never guessed
   * here, only named. */
  roleHintDeviceId?: string;
}

// ---------------------------------------------------------------------------
// Docker rows (ADR-0058), one `DockerNetworkRow` per live `ContainerNetwork`
// (decision 3's kinds). A macvlan/ipvlan network's containers also fold into
// the VLAN/subnet row their `ParentUnit` belongs to (`foldMacvlanContainersIntoRows`);
// a bridge (or host/none/overlay/other) network stays its own row only.
// `parentSameHost`/`sameHost` mark a broken same-host rule rather than
// hiding or throwing.

export interface DockerPublishedPortRow {
  id: string;
  protocolNumber: number;
  containerPort: number;
  hostPort?: number;
  hostAddress?: string;
  /** Another live `PublishedPort`, same host/protocol/host port, on a
   * different container. Absent `host_address` binds every address, same
   * as `0.0.0.0` (docker/docs port-publishing.md) — matching that is
   * `'certain'`; wildcard against a specific address is only `'likely'`,
   * since the kernel-level conflict (torvalds/linux inet_connection_sock.c)
   * is gated by `SO_REUSEADDR`/`SO_REUSEPORT`, not fully chased down here.
   * Neither level is refused: no source found for dockerd refusing the
   * recording of either shape, only a runtime bind failure. */
  conflict?: 'certain' | 'likely';
}

export interface DockerContainerRow {
  containerId: string;
  name: string;
  /** The device that actually hosts this container — its own live
   * `HasContainer` owner, which may differ from `DockerNetworkRow.hostDeviceId`
   * when the attach breaks the same-host rule. */
  deviceId: string;
  attachedToEdgeId: string;
  address?: string;
  publishedPorts: DockerPublishedPortRow[];
  /** False when this container's own host differs from the network's host
   * and the network's driver is not `overlay` — `attachedto.same-host`
   * broken, marked rather than hidden or thrown on. */
  sameHost: boolean;
}

export interface DockerNetworkRow {
  key: string;
  containerNetworkId: string;
  name: string;
  driver: string;
  hostDeviceId: string;
  subnets: string[];
  gateways: string[];
  parentUnitId?: string;
  /** False when a macvlan/ipvlan network's `ParentUnit` resolves to a unit
   * on a device other than its own host — `parentunit.same-host` broken. */
  parentSameHost: boolean;
  /** The board's "id · cidr" column: subnets joined for a plain network,
   * "VLAN 30 via eth0" / "10.0.10.0/24 via eth0" for a macvlan/ipvlan one. */
  idCidr: string;
  containers: DockerContainerRow[];
  lastChangeMs: number | null;
}

/** A container with no live `AttachedTo` edge at all — reachable through
 * neither the VLAN/subnet fold nor any `DockerNetworkRow`, so it needs a row
 * of its own or a detach could leave it nowhere a caller can find it. */
export interface DockerUnattachedContainerRow {
  key: string;
  containerId: string;
  name: string;
  hostDeviceId: string;
  publishedPorts: DockerPublishedPortRow[];
  lastChangeMs: number | null;
}

export interface NetworksDerived {
  vlanRows: VlanRow[];
  subnetRows: SubnetRow[];
  dockerNetworkRows: DockerNetworkRow[];
  dockerUnattachedContainers: DockerUnattachedContainerRow[];
}

// ---------------------------------------------------------------------------
// VLAN rows

function buildVlanRow(
  idx: DocIndex,
  base: PortGraph,
  idValue: number,
  idSet: ReadonlySet<string>,
  domainUf: UnionFind,
  candidateUnitIds: readonly string[],
  vlanNodes: readonly GraphNode[],
  joined: boolean,
): VlanRow {
  const vlanNodeIds = vlanNodes.map((n) => n.id);
  const localIdSet = new Set(vlanNodeIds);
  const devices = new Set<string>();
  let name: string | undefined;
  let description: string | undefined;
  let cidr: string | undefined;
  const elementIds: string[] = [...vlanNodeIds];
  const memberByUnit = new Map<string, VlanMemberRow>();
  const accessSeedPorts: string[] = [];

  function addMember(unitId: string, deviceId: string, interfaceId: string, opts: { vlanMemberEdgeId?: string; mode: 'access' | 'trunk' | undefined }): void {
    if (memberByUnit.has(unitId)) return;
    devices.add(deviceId);
    const res = resolvePortForInterface(idx, interfaceId);
    if (opts.mode === 'access' && (res.kind === 'live' || res.kind === 'inferred')) accessSeedPorts.push(res.portId);
    const { label, isFallback, portRemoved } = memberDisplay(idx, interfaceId, res);
    const far = farInfoFor(idx, base, res, deviceId);
    const address = firstAddressValue(idx, unitId);
    const l3 = edgesInIdx(idx, unitId, 'L3Interface')[0];
    const isGateway = l3 !== undefined && liveNode(idx, l3.from) !== undefined && localIdSet.has(l3.from);
    if (isGateway && address && cidr === undefined) {
      const net = safeIpv4NetworkOf(address);
      if (net) cidr = formatMaskedIpv4(net.value, net.len);
    }
    memberByUnit.set(unitId, {
      unitId,
      deviceId,
      interfaceId,
      vlanMemberEdgeId: opts.vlanMemberEdgeId,
      interfaceLabel: label,
      interfaceLabelIsFallback: isFallback,
      portRemoved,
      mode: opts.mode,
      address,
      isGateway,
      farDeviceId: far.farDeviceId,
      farInterfaceLabel: far.farInterfaceLabel,
      farIsSameDevice: far.farIsSameDevice,
      viaPassiveHops: far.viaPassiveHops,
      cableId: far.cableId,
    });
  }

  // Pass 1: every direct explicit member of these specific Vlan nodes —
  // always included, port or no port at all.
  for (const vn of vlanNodes) {
    const hv = edgesInIdx(idx, vn.id, 'HasVlan')[0];
    if (hv && liveNode(idx, hv.from)) {
      devices.add(hv.from);
      elementIds.push(hv.id);
    }
    if (name === undefined) name = asString(fieldValue(vn.fields, 'Vlan.name'));
    if (description === undefined) description = asString(fieldValue(vn.fields, 'Vlan.description'));

    for (const vm of edgesInIdx(idx, vn.id, 'VlanMember')) {
      if (!liveNode(idx, vm.from)) continue;
      const ctx = unitContext(idx, vm.from);
      if (!ctx) continue;
      const mode = asString(fieldValue(vm.fields, 'VlanMember.mode'));
      addMember(vm.from, ctx.deviceId, ctx.interfaceId, { vlanMemberEdgeId: vm.id, mode: mode === 'access' || mode === 'trunk' ? mode : undefined });
      elementIds.push(vm.id);
    }
    for (const l3 of edgesOutIdx(idx, vn.id, 'L3Interface')) {
      if (liveNode(idx, l3.to)) elementIds.push(l3.id);
    }
  }

  // Pass 1b: a routed sub-interface naming this VLAN only through its
  // `vlan_id` field, no `VlanMember` edge at all — `unitCarries`'s fallback
  // channel. Not something a flood should ever discover (it is not
  // "untagged"; it is a trunk's far end); scoped to this row's domain key
  // so an unrelated device using the same numeric id elsewhere is never
  // pulled in.
  const rowKey = nodeComponentKey(idx, base, domainUf, vlanNodes[0]);
  for (const unitId of candidateUnitIds) {
    if (memberByUnit.has(unitId) || !liveNode(idx, unitId)) continue;
    if (unitVlanIdField(idx, unitId) !== idValue) continue;
    const hasOwnMembership = edgesOutIdx(idx, unitId, 'VlanMember').some((e) => idSet.has(e.to) && liveNode(idx, e.to));
    if (hasOwnMembership) continue; // an explicit VlanMember edge -- Pass 1 above already found it
    const ctx = unitContext(idx, unitId);
    if (!ctx) continue;
    const res = resolvePortForInterface(idx, ctx.interfaceId);
    if (res.kind !== 'live' && res.kind !== 'inferred') continue;
    if (domainKeyOfPort(base, domainUf, res.portId) !== rowKey) continue;
    addMember(unitId, ctx.deviceId, ctx.interfaceId, { mode: 'trunk' });
  }

  // Pass 2: flood outward from this row's ACCESS carriers only (a trunk
  // seeds nothing; an untagged unit on a trunk joins no VLAN, it stays in
  // the subnet rows by its component). A boundary that turns out to be
  // another VLAN's access carrier is a conflict, not a silent join and not
  // a silent theft.
  const { implicit, conflicts } = floodFromAccessCarriers(idx, base, idValue, accessSeedPorts);
  for (const m of implicit) {
    if (memberByUnit.has(m.unitId)) continue;
    addMember(m.unitId, m.deviceId, m.interfaceId, { mode: undefined });
  }
  const dedupedConflicts: VlanRow['conflicts'] = [];
  const seenConflict = new Set<string>();
  for (const c of conflicts) {
    const key = `${c.otherVlanId}\u0000${c.viaDeviceId ?? ''}`;
    if (seenConflict.has(key)) continue;
    seenConflict.add(key);
    dedupedConflicts.push(c);
  }

  return {
    key: joined ? `vlan:${idValue}` : `vlan:${idValue}:${vlanNodeIds.slice().sort().join(',')}`,
    vlanId: idValue,
    name,
    description,
    vlanNodeIds,
    devices: [...devices],
    members: [...memberByUnit.values()],
    cidr,
    joined,
    lastChangeMs: lastChangeMsOf(idx, elementIds),
    conflicts: dedupedConflicts,
  };
}

function vlanRowsForId(idx: DocIndex, base: PortGraph, idValue: number, vlanNodes: readonly GraphNode[], candidateUnitIds: readonly string[]): VlanRow[] {
  const idSet = new Set(vlanNodes.map((n) => n.id));
  const domainUf = buildDomainUnionFind(idx, base, idValue, idSet, candidateUnitIds);

  // Group the Vlan nodes themselves: by shared domain key (port-graph
  // reachable), and by owning the same device — the same VLAN id twice on
  // one device is one VLAN there, port or no port on the second node.
  const nodeUf = new UnionFind();
  for (const vn of vlanNodes) nodeUf.find(vn.id);
  const byNodeComponentKey = new Map<string, string[]>();
  for (const vn of vlanNodes) {
    const key = nodeComponentKey(idx, base, domainUf, vn);
    const arr = byNodeComponentKey.get(key);
    if (arr) arr.push(vn.id);
    else byNodeComponentKey.set(key, [vn.id]);
  }
  for (const ids of byNodeComponentKey.values()) for (let i = 1; i < ids.length; i += 1) nodeUf.union(ids[0], ids[i]);
  const byDevice = new Map<string, string[]>();
  for (const vn of vlanNodes) {
    const hv = edgesInIdx(idx, vn.id, 'HasVlan')[0];
    if (!hv || !liveNode(idx, hv.from)) continue;
    const arr = byDevice.get(hv.from);
    if (arr) arr.push(vn.id);
    else byDevice.set(hv.from, [vn.id]);
  }
  for (const ids of byDevice.values()) for (let i = 1; i < ids.length; i += 1) nodeUf.union(ids[0], ids[i]);

  const groups = new Map<string, GraphNode[]>();
  const byId = new Map(vlanNodes.map((n) => [n.id, n]));
  for (const vn of vlanNodes) {
    const root = nodeUf.find(vn.id);
    const arr = groups.get(root);
    if (arr) arr.push(byId.get(vn.id)!);
    else groups.set(root, [byId.get(vn.id)!]);
  }
  const joined = groups.size === 1;

  const rows: VlanRow[] = [];
  for (const nodesInGroup of groups.values()) rows.push(buildVlanRow(idx, base, idValue, idSet, domainUf, candidateUnitIds, nodesInGroup, joined));
  return rows;
}

function vlanRowsOf(idx: DocIndex, base: PortGraph, carrierIndex: ReadonlyMap<number, string[]>): VlanRow[] {
  const byId = new Map<number, GraphNode[]>();
  for (const n of idx.nodeById.values()) {
    if (parseNodeId(n.id).kind !== 'Vlan') continue;
    const id = vlanIdOfNode(n);
    if (id === undefined) continue;
    const hv = edgesInIdx(idx, n.id, 'HasVlan')[0];
    if (!hv || !liveNode(idx, hv.from)) continue;
    const arr = byId.get(id);
    if (arr) arr.push(n);
    else byId.set(id, [n]);
  }

  const rows: VlanRow[] = [];
  for (const [idValue, nodes] of byId) rows.push(...vlanRowsForId(idx, base, idValue, nodes, carrierIndex.get(idValue) ?? EMPTY_UNIT_IDS));
  return rows.sort((a, b) => a.vlanId - b.vlanId || a.key.localeCompare(b.key));
}

const EMPTY_UNIT_IDS: readonly string[] = [];

// ---------------------------------------------------------------------------
// Subnets with no VLAN — grouped by (prefix, base-graph component).

interface SubnetCandidate {
  unitId: string;
  deviceId: string;
  interfaceId: string;
  addressNodeId: string;
  address: string;
  description?: string;
  net: { value: number; len: number };
}

function buildSubnetRow(idx: DocIndex, prefix: string, members: readonly SubnetCandidate[], singleGroupForPrefix: boolean): SubnetRow {
  const addressNodeIds = members.map((m) => m.addressNodeId);
  const key = singleGroupForPrefix ? `subnet:${prefix}` : `subnet:${prefix}:${addressNodeIds.slice().sort().join(',')}`;
  const first = members[0];
  const firstLabel = memberDisplay(idx, first.interfaceId, resolvePortForInterface(idx, first.interfaceId)).label;
  const label = `${firstLabel}${first.description ? ` · ${first.description}` : ''}`;
  const elementIds = [
    ...addressNodeIds,
    ...members.map((m) => edgesInIdx(idx, m.addressNodeId, 'HasAddress')[0]?.id).filter((x): x is string => x !== undefined),
  ];
  return {
    key,
    prefix,
    label,
    addressNodeIds,
    members: members.map((m) => {
      const res = resolvePortForInterface(idx, m.interfaceId);
      const { label: interfaceLabel, isFallback, portRemoved } = memberDisplay(idx, m.interfaceId, res);
      return {
        unitId: m.unitId,
        deviceId: m.deviceId,
        interfaceId: m.interfaceId,
        interfaceLabel,
        interfaceLabelIsFallback: isFallback,
        portRemoved,
        addressNodeId: m.addressNodeId,
        address: m.address,
        description: m.description,
      };
    }),
    lastChangeMs: lastChangeMsOf(idx, elementIds),
  };
}

function subnetRowsOf(idx: DocIndex, base: PortGraph, excludeUnits: ReadonlySet<string>): SubnetRow[] {
  const candidates: SubnetCandidate[] = [];
  for (const n of idx.nodeById.values()) {
    if (parseNodeId(n.id).kind !== 'Address') continue;
    const ha = edgesInIdx(idx, n.id, 'HasAddress')[0];
    if (!ha || !liveNode(idx, ha.from)) continue;
    if (excludeUnits.has(ha.from)) continue;
    const value = asString(fieldValue(n.fields, 'Address.value'));
    if (!value) continue;
    const net = safeIpv4NetworkOf(value);
    if (!net) continue; // inet6 or otherwise unreadable -- skipped, never thrown on
    const ctx = unitContext(idx, ha.from);
    if (!ctx) continue;
    const unitNode = liveNode(idx, ha.from);
    const description = asString(fieldValue(unitNode?.fields ?? {}, 'LogicalUnit.description'));
    candidates.push({ unitId: ha.from, deviceId: ctx.deviceId, interfaceId: ctx.interfaceId, addressNodeId: n.id, address: value, description, net });
  }

  const byPrefix = new Map<string, SubnetCandidate[]>();
  for (const c of candidates) {
    const prefix = formatMaskedIpv4(c.net.value, c.net.len);
    const arr = byPrefix.get(prefix);
    if (arr) arr.push(c);
    else byPrefix.set(prefix, [c]);
  }

  const rows: SubnetRow[] = [];
  for (const [prefix, members] of byPrefix) {
    if (members.length === 1) {
      rows.push(buildSubnetRow(idx, prefix, members, true));
      continue;
    }
    const groupKeyOf = (m: SubnetCandidate): string => {
      const res = resolvePortForInterface(idx, m.interfaceId);
      return res.kind === 'live' || res.kind === 'inferred' ? `p:${base.uf.find(res.portId)}` : `u:${m.unitId}`;
    };
    const groups = new Map<string, SubnetCandidate[]>();
    for (const m of members) {
      const root = groupKeyOf(m);
      const arr = groups.get(root);
      if (arr) arr.push(m);
      else groups.set(root, [m]);
    }
    const singleGroupForPrefix = groups.size === 1;
    for (const g of groups.values()) rows.push(buildSubnetRow(idx, prefix, g, singleGroupForPrefix));
  }
  return rows.sort((a, b) => a.prefix.localeCompare(b.prefix) || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// "Do not guess": a device with no role never bridges, so two same-prefix
// subnet rows that would join through it stay apart. This names the device
// on both rows instead, rather than assuming its role.

function roleHintsForSubnets(idx: DocIndex, base: PortGraph, rows: readonly SubnetRow[]): Map<string, string> {
  const hints = new Map<string, string>();
  const byPrefix = new Map<string, SubnetRow[]>();
  for (const r of rows) {
    if (r.members.length === 0) continue;
    const arr = byPrefix.get(r.prefix);
    if (arr) arr.push(r);
    else byPrefix.set(r.prefix, [r]);
  }
  for (const group of byPrefix.values()) {
    if (group.length < 2) continue;
    const rootOfRow = new Map<string, string>();
    for (const r of group) {
      const res = resolvePortForInterface(idx, r.members[0].interfaceId);
      if (res.kind === 'live' || res.kind === 'inferred') rootOfRow.set(r.key, base.uf.find(res.portId));
    }
    if (rootOfRow.size < 2) continue;
    for (const n of idx.nodeById.values()) {
      if (parseNodeId(n.id).kind !== 'Device' || deviceRole(idx, n.id) !== undefined) continue;
      const ports = chassisPortsOf(idx, n.id);
      if (ports.length < 2) continue;
      const farRoots = new Set<string>();
      for (const p of ports) {
        const partner = base.cablePartner.get(p);
        if (partner) farRoots.add(base.uf.find(partner.farPortId));
      }
      const matched = [...rootOfRow.entries()].filter(([, root]) => farRoots.has(root));
      if (matched.length >= 2) for (const [rowKey] of matched) hints.set(rowKey, n.id);
    }
  }
  return hints;
}

// ---------------------------------------------------------------------------
// Docker rows themselves (ADR-0058).

function asStringArrayField(fields: Readonly<Record<string, FieldEntry>>, name: string): string[] {
  const v = fieldValue(fields, name);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function firstAttachedAddress(edge: GraphEdge): string | undefined {
  const v = fieldValue(edge.fields, 'AttachedTo.address');
  return Array.isArray(v) ? v.find((x): x is string => typeof x === 'string') : undefined;
}

function numberField(fields: Readonly<Record<string, FieldEntry>>, name: string): number | undefined {
  const s = asString(fieldValue(fields, name));
  return s !== undefined ? Number(s) : undefined;
}

/** Whichever VLAN or subnet row a Docker network's parent unit already
 * belongs to, by its own membership (ADR-0058 decision 2) — never guessed. */
function findParentPlacement(unitId: string, vlanRows: readonly VlanRow[], subnetRows: readonly SubnetRow[]): string | undefined {
  for (const r of vlanRows) {
    if (r.members.some((m) => m.unitId === unitId)) return `VLAN ${r.vlanId}`;
  }
  for (const r of subnetRows) {
    if (r.members.some((m) => m.unitId === unitId)) return r.prefix;
  }
  return undefined;
}

/** An absent `host_address` binds every host address, same as an explicit
 * `0.0.0.0` (docker/docs port-publishing.md) — both are "wildcard" here. */
function isWildcardHostAddress(hostAddress: string | undefined): boolean {
  return hostAddress === undefined || hostAddress === '0.0.0.0';
}

/** Every live `PublishedPort` sharing host, protocol and host port with
 * another on the same host: `'certain'` when the address matches exactly,
 * `'likely'` when a wildcard binds against a specific address (see
 * `conflict`'s own doc). An ephemeral port (no `host_port`) never
 * conflicts — Docker assigns a fresh one each time. One pass, shared by
 * `dockerNetworkRowsOf` and `dockerUnattachedContainersOf`. */
function buildPublishedPortConflicts(idx: DocIndex): ReadonlyMap<string, 'certain' | 'likely'> {
  interface PortGroup {
    wildcard: string[];
    byAddress: Map<string, string[]>;
  }
  const groups = new Map<string, PortGroup>();
  for (const n of idx.nodesByKind.get('PublishedPort') ?? EMPTY_NODES) {
    const hostPort = numberField(n.fields, 'PublishedPort.host_port');
    if (hostPort === undefined) continue;
    const protocol = numberField(n.fields, 'PublishedPort.protocol');
    const hostAddress = asString(fieldValue(n.fields, 'PublishedPort.host_address'));
    const hpp = edgesInIdx(idx, n.id, 'HasPublishedPort')[0];
    const container = hpp ? liveNode(idx, hpp.from) : undefined;
    if (!container) continue;
    const hc = edgesInIdx(idx, container.id, 'HasContainer')[0];
    const hostDeviceId = hc && liveNode(idx, hc.from) ? hc.from : undefined;
    if (!hostDeviceId) continue;
    const key = `${hostDeviceId}\u0000${protocol}\u0000${hostPort}`;
    let g = groups.get(key);
    if (!g) {
      g = { wildcard: [], byAddress: new Map() };
      groups.set(key, g);
    }
    if (isWildcardHostAddress(hostAddress)) {
      g.wildcard.push(n.id);
    } else {
      const arr = g.byAddress.get(hostAddress!);
      if (arr) arr.push(n.id);
      else g.byAddress.set(hostAddress!, [n.id]);
    }
  }
  const conflicts = new Map<string, 'certain' | 'likely'>();
  const mark = (id: string, level: 'certain' | 'likely') => {
    if (conflicts.get(id) !== 'certain') conflicts.set(id, level);
  };
  for (const g of groups.values()) {
    if (g.wildcard.length > 1) for (const id of g.wildcard) mark(id, 'certain');
    for (const ids of g.byAddress.values()) {
      if (ids.length > 1) for (const id of ids) mark(id, 'certain');
    }
    if (g.wildcard.length > 0 && g.byAddress.size > 0) {
      for (const id of g.wildcard) mark(id, 'likely');
      for (const ids of g.byAddress.values()) for (const id of ids) mark(id, 'likely');
    }
  }
  return conflicts;
}

/** One row per live `ContainerNetwork`, board A's "Docker networks" group.
 * A network whose host `Device` is no longer live is skipped entirely, the
 * same rule `vlanRowsOf`/`subnetRowsOf` follow. */
function dockerNetworkRowsOf(
  idx: DocIndex,
  vlanRows: readonly VlanRow[],
  subnetRows: readonly SubnetRow[],
  portConflicts: ReadonlyMap<string, 'certain' | 'likely'>,
): DockerNetworkRow[] {
  const rows: DockerNetworkRow[] = [];
  for (const n of idx.nodesByKind.get('ContainerNetwork') ?? EMPTY_NODES) {
    const hcn = edgesInIdx(idx, n.id, 'HasContainerNetwork')[0];
    if (!hcn || !liveNode(idx, hcn.from)) continue;
    const hostDeviceId = hcn.from;
    const name = asString(fieldValue(n.fields, 'ContainerNetwork.name')) ?? n.id;
    const driver = asString(fieldValue(n.fields, 'ContainerNetwork.driver')) ?? 'other';
    const subnets = asStringArrayField(n.fields, 'ContainerNetwork.subnet');
    const gateways = asStringArrayField(n.fields, 'ContainerNetwork.gateway');

    const elementIds: string[] = [n.id, hcn.id];
    let parentUnitId: string | undefined;
    let parentSameHost = true;
    let idCidr = subnets.length > 0 ? subnets.join(', ') : '—';
    const pu = edgesOutIdx(idx, n.id, 'ParentUnit')[0];
    if (pu && liveNode(idx, pu.to)) {
      parentUnitId = pu.to;
      elementIds.push(pu.id);
      const ctx = unitContext(idx, parentUnitId);
      parentSameHost = ctx?.deviceId === hostDeviceId;
      const ifaceLabel = ctx ? memberDisplay(idx, ctx.interfaceId, resolvePortForInterface(idx, ctx.interfaceId)).label : parentUnitId;
      const placement = findParentPlacement(parentUnitId, vlanRows, subnetRows);
      idCidr = placement ? `${placement} via ${ifaceLabel}` : `via ${ifaceLabel}`;
    }

    const containers: DockerContainerRow[] = [];
    for (const at of edgesInIdx(idx, n.id, 'AttachedTo')) {
      const containerNode = liveNode(idx, at.from);
      if (!containerNode) continue;
      const hc = edgesInIdx(idx, containerNode.id, 'HasContainer')[0];
      const containerHost = hc && liveNode(idx, hc.from) ? hc.from : undefined;
      // A container whose own host is gone is never listed here at all —
      // never credited to this network's host instead, overlay or not.
      if (!containerHost) continue;
      const sameHost = driver === 'overlay' || containerHost === hostDeviceId;
      const cName = asString(fieldValue(containerNode.fields, 'Container.name')) ?? containerNode.id;
      const publishedPorts: DockerPublishedPortRow[] = [];
      for (const hpp of edgesOutIdx(idx, containerNode.id, 'HasPublishedPort')) {
        const ppNode = liveNode(idx, hpp.to);
        if (!ppNode) continue;
        publishedPorts.push({
          id: ppNode.id,
          protocolNumber: numberField(ppNode.fields, 'PublishedPort.protocol') ?? 0,
          containerPort: numberField(ppNode.fields, 'PublishedPort.container_port') ?? 0,
          hostPort: numberField(ppNode.fields, 'PublishedPort.host_port'),
          hostAddress: asString(fieldValue(ppNode.fields, 'PublishedPort.host_address')),
          conflict: portConflicts.get(ppNode.id),
        });
        elementIds.push(ppNode.id, hpp.id);
      }
      containers.push({
        containerId: containerNode.id,
        name: cName,
        deviceId: containerHost,
        attachedToEdgeId: at.id,
        address: firstAttachedAddress(at),
        publishedPorts,
        sameHost,
      });
      elementIds.push(containerNode.id, at.id);
      if (hc) elementIds.push(hc.id);
    }

    rows.push({
      key: `docker:${n.id}`,
      containerNetworkId: n.id,
      name,
      driver,
      hostDeviceId,
      subnets,
      gateways,
      parentUnitId,
      parentSameHost,
      idCidr,
      containers,
      lastChangeMs: lastChangeMsOf(idx, elementIds),
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/** Every live `Container` with no live `AttachedTo` edge at all — a row of
 * its own, per host, so a detach never leaves something nobody can see. */
function dockerUnattachedContainersOf(idx: DocIndex, portConflicts: ReadonlyMap<string, 'certain' | 'likely'>): DockerUnattachedContainerRow[] {
  const rows: DockerUnattachedContainerRow[] = [];
  for (const n of idx.nodesByKind.get('Container') ?? EMPTY_NODES) {
    const hasAnyAttachment = edgesOutIdx(idx, n.id, 'AttachedTo').some((e) => liveNode(idx, e.to));
    if (hasAnyAttachment) continue;
    const hc = edgesInIdx(idx, n.id, 'HasContainer')[0];
    if (!hc || !liveNode(idx, hc.from)) continue;
    const name = asString(fieldValue(n.fields, 'Container.name')) ?? n.id;
    const elementIds: string[] = [n.id, hc.id];
    const publishedPorts: DockerPublishedPortRow[] = [];
    for (const hpp of edgesOutIdx(idx, n.id, 'HasPublishedPort')) {
      const ppNode = liveNode(idx, hpp.to);
      if (!ppNode) continue;
      publishedPorts.push({
        id: ppNode.id,
        protocolNumber: numberField(ppNode.fields, 'PublishedPort.protocol') ?? 0,
        containerPort: numberField(ppNode.fields, 'PublishedPort.container_port') ?? 0,
        hostPort: numberField(ppNode.fields, 'PublishedPort.host_port'),
        hostAddress: asString(fieldValue(ppNode.fields, 'PublishedPort.host_address')),
        conflict: portConflicts.get(ppNode.id),
      });
      elementIds.push(ppNode.id, hpp.id);
    }
    rows.push({ key: `docker-unattached:${n.id}`, containerId: n.id, name, hostDeviceId: hc.from, publishedPorts, lastChangeMs: lastChangeMsOf(idx, elementIds) });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/** A macvlan/ipvlan container's address also counts as a member of its
 * parent unit's VLAN or subnet row — mutates the freshly-built rows in
 * place before `deriveNetworks` caches its result. A broken same-host rule
 * is skipped here, not folded; `dockerNetworkRows` still lists it, marked. */
function foldMacvlanContainersIntoRows(dockerRows: readonly DockerNetworkRow[], vlanRows: readonly VlanRow[], subnetRows: readonly SubnetRow[]): void {
  for (const dr of dockerRows) {
    if (dr.driver !== 'macvlan' && dr.driver !== 'ipvlan') continue;
    if (!dr.parentUnitId || !dr.parentSameHost) continue;
    for (const c of dr.containers) {
      if (!c.sameHost) continue;
      const vlanRow = vlanRows.find((r) => r.members.some((m) => m.unitId === dr.parentUnitId));
      if (vlanRow) {
        vlanRow.members.push({
          unitId: c.containerId,
          deviceId: c.deviceId,
          interfaceId: dr.parentUnitId,
          interfaceLabel: c.name,
          interfaceLabelIsFallback: false,
          portRemoved: false,
          mode: undefined,
          address: c.address,
          isGateway: false,
          farIsSameDevice: false,
          viaPassiveHops: 0,
          container: { containerId: c.containerId, name: c.name },
        });
        continue;
      }
      const subnetRow = subnetRows.find((r) => r.members.some((m) => m.unitId === dr.parentUnitId));
      if (subnetRow) {
        subnetRow.members.push({
          unitId: c.containerId,
          deviceId: c.deviceId,
          interfaceId: dr.parentUnitId,
          interfaceLabel: c.name,
          interfaceLabelIsFallback: false,
          portRemoved: false,
          addressNodeId: c.containerId,
          address: c.address ?? '',
          container: { containerId: c.containerId, name: c.name },
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------

const derivedCache = new WeakMap<Document, NetworksDerived>();

/** The whole Networks list, in one pass over one shared, indexed port graph.
 * Pure — a fresh computation over `doc` the first time it is asked for, then
 * memoised on the `Document` object itself: a caller that hands back the
 * same reference (unchanged since the last call) gets the cached result,
 * not a rebuild. Never throws: every numeric parse inside is guarded, so a
 * document holding an IPv6 or otherwise unreadable `Address` still derives
 * everything it can read. */
export function deriveNetworks(doc: Document): NetworksDerived {
  const cached = derivedCache.get(doc);
  if (cached) return cached;
  const idx = buildIndex(doc);
  const base = buildPortGraph(idx);
  const carrierIndex = buildVlanCarrierIndex(idx);
  const vlanRows = vlanRowsOf(idx, base, carrierIndex);
  const excludeUnits = new Set(vlanRows.flatMap((r) => r.members.map((m) => m.unitId)));
  const subnetRowsPlain = subnetRowsOf(idx, base, excludeUnits);
  const hints = roleHintsForSubnets(idx, base, subnetRowsPlain);
  const subnetRows = hints.size === 0 ? subnetRowsPlain : subnetRowsPlain.map((r) => (hints.has(r.key) ? { ...r, roleHintDeviceId: hints.get(r.key) } : r));
  const portConflicts = buildPublishedPortConflicts(idx);
  const dockerNetworkRows = dockerNetworkRowsOf(idx, vlanRows, subnetRows, portConflicts);
  foldMacvlanContainersIntoRows(dockerNetworkRows, vlanRows, subnetRows);
  const dockerUnattachedContainers = dockerUnattachedContainersOf(idx, portConflicts);
  const result: NetworksDerived = { vlanRows, subnetRows, dockerNetworkRows, dockerUnattachedContainers };
  derivedCache.set(doc, result);
  return result;
}

/** GitHub issue #54 — "show only the cables of VLAN 30": every live `Cable`
 * id carrying a member of ONE joined row, given by its `vlanNodeIds`. */
export function cablesCarryingVlan(doc: Document, vlanNodeIds: readonly string[]): string[] {
  const idx = buildIndex(doc);
  const nodes = vlanNodeIds.map((id) => liveNode(idx, id)).filter((n): n is GraphNode => n !== undefined);
  if (nodes.length === 0) return [];
  const idValue = vlanIdOfNode(nodes[0]);
  if (idValue === undefined) return [];
  const idSet = new Set(allLiveVlanNodesWithId(idx, idValue).map((n) => n.id));
  const base = buildPortGraph(idx);
  const domainUf = buildDomainUnionFind(idx, base, idValue, idSet, buildVlanCarrierIndex(idx).get(idValue) ?? EMPTY_UNIT_IDS);
  const key = nodeComponentKey(idx, base, domainUf, nodes[0]);
  const cableIds = new Set<string>();
  for (const portId of base.livePorts) {
    if (domainKeyOfPort(base, domainUf, portId) !== key) continue;
    const partner = base.cablePartner.get(portId);
    if (partner) for (const c of partner.cableIds) cableIds.add(c);
  }
  return [...cableIds].sort();
}
