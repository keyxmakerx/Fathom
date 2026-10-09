// Prefixes and VLANs for the Inventory kinds: read off what devices already carry, never stored.
// A prefix is the set of live `Address` nodes that fall in one IPv4 network; a VLAN row comes from
// `deriveNetworks`. Site is the premises the device is placed in; the gateway is the unit a VLAN
// flags with an L3Interface edge (else the one address on a router or firewall). Pure; nothing
// here throws on an IPv6 or unreadable address: it is listed, not read.

import { edgesIn, edgesOut, findNode, parseNodeId, readDeviceFields, readPremisesFields, type Document, type GraphNode } from './model';
import type { NetworksDerived, VlanRow } from './networks-derive';

// ---------------------------------------------------------------------------
// IPv4 arithmetic. Plain numbers (no 32-bit bit ops) so /0 and /32 need no special case.

export function parseIpv4(text: string): number | undefined {
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(text.trim());
  if (!m) return undefined;
  let n = 0;
  for (let i = 1; i <= 4; i += 1) {
    const octet = Number(m[i]);
    if (octet > 255) return undefined;
    n = n * 256 + octet;
  }
  return n;
}

export function formatIpv4(n: number): string {
  return [Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join('.');
}

/** `a.b.c.d/len`, or a bare address as a /32. Undefined for anything else (IPv6 included). */
export function parseCidr(text: string): { ip: number; len: number } | undefined {
  const [addr, lenText, extra] = text.trim().split('/');
  if (extra !== undefined || addr === undefined) return undefined;
  const ip = parseIpv4(addr);
  if (ip === undefined) return undefined;
  if (lenText === undefined) return { ip, len: 32 };
  if (!/^\d{1,2}$/.test(lenText) || Number(lenText) > 32) return undefined;
  return { ip, len: Number(lenText) };
}

export interface Range {
  base: number;
  len: number;
  /** Every address in the block, network and broadcast included. */
  size: number;
  /** The usable span: the whole block for /31 and /32, else without network and broadcast. */
  first: number;
  last: number;
  total: number;
}

export function rangeOf(ip: number, len: number): Range {
  const size = 2 ** (32 - len);
  const base = Math.floor(ip / size) * size;
  const first = len >= 31 ? base : base + 1;
  const last = len >= 31 ? base + size - 1 : base + size - 2;
  return { base, len, size, first, last, total: last - first + 1 };
}

export const prefixText = (r: Range): string => `${formatIpv4(r.base)}/${r.len}`;

/** Addresses of `ips` that sit in the usable span, once each. */
export function usedIn(r: Range, ips: Iterable<number>): Set<number> {
  const out = new Set<number>();
  for (const ip of ips) if (ip >= r.first && ip <= r.last) out.add(ip);
  return out;
}

/** The lowest usable address not in `used`, or null when the range is full. */
export function nextFree(r: Range, used: ReadonlySet<number>): number | null {
  let n = r.first;
  while (n <= r.last && used.has(n)) n += 1;
  return n <= r.last ? n : null;
}

/** The free stretches of the usable span, in order. */
export function freeRuns(r: Range, used: ReadonlySet<number>): Array<{ from: number; to: number }> {
  const sorted = [...used].sort((a, b) => a - b);
  const runs: Array<{ from: number; to: number }> = [];
  let at = r.first;
  for (const u of sorted) {
    if (u > at) runs.push({ from: at, to: u - 1 });
    at = u + 1;
  }
  if (at <= r.last) runs.push({ from: at, to: r.last });
  return runs;
}

export type CellState = 'free' | 'used' | 'shared';

export interface GridCell {
  start: number;
  /** Usable addresses the cell covers (one for a fine grid). */
  covers: number;
  used: number;
  state: CellState;
}

export const GRID_CELLS = 256;

/**
 * The picture of a range: one cell per usable address when there are at most 256, else 256 equal
 * slices of the block. `onTwo` holds the addresses carried by more than one device.
 */
export function buildGrid(r: Range, used: ReadonlySet<number>, onTwo: ReadonlySet<number> = new Set()): { cells: GridCell[]; perCell: number } {
  if (r.total <= GRID_CELLS) {
    const cells: GridCell[] = [];
    for (let ip = r.first; ip <= r.last; ip += 1) {
      cells.push({ start: ip, covers: 1, used: used.has(ip) ? 1 : 0, state: !used.has(ip) ? 'free' : onTwo.has(ip) ? 'shared' : 'used' });
    }
    return { cells, perCell: 1 };
  }
  const perCell = r.size / GRID_CELLS;
  const cells: GridCell[] = [];
  for (let i = 0; i < GRID_CELLS; i += 1) {
    const start = r.base + i * perCell;
    const lo = Math.max(start, r.first);
    const hi = Math.min(start + perCell - 1, r.last);
    cells.push({ start, covers: Math.max(0, hi - lo + 1), used: 0, state: 'free' });
  }
  for (const ip of used) {
    const cell = cells[Math.floor((ip - r.base) / perCell)];
    if (!cell) continue;
    cell.used += 1;
    cell.state = cell.state === 'shared' || onTwo.has(ip) ? 'shared' : 'used';
  }
  return { cells, perCell };
}

// ---------------------------------------------------------------------------
// Rows

export type AddressSource = 'typed' | 'pasted config' | 'imported';

export interface AddressEntry {
  addressNodeId: string;
  /** As stored, e.g. 10.0.20.1/24. */
  address: string;
  /** Without the mask; the number is undefined for an address that is not IPv4. */
  ip: string;
  ipNum?: number;
  unitId: string;
  interfaceId: string;
  interfaceLabel: string;
  deviceId: string;
  deviceName: string;
  /** Typed by hand or read from a pasted config. No origin marks an import yet. */
  source: AddressSource;
  /** A VLAN flags this unit as its gateway. */
  flaggedGateway: boolean;
  /** Names of the other devices carrying this same address. */
  alsoOn: string[];
}

export interface PrefixRow {
  key: string;
  /** The network as `a.b.c.d/len`; for an IPv6 address, the address as written. */
  prefix: string;
  readable: boolean;
  range?: Range;
  vlan: { key: string; vlanId: number; name?: string } | null;
  sites: string[];
  used: number;
  total: number;
  entries: AddressEntry[];
  gateway: { address: string; deviceId: string; deviceName: string; inferred: boolean } | null;
  nextFree: string | null;
  /** Addresses carried by more than one device. */
  clashes: number;
}

export interface VlanKindRow {
  key: string;
  vlanId: number;
  name?: string;
  description?: string;
  vlanNodeIds: string[];
  deviceIds: string[];
  deviceNames: string[];
  prefixes: string[];
  sites: string[];
  members: Array<{ deviceName: string; interfaceLabel: string; mode: 'access' | 'trunk' | undefined }>;
}

export interface IpamDerived {
  prefixes: PrefixRow[];
  vlans: VlanKindRow[];
}

const NO_NAME = 'unnamed';

function str(node: GraphNode | undefined, key: string): string | undefined {
  const e = node?.fields[key];
  return e && e.presence === 'set' && typeof e.value === 'string' ? e.value : undefined;
}

function live(doc: Document, id: string | undefined): GraphNode | undefined {
  if (id === undefined) return undefined;
  const n = findNode(doc, id);
  return n && n.absentSince === undefined ? n : undefined;
}

function premisesLabel(doc: Document, premisesId: string | undefined): string | undefined {
  const n = live(doc, premisesId);
  return n ? (readPremisesFields(n).label ?? undefined) : undefined;
}

function placedPremises(doc: Document, id: string, depth: number): string | undefined {
  if (depth > 6) return undefined;
  const rack = edgesOut(doc, id, 'MountedIn')[0];
  if (rack) return premisesLabel(doc, edgesIn(doc, rack.to, 'HasRack')[0]?.from);
  const fixed = edgesOut(doc, id, 'FixedTo')[0];
  if (fixed) {
    return parseNodeId(fixed.to).kind === 'Surface'
      ? premisesLabel(doc, edgesIn(doc, fixed.to, 'HasSurface')[0]?.from)
      : placedPremises(doc, fixed.to, depth + 1);
  }
  const sits = edgesOut(doc, id, 'SitsOn')[0];
  return sits ? placedPremises(doc, sits.to, depth + 1) : undefined;
}

function vlanName(r: VlanRow): { vlanId: number; name?: string } {
  return { vlanId: r.vlanId, name: r.name };
}

export function vlanLabel(v: { vlanId: number; name?: string }): string {
  return v.name ? `${v.vlanId} · ${v.name}` : String(v.vlanId);
}

export function deriveIpam(doc: Document, derived: NetworksDerived): IpamDerived {
  const provOrigin = new Map(doc.provenance.map((p) => [p.id, p.origin.kind]));
  const deviceSite = new Map<string, string | undefined>();
  const siteOf = (deviceId: string): string | undefined => {
    if (!deviceSite.has(deviceId)) {
      const chassis = edgesOut(doc, deviceId, 'HasChassis')[0]?.to;
      deviceSite.set(deviceId, chassis ? placedPremises(doc, chassis, 0) : undefined);
    }
    return deviceSite.get(deviceId);
  };
  const deviceName = (deviceId: string): string => {
    const n = live(doc, deviceId);
    return (n && readDeviceFields(n).hostname) || NO_NAME;
  };

  const vlanOfUnit = new Map<string, VlanRow>();
  for (const row of derived.vlanRows) for (const m of row.members) if (!m.container && !vlanOfUnit.has(m.unitId)) vlanOfUnit.set(m.unitId, row);
  const vlanOfCidr = new Map<string, VlanRow>();
  for (const row of derived.vlanRows) if (row.cidr && !vlanOfCidr.has(row.cidr)) vlanOfCidr.set(row.cidr, row);

  interface Group {
    key: string;
    prefix: string;
    range?: Range;
    entries: AddressEntry[];
  }
  const groups = new Map<string, Group>();

  for (const node of doc.nodes) {
    if (node.absentSince !== undefined || parseNodeId(node.id).kind !== 'Address') continue;
    const value = str(node, 'Address.value');
    if (!value) continue;
    const unitId = edgesIn(doc, node.id, 'HasAddress')[0]?.from;
    const unit = live(doc, unitId);
    const interfaceId = unit ? edgesIn(doc, unit.id, 'HasUnit')[0]?.from : undefined;
    const iface = live(doc, interfaceId);
    const deviceId = iface ? edgesIn(doc, iface.id, 'HasInterface')[0]?.from : undefined;
    if (!unit || !iface || !live(doc, deviceId)) continue;

    const cidr = parseCidr(value);
    const unitIndex = unit.fields['LogicalUnit.index'];
    const index = unitIndex && unitIndex.presence === 'set' && typeof unitIndex.value === 'number' ? unitIndex.value : 0;
    const base = str(iface, 'Interface.name') ?? str(iface, 'AggregateInterface.name') ?? iface.id.slice(-6);
    const origin = provOrigin.get(node.existence);
    const entry: AddressEntry = {
      addressNodeId: node.id,
      address: value,
      ip: cidr ? formatIpv4(cidr.ip) : value.split('/')[0]!,
      ipNum: cidr?.ip,
      unitId: unit.id,
      interfaceId: iface.id,
      interfaceLabel: index > 0 ? `${base}.${index}` : base,
      deviceId: deviceId!,
      deviceName: deviceName(deviceId!),
      source: origin === 'parsed' ? 'pasted config' : 'typed',
      flaggedGateway: edgesIn(doc, unit.id, 'L3Interface').some((e) => live(doc, e.from) !== undefined),
      alsoOn: [],
    };
    let range: Range | undefined;
    let key: string;
    let prefix: string;
    if (cidr) {
      range = rangeOf(cidr.ip, cidr.len);
      prefix = prefixText(range);
      key = `prefix:${prefix}`;
    } else {
      prefix = value;
      key = `prefix6:${value}`;
    }
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, prefix, range, entries: [] }));
    g.entries.push(entry);
  }

  const prefixes: PrefixRow[] = [];
  for (const g of groups.values()) {
    const entries = g.entries.sort((a, b) => (a.ipNum ?? 0) - (b.ipNum ?? 0) || a.deviceName.localeCompare(b.deviceName));
    const range = g.range;

    // The same address on two devices, unless both are a shared virtual address (a VRRP group).
    const byIp = new Map<number, AddressEntry[]>();
    for (const e of entries) if (e.ipNum !== undefined) byIp.set(e.ipNum, [...(byIp.get(e.ipNum) ?? []), e]);
    const onTwo = new Set<number>();
    for (const [ip, list] of byIp) {
      const devices = new Set(list.map((e) => e.deviceId));
      if (devices.size < 2) continue;
      const groupsSeen = list.map((e) => vrrpGroup(doc, e.addressNodeId));
      if (groupsSeen.every((x) => x !== undefined && x === groupsSeen[0])) continue;
      onTwo.add(ip);
      for (const e of list) e.alsoOn = [...devices].filter((d) => d !== e.deviceId).map(deviceName);
    }

    const usedSet = range ? usedIn(range, byIp.keys()) : new Set<number>();
    const free = range ? nextFree(range, usedSet) : null;

    // Which VLAN: the one whose gateway has this prefix, else the one most of the units are in.
    let vlanRow: VlanRow | undefined = vlanOfCidr.get(g.prefix);
    if (!vlanRow) {
      const votes = new Map<VlanRow, number>();
      for (const e of entries) {
        const v = vlanOfUnit.get(e.unitId);
        if (v) votes.set(v, (votes.get(v) ?? 0) + 1);
      }
      let best = 0;
      for (const [v, n] of votes) {
        if (n > best) {
          vlanRow = v;
          best = n;
        }
      }
    }

    const flagged = entries.find((e) => e.flaggedGateway);
    const routers = entries.filter((e) => {
      const role = str(live(doc, e.deviceId), 'Device.role');
      return role === 'router' || role === 'firewall';
    });
    const gatewayEntry = flagged ?? (routers.length === 1 ? routers[0] : undefined);

    const sites = [...new Set(entries.map((e) => siteOf(e.deviceId)).filter((s): s is string => !!s))].sort();
    prefixes.push({
      key: g.key,
      prefix: g.prefix,
      readable: range !== undefined,
      range,
      vlan: vlanRow ? { key: vlanRow.key, ...vlanName(vlanRow) } : null,
      sites,
      used: usedSet.size,
      total: range?.total ?? 0,
      entries,
      gateway: gatewayEntry ? { address: gatewayEntry.ip, deviceId: gatewayEntry.deviceId, deviceName: gatewayEntry.deviceName, inferred: gatewayEntry !== flagged } : null,
      nextFree: free === null ? null : formatIpv4(free),
      clashes: onTwo.size,
    });
  }
  prefixes.sort((a, b) => Number(b.readable) - Number(a.readable) || (a.range?.base ?? 0) - (b.range?.base ?? 0) || (a.range?.len ?? 0) - (b.range?.len ?? 0) || a.prefix.localeCompare(b.prefix));

  const vlans: VlanKindRow[] = derived.vlanRows.map((row) => {
    const deviceIds = [...new Set(row.devices)];
    const sites = [...new Set(deviceIds.map(siteOf).filter((s): s is string => !!s))].sort();
    return {
      key: row.key,
      vlanId: row.vlanId,
      name: row.name,
      description: row.description,
      vlanNodeIds: row.vlanNodeIds,
      deviceIds,
      deviceNames: deviceIds.map(deviceName),
      prefixes: prefixes.filter((p) => p.vlan?.key === row.key).map((p) => p.prefix),
      sites,
      members: row.members.map((m) => ({ deviceName: deviceName(m.deviceId), interfaceLabel: m.interfaceLabel, mode: m.mode })),
    };
  });
  return { prefixes, vlans };
}

function vrrpGroup(doc: Document, addressNodeId: string): string | undefined {
  const e = live(doc, addressNodeId)?.fields['Address.vrrp_group'];
  return e && e.presence === 'set' && e.value !== undefined && e.value !== null ? String(e.value) : undefined;
}
