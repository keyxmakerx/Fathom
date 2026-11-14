// The difference checks between a design and the organisation's IP plan (ADR-0083 decision 2).
// The drawing is the truth for what is configured; the plan holds what is intended. The engine sees
// one design, and the plan lives on the server (`api/ipPlan.ts`), so these findings are worked out
// here and join the engine's in the panel, as the links between sites do.
//
// A drawn address matches the plan when it is inside a planned prefix with the same length and
// VRF, equals a planned address, or is inside a reservation. What is checked:
// - configured differently: the length, or the VRF, is not the plan's;
// - configured but not planned: nothing in the plan holds it (one finding per drawn network);
// - planned but not configured: an address planned for a device in this design is not on it;
// - a VRF drawn here that the plan does not have;
// - a BGP AS number inside a planned ASN range that the plan does not hold;
// - in use twice: an address the plan holds in the global table that is also drawn on a device in
//   another design this person may read, found through the estate index (ADR-0079).
// A design whose organisation has no plan gets none of these, so it behaves as it did before.
//
// Adopt makes a plan record from what is drawn (decision 2), through the store's own create, so it
// needs the same right the IP plan page does. Ignore hides a finding in this browser only.
import { useCallback, useEffect, useMemo, useState } from 'react';

import { searchEstate } from '../../api/estate';
import { createRecord, fetchPlan, planRefusal, type PlanFields, type PlanKind, type PlanRecord } from '../../api/ipPlan';
import { edgesIn, edgesOut, findNode, parseNodeId, readDeviceFields, type Document, type GraphNode } from '../../document/model';
import type { CheckAction, CheckFinding } from '../../engine/engine';
import { ADDRESS_KINDS, flag, formatIp, nameOfVrf, parseCidrBig, parseIp, spanContains, spanOf, spanSize, text, vrfOf, type Span } from '../organisation/ipPlanModel';

const SOURCE = {
  title: '',
  url: '',
  note: 'The drawing says what is configured and the IP plan says what is intended; where they differ, one of them is out of date.',
};
const CONCEPT = 'the IP plan';
const WHERE = 'Steward › IP plan';

/** One address drawn on an interface in this design. */
export interface DrawnAddress {
  addressNodeId: string;
  /** As stored, e.g. 10.20.1.1/24. */
  value: string;
  deviceId: string;
  deviceName: string;
  interfaceLabel: string;
  /** The routing instance its unit is in, or null for the global table. */
  instance: string | null;
}

/** A BGP AS number a device in this design says it is. */
export interface DrawnAsn {
  asn: string;
  deviceId: string;
  deviceName: string;
}

export interface DrawnFacts {
  addresses: DrawnAddress[];
  asns: DrawnAsn[];
  /** Every device's hostname, to find what a planned address is meant for. */
  devices: Array<{ id: string; name: string }>;
}

/** The same address drawn on a device in another design, as the estate index has it. */
export interface Elsewhere {
  design: string;
  designName: string | null;
  device: string;
}

/** A planned address that is not drawn on the device it is meant for: the canvas marks it there. */
export interface PlannedMark {
  deviceId: string;
  address: string;
  meant: string;
}

/** A finding, with what Adopt would add to the plan and the key Ignore remembers it by. */
export interface PlanFinding extends CheckFinding {
  ignoreKey: string;
  adopt?: { kind: PlanKind; fields: PlanFields };
  mark?: PlannedMark;
}

// ---------------------------------------------------------------------------
// Reading the design

function live(doc: Document, id: string | undefined): GraphNode | undefined {
  if (id === undefined) return undefined;
  const n = findNode(doc, id);
  return n && n.absentSince === undefined ? n : undefined;
}

function str(node: GraphNode | undefined, key: string): string | undefined {
  const e = node?.fields[key];
  return e && e.presence === 'set' && typeof e.value === 'string' ? e.value : undefined;
}

function scalar(node: GraphNode | undefined, key: string): string | undefined {
  const e = node?.fields[key];
  if (!e || e.presence !== 'set') return undefined;
  if (typeof e.value === 'number' && Number.isInteger(e.value)) return String(e.value);
  if (typeof e.value === 'string' && /^\d+$/.test(e.value)) return e.value;
  return undefined;
}

