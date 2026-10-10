// "Find anything": one box that reads what you typed as a clue (a cable's label, a MAC address in any
// format, an IP or prefix, a device and port in any vendor's spelling, a serial, a rack, a name) and
// finds the things it points at. Pure; nothing here writes. Where narrows the answer, and what it
// hides is counted so the box can say so. A clue that matches nothing falls back to the nearest names.

import { parseCidr, parseIpv4, rangeOf, type PrefixRow } from '../../document/ipam';
import { prefixRows, type InvRow, type Kind } from './kinds';
import { inWhere, type PlaceIndex, type Where } from './placeIndex';

export type How = 'exact' | 'part' | 'near';

export interface Hit {
  row: InvRow;
  kind: Kind;
  how: How;
  /** One line on why it matched, in plain words. */
  why: string;
}

export interface Group {
  kind: Kind;
  label: string;
  hits: Hit[];
}

export interface Outcome {
  clue: string;
  /** What the box says it understood, e.g. `port Gi1/0/24 on core1`. Empty when there is no clue. */
  reading: string;
  groups: Group[];
  total: number;
  /** Matches that Where hides. */
  outside: number;
  /** The one thing Enter opens: exactly one match, and an exact one. */
  jump: Hit | null;
}

export interface SearchSource {
  devices: readonly InvRow[];
  ports: readonly InvRow[];
  racks: readonly InvRow[];
  cables: readonly InvRow[];
  idx: PlaceIndex;
  prefixes?: readonly PrefixRow[];
  /** The VLANs kind's rows (`vlanKindRows`). */
  vlans?: readonly InvRow[];
}

// ---------------------------------------------------------------------------
// Reading the clue

const alnum = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Interface-type words in the spellings devices and people use, folded to one letter. */
const TYPE_WORDS: ReadonlyMap<string, string> = new Map([
  ...['gigabitethernet', 'gigabit', 'gigethernet', 'gige', 'gig', 'gi', 'ge'].map((w): [string, string] => [w, 'g']),
  ...['tengigabitethernet', 'tengigabit', 'tengige', 'tengig', 'ten', 'te', 'xe'].map((w): [string, string] => [w, 'x']),
  ...['fastethernet', 'fast', 'fa'].map((w): [string, string] => [w, 'f']),
  ...['ethernet', 'eth', 'et', 'e'].map((w): [string, string] => [w, 'e']),
  ...['port', 'p'].map((w): [string, string] => [w, '']),
]);

/** `Gi1/0/1`, `ge-0/0/1` and `GigabitEthernet0/0/1` spelled the same way: type letter, then the path. */
export function portKey(label: string): { type: string; path: string } {
  const s = label.trim().toLowerCase();
  const m = /^([a-z]*)[\s\-_:]*(.*)$/.exec(s)!;
  const word = m[1]!;
  const type = TYPE_WORDS.get(word) ?? word;
  const path = m[2]!
    .replace(/[\s\-_:.]+/g, '/')
    .replace(/^\/+|\/+$/g, '');
  return { type, path };
}
const lastPart = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

// A MAC as stored in a field: colons or dashes, spaces, Cisco dots, HP/H3C `001a-2b3c-4d5e`, or bare.
const MAC_IN_TEXT = /\b[0-9a-f]{2}(?:[:\- ][0-9a-f]{2}){5}\b|\b(?:[0-9a-f]{4}[.\-]){2}[0-9a-f]{4}\b|\b[0-9a-f]{12}\b/gi;

/** Twelve hex digits from a MAC written any way (colons, dashes, Cisco dots, bare), or a start of one. */
export function macClue(text: string): { hex: string; full: boolean } | null {
  const t = text.trim();
  if (!/^[0-9a-f:.\-\s]+$/i.test(t)) return null;
  const hex = t.replace(/[^0-9a-f]/gi, '').toLowerCase();
  const sep = /[:.\-\s]/.test(t);
  if (hex.length === 12) return { hex, full: true };
  if (hex.length >= 6 && hex.length < 12) {
    // A vendor prefix written in pairs, "00:50:56", is a MAC clue even with no letter in it.
    if (/^[0-9a-f]{2}([:-][0-9a-f]{2}){2,4}$/i.test(t)) return { hex, full: false };
    // Otherwise a plain number is not read as one: it needs separators and a letter.
    if (sep && /[a-f]/.test(hex)) return { hex, full: false };
  }
  return null;
}
const prettyMac = (hex: string): string => (hex.match(/.{1,2}/g) ?? []).join(':');

