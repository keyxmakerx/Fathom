// Who is plugged in where, from a switch's MAC table and a router's ARP table (round 29, card r29-fill; mockup
// r29-autofill-a). A person pastes the hardware addresses the switch has learned on each port and, optionally, the
// router's table of which address belongs to which IP. A port that has learned exactly one MAC either meets a port
// this design already gives that MAC (a suggested cable) or names a device nobody has drawn yet (a suggested sketch
// device with one port, the MAC and the address). Suggestions are never facts (ADR-0046): nothing is written until
// the person accepts, and then as one undo step. The pasted text is a parameter, never stored or sent.
//
// The table shapes read here, from vendor pages read on 2026-10-25:
// - Cisco IOS `show mac address-table`: Vlan, Mac Address, Type, Ports, rows like `100  9c54.1631.8bd1  DYNAMIC
//   Te2/1/1`, then `Total Mac Addresses for this criterion: 1` (cisco.com, "Troubleshoot MAC Address Table Manager
//   on Catalyst 9000 Switches", doc 222060). An SVI's own entry reads `STATIC Vl100`.
// - Cisco NX-OS `show mac address-table`: VLAN, MAC Address, Type, age, Secure, NTFY, Ports, a legend above and a
//   `---------+----` rule (developer.cisco.com, Nexus 3500 NX-API CLI reference, MAC address commands).
// - Junos `show ethernet-switching table` (EX, non-ELS): VLAN, MAC address, Type, Age, Interfaces, a `*` Flood row
//   to All-members and a Static row to Router (juniper.net, junos13.2 command summary "show ethernet-switching
//   table"). The ELS form (EX2300, EX4300 on newer Junos) prints two header lines; no vendor page with its sample
//   output was found on that date, so it is not read.
// - Cisco IOS `show ip arp`: Protocol, Address, Age(min), Hardware Addr, Type, Interface (cisco.com, "Using Cisco
//   IOS Software" command reference, show ip arp).
// - Junos `show arp`: MAC Address, Address, Name, Interface (and Flags under no-resolve) (juniper.net, junos13.2
//   command summary "show arp").
// - Linux `ip neigh show`: one line per neighbour in the form `ip neigh add` takes, `ADDR dev DEV lladdr LLADDR
//   STATE` (man7.org, ip-neighbour(8)); FAILED and INCOMPLETE lines carry no lladdr and say nothing.
// A MAC is accepted in the spellings these pages use: colon pairs and Cisco's dotted quads.

import { addSketchPort } from './commands';
import { foldIntoOneBatch } from './bulk';
import { connectPorts } from './cables';
import { compatible, PORT_CONNECTOR_VALUES } from './compat';
import { setDeviceField, setPortMac } from './edit';
import { BOX_W, createFreeBox } from './freeform';
import { asString, edgesIn, edgesOut, fieldValue, findNode, macAddress, parseNodeId, readPhysicalPortFields, type Document, type GraphNode } from './model';
import { portNamed } from './neighbours';
import { deviceOf } from './portTies';

export type MacFormat = 'cisco' | 'junos';

/** One learned address: the switch port it was seen on, and the VLAN when the table says. */
export interface MacRow {
  vlan: string;
  mac: string;
  port: string;
}

export interface MacTable {
  format: MacFormat;
  rows: MacRow[];
}

/** One IP-to-MAC line, with the name when the table carries one (Junos resolves names). */
export interface ArpRow {
  ip: string;
  mac: string;
  name?: string;
}

const MAC = /^(?:[0-9a-f]{2}(?::[0-9a-f]{2}){5}|[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})$/i;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]*:[0-9a-f:]*$/i;

const canonMac = (s: string): string | null => {
  if (!MAC.test(s)) return null;
  try {
    return macAddress(s) as string;
  } catch {
    return null;
  }
};

/** Words with where each starts, so a row's word is read under the header column it sits beneath. */
const wordsOf = (line: string): { text: string; at: number }[] => [...line.matchAll(/\S+/g)].map((m) => ({ text: m[0], at: m.index }));

/** The word whose start is nearest the column at `at`. */
function under(words: readonly { text: string; at: number }[], at: number): string | undefined {
  let best: { text: string; at: number } | undefined;
  for (const w of words) if (best === undefined || Math.abs(w.at - at) < Math.abs(best.at - at)) best = w;
  return best?.text;
}

