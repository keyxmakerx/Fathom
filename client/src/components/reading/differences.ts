// What a device said against what the drawing says (ADR-0082 §5; sign-off r100). Pure: the
// reading the server kept for one device, the open design, and the differences people dismissed,
// in; the rows the Readings tab shows, out. Accepting one is an ordinary design edit.
//
// What is compared: the name (sysName against Device.hostname), the serial and the software
// version of the chassis (ENTITY-MIB entPhysicalSerialNum and entPhysicalSoftwareRev against
// Chassis.serial and Device.os_version), and each LLDP neighbour against the cable drawn on that
// port. A port's description (ifAlias) is not compared: the drawing keeps no description on a
// physical port.

import type { EditorChange } from '../drawing';
import { asString, edgesIn, edgesOut, fieldValue, findNode, isNodeOfKind, readPhysicalPortFields, type Document } from '../../document/model';

/** What the server writes in place of a string the redaction gate stopped. */
const WITHHELD = '[withheld';

/** entPhysicalClass chassis(3) (ENTITY-MIB, RFC 6933). */
const CLASS_CHASSIS = 3;

export interface Difference {
  /** What a dismissal is filed under: `hostname`, `serial`, `os_version`, or `lldp:<local port>`. */
  field: string;
  /** The row's name: "Name", "Serial", "Gi1/0/48". */
  what: string;
  /** What the device said. */
  read: string;
  /** What the drawing says, in words; null when it says nothing. */
  drawn: string | null;
  /** Where on the device it came from: "sysName", "LLDP · dist-sw2 is in this design". */
  why: string;
  /** The edit Accept makes, and the button's word; null when there is nothing Fathom can do but dismiss. */
  accept: { label: 'Accept' | 'Add' | 'Add cable'; change: EditorChange } | null;
}

export interface Comparison {
  differs: Difference[];
  /** What matched, in a few words each, for the folded line. */
  matches: string[];
  /** Ethernet ports up and down, as the device said. */
  up: number;
  down: number;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | null {
  return v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;
}

function rows(v: unknown): Rec[] {
  return Array.isArray(v) ? v.map(rec).filter((r): r is Rec => r !== null) : [];
}

/** A string the device said, trimmed; null when absent, empty, binary or withheld. */
function said(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '' || t.startsWith('hex:') || t.startsWith(WITHHELD)) return null;
  return t;
}

/** sysName is often a full name; the drawing's hostname is the first label. */
export function shortName(name: string): string {
  const dot = name.indexOf('.');
  return dot > 0 && !/^\d+\.\d+\.\d+\.\d+$/.test(name) ? name.slice(0, dot) : name;
}

function sameName(a: string, b: string): boolean {
  return shortName(a).toLowerCase() === shortName(b).toLowerCase();
}

interface DrawnPort {
  id: string;
  label: string;
  /** The far port, when a cable is drawn from this one. */
  cabled: boolean;
  farPortId: string | null;
}

interface DrawnDevice {
  deviceId: string;
  chassisId: string | null;
  hostname: string | null;
  serial: string | null;
  osVersion: string | null;
  ports: DrawnPort[];
}

function farOf(doc: Document, portId: string): { cabled: boolean; farPortId: string | null } {
  const near = edgesIn(doc, portId, 'Terminates')[0];
  if (!near) return { cabled: false, farPortId: null };
  const far = edgesOut(doc, near.from, 'Terminates').find((e) => e.id !== near.id && findNode(doc, e.to)?.absentSince === undefined);
  return { cabled: true, farPortId: far?.to ?? null };
}

function drawnDevice(doc: Document, deviceId: string): DrawnDevice | null {
  const device = findNode(doc, deviceId);
  if (!device || device.absentSince !== undefined) return null;
  const chassisId = edgesOut(doc, deviceId, 'HasChassis').find((e) => findNode(doc, e.to)?.absentSince === undefined)?.to ?? null;
  const chassis = chassisId ? findNode(doc, chassisId) : undefined;
  const ports: DrawnPort[] = [];
  if (chassisId) {
    for (const e of edgesOut(doc, chassisId, 'HasPort')) {
      const n = findNode(doc, e.to);
      if (!n || n.absentSince !== undefined) continue;
      const label = readPhysicalPortFields(n).label ?? '';
      if (label === '') continue;
      ports.push({ id: n.id, label, ...farOf(doc, n.id) });
    }
  }
  return {
    deviceId,
    chassisId,
    hostname: asString(fieldValue(device.fields, 'Device.hostname')) ?? null,
    osVersion: asString(fieldValue(device.fields, 'Device.os_version')) ?? null,
    serial: chassis ? (asString(fieldValue(chassis.fields, 'Chassis.serial')) ?? null) : null,
    ports,
  };
}