const hostname = (doc: Document, deviceId: string) => {
  const n = live(doc, deviceId);
  return (n && readDeviceFields(n).hostname) || 'unnamed';
};

/** The addresses, AS numbers and device names a design holds. */
export function drawnFacts(doc: Document): DrawnFacts {
  const addresses: DrawnAddress[] = [];
  const asns: DrawnAsn[] = [];
  const devices: DrawnFacts['devices'] = [];
  for (const node of doc.nodes) {
    if (node.absentSince !== undefined) continue;
    const kind = parseNodeId(node.id).kind;
    if (kind === 'Device') {
      devices.push({ id: node.id, name: hostname(doc, node.id) });
    } else if (kind === 'Address') {
      const value = str(node, 'Address.value');
      if (!value) continue;
      const unit = live(doc, edgesIn(doc, node.id, 'HasAddress')[0]?.from);
      const iface = unit ? live(doc, edgesIn(doc, unit.id, 'HasUnit')[0]?.from) : undefined;
      const deviceId = iface ? edgesIn(doc, iface.id, 'HasInterface')[0]?.from : undefined;
      if (!unit || !iface || deviceId === undefined || !live(doc, deviceId)) continue;
      const index = unit.fields['LogicalUnit.index'];
      const n = index && index.presence === 'set' && typeof index.value === 'number' ? index.value : 0;
      const base = str(iface, 'Interface.name') ?? str(iface, 'AggregateInterface.name') ?? iface.id.slice(-6);
      const instance = live(doc, edgesOut(doc, unit.id, 'InRoutingInstance').find((e) => e.absentSince === undefined)?.to);
      addresses.push({
        addressNodeId: node.id,
        value,
        deviceId,
        deviceName: hostname(doc, deviceId),
        interfaceLabel: n > 0 ? `${base}.${n}` : base,
        instance: instance ? (str(instance, 'RoutingInstance.name') ?? null) : null,
      });
    } else if (kind === 'RoutingProtocol') {
      if (str(node, 'RoutingProtocol.protocol')?.toLowerCase() !== 'bgp') continue;
      const asn = scalar(node, 'RoutingProtocol.local_as');
      const instance = live(doc, edgesIn(doc, node.id, 'HasRoutingProtocol')[0]?.from);
      const deviceId = instance ? edgesIn(doc, instance.id, 'HasRoutingInstance')[0]?.from : undefined;
      if (asn === undefined || deviceId === undefined || !live(doc, deviceId)) continue;
      asns.push({ asn, deviceId, deviceName: hostname(doc, deviceId) });
    }
  }
  return { addresses, asns, devices };
}

// ---------------------------------------------------------------------------
// Comparing

/** Names a platform gives its default table: an address there is in the plan's global table. */
const GLOBAL_NAMES = new Set(['default', 'master', 'global', 'main', 'inet.0']);