/** Levenshtein distance, giving up above `limit`. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > limit) return limit + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

// ---------------------------------------------------------------------------
// The index: built once per document, so a keystroke costs a few scans of short strings

interface Named {
  row: InvRow;
  lower: string;
  norm: string;
}

export interface SearchIndex {
  src: SearchSource;
  devices: Named[];
  racks: Named[];
  cables: Named[];
  serials: Named[];
  /** Device name (lower) -> row. */
  deviceByName: Map<string, InvRow[]>;
  deviceByNode: Map<string, InvRow>;
  /** A device's ports, by device row key. */
  portsOf: Map<string, Array<{ row: InvRow; type: string; path: string }>>;
  allPorts: Array<{ row: InvRow; type: string; path: string }>;
  macs: Array<{ row: InvRow; hexes: string[] }>;
  ips: Map<number, Array<{ row: InvRow; text: string }>>;
  ipList: Array<{ row: InvRow; text: string }>;
  prefixes: Array<{ row: InvRow; p: PrefixRow }>;
  vlans: Array<{ row: InvRow; id: number; name: string }>;
}

export function buildSearchIndex(src: SearchSource): SearchIndex {
  const named = (rows: readonly InvRow[], cell: string): Named[] =>
    rows.map((row) => {
      const v = row.cells[cell] ?? '';
      return { row, lower: v.toLowerCase(), norm: alnum(v) };
    });
  const devices = named(src.devices, 'name');
  const deviceByName = new Map<string, InvRow[]>();
  const deviceByNode = new Map<string, InvRow>();
  for (const d of devices) {
    if (d.lower) deviceByName.set(d.lower, [...(deviceByName.get(d.lower) ?? []), d.row]);
    if (d.row.deviceNodeId) deviceByNode.set(d.row.deviceNodeId, d.row);
  }
  const portsOf = new Map<string, Array<{ row: InvRow; type: string; path: string }>>();
  const allPorts: Array<{ row: InvRow; type: string; path: string }> = [];
  const portHost = new Map(src.idx.ports.map((p) => [`port:${p.id}`, p.hostId]));
  const deviceByHost = new Map<string, InvRow>();
  for (const r of src.devices) if (r.ids.chassisId) deviceByHost.set(r.ids.chassisId, r);
  for (const row of src.ports) {
    const k = portKey(row.cells.name ?? '');
    const entry = { row, ...k };
    allPorts.push(entry);
    const host = deviceByHost.get(portHost.get(row.key) ?? '');
    const hostKey = host?.key ?? `name:${(row.cells.device ?? '').toLowerCase()}`;
    const list = portsOf.get(hostKey);
    if (list) list.push(entry);
    else portsOf.set(hostKey, [entry]);
  }
  const macs: SearchIndex['macs'] = [];
  for (const rows of [src.devices, src.ports, src.racks, src.cables]) {
    for (const row of rows) {
      let hexes: string[] | null = null;
      for (const [k, v] of Object.entries(row.cells)) {
        if ((k !== 'mac' && !k.startsWith('field:')) || v.length < 12) continue;
        for (const m of v.matchAll(MAC_IN_TEXT)) (hexes ??= []).push(m[0].replace(/[^0-9a-f]/gi, '').toLowerCase());
      }
      if (hexes) macs.push({ row, hexes });
    }
  }
  const ips = new Map<number, Array<{ row: InvRow; text: string }>>();
  const ipList: Array<{ row: InvRow; text: string }> = [];
  const addIp = (text: string, row: InvRow | undefined) => {
    if (!row) return;
    const n = parseIpv4(text.split('/')[0] ?? '');
    ipList.push({ row, text });
    if (n === undefined) return;
    const list = ips.get(n);
    if (list) list.push({ row, text });
    else ips.set(n, [{ row, text }]);
  };
  for (const row of src.devices) if (row.cells.mgmt) addIp(row.cells.mgmt, row);
  for (const p of src.prefixes ?? []) for (const e of p.entries) addIp(e.address, deviceByNode.get(e.deviceId));
  const prefixes = (src.prefixes ?? []).map((p) => ({ row: prefixRows([p])[0]!, p }));
  const vlans = (src.vlans ?? []).map((row) => ({ row, id: Number(row.cells.vlan), name: (row.cells.label ?? '').toLowerCase() }));
  return {
    src,
    vlans,
    devices,
    racks: named(src.racks, 'name'),
    cables: named(src.cables, 'name'),
    serials: named(src.devices, 'serial'),
    deviceByName,
    deviceByNode,
    portsOf,
    allPorts,
    macs,
    ips,
    ipList,
    prefixes,
  };
}