/** The number at the end of an interface name: "Gi1/0/48" and "GigabitEthernet1/0/48" give "48". */
function lastNumber(name: string): string | null {
  const m = /(\d+)\s*$/.exec(name);
  return m ? String(Number(m[1])) : null;
}

/**
 * The drawn port an interface name means: one whose label is the name itself, else the one whose
 * label is the name's last number, when exactly one port has it. Null when it cannot be told.
 */
export function portFor(ports: readonly DrawnPort[], names: readonly (string | null)[]): DrawnPort | null {
  const given = names.filter((n): n is string => n != null && n !== '');
  for (const n of given) {
    const hit = ports.filter((p) => p.label.toLowerCase() === n.toLowerCase());
    if (hit.length === 1) return hit[0]!;
  }
  for (const n of given) {
    const last = lastNumber(n);
    if (last === null) continue;
    // Only a label that is a bare number: "mgmt1" is not port 1.
    const hit = ports.filter((p) => /^\d+$/.test(p.label) && String(Number(p.label)) === last);
    if (hit.length === 1) return hit[0]!;
  }
  return null;
}

/** The chassis row of ENTITY-MIB: class chassis and contained in nothing, else the first chassis. */
function chassisRow(inventory: Rec[]): Rec | null {
  const chassis = inventory.filter((r) => r.class === CLASS_CHASSIS);
  return chassis.find((r) => r.containedIn === 0) ?? chassis[0] ?? null;
}

/** Interface names by ifIndex, for an LLDP local port number or a MAC row. */
export function interfaceNames(reading: Rec | null): Map<number, { name: string | null; descr: string | null }> {
  const out = new Map<number, { name: string | null; descr: string | null }>();
  for (const r of rows(reading?.interfaces)) {
    if (typeof r.index === 'number') out.set(r.index, { name: said(r.name), descr: said(r.descr) });
  }
  return out;
}

function devicesByName(doc: Document, except: string): DrawnDevice[] {
  return doc.nodes
    .filter((n) => n.absentSince === undefined && n.id !== except && isNodeOfKind(n.id, 'Device'))
    .map((n) => drawnDevice(doc, n.id))
    .filter((d): d is DrawnDevice => d !== null && d.hostname !== null);
}

function portLabel(doc: Document, portId: string): string {
  const n = findNode(doc, portId);
  const label = n ? (readPhysicalPortFields(n).label ?? '') : '';
  const chassis = edgesIn(doc, portId, 'HasPort')[0]?.from;
  const device = chassis ? edgesIn(doc, chassis, 'HasChassis')[0]?.from : undefined;
  const host = device ? asString(fieldValue(findNode(doc, device)?.fields ?? {}, 'Device.hostname')) : undefined;
  return [host ?? 'another device', label].filter(Boolean).join(' · ');
}

function dismissedNow(dismissed: readonly { field: string; value: string }[], field: string, value: string): boolean {
  return dismissed.some((d) => d.field === field && d.value === value);
}

/**
 * Compares one reading with one device in the design. A difference someone dismissed stays
 * dismissed while the device says the same; a new value brings it back.
 */
