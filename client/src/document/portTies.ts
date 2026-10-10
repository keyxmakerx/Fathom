// Port ties: a pasted Interface joined to the drawn PhysicalPort it sits on (schema.yaml, edge Occupies).
// The person makes every tie; Fathom only suggests, and only from a cited rule in corpus/dict/port-names.json
// (an interface name read as a PortPosition, matched against a port that holds that position). Never a guess:
// no name likeness, no first free port. Logical interfaces never occupy a port, so they are never offered.

import { addEdge, addNode, begin, finish, tombstone } from './freeform';
import { asString, edgesIn, edgesOut, fieldValue, findNode, parseNodeId, readChassisFields, readPhysicalPortFields, type Document, type GraphNode } from './model';

interface Actor {
  actor?: string;
  now?: number;
}

/** 19 §3.3's PortPosition. */
export interface PortPosition {
  slot?: number;
  subslot?: number;
  index: number;
}

export interface PortNameRule {
  id: string;
  platforms: string[];
  pattern: string;
  slot?: number;
  subslot?: number;
  index: number;
  source: { cite: string; url: string; read_on: string } | null;
  wanted?: string;
}

const ruleFiles = import.meta.glob('../../../corpus/dict/port-names.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

/** Every rule in the file, cited or not. */
export function allPortNameRules(): PortNameRule[] {
  const text = Object.values(ruleFiles)[0];
  return text === undefined ? [] : (JSON.parse(text) as { rules: PortNameRule[] }).rules;
}

/** A rule suggests only with a vendor page and the date it was read (ADR-0034). */
export function isCited(rule: PortNameRule): boolean {
  const s = rule.source;
  return s != null && s.cite.trim() !== '' && /^https:\/\//.test(s.url) && /^\d{4}-\d{2}-\d{2}$/.test(s.read_on);
}

export function citedPortNameRules(): PortNameRule[] {
  return allPortNameRules().filter(isCited);
}

/** The position a cited rule reads from `name` on `platform`, or null. */
export function positionOf(name: string, platform: string | null, rules: readonly PortNameRule[]): PortPosition | null {
  if (platform === null) return null;
  for (const rule of rules) {
    if (!isCited(rule) || !rule.platforms.includes(platform)) continue;
    const m = new RegExp(rule.pattern).exec(name);
    if (!m) continue;
    const group = (i: number | undefined): number | undefined => (i === undefined ? undefined : Number(m[i]));
    return { slot: group(rule.slot), subslot: group(rule.subslot), index: group(rule.index)! };
  }
  return null;
}

function portPosition(port: GraphNode): PortPosition | null {
  const v = fieldValue(port.fields, 'PhysicalPort.position');
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const num = (x: unknown): number | undefined => (typeof x === 'number' ? x : undefined);
  const index = num(o.index);
  return index === undefined ? null : { slot: num(o.slot), subslot: num(o.subslot), index };
}

const samePosition = (a: PortPosition, b: PortPosition): boolean => a.index === b.index && a.slot === b.slot && a.subslot === b.subslot;

const live = (doc: Document, id: string): GraphNode | undefined => {
  const n = findNode(doc, id);
  return n && n.absentSince === undefined ? n : undefined;
};

/** The Device a chassis or device id names, or null. */
export function deviceOf(doc: Document, id: string): string | null {
  const kind = parseNodeId(id).kind;
  if (kind === 'Device') return live(doc, id) ? id : null;
  if (kind === 'Chassis') return edgesIn(doc, id, 'HasChassis')[0]?.from ?? null;
  return null;
}

/** A name that reads as a jack (ge-0/0/0, eth0, igb1), for interfaces a paste left without a form. Shared with the
 * paste's own "a port per physical interface". */
export const PHYSICAL_NAME = /^(ge|xe|et|fe|me|fxp|em|eth|ether|gi|gig|fa|te|ten|port|lan|wan|sfp|igb|ix|vtnet|re)[-/]?\d/i;
const JACK_FORMS = new Set(['ethernet', 'serial', 'management']);

/** Member Interfaces only: no units, VLANs, loopbacks, IRBs, tunnels or aggregate parents. A paste does not always
 * write Interface.form, so an interface without one is offered only when its name reads as a jack. */
function memberInterfaces(doc: Document, deviceId: string): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const e of edgesOut(doc, deviceId, 'HasInterface')) {
    if (parseNodeId(e.to).kind !== 'Interface') continue;
    const n = live(doc, e.to);
    const name = n ? asString(fieldValue(n.fields, 'Interface.name')) : undefined;
    const form = n ? asString(fieldValue(n.fields, 'Interface.form')) : undefined;
    if (!n || name === undefined || name.includes('.')) continue;
    if (form !== undefined ? !JACK_FORMS.has(form) : !PHYSICAL_NAME.test(name)) continue;
    out.push({ id: n.id, name });
  }
  return out;
}

const isTied = (doc: Document, interfaceId: string): boolean => edgesOut(doc, interfaceId, 'Occupies').some((e) => live(doc, e.to) !== undefined);

/** Every live data port on the device's chassis. */
function devicePorts(doc: Document, deviceId: string): GraphNode[] {
  const out: GraphNode[] = [];
  for (const hc of edgesOut(doc, deviceId, 'HasChassis')) {
    for (const hp of edgesOut(doc, hc.to, 'HasPort')) {
      const p = live(doc, hp.to);
      if (p && readPhysicalPortFields(p).service !== 'power') out.push(p);
    }
  }
  return out;
}