/** Link-local and loopback space is never planned. */
function unplannable(s: Span): boolean {
  if (s.v6) return s.lo >> 118n === 0x3fan || s.lo === 1n; // fe80::/10, ::1
  const first = s.lo >> 24n;
  return first === 127n || s.lo >> 16n === 0xa9fen; // 127/8, 169.254/16
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const listNames = (names: string[]) => (names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`);

interface Located {
  drawn: DrawnAddress;
  host: Span & { len: number };
  network: Span & { len: number };
  vrf: string;
}

/** Roles an address takes on several devices by design: never "in use twice". */
const SHARED_ROLES = new Set(['anycast', 'vip', 'vrrp', 'hsrp', 'glbp', 'carp']);

interface Placed {
  addressRecords: PlanRecord[];
  spans: Map<string, Span>;
  located: Located[];
  unknownVrf: Map<string, DrawnAddress[]>;
}

/** Each drawn address with the VRF the plan knows it by; a VRF the plan does not have is kept apart. */
function place(facts: DrawnFacts, records: readonly PlanRecord[]): Placed {
  const addressRecords = records.filter((r) => ADDRESS_KINDS.includes(r.kind));
  const spans = new Map<string, Span>();
  for (const r of addressRecords) {
    const s = spanOf(r);
    if (s) spans.set(r.id, s);
  }
  const vrfByName = new Map<string, string>();
  for (const r of records) if (r.kind === 'vrf') vrfByName.set((text(r.fields, 'name') ?? '').toLowerCase(), r.id);
  const located: Located[] = [];
  const unknownVrf = new Map<string, DrawnAddress[]>();
  for (const d of facts.addresses) {
    const host = parseCidrBig(d.value, true);
    const network = parseCidrBig(d.value);
    if (!host || !network || unplannable(host)) continue;
    let vrf = '';
    if (d.instance !== null && !GLOBAL_NAMES.has(d.instance.toLowerCase())) {
      const id = vrfByName.get(d.instance.toLowerCase());
      if (id === undefined) {
        unknownVrf.set(d.instance, [...(unknownVrf.get(d.instance) ?? []), d]);
        continue;
      }
      vrf = id;
    }
    located.push({ drawn: d, host, network, vrf });
  }
  return { addressRecords, spans, located, unknownVrf };
}

/** The global table's planned records holding `host`, leaving out addresses shared by role. */
function heldInGlobal(p: Placed, host: Span): PlanRecord[] {
  return p.addressRecords.filter((r) => vrfOf(r) === '' && p.spans.has(r.id) && spanContains(p.spans.get(r.id)!, host));
}

/** One address in the plan's global table that should be in one place only. */
const isUnique = (held: PlanRecord[]) => held.length > 0 && !held.some((r) => r.kind === 'address' && SHARED_ROLES.has(text(r.fields, 'role') ?? ''));

/** The drawn addresses worth asking the estate index about: in the global table, held by the plan. */
export function uniqueSpaceIps(facts: DrawnFacts, records: readonly PlanRecord[]): string[] {
  const p = place(facts, records);
  const out = new Set<string>();
  for (const l of p.located) {
    if (l.vrf === '' && isUnique(heldInGlobal(p, l.host))) out.add(formatIp(l.host.v6, l.host.lo));
  }
  return [...out].sort();
}

/** The same address as the index writes it, so 2001:DB8::1 and 2001:db8::1 agree. */
export function sameIp(a: string, b: string): boolean {
  const x = parseIp(a.split('/')[0] ?? '');
  const y = parseIp(b.split('/')[0] ?? '');
  return x !== undefined && y !== undefined && x.v6 === y.v6 && x.n === y.n;
}

/** The findings for a design against the plan. `elsewhere` is what the estate index says about
 * the addresses `uniqueSpaceIps` named, by address. */
export function ipPlanFindings(facts: DrawnFacts, records: readonly PlanRecord[], elsewhere: ReadonlyMap<string, readonly Elsewhere[]> = new Map()): PlanFinding[] {
  const placed = place(facts, records);
  const { addressRecords, spans, located, unknownVrf } = placed;
  if (addressRecords.length === 0 && !records.some((r) => r.kind === 'asn_range' || r.kind === 'asn')) return [];
  const out: PlanFinding[] = [];
  if (addressRecords.length > 0) {
    for (const [name, list] of unknownVrf) {
      const devices = [...new Map(list.map((d) => [d.deviceId, d])).values()];
      out.push({
        rule: 'ip-plan.vrf-not-planned',
        ignoreKey: `vrf|${name.toLowerCase()}`,
        adopt: { kind: 'vrf', fields: { name, enforce_unique: false, note: `Adopted from ${listNames(devices.map((d) => d.deviceName))}.` } },
        severity: 'idea',
        title: `VRF ${name} is drawn here but is not in the IP plan`,
        fix: `Add VRF ${name} in ${WHERE}, or put these interfaces in a VRF the plan has.`,
        why: `${list.length} ${plural(list.length, 'address is', 'addresses are')} drawn in VRF ${name} on ${listNames(devices.map((d) => d.deviceName))}. The plan has no VRF by that name, so nothing here can be compared with it.`,
        concept: CONCEPT,
        source: SOURCE,
        elements: devices.map((d) => ({ id: d.deviceId, name: d.deviceName })),
      });
    }
  }

  const notPlanned = new Map<string, { network: string; vrf: string; within: PlanRecord | null; drawn: DrawnAddress[] }>();
  const smallest = (list: PlanRecord[]) => list.sort((a, b) => (spanSize(spans.get(a.id)!) < spanSize(spans.get(b.id)!) ? -1 : 1))[0] ?? null;

  for (const at of located) {
    const { drawn, host, network, vrf } = at;
    const ip = formatIp(host.v6, host.lo);
    const holding = addressRecords.filter((r) => spans.has(r.id) && spanContains(spans.get(r.id)!, host));
    const inVrf = holding.filter((r) => vrfOf(r) === vrf);
    const element = { id: drawn.deviceId, name: `${drawn.deviceName} ${drawn.interfaceLabel}` };

    // In the global table and held by the plan, but drawn in another design too.
    const others = vrf === '' ? [...elsewhere.entries()].find(([k]) => sameIp(k, ip))?.[1] : undefined;
    if (others && others.length > 0 && isUnique(heldInGlobal(placed, host))) {
      const named = others.map((o) => `${o.device} in ${o.designName ?? 'another design'}`);
      out.push({
        rule: 'ip-plan.in-use-twice',
        ignoreKey: `twice|${drawn.addressNodeId}`,
        severity: 'warn',
        title: `${ip} on ${drawn.deviceName} is also drawn on ${listNames(named)}`,
        fix: `Give one of them another address. If the other one is in a VRF, this is fine: press Ignore.`,
        why: `The plan holds ${ip} in the global table, where an address belongs in one place. ${drawn.deviceName} ${drawn.interfaceLabel} has it here, and ${listNames(named)} ${plural(others.length, 'has', 'have')} it too. Two devices answering for one address each get some of its traffic. The other design's VRF is not known here.`,
        concept: CONCEPT,
        source: SOURCE,
        elements: [element],
      });
    }

    // A planned address for this exact IP: the length should agree.
    const planned = inVrf.find((r) => r.kind === 'address');
    if (planned) {
      const want = parseCidrBig(text(planned.fields, 'address') ?? '', true);
      if (want && (text(planned.fields, 'address') ?? '').includes('/') && want.len !== host.len) {
        out.push(differently(drawn, element, `${ip}/${host.len}`, `${ip}/${want.len}`, 'the planned address'));
      }
      continue;
    }
    // Inside a reservation: in use, as decision 3 says, not a difference.
    if (inVrf.some((r) => r.kind === 'reservation')) continue;

    const prefixes = inVrf.filter((r) => r.kind === 'prefix' && text(r.fields, 'status') !== 'container');
    const prefix = smallest(prefixes);
    if (prefix) {
      const span = spans.get(prefix.id)!;
      const planLen = parseCidrBig(text(prefix.fields, 'prefix') ?? '')?.len;
      const hostLength = host.len === (host.v6 ? 128 : 32);
      if (planLen !== undefined && planLen !== host.len && !(hostLength && flag(prefix.fields, 'is_pool'))) {
        out.push(differently(drawn, element, `${ip}/${host.len}`, `${formatIp(span.v6, span.lo)}/${planLen}`, 'its planned prefix'));
      }
      continue;
    }

    // Not in its own VRF's plan: planned in another VRF is a difference, else it is not planned.
    const otherVrf = smallest(holding.filter((r) => r.kind === 'prefix' && text(r.fields, 'status') !== 'container' && vrfOf(r) !== vrf));
    if (otherVrf) {
      const planVrf = nameOfVrf(records, vrfOf(otherVrf));
      const drawnVrf = nameOfVrf(records, vrf);
      out.push({
        rule: 'ip-plan.different-vrf',
        ignoreKey: `vrf-differs|${drawn.addressNodeId}|${vrf}`,
        severity: 'warn',
        title: `${ip} is drawn in ${drawnVrf} but planned in ${planVrf}`,
        fix: `Move ${drawn.interfaceLabel} on ${drawn.deviceName} into ${planVrf}, or change the plan in ${WHERE}.`,
        why: `The plan puts ${text(otherVrf.fields, 'prefix')} in ${planVrf}. On ${drawn.deviceName} the address is in ${drawnVrf}, so the two tables would each think they own it.`,
        concept: CONCEPT,
        source: SOURCE,
        elements: [element],
      });
      continue;
    }
    const net = `${formatIp(network.v6, network.lo)}/${network.len}`;
    const key = `${vrf}|${net}`;
    const within = smallest(inVrf.filter((r) => r.kind === 'aggregate' || r.kind === 'prefix' || r.kind === 'range'));
    const entry = notPlanned.get(key) ?? { network: net, vrf, within, drawn: [] };
    entry.drawn.push(drawn);
    notPlanned.set(key, entry);
  }

  for (const entry of notPlanned.values()) {
    const devices = [...new Map(entry.drawn.map((d) => [d.deviceId, d])).values()];
    const space = entry.vrf === '' ? '' : ` in ${nameOfVrf(records, entry.vrf)}`;
    const within = entry.within ? (text(entry.within.fields, 'prefix') ?? text(entry.within.fields, 'range')) : null;
    const folder = entry.within ? text(entry.within.fields, 'folder') : null;
    const adopt: Record<string, string | boolean> = {
      prefix: entry.network,
      status: 'active',
      is_pool: false,
      mark_utilised: false,
      note: `Adopted from ${listNames(devices.map((d) => d.deviceName))}.`,
    };
    if (entry.vrf !== '') adopt.vrf = entry.vrf;
    if (folder) adopt.folder = folder;
    out.push({
      rule: 'ip-plan.not-planned',
      ignoreKey: `unplanned|${entry.vrf}|${entry.network}`,
      adopt: { kind: 'prefix', fields: adopt },
      severity: 'idea',
      title: `${entry.network}${space} is drawn here but is not in the IP plan`,
      fix: within ? `Add ${entry.network} under ${within} in ${WHERE}.` : `Add ${entry.network} in ${WHERE}, or check the address is right.`,
      why: `${entry.drawn.length} ${plural(entry.drawn.length, 'address', 'addresses')} in ${entry.network} ${plural(entry.drawn.length, 'is', 'are')} drawn on ${listNames(devices.map((d) => d.deviceName))}, and no planned prefix, address or reservation holds ${plural(entry.drawn.length, 'it', 'them')}. Next free can hand ${plural(entry.drawn.length, 'it', 'them')} to someone else.`,
      concept: CONCEPT,
      source: SOURCE,
      elements: devices.map((d) => ({ id: d.deviceId, name: d.deviceName })),
    });
  }

  // Planned for a device in this design, but not drawn on it.
  const byName = new Map(facts.devices.map((d) => [d.name.toLowerCase(), d]));
  for (const r of addressRecords) {
    if (r.kind !== 'address' || text(r.fields, 'status') !== 'active') continue;
    const meant = (text(r.fields, 'meant_for') ?? '').trim();
    const device = byName.get(meant.split(/\s+/)[0]?.toLowerCase() ?? '');
    const want = spans.get(r.id);
    if (!device || !want) continue;
    const vrf = vrfOf(r);
    const there = located.some((l) => l.drawn.deviceId === device.id && l.host.lo === want.lo && l.host.v6 === want.v6 && l.vrf === vrf);
    if (there) continue;
    const address = text(r.fields, 'address') ?? '';
    out.push({
      rule: 'ip-plan.not-drawn',
      ignoreKey: `undrawn|${r.id}|${device.id}`,
      mark: { deviceId: device.id, address, meant },
      severity: 'idea',
      title: `${address} is planned for ${device.name} but is not drawn on it`,
      fix: `Add ${address} to ${meant.slice(device.name.length).trim() || 'an interface'} on ${device.name}, or change the plan in ${WHERE}.`,
      why: `The plan says ${address} is meant for "${meant}". ${device.name} is in this design and none of its interfaces has that address.`,
      concept: CONCEPT,
      source: SOURCE,
      elements: [{ id: device.id, name: device.name }],
    });
  }

  // A BGP AS number inside a planned range that the plan does not hold.
  const asnRecords = records.filter((r) => r.kind === 'asn');
  const ranges = records.filter((r) => r.kind === 'asn_range');
  const seen = new Set<string>();
  for (const a of facts.asns) {
    if (asnRecords.some((r) => text(r.fields, 'asn') === a.asn)) continue;
    const n = BigInt(a.asn);
    const range = ranges.find((r) => {
      const first = text(r.fields, 'first');
      const last = text(r.fields, 'last');
      return first !== null && last !== null && /^\d+$/.test(first) && /^\d+$/.test(last) && BigInt(first) <= n && n <= BigInt(last);
    });
    if (!range || seen.has(`${a.asn}|${a.deviceId}`)) continue;
    seen.add(`${a.asn}|${a.deviceId}`);
    const name = text(range.fields, 'name') ?? 'a planned range';
    const asnFields: Record<string, string> = { asn: a.asn, range: range.id, meant_for: a.deviceName };
    const rangeFolder = text(range.fields, 'folder');
    if (rangeFolder) asnFields.folder = rangeFolder;
    out.push({
      rule: 'ip-plan.asn-not-planned',
      ignoreKey: `asn|${a.asn}|${a.deviceId}`,
      adopt: { kind: 'asn', fields: asnFields },
      severity: 'idea',
      title: `AS ${a.asn} on ${a.deviceName} is in ${name} but is not in the IP plan`,
      fix: `Add AS ${a.asn} under ${name} in ${WHERE}, so next free ASN skips it.`,
      why: `${a.deviceName} runs BGP as AS ${a.asn}, which is inside ${name}, and the plan does not hold that number.`,
      concept: CONCEPT,
      source: SOURCE,
      elements: [{ id: a.deviceId, name: a.deviceName }],
    });
  }
  return out;
}

