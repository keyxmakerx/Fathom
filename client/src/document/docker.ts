// ADR-0058 — Docker commands: a ContainerNetwork/Container on their host, a
// PublishedPort on a container, AttachedTo a network, ParentUnit for
// macvlan/ipvlan. One batch per call, nothing written on a refusal; decision
// 5 keeps out environment, command and label fields, and compose import.

import {
  archiveField,
  assertHand,
  edgesIn,
  edgesOut,
  findNode,
  formatEdgeId,
  formatNodeId,
  identifier,
  interfaceAddress,
  ipAddr,
  ipPrefix,
  ipProtocol,
  ipv4NetworkOf,
  isGoTrimSpaceBlank,
  isWellFormedUnicode,
  l4Port,
  parseEdgeId,
  parseNodeId,
  requireFieldName,
  text,
  token,
  withBatch,
  withEdge,
  withNode,
  type Document,
  type FieldEntry,
  type Op,
} from './model';
import { resolve, resolveOrCreateUnit, type Actor, type NetworkAttachTarget } from './networks';
import { newUlid } from './ulid';
import type { CanonValue } from './canon';

/** `docker run -p`'s three `/proto` suffixes, mapped to `IpProtocol` numbers
 * (docker/go-connections `nat.go`): tcp 6, udp 17, sctp 132; unsuffixed
 * defaults to tcp. */
export const DOCKER_PROTOCOL_NUMBERS: Readonly<Record<string, number>> = { tcp: 6, udp: 17, sctp: 132 };

export type DockerDriver = 'bridge' | 'host' | 'none' | 'macvlan' | 'ipvlan' | 'overlay' | 'other';

// ---------------------------------------------------------------------------
// Mirrors `commands.ts`'s/`networks.ts`'s private `setField` — each module
// keeps its own copy, private to itself.

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
  const archived = existing !== undefined ? archiveField(prov.doc, elementId, key, existing) : prov.doc;
  return {
    doc: archived,
    entry: { presence: 'set', prov: prov.id, value },
    op: { type: 'set_field', element: elementId, key, presence: 'set', prov: prov.id },
  };
}

function fieldValue(fields: Readonly<Record<string, FieldEntry>>, name: string): FieldEntry['value'] | undefined {
  const e = fields[name];
  return e && e.presence === 'set' ? e.value : undefined;
}

