/** The Routing lens on the canvas (sign-off r101, option A "routed against switched"). It changes words
 * and line styles on the same boxes; it never moves or hides one (ADR-0047 §1). Read off the design
 * alone, with no new field:
 *
 * - A device that routes says so, with how many tables it keeps: `ROUTES · 2 TABLES`. A gateway for a
 *   VLAN says which: `GW VLAN 11 · 10.10.11.1`.
 * - A host (one network of its own) names its default gateway, `GW 10.10.11.1`, or says `NO GATEWAY`
 *   as a caution.
 * - A switch with VLANs and no address of its own says `SWITCHES ONLY`.
 * - A firewall with NAT rules says how many: `NAT · 3 RULES` (sign-off r104, where B). A trace shows
 *   each rule it applies as a line on that firewall's hop.
 * - A cable whose two ends hold addresses in one network is routed: drawn in ink, carrying the prefix.
 *   A cable in a VLAN is switched: drawn dashed, carrying its VLANs.
 *
 * Pure; nothing here reads the engine, so it says what is drawn and typed, not what a trace finds. */

import { edgesOut, findNode, type Document } from '../../document/model';
import type { EdgeKind } from '../../../../schema/generated/ir_types';
import { deriveNetworks } from '../../document/networks-derive';
import { instancesOf, listRoutes } from '../../document/routes';
import { formatIpv4, parseCidr, rangeOf } from '../../document/ipam';
import type { ClosetView } from './contract';
import { vlanWord, type CableWords } from './layerLabels';

export interface RoutingWord {
  text: string;
  /** Drawn in the caution colour: a host with no gateway. */
  caution: boolean;
}

export interface RoutingMarks {
  /** Words under a device, by chassis id; first. */
  devices: Map<string, RoutingWord[]>;
  /** Words on a cable: the prefix of a routed link, or the VLANs of a switched one. */
  cables: Map<string, CableWords>;
  /** Cables drawn dashed: switched. */
  switched: Set<string>;
  /** Cables drawn as routed links. */
  routed: Set<string>;
}

const EMPTY: RoutingMarks = { devices: new Map(), cables: new Map(), switched: new Set(), routed: new Set() };

/** `10.0.20.1/24` as its network, `10.0.20.0/24`; null for anything that is not an IPv4 prefix. */
export function networkOf(cidr: string): string | null {
  const p = parseCidr(cidr);
  if (p == null || !cidr.includes('/')) return null;
  return `${formatIpv4(rangeOf(p.ip, p.len).base)}/${p.len}`;
}

function bare(a: string): string {
  const i = a.indexOf('/');
  return i < 0 ? a : a.slice(0, i);
}

const DEFAULT = '0.0.0.0/0';

/** The device's NAT rules, across its rule sets (schema 0.39's NatRuleSet and NatRule). */
export function natRuleCount(doc: Document, deviceId: string): number {
  const alive = (id: string) => {
    const n = findNode(doc, id);
    return n != null && n.absentSince === undefined;
  };
  let count = 0;
  for (const s of edgesOut(doc, deviceId, 'HasNatRuleSet')) {
    if (!alive(s.to)) continue;
    count += edgesOut(doc, s.to, 'HasNatRule').filter((r) => alive(r.to)).length;
  }
  return count;
}