function differently(drawn: DrawnAddress, element: { id: string; name: string }, as: string, plan: string, what: string): PlanFinding {
  return {
    rule: 'ip-plan.different-length',
    ignoreKey: `length|${drawn.addressNodeId}|${as}|${plan}`,
    severity: 'warn',
    title: `${drawn.deviceName} ${drawn.interfaceLabel} has ${as}, but the plan says ${plan}`,
    fix: `Change the address on ${drawn.interfaceLabel} to the plan's length, or change ${what} in ${WHERE}.`,
    why: `A different length means a different network: devices on ${as} and ${plan} disagree about which neighbours they can reach directly.`,
    concept: CONCEPT,
    source: SOURCE,
    elements: [element],
  };
}

// ---------------------------------------------------------------------------
// Asking the server

/** How many addresses one design asks the estate index about at a time, and in all. */
const INDEX_AT_ONCE = 4;
const INDEX_MOST = 64;

const ignoreStore = (organisationId: string, designId: string) => `fathom.ipPlan.ignored.${organisationId}.${designId}`;

function loadIgnored(key: string): ReadonlySet<string> {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveIgnored(key: string, set: ReadonlySet<string>): void {
  try {
    if (set.size === 0) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, JSON.stringify([...set]));
  } catch {
    // Private mode or a full disk: Ignore lasts until the page is reloaded.
  }
}

