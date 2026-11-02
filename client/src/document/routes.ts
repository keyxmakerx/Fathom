// Routes by hand (sign-off r96, round 1): a device's static routes, so a drawn network can be
// traced past its first hop. A host gets a gateway as a default route (0.0.0.0/0 via the
// gateway); a router gets any route. Pasted routes are listed beside them and left as the paste
// wrote them: a re-paste owns those. A route lives in the device's routing instance; a device with
// none gets "default", and one with several (VRFs) must say which. All pure, one undo step each.

import { begin, finish, addNode, addEdge, tombstone } from './freeform';
import type { CanonValue } from './canon';
import { edgesIn, edgesOut, findNode, identifier, ipAddr, ipPrefix, parseNodeId, token, type Document, type GraphNode } from './model';

interface Actor {
  actor?: string;
  now?: number;
}

export class RouteRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteRefusal';
  }
}

export interface RouteView {
  id: string;
  deviceId: string;
  hostname: string;
  instanceId: string;
  instance: string;
  /** `10.2.0.0/16`, or `0.0.0.0/0` for a default route. */
  destination: string;
  /** How the route leaves, in words: `via 10.0.0.1`, `out st0.0`, `discard`. */
  via: string;
  /** True when a pasted config wrote it; a re-paste owns it, so it is not removed here. */
  pasted: boolean;
}

export interface InstanceView {
  id: string;
  name: string;
}

const live = (n: GraphNode | undefined): n is GraphNode => n !== undefined && n.absentSince === undefined;

function str(n: GraphNode, key: string): string {
  const f = n.fields[key];
  return f && f.presence === 'set' && typeof f.value === 'string' ? f.value : '';
}

function hostnameOf(doc: Document, deviceId: string): string {
  const n = findNode(doc, deviceId);
  const h = n ? str(n, 'Device.hostname') : '';
  return h === '' ? 'unnamed device' : h;
}

function unitName(doc: Document, unitId: string): string {
  const u = findNode(doc, unitId);
  if (!live(u)) return 'an interface no longer in the design';
  const owner = edgesIn(doc, unitId, 'HasUnit')[0]?.from;
  const iface = owner ? findNode(doc, owner) : undefined;
  const name = iface ? str(iface, `${parseNodeId(iface.id).kind}.name`) : '';
  const idx = u.fields['LogicalUnit.index'];
  const index = idx && idx.presence === 'set' ? String(idx.value) : '?';
  return name === '' ? `unit ${index}` : `${name}.${index}`;
}

function hopWords(doc: Document, hops: unknown): string {
  if (!Array.isArray(hops) || hops.length === 0) return 'no next hop';
  return hops
    .map((h) => {
      if (h === 'discard') return 'discard';
      if (h === 'reject') return 'reject';
      if (h && typeof h === 'object') {
        const o = h as Record<string, unknown>;
        if (typeof o.address === 'string') return `via ${o.address}`;
        if (typeof o.interface === 'string') return `out ${unitName(doc, o.interface)}`;
        if (typeof o.next_table === 'string') return `to table ${o.next_table}`;
      }
      return 'a next hop Fathom does not read';
    })
    .join(', ');
}

function isPasted(doc: Document, n: GraphNode): boolean {
  return doc.provenance.find((p) => p.id === n.existence)?.origin.kind === 'parsed';
}