export function routingMarks(doc: Document | null, view: ClosetView): RoutingMarks {
  if (doc == null) return EMPTY;
  const net = deriveNetworks(doc);

  // Each device's addresses, by interface label, and its networks.
  const addrByPort = new Map<string, string>();
  const networks = new Map<string, Set<string>>();
  const gateways = new Map<string, { vlanId: number; address: string }[]>();
  const inVlans = new Map<string, Set<number>>();
  const note = (deviceId: string, label: string, address: string) => {
    addrByPort.set(`${deviceId}|${label}`, address);
    const n = networkOf(address);
    if (n == null) return;
    const s = networks.get(deviceId) ?? new Set<string>();
    s.add(n);
    networks.set(deviceId, s);
  };
  for (const row of net.subnetRows) for (const m of row.members) if (m.container == null) note(m.deviceId, m.interfaceLabel, m.address);
  for (const row of net.vlanRows) {
    for (const m of row.members) {
      if (m.container != null) continue;
      const v = inVlans.get(m.deviceId) ?? new Set<number>();
      v.add(row.vlanId);
      inVlans.set(m.deviceId, v);
      if (m.address != null) note(m.deviceId, m.interfaceLabel, m.address);
      if (m.isGateway && m.address != null) {
        const g = gateways.get(m.deviceId) ?? [];
        g.push({ vlanId: row.vlanId, address: bare(m.address) });
        gateways.set(m.deviceId, g);
      }
    }
  }
  const defaults = new Map<string, string>();
  for (const r of listRoutes(doc)) if (r.destination === DEFAULT && r.instance === 'default' && !defaults.has(r.deviceId)) defaults.set(r.deviceId, r.via);
  const statics = new Set(listRoutes(doc).map((r) => r.deviceId));

  const devices = new Map<string, RoutingWord[]>();
  const chassis = [...view.racks.flatMap((r) => r.chassis), ...(view.unplaced ?? [])];
  for (const ch of chassis) {
    const d = ch.deviceId;
    const nets = networks.get(d)?.size ?? 0;
    const gws = gateways.get(d) ?? [];
    const words: RoutingWord[] = [];
    if (nets >= 2 || gws.length > 0 || (statics.has(d) && nets >= 1 && !defaults.has(d))) {
      const tables = Math.max(instancesOf(doc, d).length, 1);
      words.push({ text: `ROUTES · ${tables} ${tables === 1 ? 'TABLE' : 'TABLES'}`, caution: false });
      if (gws.length > 0) {
        const g = [...gws].sort((a, b) => a.vlanId - b.vlanId);
        const more = g.length > 1 ? ` +${g.length - 1}` : '';
        words.push({ text: `GW VLAN ${g[0]!.vlanId} · ${g[0]!.address}${more}`, caution: false });
      }
    } else if (nets === 1) {
      const via = defaults.get(d);
      words.push(via != null && via.startsWith('via ') ? { text: `GW ${via.slice(4)}`, caution: false } : { text: 'NO GATEWAY', caution: true });
    } else if ((inVlans.get(d)?.size ?? 0) > 0) {
      words.push({ text: 'SWITCHES ONLY', caution: false });
    }
    const nat = natRuleCount(doc, d);
    if (nat > 0) words.push({ text: `NAT · ${nat} ${nat === 1 ? 'RULE' : 'RULES'}`, caution: false });
    if (words.length > 0) devices.set(ch.id, words);
  }

  // Cables: routed when both ends hold an address in one network; else switched when in a VLAN.
  const cables = new Map<string, CableWords>();
  const switched = new Set<string>();
  const routed = new Set<string>();
  const chassisById = new Map(chassis.map((c) => [c.id, c]));
  for (const cable of view.cables) {
    const ends = cable.ends.filter((e): e is { portId: string; chassisId: string; rackId: string | null } => 'portId' in e);
    if (ends.length !== 2) continue;
    const nets = ends.map((e) => {
      const ch = chassisById.get(e.chassisId);
      const port = ch?.ports.find((p) => p.id === e.portId);
      const a = ch != null && port != null ? addrByPort.get(`${ch.deviceId}|${port.label}`) : undefined;
      return a != null ? networkOf(a) : null;
    });
    if (nets[0] != null && nets[0] === nets[1]) {
      routed.add(cable.id);
      cables.set(cable.id, { mid: nets[0] });
    }
  }
  const byCable = new Map<string, { ids: number[]; trunk: boolean }>();
  for (const row of net.vlanRows) {
    for (const m of row.members) {
      if (m.cableId == null || routed.has(m.cableId)) continue;
      const e = byCable.get(m.cableId) ?? { ids: [], trunk: false };
      e.ids.push(row.vlanId);
      if (m.mode === 'trunk') e.trunk = true;
      byCable.set(m.cableId, e);
    }
  }
  for (const [id, e] of byCable) {
    switched.add(id);
    cables.set(id, { mid: vlanWord(e.ids, e.trunk) });
  }
  return { devices, cables, switched, routed };
}

/** The routing tables the design holds, for the Routing lens's table picker: `default` first, then each
 * VRF's name once, however many devices keep it. Empty when no device keeps a VRF: there is nothing to pick. */
export function tableNames(doc: Document | null, view: ClosetView): string[] {
  if (doc == null) return [];
  const names = new Set<string>();
  for (const ch of [...view.racks.flatMap((r) => r.chassis), ...(view.unplaced ?? [])]) for (const i of instancesOf(doc, ch.deviceId)) if (i.name !== 'default') names.add(i.name);
  return names.size === 0 ? [] : ['default', ...[...names].sort((a, b) => a.localeCompare(b))];
}