interface MacHeader {
  format: MacFormat;
  vlan: number;
  port: number;
}

/** Where the VLAN and port columns start on a MAC table's header line, or null when the line is not one. */
function macHeaderOf(line: string): MacHeader | null {
  const lower = line.toLowerCase();
  const mac = lower.search(/\bmac address\b/);
  const vlan = lower.search(/\bvlan\b/);
  if (mac < 0 || vlan < 0 || vlan > mac) return null;
  const ports = lower.search(/\bports\b/);
  if (ports > mac) return { format: 'cisco', vlan, port: ports };
  const ifaces = lower.search(/\binterfaces\b/);
  if (ifaces > mac) return { format: 'junos', vlan, port: ifaces };
  return null;
}

/** What a switch learns on itself rather than on a port: its CPU, its routed VLAN interfaces, a flood entry. */
const NOT_A_PORT = /^(cpu|router|all-members|drop|sup-eth\d*|vl(an)?\d+|irb(\.\d+)?)$/i;

/** The MAC table in `text`, or null when it has none of the headers above. */
export function readMacTable(text: string): MacTable | null {
  const lines = text.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const header = macHeaderOf(lines[i]!);
    if (header === null) continue;
    const rows: MacRow[] = [];
    for (const line of lines.slice(i + 1)) {
      const words = wordsOf(line);
      const macWord = words.find((w) => MAC.test(w.text));
      if (macWord === undefined) continue;
      const mac = canonMac(macWord.text);
      const port = under(words.filter((w) => w !== macWord), header.port);
      const vlan = under(words, header.vlan) ?? '';
      if (mac === null || port === undefined || NOT_A_PORT.test(port) || !/\d/.test(port)) continue;
      rows.push({ vlan: vlan === macWord.text ? '' : vlan, mac, port });
    }
    return { format: header.format, rows };
  }
  return null;
}

/** True when pasted text reads as a MAC table with at least one row. */
export function looksLikeMacTable(text: string): boolean {
  return (readMacTable(text)?.rows.length ?? 0) > 0;
}

const isIp = (s: string): boolean => IPV4.test(s) || (IPV6.test(s) && s.includes(':') && !MAC.test(s));