const portWord = (p: GraphNode): string => {
  const label = readPhysicalPortFields(p).label ?? '';
  return label === '' ? 'unlabelled port' : `port ${label}`;
};

export interface TieRow {
  interfaceId: string;
  name: string;
  /** The port a cited rule points at, or null: the row then goes under "Not tied". */
  suggested: string | null;
}

export interface TiePortOption {
  id: string;
  label: string;
}

export interface TiePlan {
  deviceId: string;
  /** Untied member interfaces, in name order. Tied ones are never listed, so a later paste never moves them. */
  rows: TieRow[];
  /** Free data ports, in label order, worded for a picker ("port 3"). */
  ports: TiePortOption[];
  /** The device has no data ports at all and is drawn by hand, so ports can be added from the config. */
  canAddPorts: boolean;
}

export function tiePlan(doc: Document, id: string, rules: readonly PortNameRule[] = citedPortNameRules()): TiePlan | null {
  const deviceId = deviceOf(doc, id);
  if (deviceId === null) return null;
  const device = live(doc, deviceId)!;
  const platform = asString(fieldValue(device.fields, 'Device.platform')) ?? null;
  const all = devicePorts(doc, deviceId);
  const free = all.filter((p) => edgesIn(doc, p.id, 'Occupies').every((e) => live(doc, e.from) === undefined));
  const taken = new Set<string>();
  const rows = memberInterfaces(doc, deviceId)
    .filter((i) => !isTied(doc, i.id))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((i): TieRow => {
      const want = positionOf(i.name, platform, rules);
      const hits = want === null ? [] : free.filter((p) => !taken.has(p.id) && samePosition(portPosition(p) ?? { index: -1 }, want));
      const suggested = hits.length === 1 ? hits[0].id : null;
      if (suggested !== null) taken.add(suggested);
      return { interfaceId: i.id, name: i.name, suggested };
    });
  const ports = free.map((p) => ({ id: p.id, label: portWord(p) })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const sketch = edgesOut(doc, deviceId, 'HasChassis').some((hc) => {
    const c = live(doc, hc.to);
    return c !== undefined && readChassisFields(c).model === undefined;
  });
  return { deviceId, rows, ports, canAddPorts: all.length === 0 && sketch && rows.length > 0 };
}

export class TieRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TieRefusal';
  }
}

export interface TiePair {
  interfaceId: string;
  portId: string;
}

/** The person's ties, as one undo step: only Occupies edges, never a field. A tie already present is refused, never moved. */
export function tiePorts(doc: Document, id: string, pairs: readonly TiePair[], opts?: Actor): Document {
  const deviceId = deviceOf(doc, id);
  if (deviceId === null) throw new TieRefusal('That is not a device.');
  const members = new Set(memberInterfaces(doc, deviceId).map((i) => i.id));
  const ports = new Set(devicePorts(doc, deviceId).map((p) => p.id));
  const seen = new Set<string>();
  for (const { interfaceId, portId } of pairs) {
    if (!members.has(interfaceId)) throw new TieRefusal('Only an interface of this device that sits on a port can be tied.');
    if (!ports.has(portId)) throw new TieRefusal('Only a port of this device can be tied.');
    if (isTied(doc, interfaceId)) throw new TieRefusal('That interface is already tied to a port.');
    if (seen.has(portId) || edgesIn(doc, portId, 'Occupies').some((e) => live(doc, e.from) !== undefined)) throw new TieRefusal('That port already has an interface.');
    seen.add(portId);
  }
  const b = begin(doc, opts);
  for (const { interfaceId, portId } of pairs) addEdge(b, 'Occupies', interfaceId, portId);
  return finish(b, 'tie ports');
}

/** "Add N ports from this config": one unlabelled port per untied interface (the label is the silkscreen, and nobody
 * has read it), each tied to its interface. One undo step. Only on a hand-drawn device with no data ports. */
export function addPortsFromConfig(doc: Document, id: string, opts?: Actor): Document {
  const plan = tiePlan(doc, id, []);
  if (plan === null || !plan.canAddPorts) throw new TieRefusal('Ports can be added from a config only to a drawn device with none.');
  const chassisId = edgesOut(doc, plan.deviceId, 'HasChassis')[0]!.to;
  const b = begin(doc, opts);
  for (const row of plan.rows) {
    const portId = addNode(b, 'PhysicalPort', {});
    addEdge(b, 'HasPort', chassisId, portId);
    addEdge(b, 'Occupies', row.interfaceId, portId);
  }
  return finish(b, 'add ports from config');
}

export interface TiedPair {
  interfaceId: string;
  name: string;
  port: string;
}

/** The ties already made on a device, in name order: what the Ports tab shows, each with Untie. */
export function tiedPairs(doc: Document, id: string): TiedPair[] {
  const deviceId = deviceOf(doc, id);
  if (deviceId === null) return [];
  const out: TiedPair[] = [];
  for (const i of memberInterfaces(doc, deviceId)) {
    const port = edgesOut(doc, i.id, 'Occupies').map((e) => live(doc, e.to)).find((p) => p !== undefined);
    if (port) out.push({ interfaceId: i.id, name: i.name, port: portWord(port) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Removes an interface's ties, as one undo step. The interface and the port stay. */
export function untie(doc: Document, interfaceId: string, opts?: Actor): Document {
  const edges = edgesOut(doc, interfaceId, 'Occupies');
  if (edges.length === 0) throw new TieRefusal('That interface is not tied to a port.');
  const b = begin(doc, opts);
  tombstone(b, new Set(), new Set(edges.map((e) => e.id)));
  return finish(b, 'untie port');
}
