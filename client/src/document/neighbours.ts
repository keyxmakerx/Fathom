// Cable suggestions from a switch's neighbour list (LLDP; round 15, card r15-cables). A person pastes what the
// switch already knows about its neighbours, and each line naming a device and a port this design already has
// becomes a suggested cable. Suggestions are never facts (ADR-0046): nothing is written until the person accepts,
// and then only ordinary cables, through `connectPorts`, as one undo step. The pasted text is a parameter, never
// stored or sent: only the port pairs a person accepts reach the design.
//
// The table shapes read here, from vendor pages read on 2026-10-10:
// - Junos `show lldp neighbors`: Local Interface, Parent Interface, Chassis Id, Port info, System Name
//   (juniper.net, junos13.2 command summary "show lldp neighbors (EX Series)"). Port info can be the far port's
//   description rather than its name, so a row whose port matches nothing is left for the person.
// - Cisco `show lldp neighbors`: Device ID, Local Intf, Hold-time, Capability, Port ID (developer.cisco.com,
//   Nexus 3500 NX-API CLI reference, LLDP commands; study-ccna.com's IOS example shows the same columns).
// - Arista EOS `show lldp neighbors`: Port, Neighbor Device ID, Neighbor Port ID, TTL (arista.com, EOS user
//   manual, "Link Layer Discovery Protocol").
// - lldpd `lldpcli show neighbors` (Linux): blocks of `Interface: eth0, via: LLDP`, `SysName:`, `PortID: ifname
//   swp47`, `PortDescr:` (docs.nvidia.com, Cumulus Linux 4.3, "Link Layer Discovery Protocol").
// The same pages show one port written two ways (Arista's `Et3/1` beside `Ethernet3/2`; Cisco's `Eth1/2` beside
// `Ethernet1/2`), so a port name also matches when one word is the start of the other and the numbers agree.

import { foldIntoOneBatch } from './bulk';
import { connectPorts } from './cables';
import { compatible } from './compat';
import { asString, edgesIn, edgesOut, fieldValue, findNode, parseNodeId, readPhysicalPortFields, type Document, type GraphNode } from './model';
import { citedPortNameRules, deviceOf, positionOf, type PortNameRule } from './portTies';

export type NeighbourFormat = 'junos' | 'cisco' | 'arista' | 'lldpd';

/** One line of a neighbour list: this switch's port, and the device and port at the other end. */
export interface NeighbourRow {
  local: string;
  name: string;
  port: string;
}

export interface NeighbourList {
  format: NeighbourFormat;
  rows: NeighbourRow[];
}

interface Table {
  format: Exclude<NeighbourFormat, 'lldpd'>;
  /** Every column the header may carry, in order. */
  columns: readonly string[];
  /** Columns that must be present for the header to count. */
  required: readonly string[];
  local: string;
  name: string;
  port: string;
}

const TABLES: readonly Table[] = [
  {
    format: 'junos',
    columns: ['Local Interface', 'Parent Interface', 'Chassis Id', 'Port info', 'System Name'],
    required: ['Local Interface', 'Port info', 'System Name'],
    local: 'Local Interface',
    name: 'System Name',
    port: 'Port info',
  },
  {
    format: 'cisco',
    columns: ['Device ID', 'Local Intf', 'Hold-time', 'Capability', 'Port ID'],
    required: ['Device ID', 'Local Intf', 'Port ID'],
    local: 'Local Intf',
    name: 'Device ID',
    port: 'Port ID',
  },
  {
    format: 'arista',
    columns: ['Port', 'Neighbor Device ID', 'Neighbor Port ID', 'TTL'],
    required: ['Port', 'Neighbor Device ID', 'Neighbor Port ID'],
    local: 'Port',
    name: 'Neighbor Device ID',
    port: 'Neighbor Port ID',
  },
];

/** Where each column the header names starts, or null when the line is not this table's header. */
function headerOf(line: string, table: Table): { name: string; at: number }[] | null {
  const lower = line.toLowerCase();
  const found: { name: string; at: number }[] = [];
  let from = 0;
  for (const name of table.columns) {
    const at = lower.indexOf(name.toLowerCase(), from);
    if (at < 0) {
      if (table.required.includes(name)) return null;
      continue;
    }
    found.push({ name, at });
    from = at + name.length;
  }
  return found;
}

const SKIP = /^\s*(-{3,}|total entries|capability codes|\(\w\) )/i;

/** A row's cells by header column. Values without spaces line up one to a column; otherwise each word goes to the
 * column it starts under, with the row shifted when the header is indented further than its rows. */