// ---------------------------------------------------------------------------
// Readers: each returns the hits for one reading of the clue, or null when the clue is not that shape

interface Reading {
  text: string;
  hits: Hit[];
}

const KIND_LABEL: Record<string, string> = { devices: 'Devices', ports: 'Ports', racks: 'Racks', cables: 'Cables', prefixes: 'Prefixes', vlans: 'VLANs' };
const KIND_ORDER = ['devices', 'ports', 'racks', 'cables', 'prefixes', 'vlans'];

const hit = (kind: Kind, row: InvRow, how: How, why: string): Hit => ({ kind, row, how, why });

function cableLabel(ix: SearchIndex, clue: string): Reading | null {
  const n = alnum(clue);
  if (n.length < 2) return null;
  const hits: Hit[] = [];
  for (const c of ix.cables) {
    if (c.norm === '') continue;
    if (c.norm === n) hits.push(hit('cables', c.row, 'exact', 'its label'));
    else if (n.length >= 3 && c.norm.includes(n)) hits.push(hit('cables', c.row, 'part', 'part of its label'));
  }
  if (!hits.length) return null;
  return { text: hits.some((h) => h.how === 'exact') ? `a cable label, ${clue.trim()}` : `part of a cable label, ${clue.trim()}`, hits };
}

function macAddress(ix: SearchIndex, clue: string): Reading | null {
  const m = macClue(clue);
  if (!m) return null;
  const hits: Hit[] = [];
  for (const e of ix.macs) {
    if (m.full ? e.hexes.includes(m.hex) : e.hexes.some((h) => h.startsWith(m.hex))) {
      const kind: Kind = e.row.key.startsWith('port:') ? 'ports' : e.row.key.startsWith('rack:') ? 'racks' : e.row.key.startsWith('cable:') ? 'cables' : 'devices';
      // A port says where it is plugged, so a MAC answers "which switch port is that NAS on?".
      const plugged = kind === 'ports' && e.row.cells.cable ? `; plugged into ${e.row.cells.cable}` : '';
      hits.push(hit(kind, e.row, m.full ? 'exact' : 'part', `${e.row.cells.mac?.replace(/:/g, '').startsWith(m.hex) ? 'its MAC' : 'a MAC address in its fields'}${plugged}`));
    }
  }
  return { text: m.full ? `a MAC address, ${prettyMac(m.hex)}` : `the start of a MAC address, ${prettyMac(m.hex)}`, hits };
}

/** "vlan 30", "VLAN30", "vlan cameras", a VLAN's name, or a bare number that is some VLAN's id. */
function vlanNumber(ix: SearchIndex, clue: string): Reading | null {
  if (ix.vlans.length === 0) return null;
  const t = clue.trim();
  const hits: Hit[] = [];
  const named = /^vlan[\s:_-]*(.+)$/i.exec(t);
  const rest = (named ? named[1]! : t).trim();
  if (/^\d{1,4}$/.test(rest)) {
    const id = Number(rest);
    for (const v of ix.vlans) if (v.id === id) hits.push(hit('vlans', v.row, named ? 'exact' : 'part', named ? 'its VLAN number' : 'a VLAN with that number'));
    return hits.length ? { text: `VLAN ${id}`, hits } : null;
  }
  const want = rest.toLowerCase();
  if (want.length < 3) return null;
  for (const v of ix.vlans) {
    if (v.name === '') continue;
    if (v.name === want) hits.push(hit('vlans', v.row, 'exact', 'its name'));
    else if (v.name.includes(want)) hits.push(hit('vlans', v.row, 'part', 'part of its name'));
  }
  return hits.length ? { text: `a VLAN name, ${rest}`, hits } : null;
}