const liveOut = (doc: Document, from: string, kind: EdgeKind) => edgesOut(doc, from, kind).filter((e) => e.absentSince === undefined && findNode(doc, e.to)?.absentSince === undefined);

/** What one table lights (r101, "one table lit, the rest at 0.28"). A port on a device with VRFs is in the
 * tables its interface's units are in. A cable is in the tables of its ends; one with no such end takes the
 * tables of the devices it joins, which take them from their other cables, so a host behind a switch on a
 * VRF's port lights with that VRF. A cable that learns no table is in the default one. A box is lit when it
 * keeps the table or a lit cable reaches it; with `default` lit, a box with no cable is lit too. */
export function tableLit(doc: Document, view: ClosetView, table: string): { chassis: Set<string>; cables: Set<string> } {
  const chassis = [...view.racks.flatMap((r) => r.chassis), ...(view.unplaced ?? [])];
  const portTables = new Map<string, Set<string>>();
  const keeps = new Set<string>();
  const vrfDevice = new Set<string>();
  for (const ch of chassis) {
    const instances = instancesOf(doc, ch.deviceId);
    const vrfs = new Map(instances.filter((i) => i.name !== 'default').map((i) => [i.id, i.name]));
    // Every device holds a default table, so keeping one says nothing; a VRF device keeps the default beside its VRFs.
    if (table === 'default' ? vrfs.size > 0 : instances.some((i) => i.name === table)) keeps.add(ch.id);
    if (vrfs.size === 0) continue;
    vrfDevice.add(ch.id);
    for (const ie of liveOut(doc, ch.deviceId, 'HasInterface')) {
      const iface = findNode(doc, ie.to)!;
      const units = [ie.to, ...liveOut(doc, ie.to, 'MemberOfAggregate').map((e) => e.to)].flatMap((i) => liveOut(doc, i, 'HasUnit').map((e) => e.to));
      if (units.length === 0) continue;
      const tables = new Set(units.map((u) => vrfs.get(liveOut(doc, u, 'InRoutingInstance')[0]?.to ?? '') ?? 'default'));
      const name = iface.fields['Interface.name'];
      const occupied = liveOut(doc, ie.to, 'Occupies').map((e) => e.to);
      const ports = occupied.length > 0 ? occupied : ch.ports.filter((p) => name?.presence === 'set' && p.label === name.value).map((p) => p.id);
      for (const port of ports) portTables.set(port, new Set([...(portTables.get(port) ?? []), ...tables]));
    }
  }
  const cableEnds = view.cables.map((c) => ({ id: c.id, ends: c.ends.filter((e): e is { portId: string; chassisId: string; rackId: string | null } => 'portId' in e) }));
  const cableTables = new Map<string, Set<string>>();
  for (const c of cableEnds) {
    const t = new Set(c.ends.filter((e) => vrfDevice.has(e.chassisId)).flatMap((e) => [...(portTables.get(e.portId) ?? [])]));
    if (t.size > 0) cableTables.set(c.id, t);
  }
  // Spread across devices with no VRF of their own until nothing changes.
  const fixed = new Set(cableTables.keys());
  for (let changed = true, rounds = 0; changed && rounds <= cableEnds.length; rounds++) {
    changed = false;
    const deviceTables = new Map<string, Set<string>>();
    for (const c of cableEnds) for (const e of c.ends) if (!vrfDevice.has(e.chassisId)) for (const t of cableTables.get(c.id) ?? []) deviceTables.set(e.chassisId, new Set([...(deviceTables.get(e.chassisId) ?? []), t]));
    for (const c of cableEnds) {
      if (fixed.has(c.id)) continue;
      const before = cableTables.get(c.id)?.size ?? 0;
      const t = new Set([...(cableTables.get(c.id) ?? []), ...c.ends.flatMap((e) => [...(deviceTables.get(e.chassisId) ?? [])])]);
      if (t.size > before) {
        cableTables.set(c.id, t);
        changed = true;
      }
    }
  }
  const cables = new Set<string>();
  const lit = new Set(keeps);
  const cabled = new Set<string>();
  for (const c of cableEnds) {
    for (const e of c.ends) cabled.add(e.chassisId);
    if (!(cableTables.get(c.id) ?? new Set(['default'])).has(table)) continue;
    cables.add(c.id);
    for (const e of c.ends) lit.add(e.chassisId);
  }
  if (table === 'default') for (const ch of chassis) if (!cabled.has(ch.id)) lit.add(ch.id);
  return { chassis: lit, cables };
}