function asString(v: FieldEntry['value'] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

// ---------------------------------------------------------------------------
// One error class for every refusal this module makes, `networks.ts`'s own
// shape (ADR-0058 §7: "each refuses what the schema forbids, by name").

export type DockerRefusalCode =
  | 'unknown-reference'
  | 'network-name-invalid'
  | 'network-name-reserved'
  | 'device-already-has-network'
  | 'parent-required'
  | 'parent-not-applicable'
  | 'parent-not-same-host'
  | 'bad-subnet'
  | 'bad-gateway'
  | 'gateway-outside-subnet'
  | 'network-has-containers'
  | 'container-name-invalid'
  | 'device-already-has-container'
  | 'already-attached'
  | 'not-same-host'
  | 'bad-address'
  | 'address-outside-subnet'
  | 'duplicate-address'
  | 'unknown-protocol'
  | 'bad-port'
  | 'duplicate-published-port';

export class DockerRefusalError extends Error {
  readonly code: DockerRefusalCode;
  constructor(code: DockerRefusalCode, message: string) {
    super(message);
    this.name = 'DockerRefusalError';
    this.code = code;
  }
}

function refuse(code: DockerRefusalCode, message: string): never {
  throw new DockerRefusalError(code, message);
}

function requireLiveOfKind(doc: Document, id: string, wantedKind: string): void {
  const n = findNode(doc, id);
  if (!n || n.absentSince !== undefined || parseNodeId(id).kind !== wantedKind) {
    refuse('unknown-reference', `"${id}" is not a live ${wantedKind} in this document`);
  }
}

function requireLiveDevice(doc: Document, id: string): void {
  const n = findNode(doc, id);
  if (!n || n.absentSince !== undefined || parseNodeId(id).kind !== 'Device') {
    refuse('unknown-reference', `"${id}" is not a live Device in this document`);
  }
}

function hostOfContainerNetwork(doc: Document, containerNetworkId: string): string | undefined {
  return edgesIn(doc, containerNetworkId, 'HasContainerNetwork')[0]?.from;
}

function hostOfContainer(doc: Document, containerId: string): string | undefined {
  return edgesIn(doc, containerId, 'HasContainer')[0]?.from;
}

// ---------------------------------------------------------------------------
// addContainerNetwork / removeContainerNetwork

export interface AddContainerNetworkOptions {
  hostDeviceId: string;
  name: string;
  driver: DockerDriver;
  /** `IpPrefix` strings, `docker network create --subnet`, one or more. */
  subnets?: readonly string[];
  /** `IpAddr` strings, `docker network create --gateway`, one or more. */
  gateways?: readonly string[];
  /** The parent interface on the SAME host (ADR-0058 decision 3) — required
   * iff `driver` is `macvlan` or `ipvlan`, refused otherwise. */
  parent?: NetworkAttachTarget;
}

// schema.yaml's own doc on ContainerNetwork.name: moby/moby reserves these
// names; bridge/host/none stay accepted.
const DOCKER_RESERVED_NETWORK_NAMES = new Set(['default']);

function requireRecordableNetworkName(name: string): void {
  // Go's `strings.TrimSpace`, not JavaScript's `trim()` — the two
  // whitespace sets differ (`isGoTrimSpaceBlank`'s own doc).
  if (isGoTrimSpaceBlank(name)) {
    refuse('network-name-invalid', 'network name must not be blank');
  }
  if (!isWellFormedUnicode(name)) {
    refuse('network-name-invalid', `network name "${name}" is not well-formed Unicode`);
  }
  if (name === 'container' || name.startsWith('container:') || DOCKER_RESERVED_NETWORK_NAMES.has(name)) {
    refuse('network-name-reserved', `"${name}" cannot be a Docker network's name`);
  }
}

/** Whether `addressText`'s IP falls inside `subnetText`, masked by its own
 * prefix length — never throws; unparseable input reads as "not inside." */
function ipInSubnet(addressText: string, subnetText: string): boolean {
  try {
    const ip = addressOnly(addressText);
    const net = ipv4NetworkOf(subnetText);
    const masked = ipv4NetworkOf(`${ip}/${net.len}`);
    return masked.value === net.value;
  } catch {
    return false;
  }
}

/** The bare IP, dropping any "/len" suffix — two addresses that differ only
 * in prefix length are the same address to dockerd's allocator. */
function addressOnly(addressText: string): string {
  return addressText.split('/')[0];
}

function containerNetworkExistsOnDevice(doc: Document, deviceId: string, name: string): boolean {
  for (const hcn of edgesOut(doc, deviceId, 'HasContainerNetwork')) {
    if (hcn.absentSince !== undefined) continue;
    const n = findNode(doc, hcn.to);
    if (!n || n.absentSince !== undefined) continue;
    if (asString(fieldValue(n.fields, 'ContainerNetwork.name')) === name) return true;
  }
  return false;
}

/** Adds a Docker network on `hostDeviceId` (ADR-0058 decision 3): name,
 * driver, subnets, gateways, and a macvlan/ipvlan network's `ParentUnit`.
 * Refuses a parent for the wrong driver, and one that resolves off
 * `hostDeviceId` — `parentunit.same-host`'s L0 rule, editor-enforced. */
export function addContainerNetwork(doc: Document, opts: AddContainerNetworkOptions, actorOpts?: Actor): Document {
  requireRecordableNetworkName(opts.name);
  const needsParent = opts.driver === 'macvlan' || opts.driver === 'ipvlan';
  if (needsParent && !opts.parent) {
    refuse('parent-required', `driver "${opts.driver}" needs a parent interface on the same host`);
  }
  if (!needsParent && opts.parent) {
    refuse('parent-not-applicable', `driver "${opts.driver}" does not take a parent interface — only macvlan and ipvlan do`);
  }
  const subnets = opts.subnets ?? [];
  const subnetValues: CanonValue[] = [];
  for (const s of subnets) {
    try {
      subnetValues.push(ipPrefix(s));
    } catch {
      refuse('bad-subnet', `subnet "${s}" is not a valid host-bits-free prefix`);
    }
  }
  const gateways = opts.gateways ?? [];
  const gatewayValues: CanonValue[] = [];
  for (const g of gateways) {
    try {
      gatewayValues.push(ipAddr(g));
    } catch {
      refuse('bad-gateway', `gateway "${g}" is not a valid IPv4 address`);
    }
  }
  // dockerd's own validateAddress (daemon/network.go): a gateway outside
  // its subnet is refused, not just malformed.
  for (const g of gateways) {
    if (subnets.length > 0 && !subnets.some((s) => ipInSubnet(g, s))) {
      refuse('gateway-outside-subnet', `gateway "${g}" is outside every subnet given`);
    }
  }

  requireLiveDevice(doc, opts.hostDeviceId);
  if (containerNetworkExistsOnDevice(doc, opts.hostDeviceId, opts.name)) {
    refuse('device-already-has-network', `device "${opts.hostDeviceId}" already has a Docker network named "${opts.name}"`);
  }

  const { actor, now } = resolve(actorOpts);
  let working = doc;
  const ops: Op[] = [];

  const cnExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = cnExistence.doc;
  const cnId = formatNodeId('ContainerNetwork', newUlid(now));
  const nameField = setField(working, now, actor, cnId, undefined, 'ContainerNetwork.name', text(opts.name));
  working = nameField.doc;
  const driverField = setField(working, now, actor, cnId, undefined, 'ContainerNetwork.driver', token(opts.driver));
  working = driverField.doc;
  const nodeFields: Record<string, FieldEntry> = {
    'ContainerNetwork.name': nameField.entry,
    'ContainerNetwork.driver': driverField.entry,
  };
  const fieldOps: Op[] = [nameField.op, driverField.op];
  if (subnetValues.length > 0) {
    const sf = setField(working, now, actor, cnId, undefined, 'ContainerNetwork.subnet', subnetValues);
    working = sf.doc;
    nodeFields['ContainerNetwork.subnet'] = sf.entry;
    fieldOps.push(sf.op);
  }
  if (gatewayValues.length > 0) {
    const gf = setField(working, now, actor, cnId, undefined, 'ContainerNetwork.gateway', gatewayValues);
    working = gf.doc;
    nodeFields['ContainerNetwork.gateway'] = gf.entry;
    fieldOps.push(gf.op);
  }
  working = withNode(working, { id: cnId, existence: cnExistence.id, fields: nodeFields });
  ops.push({ type: 'add_node', node: cnId, prov: cnExistence.id }, ...fieldOps);

  const hcnProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = hcnProv.doc;
  const hcnId = formatEdgeId('HasContainerNetwork', newUlid(now));
  working = withEdge(working, { id: hcnId, from: opts.hostDeviceId, to: cnId, prov: hcnProv.id, fields: {} });
  ops.push({ type: 'add_edge', edge: hcnId, from: opts.hostDeviceId, to: cnId, prov: hcnProv.id });

  if (opts.parent) {
    const resolved = resolveOrCreateUnit(working, now, actor, ops, opts.parent, 0);
    working = resolved.working;
    if (resolved.deviceId !== opts.hostDeviceId) {
      refuse('parent-not-same-host', `the parent interface resolves to device "${resolved.deviceId}", not this network's host "${opts.hostDeviceId}"`);
    }
    const puProv = assertHand(working, { assertedAt: now, assertedBy: actor });
    working = puProv.doc;
    const puId = formatEdgeId('ParentUnit', newUlid(now));
    working = withEdge(working, { id: puId, from: cnId, to: resolved.unitId, prov: puProv.id, fields: {} });
    ops.push({ type: 'add_edge', edge: puId, from: cnId, to: resolved.unitId, prov: puProv.id });
  }

  const label = `add Docker network ${opts.name}`;
  return withBatch(working, { id: newUlid(now), label, ops });
}

/** Removes a Docker network — refused while any live `Container` is
 * `AttachedTo` it. Tombstone only; parent unit/interface/port untouched. */
export function removeContainerNetwork(doc: Document, containerNetworkId: string, actorOpts?: Actor): Document {
  requireLiveOfKind(doc, containerNetworkId, 'ContainerNetwork');
  const attached = edgesIn(doc, containerNetworkId, 'AttachedTo').filter((e) => e.absentSince === undefined);
  if (attached.length > 0) {
    refuse('network-has-containers', `"${containerNetworkId}" still has ${attached.length} container(s) attached — detach them first`);
  }
  const { actor, now } = resolve(actorOpts);
  const nodeIds = new Set([containerNetworkId]);
  const edgeIds = new Set<string>();
  const hcn = edgesIn(doc, containerNetworkId, 'HasContainerNetwork')[0];
  if (hcn) edgeIds.add(hcn.id);
  const pu = edgesOut(doc, containerNetworkId, 'ParentUnit')[0];
  if (pu) edgeIds.add(pu.id);
  const working: Document = {
    ...doc,
    nodes: doc.nodes.map((n) => (nodeIds.has(n.id) ? { ...n, absentSince: now } : n)),
    edges: doc.edges.map((e) => (edgeIds.has(e.id) ? { ...e, absentSince: now } : e)),
  };
  const ops: Op[] = [...nodeIds, ...edgeIds].map((element): Op => ({ type: 'tombstone', element, at: now, by: actor }));
  return withBatch(working, { id: newUlid(now), label: 'remove Docker network', ops });
}

// ---------------------------------------------------------------------------
// addContainer / removeContainer

export interface AddContainerOptions {
  hostDeviceId: string;
  name: string;
}

function containerExistsOnDevice(doc: Document, deviceId: string, name: string): boolean {
  for (const hc of edgesOut(doc, deviceId, 'HasContainer')) {
    if (hc.absentSince !== undefined) continue;
    const n = findNode(doc, hc.to);
    if (!n || n.absentSince !== undefined) continue;
    if (asString(fieldValue(n.fields, 'Container.name')) === name) return true;
  }
  return false;
}

/** The node/edge writes a new container needs, shared by `addContainer` and
 * `attachContainerToNetwork`'s `'new'` branch — inlined into the caller's
 * batch so naming and attaching a container is never two undos. */
function writeNewContainer(working: Document, now: number, actor: string, ops: Op[], hostDeviceId: string, name: string): { working: Document; containerId: string } {
  const cExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = cExistence.doc;
  const cId = formatNodeId('Container', newUlid(now));
  const nameField = setField(working, now, actor, cId, undefined, 'Container.name', identifier(name));
  working = nameField.doc;
  working = withNode(working, { id: cId, existence: cExistence.id, fields: { 'Container.name': nameField.entry } });
  ops.push({ type: 'add_node', node: cId, prov: cExistence.id }, nameField.op);

  const hcProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = hcProv.doc;
  const hcId = formatEdgeId('HasContainer', newUlid(now));
  working = withEdge(working, { id: hcId, from: hostDeviceId, to: cId, prov: hcProv.id, fields: {} });
  ops.push({ type: 'add_edge', edge: hcId, from: hostDeviceId, to: cId, prov: hcProv.id });

  return { working, containerId: cId };
}

/** Adds a bare Docker container on `hostDeviceId`, attached to nothing —
 * the name only (decision 5: no environment, command or labels). */
export function addContainer(doc: Document, opts: AddContainerOptions, actorOpts?: Actor): Document {
  try {
    identifier(opts.name);
  } catch (e) {
    refuse('container-name-invalid', `container name "${opts.name}" is not an Identifier (${e instanceof Error ? e.message : e})`);
  }
  requireLiveDevice(doc, opts.hostDeviceId);
  if (containerExistsOnDevice(doc, opts.hostDeviceId, opts.name)) {
    refuse('device-already-has-container', `device "${opts.hostDeviceId}" already has a container named "${opts.name}"`);
  }

  const { actor, now } = resolve(actorOpts);
  const ops: Op[] = [];
  const created = writeNewContainer(doc, now, actor, ops, opts.hostDeviceId, opts.name);
  return withBatch(created.working, { id: newUlid(now), label: `add container ${opts.name}`, ops });
}

/** Removes a container and everything it owns: its `AttachedTo` edges, its
 * `PublishedPort`s and their `HasPublishedPort` edges. The host is untouched. */
export function removeContainer(doc: Document, containerId: string, actorOpts?: Actor): Document {
  requireLiveOfKind(doc, containerId, 'Container');
  const { actor, now } = resolve(actorOpts);
  const nodeIds = new Set([containerId]);
  const edgeIds = new Set<string>();
  const hc = edgesIn(doc, containerId, 'HasContainer')[0];
  if (hc) edgeIds.add(hc.id);
  for (const at of edgesOut(doc, containerId, 'AttachedTo')) {
    if (at.absentSince === undefined) edgeIds.add(at.id);
  }
  for (const hpp of edgesOut(doc, containerId, 'HasPublishedPort')) {
    if (hpp.absentSince !== undefined) continue;
    edgeIds.add(hpp.id);
    nodeIds.add(hpp.to);
  }
  const working: Document = {
    ...doc,
    nodes: doc.nodes.map((n) => (nodeIds.has(n.id) ? { ...n, absentSince: now } : n)),
    edges: doc.edges.map((e) => (edgeIds.has(e.id) ? { ...e, absentSince: now } : e)),
  };
  const ops: Op[] = [...nodeIds, ...edgeIds].map((element): Op => ({ type: 'tombstone', element, at: now, by: actor }));
  return withBatch(working, { id: newUlid(now), label: 'remove container', ops });
}

// ---------------------------------------------------------------------------
// attachContainerToNetwork / detachContainerFromNetwork

/** Which container ends up attached: one already on the graph, or one named
 * fresh here — decision 7's "one undoable change" means naming and
 * attaching a container never costs two batches. */
export type AttachContainerTarget = { kind: 'existing'; containerId: string } | { kind: 'new'; hostDeviceId: string; name: string };

export interface AttachContainerOptions {
  networkId: string;
  container: AttachContainerTarget;
  /** `InterfaceAddress` — Docker's own assigned address, or one the user
   * states; optional (Docker may assign one later). */
  address?: string;
}

/** Attaches a container to a Docker network with its address (ADR-0058
 * decision 3). Refuses a second live `AttachedTo` edge between the same
 * pair, and attaching across hosts unless the driver is `overlay` —
 * `attachedto.same-host`'s L0 rule, editor-enforced. */
export function attachContainerToNetwork(doc: Document, opts: AttachContainerOptions, actorOpts?: Actor): Document {
  requireLiveOfKind(doc, opts.networkId, 'ContainerNetwork');
  let addressValue: FieldEntry['value'] | undefined;
  if (opts.address !== undefined) {
    try {
      addressValue = interfaceAddress(opts.address);
    } catch {
      refuse('bad-address', `address "${opts.address}" is not a valid IPv4 host address`);
    }
  }

  if (opts.container.kind === 'new') {
    try {
      identifier(opts.container.name);
    } catch (e) {
      refuse('container-name-invalid', `container name "${opts.container.name}" is not an Identifier (${e instanceof Error ? e.message : e})`);
    }
    requireLiveDevice(doc, opts.container.hostDeviceId);
    if (containerExistsOnDevice(doc, opts.container.hostDeviceId, opts.container.name)) {
      refuse('device-already-has-container', `device "${opts.container.hostDeviceId}" already has a container named "${opts.container.name}"`);
    }
  } else {
    requireLiveOfKind(doc, opts.container.containerId, 'Container');
  }

  const { actor, now } = resolve(actorOpts);
  let working = doc;
  const ops: Op[] = [];
  let containerId: string;
  if (opts.container.kind === 'new') {
    const created = writeNewContainer(working, now, actor, ops, opts.container.hostDeviceId, opts.container.name);
    working = created.working;
    containerId = created.containerId;
  } else {
    containerId = opts.container.containerId;
  }

  const already = edgesOut(working, containerId, 'AttachedTo').some((e) => e.absentSince === undefined && e.to === opts.networkId);
  if (already) {
    refuse('already-attached', `container "${containerId}" is already attached to "${opts.networkId}"`);
  }

  const networkNode = findNode(working, opts.networkId)!;
  const driver = asString(fieldValue(networkNode.fields, 'ContainerNetwork.driver'));
  const networkHost = hostOfContainerNetwork(working, opts.networkId);
  const containerHost = hostOfContainer(working, containerId);
  if (driver !== 'overlay' && networkHost !== containerHost) {
    refuse('not-same-host', `container "${containerId}" is on a different host than network "${opts.networkId}" — only an overlay network spans hosts`);
  }

  if (opts.address !== undefined) {
    // dockerd's own address allocator (daemon/libnetwork/endpoint.go,
    // RequestAddress): refuses an address outside every subnet, or one
    // already allocated to another container on the same network.
    const networkSubnetsField = fieldValue(networkNode.fields, 'ContainerNetwork.subnet');
    const networkSubnets = Array.isArray(networkSubnetsField) ? networkSubnetsField.filter((v): v is string => typeof v === 'string') : [];
    if (networkSubnets.length > 0 && !networkSubnets.some((s) => ipInSubnet(opts.address!, s))) {
      refuse('address-outside-subnet', `address "${opts.address}" is outside every subnet "${opts.networkId}" carries`);
    }
    for (const at of edgesIn(working, opts.networkId, 'AttachedTo')) {
      if (at.from === containerId) continue;
      const existingAddressField = fieldValue(at.fields, 'AttachedTo.address');
      const existingAddress = Array.isArray(existingAddressField) ? existingAddressField[0] : undefined;
      if (typeof existingAddress === 'string' && addressOnly(existingAddress) === addressOnly(opts.address)) {
        refuse('duplicate-address', `address "${opts.address}" is already used by another container on "${opts.networkId}"`);
      }
    }
  }

  const atProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = atProv.doc;
  const atId = formatEdgeId('AttachedTo', newUlid(now));
  const edgeFields: Record<string, FieldEntry> = {};
  const fieldOps: Op[] = [];
  if (addressValue !== undefined) {
    const af = setField(working, now, actor, atId, undefined, 'AttachedTo.address', [addressValue]);
    working = af.doc;
    edgeFields['AttachedTo.address'] = af.entry;
    fieldOps.push(af.op);
  }
  working = withEdge(working, { id: atId, from: containerId, to: opts.networkId, prov: atProv.id, fields: edgeFields });
  ops.push({ type: 'add_edge', edge: atId, from: containerId, to: opts.networkId, prov: atProv.id }, ...fieldOps);

  const label = opts.container.kind === 'new' ? 'attach a new container to Docker network' : 'attach container to Docker network';
  return withBatch(working, { id: newUlid(now), label, ops });
}

/** Detaches a container from a network — tombstones the `AttachedTo` edge
 * only. The container and network themselves are untouched. */
export function detachContainerFromNetwork(doc: Document, attachedToEdgeId: string, actorOpts?: Actor): Document {
  const e = doc.edges.find((x) => x.id === attachedToEdgeId);
  if (!e || e.absentSince !== undefined || parseEdgeId(attachedToEdgeId).kind !== 'AttachedTo') {
    refuse('unknown-reference', `"${attachedToEdgeId}" is not a live AttachedTo edge in this document`);
  }
  const { actor, now } = resolve(actorOpts);
  const working: Document = { ...doc, edges: doc.edges.map((x) => (x.id === attachedToEdgeId ? { ...x, absentSince: now } : x)) };
  const ops: Op[] = [{ type: 'tombstone', element: attachedToEdgeId, at: now, by: actor }];
  return withBatch(working, { id: newUlid(now), label: 'detach container from Docker network', ops });
}

// ---------------------------------------------------------------------------
// addPublishedPort / removePublishedPort

export interface AddPublishedPortOptions {
  containerId: string;
  /** `"tcp"`, `"udp"` or `"sctp"` — `docker run -p`'s `/proto` suffix. */
  protocol: 'tcp' | 'udp' | 'sctp';
  containerPort: number;
  hostPort?: number;
  /** `IpAddr` — absent means the daemon's default bind address (all host
   * addresses), `port-publishing.md`'s "Setting the default bind address". */
  hostAddress?: string;
}

function portInRange(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65_535;
}

/** Adds a published port — destination NAT on the host, held exactly as
 * `docker run -p` states it (ADR-0058 decision 4). Refuses port 0, an
 * unrecognised protocol, and a duplicate of an existing published port. */
export function addPublishedPort(doc: Document, opts: AddPublishedPortOptions, actorOpts?: Actor): Document {
  requireLiveOfKind(doc, opts.containerId, 'Container');
  const protocolNumber = DOCKER_PROTOCOL_NUMBERS[opts.protocol];
  if (protocolNumber === undefined) {
    refuse('unknown-protocol', `"${opts.protocol}" is not one of: ${Object.keys(DOCKER_PROTOCOL_NUMBERS).join(', ')}`);
  }
  if (!portInRange(opts.containerPort)) {
    refuse('bad-port', `container port ${opts.containerPort} is outside 1..=65535`);
  }
  if (opts.hostPort !== undefined && !portInRange(opts.hostPort)) {
    refuse('bad-port', `host port ${opts.hostPort} is outside 1..=65535`);
  }
  let hostAddressValue: FieldEntry['value'] | undefined;
  if (opts.hostAddress !== undefined) {
    try {
      hostAddressValue = ipAddr(opts.hostAddress);
    } catch {
      refuse('bad-address', `host address "${opts.hostAddress}" is not a valid IPv4 address`);
    }
  }

  const protocolCanon = ipProtocol(protocolNumber);
  const containerPortCanon = l4Port(opts.containerPort);
  const hostPortCanon = opts.hostPort !== undefined ? l4Port(opts.hostPort) : undefined;
  for (const hpp of edgesOut(doc, opts.containerId, 'HasPublishedPort')) {
    if (hpp.absentSince !== undefined) continue;
    const n = findNode(doc, hpp.to);
    if (!n || n.absentSince !== undefined) continue;
    const sameProtocol = fieldValue(n.fields, 'PublishedPort.protocol') === protocolCanon;
    const sameContainerPort = fieldValue(n.fields, 'PublishedPort.container_port') === containerPortCanon;
    const sameHostAddress = fieldValue(n.fields, 'PublishedPort.host_address') === hostAddressValue;
    const sameHostPort = fieldValue(n.fields, 'PublishedPort.host_port') === hostPortCanon;
    if (sameProtocol && sameContainerPort && sameHostAddress && sameHostPort) {
      refuse('duplicate-published-port', `container "${opts.containerId}" already publishes this exact port`);
    }
  }

  const { actor, now } = resolve(actorOpts);
  let working = doc;
  const ops: Op[] = [];

  const ppExistence = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = ppExistence.doc;
  const ppId = formatNodeId('PublishedPort', newUlid(now));
  const protocolField = setField(working, now, actor, ppId, undefined, 'PublishedPort.protocol', protocolCanon);
  working = protocolField.doc;
  const containerPortField = setField(working, now, actor, ppId, undefined, 'PublishedPort.container_port', containerPortCanon);
  working = containerPortField.doc;
  const nodeFields: Record<string, FieldEntry> = {
    'PublishedPort.protocol': protocolField.entry,
    'PublishedPort.container_port': containerPortField.entry,
  };
  const fieldOps: Op[] = [protocolField.op, containerPortField.op];
  if (hostPortCanon !== undefined) {
    const hpf = setField(working, now, actor, ppId, undefined, 'PublishedPort.host_port', hostPortCanon);
    working = hpf.doc;
    nodeFields['PublishedPort.host_port'] = hpf.entry;
    fieldOps.push(hpf.op);
  }
  if (hostAddressValue !== undefined) {
    const haf = setField(working, now, actor, ppId, undefined, 'PublishedPort.host_address', hostAddressValue);
    working = haf.doc;
    nodeFields['PublishedPort.host_address'] = haf.entry;
    fieldOps.push(haf.op);
  }
  working = withNode(working, { id: ppId, existence: ppExistence.id, fields: nodeFields });
  ops.push({ type: 'add_node', node: ppId, prov: ppExistence.id }, ...fieldOps);

  const hppProv = assertHand(working, { assertedAt: now, assertedBy: actor });
  working = hppProv.doc;
  const hppId = formatEdgeId('HasPublishedPort', newUlid(now));
  working = withEdge(working, { id: hppId, from: opts.containerId, to: ppId, prov: hppProv.id, fields: {} });
  ops.push({ type: 'add_edge', edge: hppId, from: opts.containerId, to: ppId, prov: hppProv.id });

  const label = `publish ${opts.hostPort ?? ''}${opts.hostPort ? ':' : ''}${opts.containerPort}/${opts.protocol}`;
  return withBatch(working, { id: newUlid(now), label, ops });
}

/** Removes a published port — tombstones the `PublishedPort` node and its
 * `HasPublishedPort` edge. The container is untouched. */
export function removePublishedPort(doc: Document, publishedPortId: string, actorOpts?: Actor): Document {
  requireLiveOfKind(doc, publishedPortId, 'PublishedPort');
  const { actor, now } = resolve(actorOpts);
  const nodeIds = new Set([publishedPortId]);
  const edgeIds = new Set<string>();
  const hpp = edgesIn(doc, publishedPortId, 'HasPublishedPort')[0];
  if (hpp) edgeIds.add(hpp.id);
  const working: Document = {
    ...doc,
    nodes: doc.nodes.map((n) => (nodeIds.has(n.id) ? { ...n, absentSince: now } : n)),
    edges: doc.edges.map((e) => (edgeIds.has(e.id) ? { ...e, absentSince: now } : e)),
  };
  const ops: Op[] = [...nodeIds, ...edgeIds].map((element): Op => ({ type: 'tombstone', element, at: now, by: actor }));
  return withBatch(working, { id: newUlid(now), label: 'remove published port', ops });
}