function cellsOf(line: string, header: readonly { name: string; at: number }[]): Map<string, string> {
  const words = [...line.matchAll(/\S+/g)].map((m) => ({ text: m[0], at: m.index }));
  const cells = new Map<string, string>();
  if (words.length === header.length) {
    header.forEach((h, i) => cells.set(h.name, words[i]!.text));
    return cells;
  }
  const shift = words.length > 0 ? Math.max(0, header[0]!.at - words[0]!.at) : 0;
  for (const w of words) {
    let col = 0;
    for (let i = 0; i < header.length; i += 1) if (header[i]!.at <= w.at + shift + 2) col = i;
    const name = header[col]!.name;
    const had = cells.get(name);
    cells.set(name, had === undefined ? w.text : `${had} ${w.text}`);
  }
  return cells;
}

/** An interface name has a digit in it; a legend line or a stray word does not. */
const looksLikePort = (s: string): boolean => /\d/.test(s);

function readTable(lines: readonly string[]): NeighbourList | null {
  for (let i = 0; i < lines.length; i += 1) {
    for (const table of TABLES) {
      const header = headerOf(lines[i]!, table);
      if (header === null) continue;
      const rows: NeighbourRow[] = [];
      for (const line of lines.slice(i + 1)) {
        if (line.trim() === '' || SKIP.test(line)) continue;
        const cells = cellsOf(line, header);
        const local = cells.get(table.local) ?? '';
        const name = cells.get(table.name) ?? '';
        const port = cells.get(table.port) ?? '';
        if (!looksLikePort(local) || name === '' || port === '' || name === '-') continue;
        rows.push({ local, name, port });
      }
      return { format: table.format, rows };
    }
  }
  return null;
}

const LLDPD_INTERFACE = /^\s*Interface:\s*([^,\s]+)\s*,/;

/** lldpd's plain blocks. A PortID that is a MAC address names no port, so the description stands in for it. */
function readLldpd(lines: readonly string[]): NeighbourList | null {
  if (!lines.some((l) => LLDPD_INTERFACE.test(l))) return null;
  const rows: NeighbourRow[] = [];
  let cur: { local: string; name: string; id: string; idKind: string; descr: string } | null = null;
  const flush = () => {
    if (cur === null) return;
    const port = cur.idKind === 'mac' ? cur.descr : cur.id;
    if (cur.name !== '' && port !== '') rows.push({ local: cur.local, name: cur.name, port });
    cur = null;
  };
  for (const line of lines) {
    const iface = LLDPD_INTERFACE.exec(line);
    if (iface) {
      flush();
      cur = { local: iface[1]!, name: '', id: '', idKind: '', descr: '' };
      continue;
    }
    if (cur === null) continue;
    const field = /^\s*(SysName|PortID|PortDescr):\s*(.*?)\s*$/.exec(line);
    if (!field) continue;
    const value = field[2]!;
    const c: { name: string; id: string; idKind: string; descr: string } = cur;
    if (field[1] === 'SysName' && c.name === '') c.name = value;
    else if (field[1] === 'PortDescr' && c.descr === '') c.descr = value;
    else if (field[1] === 'PortID' && c.id === '') {
      const m = /^(\w+)\s+(.+)$/.exec(value);
      c.idKind = m ? m[1]!.toLowerCase() : '';
      c.id = m ? m[2]! : value;
    }
  }
  flush();
  return { format: 'lldpd', rows };
}

/** The neighbour list in `text`, or null when it is not one of the shapes above. */
export function readNeighbours(text: string): NeighbourList | null {
  const lines = text.replace(/\r/g, '').split('\n');
  return readLldpd(lines) ?? readTable(lines);
}

/** True when pasted text reads as a neighbour list with at least one row: the canvas then offers suggestions
 * instead of reading it as a config. */