function ipAddress(ix: SearchIndex, clue: string): Reading | null {
  const t = clue.trim();
  if (t.includes('/')) {
    const c = parseCidr(t);
    if (!c || c.len === 32) return null;
    const want = rangeOf(c.ip, c.len);
    const hits: Hit[] = [];
    for (const { row, p } of ix.prefixes) {
      if (!p.range) continue;
      const r = p.range;
      if (r.base === want.base && r.len === want.len) hits.push(hit('prefixes', row, 'exact', 'this network'));
      else if (r.base <= want.base && r.base + r.size >= want.base + want.size) hits.push(hit('prefixes', row, 'part', 'a network that contains it'));
      else if (want.base <= r.base && want.base + want.size >= r.base + r.size) hits.push(hit('prefixes', row, 'part', 'a network inside it'));
    }
    return { text: `a network, ${t}`, hits };
  }
  const n = parseIpv4(t);
  if (n !== undefined) {
    const hits: Hit[] = [];
    const seen = new Set<string>();
    for (const e of ix.ips.get(n) ?? []) {
      if (seen.has(e.row.key)) continue;
      seen.add(e.row.key);
      hits.push(hit('devices', e.row, 'exact', `it has ${e.text}`));
    }
    if (!hits.length) {
      // Nobody carries it: say which network it would sit in.
      let best: { row: InvRow; len: number } | null = null;
      for (const { row, p } of ix.prefixes) {
        if (p.range && n >= p.range.base && n < p.range.base + p.range.size && (!best || p.range.len > best.len)) best = { row, len: p.range.len };
      }
      if (best) hits.push(hit('prefixes', best.row, 'part', `no device has ${t}; this is the network it sits in`));
    }
    return { text: `an IP address, ${t}`, hits };
  }
  // A start of an address: "10.20.3".
  if (/^\d{1,3}(\.\d{0,3}){1,3}$/.test(t) && t.includes('.')) {
    const hits: Hit[] = [];
    const seen = new Set<string>();
    for (const e of ix.ipList) {
      if (!e.text.startsWith(t) || seen.has(e.row.key)) continue;
      seen.add(e.row.key);
      hits.push(hit('devices', e.row, 'part', `it has ${e.text}`));
    }
    return { text: `the start of an IP address, ${t}`, hits };
  }
  return null;
}

/** "core1 24", "core1 Gi1/0/24", "ge-0/0/1": a device and a port, in any vendor's spelling. */
function devicePort(ix: SearchIndex, clue: string): Reading | null {
  const tokens = clue.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const hits: Hit[] = [];
  let reading = '';
  const matchPorts = (list: ReadonlyArray<{ row: InvRow; type: string; path: string }>, portText: string, onDevice: boolean): Hit[] => {
    const want = portKey(portText);
    if (want.path === '') return [];
    const out: Hit[] = [];
    for (const p of list) {
      if (want.type !== '') {
        if (p.type === want.type && p.path === want.path) out.push(hit('ports', p.row, 'exact', onDevice ? 'the port, spelled your way' : 'a port of that name'));
      } else if (p.path === want.path) {
        out.push(hit('ports', p.row, 'exact', onDevice ? 'the port number' : 'a port of that number'));
      } else if (!want.path.includes('/') && lastPart(p.path) === want.path) {
        // "core1 24" names a device and a number: one port ending in it is the answer (two are listed).
        out.push(hit('ports', p.row, onDevice ? 'exact' : 'part', 'ends in that port number'));
      }
    }
    return out;
  };
  // Device first, port after.
  for (let i = tokens.length - 1; i >= 1; i -= 1) {
    const deviceText = tokens.slice(0, i).join(' ').toLowerCase();
    const portText = tokens.slice(i).join('');
    let devs = ix.deviceByName.get(deviceText) ?? [];
    if (!devs.length) devs = ix.devices.filter((d) => d.lower.includes(deviceText) && deviceText.length >= 2).map((d) => d.row);
    if (!devs.length) continue;
    const found: Hit[] = [];
    for (const d of devs) found.push(...matchPorts(ix.portsOf.get(d.key) ?? [], portText, true));
    if (found.length) {
      hits.push(...found);
      reading = `port ${portText} on ${devs.length === 1 ? (devs[0]!.cells.name ?? deviceText) : `devices named like ${tokens.slice(0, i).join(' ')}`}`;
      break;
    }
  }
  // A port on its own: "ge-0/0/1".
  if (!hits.length && tokens.length === 1 && /\d/.test(tokens[0]!) && /^[a-z]*[\s\-_:]*\d[\d/.\-:]*$/i.test(tokens[0]!)) {
    const found = matchPorts(ix.allPorts, tokens[0]!, false).filter((h) => h.how === 'exact' || portKey(tokens[0]!).type === '');
    if (found.length) {
      hits.push(...found);
      reading = `port ${tokens[0]} on any device`;
    }
  }
  return hits.length ? { text: reading, hits } : null;
}

function serialNumber(ix: SearchIndex, clue: string): Reading | null {
  const n = alnum(clue);
  if (n.length < 4) return null;
  const hits: Hit[] = [];
  for (const s of ix.serials) {
    if (s.norm === '') continue;
    if (s.norm === n) hits.push(hit('devices', s.row, 'exact', 'its serial number'));
    else if (s.norm.includes(n)) hits.push(hit('devices', s.row, 'part', 'part of its serial number'));
  }
  return hits.length ? { text: `a serial number, ${clue.trim()}`, hits } : null;
}