export function compare(
  doc: Document,
  deviceId: string,
  reading: Rec | null,
  dismissed: readonly { field: string; value: string }[],
): Comparison {
  const out: Comparison = { differs: [], matches: [], up: 0, down: 0 };
  const me = drawnDevice(doc, deviceId);
  if (!me || !reading) return out;
  const push = (d: Difference) => {
    if (!dismissedNow(dismissed, d.field, d.read)) out.differs.push(d);
  };

  // The name.
  const sysName = said(rec(reading.system)?.name);
  if (sysName !== null) {
    if (me.hostname !== null && sameName(sysName, me.hostname)) out.matches.push('name');
    else {
      const value = shortName(sysName);
      push({
        field: 'hostname',
        what: 'Name',
        read: value,
        drawn: me.hostname,
        why: 'sysName',
        accept: { label: me.hostname ? 'Accept' : 'Add', change: { kind: 'device', id: deviceId, field: 'hostname', value } },
      });
    }
  }

  // The chassis: serial and software version.
  const chassis = chassisRow(rows(reading.inventory));
  const serial = said(chassis?.serial);
  if (serial !== null && me.chassisId !== null) {
    if (me.serial !== null && me.serial === serial) out.matches.push('serial');
    else
      push({
        field: 'serial',
        what: 'Serial',
        read: serial,
        drawn: me.serial,
        why: 'entPhysicalSerialNum',
        accept: { label: me.serial ? 'Accept' : 'Add', change: { kind: 'chassis', id: me.chassisId, field: 'serial', value: serial } },
      });
  }
  const version = said(chassis?.softwareRev) ?? said(rows(reading.inventory).find((r) => said(r.softwareRev) !== null)?.softwareRev);
  if (version !== null) {
    if (me.osVersion !== null && me.osVersion === version) out.matches.push('firmware');
    else
      push({
        field: 'os_version',
        what: 'Firmware',
        read: version,
        drawn: me.osVersion,
        why: 'entPhysicalSoftwareRev',
        accept: { label: me.osVersion ? 'Accept' : 'Add', change: { kind: 'device', id: deviceId, field: 'os_version', value: version } },
      });
  }

  // Ports up and down: ethernetCsmacd(6) only, so VLANs and loopbacks are not counted (IANAifType-MIB).
  for (const r of rows(reading.interfaces)) {
    if (r.type !== 6) continue;
    if (r.operStatus === 1) out.up += 1;
    else if (r.operStatus === 2) out.down += 1;
  }

  // LLDP neighbours against the cables drawn.
  const lldp = rec(reading.lldp);
  const local = new Map<number, Rec>();
  for (const r of rows(lldp?.local)) if (typeof r.portNum === 'number') local.set(r.portNum, r);
  const ifs = interfaceNames(reading);
  const others = devicesByName(doc, deviceId);
  let neighboursMatched = 0;
  const seen = new Set<string>();
  for (const r of rows(lldp?.remote)) {
    const n = typeof r.localPortNum === 'number' ? r.localPortNum : null;
    if (n === null) continue;
    const loc = local.get(n);
    const iface = ifs.get(n);
    const localNames = [said(loc?.portId), said(loc?.portDesc), iface?.name ?? null, iface?.descr ?? null];
    const shown = localNames.find((x) => x !== null) ?? `port ${n}`;
    const field = `lldp:${shown}`;
    if (seen.has(field)) continue;
    seen.add(field);
    const remoteName = said(r.sysName);
    const remotePortNames = [said(r.portId), said(r.portDesc)];
    const remotePortShown = remotePortNames.find((x) => x !== null) ?? '';
    const readText = [remoteName ? shortName(remoteName) : said(r.chassisId) ?? 'a neighbour', remotePortShown].filter(Boolean).join(' · ');
    const mine = portFor(me.ports, localNames);
    const them = remoteName ? others.find((d) => d.hostname !== null && sameName(remoteName, d.hostname)) : undefined;
    const theirPort = them ? portFor(them.ports, remotePortNames) : null;
    if (mine && theirPort && mine.farPortId === theirPort.id) {
      neighboursMatched += 1;
      continue;
    }
    const drawn = mine === null ? null : !mine.cabled ? 'nothing connected' : mine.farPortId ? portLabel(doc, mine.farPortId) : 'a cable with no far end';
    let why: string;
    let accept: Difference['accept'] = null;
    if (mine === null) why = `LLDP · Fathom can't tell which drawn port ${shown} is`;
    else if (!them) why = remoteName ? `LLDP · ${shortName(remoteName)} isn't in this design` : 'LLDP';
    else if (!theirPort) why = `LLDP · ${them.hostname} has no port Fathom can match to ${remotePortShown || 'it'}`;
    else if (mine.cabled || theirPort.cabled) why = `LLDP · ${them.hostname} is in this design; a cable is drawn on one end`;
    else {
      why = `LLDP · ${them.hostname} is in this design`;
      accept = { label: 'Add cable', change: { kind: 'cable-connect', fromPortId: mine.id, toPortId: theirPort.id } };
    }
    push({ field, what: shown, read: readText, drawn: drawn ?? 'no port drawn', why, accept });
  }
  if (neighboursMatched > 0) out.matches.push(`${neighboursMatched} neighbour${neighboursMatched === 1 ? '' : 's'}`);
  return out;
}

/** "Accept all": every difference with an edit, as one change and one undo step. */
export function acceptAll(differs: readonly Difference[]): EditorChange | null {
  const changes = differs.flatMap((d) => (d.accept ? [d.accept.change] : []));
  return changes.length === 0 ? null : { kind: 'all', changes };
}