export function looksLikeNeighbours(text: string): boolean {
  return (readNeighbours(text)?.rows.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Matching rows to this design.

const live = (doc: Document, id: string): GraphNode | undefined => {
  const n = findNode(doc, id);
  return n && n.absentSince === undefined ? n : undefined;
};

const hostnameOf = (doc: Document, deviceId: string): string => {
  const n = live(doc, deviceId);
  return (n && asString(fieldValue(n.fields, 'Device.hostname'))) ?? '';
};

const short = (name: string): string => name.trim().toLowerCase().split('.')[0]!;

/** The one live device named `name`: the whole name first, then the name before its first dot on both sides
 * (`ap-lobby.example.net` is `ap-lobby`). Null when none, or more than one, matches. */
export function deviceNamed(doc: Document, name: string): string | null {
  const devices = doc.nodes.filter((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Device');
  const want = name.trim().toLowerCase();
  const exact = devices.filter((d) => (asString(fieldValue(d.fields, 'Device.hostname')) ?? '').trim().toLowerCase() === want);
  if (exact.length === 1) return exact[0]!.id;
  if (exact.length > 1) return null;
  const s = short(name);
  const near = devices.filter((d) => {
    const h = asString(fieldValue(d.fields, 'Device.hostname'));
    return h !== undefined && h.trim() !== '' && short(h) === s;
  });
  return near.length === 1 ? near[0]!.id : null;
}

/** Every live data port on the device's chassis. */
function dataPorts(doc: Document, deviceId: string): GraphNode[] {
  const out: GraphNode[] = [];
  for (const hc of edgesOut(doc, deviceId, 'HasChassis')) {
    for (const hp of edgesOut(doc, hc.to, 'HasPort')) {
      const p = live(doc, hp.to);
      if (p && readPhysicalPortFields(p).service !== 'power') out.push(p);
    }
  }
  return out;
}

/** A port name as compared: no case, no surrounding space, no logical unit (`xe-3/0/4.0` is `xe-3/0/4`). */
const fold = (name: string): string => name.trim().toLowerCase().replace(/\.\d+$/, '');

/** True when one name is the other written short: the same numbers after a word that starts the other's word. */
function sameWrittenShort(a: string, b: string): boolean {
  const ma = /^([a-z]+)(\d.*)$/.exec(a);
  const mb = /^([a-z]+)(\d.*)$/.exec(b);
  if (!ma || !mb || ma[2] !== mb[2]) return false;
  const [x, y] = ma[1]!.length <= mb[1]!.length ? [ma[1]!, mb[1]!] : [mb[1]!, ma[1]!];
  return x.length >= 2 && y.startsWith(x);
}

/** The names a port answers to: its own label, and the name of any interface tied to it. */
function namesOf(doc: Document, port: GraphNode): string[] {
  const names: string[] = [];
  const label = readPhysicalPortFields(port).label;
  if (label !== undefined && label.trim() !== '') names.push(fold(label));
  for (const e of edgesIn(doc, port.id, 'Occupies')) {
    const iface = live(doc, e.from);
    const name = iface ? asString(fieldValue(iface.fields, 'Interface.name')) : undefined;
    if (name !== undefined) names.push(fold(name));
  }
  return names;
}

function portPosition(port: GraphNode): { slot?: number; subslot?: number; index: number } | null {
  const v = fieldValue(port.fields, 'PhysicalPort.position');
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const num = (x: unknown): number | undefined => (typeof x === 'number' ? x : undefined);
  const index = num(o.index);
  return index === undefined ? null : { slot: num(o.slot), subslot: num(o.subslot), index };
}

/** The one port of `deviceId` that `name` names: by label or tied interface, then written short, then by a cited
 * port-name rule's position. Null when none or several do: a guess would be the invented fact ADR-0046 forbids. */
export function portNamed(doc: Document, deviceId: string, name: string, rules: readonly PortNameRule[] = citedPortNameRules()): string | null {
  const want = fold(name);
  if (want === '') return null;
  const ports = dataPorts(doc, deviceId);
  const named = ports.map((p) => ({ id: p.id, names: namesOf(doc, p) }));
  const exact = named.filter((p) => p.names.includes(want));
  if (exact.length > 0) return exact.length === 1 ? exact[0]!.id : null;
  const shortHits = named.filter((p) => p.names.some((n) => sameWrittenShort(n, want)));
  if (shortHits.length > 0) return shortHits.length === 1 ? shortHits[0]!.id : null;
  const device = live(doc, deviceId);
  const platform = device ? (asString(fieldValue(device.fields, 'Device.platform')) ?? null) : null;
  const pos = positionOf(name.trim().replace(/\.\d+$/, ''), platform, rules);
  if (pos === null) return null;
  const at = ports.filter((p) => {
    const q = portPosition(p);
    return q !== null && q.index === pos.index && q.slot === pos.slot && q.subslot === pos.subslot;
  });
  return at.length === 1 ? at[0]!.id : null;
}

/** What became of one row. Only `ready` rows can be ticked. */
export type SuggestionState = 'ready' | 'cabled' | 'busy' | 'several' | 'no-device' | 'no-port' | 'clash';

export interface CableSuggestion {
  /** Stable across edits while both ports stand: the pair of ports, else the row's own words. */
  key: string;
  row: NeighbourRow;
  localName: string;
  /** The far device's name as this design has it, or as the list wrote it when it is not here. */
  remoteName: string;
  localPortId: string | null;
  remotePortId: string | null;
  remoteDeviceId: string | null;
  state: SuggestionState;
  /** Why it is left for the person, as a sentence; null when ready. */
  why: string | null;
}

/** The cable on a port, if any, and the port at its other end. */
function cableOn(doc: Document, portId: string): { cableId: string; otherPortId: string | null } | null {
  const t = edgesIn(doc, portId, 'Terminates')[0];
  if (!t) return null;
  const other = edgesOut(doc, t.from, 'Terminates').find((e) => e.to !== portId);
  return { cableId: t.from, otherPortId: other?.to ?? null };
}

/** Each row of `list` matched against the design, from the device `id` names (a device or its chassis). */
export function suggestCables(doc: Document, id: string, list: NeighbourList, rules: readonly PortNameRule[] = citedPortNameRules()): CableSuggestion[] {
  const deviceId = deviceOf(doc, id);
  if (deviceId === null) return [];
  const localName = hostnameOf(doc, deviceId) || 'This device';
  // A line naming the switch itself (a loop, or a list read on the wrong device) suggests nothing.
  const rows = list.rows.map((row, i) => ({ row, i, found: deviceNamed(doc, row.name) })).filter((r) => r.found !== deviceId);
  const out: CableSuggestion[] = rows.map(({ row, i, found: remoteDeviceId }) => {
    const localPortId = portNamed(doc, deviceId, row.local, rules);
    const remoteName = remoteDeviceId !== null ? hostnameOf(doc, remoteDeviceId) || row.name : row.name;
    const remotePortId = remoteDeviceId !== null ? portNamed(doc, remoteDeviceId, row.port, rules) : null;
    const base = { key: localPortId !== null && remotePortId !== null ? `${localPortId}|${remotePortId}` : `row:${i}:${row.local}`, row, localName, remoteName, localPortId, remotePortId, remoteDeviceId };
    if (remoteDeviceId === null) return { ...base, state: 'no-device', why: `${row.name} is not in this design yet, so its cable is left for you.` };
    if (localPortId === null) return { ...base, state: 'no-port', why: `${localName} has no port called ${row.local} drawn, so it is left for you.` };
    if (remotePortId === null) return { ...base, state: 'no-port', why: `${remoteName} has no port called ${row.port} drawn, so it is left for you.` };
    const here = cableOn(doc, localPortId);
    if (here !== null && here.otherPortId === remotePortId) return { ...base, state: 'cabled', why: 'Already cabled.' };
    if (here !== null) return { ...base, state: 'busy', why: `${localName} ${row.local} already has a cable, so it is left for you.` };
    if (cableOn(doc, remotePortId) !== null) return { ...base, state: 'busy', why: `${remoteName} ${row.port} already has a cable, so it is left for you.` };
    const a = live(doc, localPortId)!;
    const b = live(doc, remotePortId)!;
    const fit = compatible(readPhysicalPortFields(a).connector ?? '', readPhysicalPortFields(b).connector ?? '');
    if (!fit.ok) return { ...base, state: 'clash', why: `${localName} ${row.local} and ${remoteName} ${row.port} take different plugs, so it is left for you.` };
    return { ...base, state: 'ready', why: null };
  });
  // Two rows on one port (a hub or a phone with a PC behind it) say nothing certain about either cable.
  const uses = new Map<string, number>();
  for (const s of out) {
    if (s.state !== 'ready') continue;
    for (const p of [s.localPortId!, s.remotePortId!]) uses.set(p, (uses.get(p) ?? 0) + 1);
  }
  return out.map((s) =>
    s.state === 'ready' && ((uses.get(s.localPortId!) ?? 0) > 1 || (uses.get(s.remotePortId!) ?? 0) > 1)
      ? { ...s, state: 'several', why: `More than one neighbour is listed on ${s.localName} ${s.row.local}, so it is left for you.` }
      : s,
  );
}

const LABEL = 'cables from neighbours';

/** The ticked suggestions as cables, one undo step. Rows are matched again against `doc`, so a port cabled since
 * the list was read is skipped, never doubled. Throws only what `connectPorts` refuses. */
export function acceptSuggestions(doc: Document, id: string, list: NeighbourList, keys: ReadonlySet<string>, opts?: { actor?: string; now?: number }): Document {
  const from = doc.batches.length;
  let working = doc;
  for (const s of suggestCables(doc, id, list)) {
    if (s.state !== 'ready' || !keys.has(s.key)) continue;
    working = connectPorts(working, s.localPortId!, s.remotePortId!, {}, opts);
  }
  const folded = foldIntoOneBatch(working, from, LABEL);
  // One cable is one batch already; it carries the same name as many.
  const last = folded.batches.length === from + 1 ? folded.batches[from]! : null;
  return last === null || last.label === LABEL ? folded : { ...folded, batches: [...folded.batches.slice(0, from), { ...last, label: LABEL }] };
}