function rackName(ix: SearchIndex, clue: string): Reading | null {
  const n = alnum(clue.replace(/^\s*rack\s+/i, ''));
  if (n.length < 2) return null;
  const hits: Hit[] = [];
  for (const r of ix.racks) {
    if (r.norm === n) hits.push(hit('racks', r.row, 'exact', 'its name'));
    else if (r.norm.includes(n)) hits.push(hit('racks', r.row, 'part', 'part of its name'));
  }
  return hits.length ? { text: `a rack, ${clue.trim().replace(/^rack\s+/i, '')}`, hits } : null;
}

function deviceName(ix: SearchIndex, clue: string): Reading | null {
  const t = clue.trim().toLowerCase();
  if (t.length < 2) return null;
  const hits: Hit[] = [];
  for (const d of ix.devices) {
    if (d.lower === t) hits.push(hit('devices', d.row, 'exact', 'its name'));
    else if (d.lower.includes(t)) hits.push(hit('devices', d.row, 'part', 'part of its name'));
  }
  return hits.length ? { text: `a device name, ${clue.trim()}`, hits } : null;
}

function nearest(ix: SearchIndex, clue: string): Reading | null {
  const n = alnum(clue);
  if (n.length < 3) return null;
  const limit = Math.max(1, Math.floor(n.length / 4));
  const found: Array<{ hit: Hit; d: number }> = [];
  const consider = (list: Named[], kind: Kind, word: string) => {
    for (const c of list) {
      if (c.norm === '') continue;
      const d = distance(n, c.norm, limit);
      if (d <= limit) found.push({ d, hit: hit(kind, c.row, 'near', `close to ${word}`) });
    }
  };
  consider(ix.devices, 'devices', 'its name');
  consider(ix.racks, 'racks', 'its name');
  consider(ix.cables, 'cables', 'its label');
  found.sort((a, b) => a.d - b.d);
  const hits = found.slice(0, 8).map((f) => f.hit);
  return hits.length ? { text: `nothing exact; the nearest names to ${clue.trim()}`, hits } : null;
}

// ---------------------------------------------------------------------------

const RANK: Record<How, number> = { exact: 0, part: 1, near: 2 };

export function search(ix: SearchIndex, clue: string, where: Where): Outcome {
  const t = clue.trim();
  const empty: Outcome = { clue: t, reading: '', groups: [], total: 0, outside: 0, jump: null };
  if (t === '') return empty;
  const readers = [cableLabel, macAddress, ipAddress, vlanNumber, devicePort, serialNumber, rackName, deviceName];
  const readings: Reading[] = [];
  for (const read of readers) {
    const r = read(ix, t);
    if (r) readings.push(r);
  }
  const withHits = readings.filter((r) => r.hits.length > 0);
  let used = withHits;
  if (withHits.length === 0) {
    const near = nearest(ix, t);
    used = near ? [near] : [];
    // The clue had a recognisable shape but nothing carries it: say what it was read as.
    if (!near && readings.length) return { ...empty, reading: `${readings[0]!.text}, which nothing here has` };
    if (!near) return { ...empty, reading: 'no known kind of clue' };
  }
  // The strongest reading of each thing wins.
  const best = new Map<string, Hit>();
  for (const r of used) for (const h of r.hits) {
    const cur = best.get(h.row.key);
    if (!cur || RANK[h.how] < RANK[cur.how]) best.set(h.row.key, h);
  }
  const inside: Hit[] = [];
  let outside = 0;
  for (const h of best.values()) {
    if (inWhere(h.row.places, where)) inside.push(h);
    else outside += 1;
  }
  inside.sort((a, b) => RANK[a.how] - RANK[b.how]);
  const groups: Group[] = [];
  for (const kind of KIND_ORDER) {
    const hs = inside.filter((h) => h.kind === kind);
    if (hs.length) groups.push({ kind: kind as Kind, label: KIND_LABEL[kind]!, hits: hs });
  }
  // Enter opens the one EXACT match even with partial ones beside it; two exact (or a fragment) show the list.
  const exact = inside.filter((h) => h.how === 'exact');
  const jump = exact.length === 1 ? exact[0]! : null;
  return { clue: t, reading: used.map((r) => r.text).join(', or '), groups, total: inside.length, outside, jump };
}