export function instancesOf(doc: Document, deviceId: string): InstanceView[] {
  return edgesOut(doc, deviceId, 'HasRoutingInstance')
    .filter((e) => e.absentSince === undefined)
    .map((e) => findNode(doc, e.to))
    .filter(live)
    .map((n) => ({ id: n.id, name: str(n, 'RoutingInstance.name') || 'default' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every static route on every device, by device then destination. */
export function listRoutes(doc: Document): RouteView[] {
  const out: RouteView[] = [];
  for (const d of doc.nodes) {
    if (!live(d) || parseNodeId(d.id).kind !== 'Device') continue;
    const hostname = hostnameOf(doc, d.id);
    for (const inst of instancesOf(doc, d.id)) {
      for (const e of edgesOut(doc, inst.id, 'HasStaticRoute')) {
        if (e.absentSince !== undefined) continue;
        const r = findNode(doc, e.to);
        if (!live(r)) continue;
        const dest = r.fields['StaticRoute.destination'];
        const hops = r.fields['StaticRoute.next_hop'];
        out.push({
          id: r.id,
          deviceId: d.id,
          hostname,
          instanceId: inst.id,
          instance: inst.name,
          destination: dest && dest.presence === 'set' && typeof dest.value === 'string' ? dest.value : '?',
          via: hops && hops.presence === 'set' ? hopWords(doc, hops.value) : 'no next hop',
          pasted: isPasted(doc, r),
        });
      }
    }
  }
  return out.sort((a, b) => a.hostname.localeCompare(b.hostname, undefined, { numeric: true }) || a.instance.localeCompare(b.instance) || a.destination.localeCompare(b.destination, undefined, { numeric: true }));
}

/** A destination as a person types it: a prefix, or `default` (also empty) for 0.0.0.0/0. Host bits are refused. */
export function cleanDestination(raw: string): string {
  const v = raw.trim();
  if (v === '' || v.toLowerCase() === 'default') return '0.0.0.0/0';
  try {
    return ipPrefix(v) as string;
  } catch {
    throw new RouteRefusal(`"${v}" is not a network. Write it as a network and a length, like 10.2.0.0/16, or "default".`);
  }
}

/** A next hop: an IPv4 address, or `discard` (a null route). */
export function cleanVia(raw: string): CanonValue {
  const v = raw.trim();
  if (v.toLowerCase() === 'discard') return 'discard';
  if (v === '') throw new RouteRefusal('Say where the route goes: the next hop’s address, or "discard".');
  try {
    return { address: ipAddr(v) };
  } catch {
    throw new RouteRefusal(`"${v}" is not an IPv4 address. Write the next hop’s address, like 10.0.0.1, or "discard".`);
  }
}

export interface NewRoute {
  deviceId: string;
  /** A prefix, or `default`. */
  destination: string;
  /** An address, or `discard`. */
  via: string;
  /** Needed only when the device has more than one routing instance. */
  instanceId?: string;
}

/** Adds one static route. A device with no routing instance gets "default". One undo step. */
export function addRoute(doc: Document, input: NewRoute, opts?: Actor): { doc: Document; id: string } {
  const device = findNode(doc, input.deviceId);
  if (!live(device) || parseNodeId(input.deviceId).kind !== 'Device') throw new RouteRefusal('That device is not in the design any more.');
  const destination = cleanDestination(input.destination);
  const via = cleanVia(input.via);
  const instances = instancesOf(doc, input.deviceId);
  let instanceId: string | undefined;
  if (input.instanceId !== undefined) {
    if (!instances.some((i) => i.id === input.instanceId)) throw new RouteRefusal('That routing table is not on this device.');
    instanceId = input.instanceId;
  } else if (instances.length === 1) {
    instanceId = instances[0].id;
  } else if (instances.length > 1) {
    throw new RouteRefusal(`${hostnameOf(doc, input.deviceId)} has more than one routing table (${instances.map((i) => i.name).join(', ')}). Pick the one this route is in.`);
  }
  const words = hopWords(doc, [via]);
  if (listRoutes(doc).some((r) => r.deviceId === input.deviceId && (instanceId === undefined || r.instanceId === instanceId) && r.destination === destination && r.via === words)) {
    throw new RouteRefusal(`${hostnameOf(doc, input.deviceId)} already has ${destination === '0.0.0.0/0' ? 'that default route' : `a route to ${destination}`} ${words}.`);
  }
  const b = begin(doc, opts);
  if (instanceId === undefined) {
    instanceId = addNode(b, 'RoutingInstance', {
      'RoutingInstance.name': identifier('default'),
      'RoutingInstance.isolation': token('routing_table_only'),
    });
    addEdge(b, 'HasRoutingInstance', input.deviceId, instanceId);
  }
  const id = addNode(b, 'StaticRoute', {
    'StaticRoute.destination': destination,
    'StaticRoute.next_hop': [via],
  });
  addEdge(b, 'HasStaticRoute', instanceId, id);
  return { doc: finish(b, destination === '0.0.0.0/0' ? 'add default route' : 'add route'), id };
}

/** Removes a route entered by hand. A pasted route belongs to its paste and is refused. */
export function removeRoute(doc: Document, routeId: string, opts?: Actor): Document {
  const r = findNode(doc, routeId);
  if (!live(r) || parseNodeId(routeId).kind !== 'StaticRoute') throw new RouteRefusal('That route is not in the design any more.');
  if (isPasted(doc, r)) throw new RouteRefusal('That route came from a pasted config. Paste the config again without it to remove it.');
  const b = begin(doc, opts);
  const edges = edgesIn(doc, routeId, 'HasStaticRoute').filter((e) => e.absentSince === undefined);
  tombstone(b, new Set([routeId]), new Set(edges.map((e) => e.id)));
  return finish(b, 'remove route');
}