/** What the estate index says about each address: the devices in other designs that have it, and
 * whether any design was still being brought up to date, so the answer is worth asking again. */
async function askIndex(organisationId: string, designId: string, ips: readonly string[]): Promise<{ found: Map<string, Elsewhere[]>; behind: boolean }> {
  const out = new Map<string, Elsewhere[]>();
  let behind = false;
  const queue = ips.slice(0, INDEX_MOST);
  const worker = async () => {
    for (let ip = queue.shift(); ip !== undefined; ip = queue.shift()) {
      const found = await searchEstate(organisationId, ip, 'device');
      if (found.behind > 0) behind = true;
      const ask = ip;
      const hits = found.hits.filter((h) => h.design !== designId && h.addresses.some((a) => sameIp(a, ask)));
      if (hits.length > 0) out.set(ip, hits.map((h) => ({ design: h.design, designName: h.designName, device: h.name || 'unnamed' })));
    }
  };
  await Promise.all(Array.from({ length: INDEX_AT_ONCE }, worker));
  return { found: out, behind };
}

/** A design still being indexed is asked about again after this long, at most this many times. */
const INDEX_AGAIN_MS = 8000;
const INDEX_TRIES = 3;

export interface IpPlanChecks {
  findings: CheckFinding[];
  /** Planned addresses not drawn on the device they are meant for, by device id. */
  planned: ReadonlyMap<string, readonly PlannedMark[]>;
  /** How many findings Ignore is hiding here, and how to show them again. */
  ignored: number;
  unignore: () => void;
}