/** Every IP-to-MAC line in `text`: Cisco and Junos tables by their headers, Linux `ip neigh` by its form. */
export function readArp(text: string): ArpRow[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: ArpRow[] = [];
  let nameAt: number | null = null;
  let tabular = false;
  for (const line of lines) {
    const neigh = /^\s*(\S+)\s+dev\s+\S+\s+lladdr\s+(\S+)/.exec(line);
    if (neigh) {
      const mac = canonMac(neigh[2]!);
      if (mac !== null && isIp(neigh[1]!)) out.push({ ip: neigh[1]!, mac });
      continue;
    }
    const lower = line.toLowerCase();
    if (/\bhardware addr\b/.test(lower) && /\baddress\b/.test(lower)) {
      tabular = true;
      nameAt = null;
      continue;
    }
    if (/\bmac address\b/.test(lower) && /\baddress\b/.test(lower.replace('mac address', ''))) {
      tabular = true;
      const at = lower.search(/\bname\b/);
      nameAt = at >= 0 ? at : null;
      continue;
    }
    if (!tabular) continue;
    const words = wordsOf(line);
    const macWord = words.find((w) => MAC.test(w.text));
    const ipWord = words.find((w) => isIp(w.text));
    if (macWord === undefined || ipWord === undefined) continue;
    const mac = canonMac(macWord.text);
    if (mac === null) continue;
    const row: ArpRow = { ip: ipWord.text, mac };
    if (nameAt !== null) {
      const name = under(words, nameAt);
      // Junos prints the address again when it resolves no name.
      if (name !== undefined && name !== ipWord.text && name !== macWord.text && !isIp(name)) row.name = name;
    }
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching the table to this design.

const live = (doc: Document, id: string): GraphNode | undefined => {
  const n = findNode(doc, id);
  return n && n.absentSince === undefined ? n : undefined;
};

const hostnameOf = (doc: Document, deviceId: string): string => {
  const n = live(doc, deviceId);
  return (n && asString(fieldValue(n.fields, 'Device.hostname'))) ?? '';
};

/** The device a port belongs to, through its chassis. */
function deviceOfPort(doc: Document, portId: string): string | null {
  const hp = edgesIn(doc, portId, 'HasPort')[0];
  if (!hp) return null;
  const hc = edgesIn(doc, hp.from, 'HasChassis')[0];
  return hc ? hc.from : null;
}

/** Every live port this design gives `mac`. */
function portsWithMac(doc: Document, mac: string): string[] {
  return doc.nodes.filter((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'PhysicalPort' && readPhysicalPortFields(n).mac === mac).map((n) => n.id);
}

/** Devices whose management address is `ip`. */
function devicesAt(doc: Document, ip: string): string[] {
  return doc.nodes
    .filter((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Device' && asString(fieldValue(n.fields, 'Device.management_address')) === ip)
    .map((n) => n.id);
}

function cableOn(doc: Document, portId: string): { otherPortId: string | null } | null {
  const t = edgesIn(doc, portId, 'Terminates')[0];
  if (!t) return null;
  const other = edgesOut(doc, t.from, 'Terminates').find((e) => e.to !== portId);
  return { otherPortId: other?.to ?? null };
}

/** What became of one switch port. Only `ready` rows can be ticked. */
export type HostState = 'ready' | 'cabled' | 'busy' | 'several' | 'no-port' | 'known' | 'clash';

export interface HostSuggestion {
  key: string;
  /** The switch port as the table wrote it. */
  port: string;
  vlan: string;
  macs: string[];
  localPortId: string | null;
  /** `cable`: to a port already drawn with this MAC. `new`: a sketch device that is not drawn yet. */
  kind: 'cable' | 'new';
  /** The far port, for a cable. */
  remotePortId: string | null;
  /** The far device's name: as drawn, or the name a new device would get. */
  name: string;
  ip: string | null;
  state: HostState;
  why: string | null;
}

/** A name a new device can carry (`Identifier`, printable ASCII, no spaces): the ARP name before its first dot, or
 * the address, or the MAC's last three pairs. */
function newName(mac: string, arp: ArpRow | undefined): string {
  const fromArp = arp?.name?.split('.')[0]?.replace(/[^\x21-\x7e]/g, '');
  if (fromArp) return fromArp;
  if (arp) return `host-${arp.ip.replace(/[.:]/g, '-')}`;
  return `host-${mac.split(':').slice(3).join('')}`;
}

/** Each port of the switch `id` names (a device or its chassis) with what the table learned there. */
export function suggestHosts(doc: Document, id: string, table: MacTable, arp: readonly ArpRow[] = []): HostSuggestion[] {
  const deviceId = deviceOf(doc, id);
  if (deviceId === null) return [];
  const switchName = hostnameOf(doc, deviceId) || 'This switch';
  const byMac = new Map<string, ArpRow>();
  for (const a of arp) if (!byMac.has(a.mac)) byMac.set(a.mac, a);

  const byPort = new Map<string, MacRow[]>();
  for (const row of table.rows) {
    const k = row.port.toLowerCase();
    byPort.set(k, [...(byPort.get(k) ?? []), row]);
  }
  const out: HostSuggestion[] = [];
  for (const rows of byPort.values()) {
    const port = rows[0]!.port;
    const macs = [...new Set(rows.map((r) => r.mac))];
    const vlan = rows[0]!.vlan;
    const localPortId = portNamed(doc, deviceId, port);
    const mac = macs[0]!;
    const a = byMac.get(mac);
    const base = { key: `port:${port.toLowerCase()}`, port, vlan, macs, localPortId, kind: 'new' as const, remotePortId: null, name: newName(mac, a), ip: a?.ip ?? null };
    if (localPortId === null) {
      out.push({ ...base, state: 'no-port', why: `${switchName} has no port called ${port} drawn, so it is left for you.` });
      continue;
    }
    if (macs.length > 1) {
      out.push({ ...base, state: 'several', why: `${switchName} ${port} has learned ${macs.length} addresses: another switch or an access point is probably behind it, so it is left for you.` });
      continue;
    }
    const here = cableOn(doc, localPortId);
    const known = portsWithMac(doc, mac).filter((p) => deviceOfPort(doc, p) !== deviceId);
    if (known.length > 1) {
      out.push({ ...base, state: 'known', why: `${known.length} drawn ports have the address ${mac}, so ${switchName} ${port} is left for you.` });
      continue;
    }
    if (known.length === 1) {
      const remotePortId = known[0]!;
      const remoteDevice = deviceOfPort(doc, remotePortId);
      const name = (remoteDevice !== null && hostnameOf(doc, remoteDevice)) || 'a drawn device';
      const cable = { ...base, kind: 'cable' as const, remotePortId, name, key: `${localPortId}|${remotePortId}` };
      if (here !== null && here.otherPortId === remotePortId) {
        out.push({ ...cable, state: 'cabled', why: 'Already cabled.' });
        continue;
      }
      if (here !== null) {
        out.push({ ...cable, state: 'busy', why: `${switchName} ${port} already has a cable, so it is left for you.` });
        continue;
      }
      if (cableOn(doc, remotePortId) !== null) {
        out.push({ ...cable, state: 'busy', why: `${name}'s port with ${mac} already has a cable, so it is left for you.` });
        continue;
      }
      const fit = compatible(readPhysicalPortFields(live(doc, localPortId)!).connector ?? '', readPhysicalPortFields(live(doc, remotePortId)!).connector ?? '');
      if (!fit.ok) {
        out.push({ ...cable, state: 'clash', why: `${switchName} ${port} and ${name} take different plugs, so it is left for you.` });
        continue;
      }
      out.push({ ...cable, state: 'ready', why: null });
      continue;
    }
    if (here !== null) {
      out.push({ ...base, state: 'busy', why: `${switchName} ${port} already has a cable, but nothing drawn has ${mac}; add it to the far port and read again.` });
      continue;
    }
    const at = a ? devicesAt(doc, a.ip) : [];
    if (at.length > 0) {
      const name = hostnameOf(doc, at[0]!) || a!.ip;
      out.push({ ...base, state: 'known', why: `${name} has the address ${a!.ip} but no port with ${mac}; give one of its ports that MAC and read again.` });
      continue;
    }
    out.push({ ...base, state: 'ready', why: null });
  }
  return out;
}

const LABEL = 'devices from MAC table';
const GAP = 32;

/** The ticked suggestions written as one undo step: cables to drawn ports, and for each new device a sketch box
 * pinned in a row from `origin` with one port (its MAC set) and its address, cabled to the switch port. Rows are
 * matched again against `doc`, so a port cabled since the table was read is skipped. */
export function acceptHosts(
  doc: Document,
  id: string,
  table: MacTable,
  arp: readonly ArpRow[],
  keys: ReadonlySet<string>,
  origin: { x: number; y: number },
  opts?: { actor?: string; now?: number; boxWidth?: number },
): Document {
  const from = doc.batches.length;
  let working = doc;
  let placed = 0;
  for (const s of suggestHosts(doc, id, table, arp)) {
    if (s.state !== 'ready' || !keys.has(s.key)) continue;
    if (s.kind === 'cable') {
      working = connectPorts(working, s.localPortId!, s.remotePortId!, {}, opts);
      continue;
    }
    const box = createFreeBox(working, { hostname: s.name, x: origin.x + placed * ((opts?.boxWidth ?? BOX_W) + GAP), y: origin.y, ...opts });
    working = box.doc;
    const { deviceId, chassisId } = box;
    placed += 1;
    const theirs = readPhysicalPortFields(live(working, s.localPortId!)!).connector ?? 'rj45';
    const connector = (PORT_CONNECTOR_VALUES as readonly string[]).includes(theirs) ? theirs : 'rj45';
    const before = new Set(working.nodes.map((n) => n.id));
    working = addSketchPort(working, chassisId, { label: 'LAN', connector, face: 'front' }, opts);
    const portId = working.nodes.find((n) => !before.has(n.id) && parseNodeId(n.id).kind === 'PhysicalPort')!.id;
    working = setPortMac(working, portId, s.macs[0]!, opts);
    if (s.ip !== null) working = setDeviceField(working, deviceId, 'management_address', s.ip, opts);
    working = connectPorts(working, s.localPortId!, portId, {}, opts);
  }
  return foldIntoOneBatch(working, from, LABEL);
}