const NO_MARKS: ReadonlyMap<string, readonly PlannedMark[]> = new Map();

/** The organisation's plan, asked for again when the drawn addresses change; nothing until it answers. */
export function useIpPlanFindings(doc: Document | null, organisationId: string | undefined, designId?: string | null): IpPlanChecks {
  const facts = useMemo(() => (doc == null ? null : drawnFacts(doc)), [doc]);
  const key = facts == null ? '' : [...facts.addresses.map((a) => `${a.deviceId}:${a.value}@${a.instance ?? ''}`), ...facts.asns.map((a) => `${a.deviceId}:as${a.asn}`), ...facts.devices.map((d) => `${d.id}=${d.name}`)].sort().join('|');
  const [records, setRecords] = useState<readonly PlanRecord[]>([]);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (organisationId == null || key === '') {
      setRecords([]);
      return;
    }
    let live = true;
    fetchPlan(organisationId).then(
      (plan) => {
        if (live) setRecords(plan.records);
      },
      () => {
        // No plan to read, or the server is not answering: say nothing rather than guess.
        if (live) setRecords([]);
      },
    );
    return () => {
      live = false;
    };
  }, [organisationId, key, reload]);

  // In use twice: only once the plan says which addresses should be in one place.
  const ips = useMemo(() => (facts == null || records.length === 0 ? [] : uniqueSpaceIps(facts, records)), [facts, records]);
  const ipsKey = ips.join(',');
  const [elsewhere, setElsewhere] = useState<ReadonlyMap<string, readonly Elsewhere[]>>(new Map());
  useEffect(() => {
    if (organisationId == null || designId == null || ipsKey === '') {
      setElsewhere(new Map());
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = (tries: number) => {
      askIndex(organisationId, designId, ipsKey.split(',')).then(
        (got) => {
          if (!live) return;
          setElsewhere(got.found);
          if (got.behind && tries + 1 < INDEX_TRIES) timer = setTimeout(() => ask(tries + 1), INDEX_AGAIN_MS);
        },
        () => {
          if (live) setElsewhere(new Map());
        },
      );
    };
    ask(0);
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [organisationId, designId, ipsKey]);

  const store = organisationId != null && designId != null ? ignoreStore(organisationId, designId) : null;
  const [ignored, setIgnored] = useState<ReadonlySet<string>>(() => (store ? loadIgnored(store) : new Set()));
  useEffect(() => setIgnored(store ? loadIgnored(store) : new Set()), [store]);
  const ignore = useCallback(
    (k: string) => {
      setIgnored((prev) => {
        const next = new Set(prev).add(k);
        if (store) saveIgnored(store, next);
        return next;
      });
    },
    [store],
  );
  const unignore = useCallback(() => {
    setIgnored(new Set());
    if (store) saveIgnored(store, new Set());
  }, [store]);

  const all = useMemo(() => (facts == null ? [] : ipPlanFindings(facts, records, elsewhere)), [facts, records, elsewhere]);
  return useMemo(() => {
    const shown = all.filter((f) => !ignored.has(f.ignoreKey));
    const findings = shown.map(({ ignoreKey, adopt, mark: _mark, ...f }): CheckFinding => {
      const actions: CheckAction[] = [];
      if (adopt && organisationId != null) {
        actions.push({
          label: 'Adopt',
          run: async () => {
            try {
              await createRecord(organisationId, adopt.kind, adopt.fields);
            } catch (e) {
              throw new Error(planRefusal(e) ?? 'The plan did not take it. Check you may change the IP plan, then try again.');
            }
            setReload((n) => n + 1);
          },
        });
      }
      actions.push({ label: 'Ignore', run: async () => ignore(ignoreKey) });
      return { ...f, actions };
    });
    const marks = new Map<string, PlannedMark[]>();
    for (const f of shown) if (f.mark) marks.set(f.mark.deviceId, [...(marks.get(f.mark.deviceId) ?? []), f.mark]);
    const hidden = all.length - shown.length;
    return { findings, planned: marks.size > 0 ? marks : NO_MARKS, ignored: hidden, unignore };
  }, [all, ignored, organisationId, ignore, unignore]);
}
