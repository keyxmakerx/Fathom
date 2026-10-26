// What a device says about itself (round 29, card r29-fill): its serial, its running version and its model, read from
// `show version`, `show inventory` or `show chassis hardware`. A drawn device is offered the serial and version it
// lacks, and told where the drawing differs; a difference is offered unticked, so the drawing wins until the person
// says otherwise (ADR-0046). The model is never changed here: a different model is a swap, which keeps ports by its
// own rules. The pasted text is a parameter, never stored or sent.
//
// The output shapes read here, read on 2026-10-25:
// - Junos `show version`: `Hostname: router1`, `Model: m20`, and the version in brackets on `JUNOS Base OS Software
//   Suite [7.2-20050312.0]` (juniper.net, junos13.1 command summary "show version"); newer releases print
//   `Junos: 14.1X53-D49` (community.juniper.net, "extract juniper info hostname model version etc via python
//   netmiko", quoting `Hostname:R2Model:qfx5100-48s-6qJunos:14.1X53-D49`).
// - Junos `show chassis hardware`: `Hardware inventory:`, the column line `Item Version Part number Serial number
//   Description`, then `Chassis ZF4320340016 EX4400-48MP` (juniper.net, CLI reference "show chassis hardware", EX4400
//   sample).
// - Cisco IOS `show version`: `Cisco IOS Software [Bengaluru], Catalyst L3 Switch Software (CAT9K_IOSXE), Version
//   17.6.4, RELEASE SOFTWARE (fc1)` (and the older `Cisco IOS (tm) C3750 Software (...), Version 12.1(14)EA1,`), and
//   `System Serial Number : FJC2325E0HB` (cisco.com, "Find the serial number of Catalyst switches", doc 41361).
// - Cisco `show inventory`: `NAME: "Chassis", DESCR: "..."` then `PID: N3K-C3548P-10GX , VID: V00 , SN: FOC1847R05N`
//   (developer.cisco.com, Nexus 3500 NX-API CLI reference, inventory commands).
// - The parts in those two (r35, read on 2026-10-26). Junos rows under the column line: `FPC 0 REV 60 750-070395
//   EAAT9462 MPC10E 3D MRATE-15xQSFPP`, `PIC 0 BUILTIN BUILTIN MRATE-5xQSFPP`, `Xcvr 4 REV 01 740-157132 2E1CZFA728016
//   QSFP56-DD-400G-ZR`, `PEM 0 Rev 02 740-063046 QCS2207U0AJ PS 1.4-2.52kW; 90-264V AC in` (juniper.net, CLI reference
//   "show chassis hardware", MX960 sample). Cisco entries: `NAME: "TenGigabitEthernet1/1/1", DESCR: "10Gbase-SR SFP
//   Module"` / `PID: SFP-10G-SR , VID: V02 , SN: AVP19230XYZ` (layer23-switch.com, "How to check SFP type");
//   `NAME: "Switch 2 - Power Supply A"` / `PID: PWR-C6-1KWAC`, `NAME: "Switch 2 FRU Uplink Module 1", DESCR: "4x10G
//   Uplink Module"`, `NAME: "Te2/1/1", DESCR: "SFP-10GBase-SR"`, and a third-party optic with an empty PID: `PID:      ,
//   VID:    , SN: OSSX06400` (community.cisco.com, "SFP transceiver module not detected stacked switch 3850", a
//   C9200-48P `show inventory`).
// - Arista EOS `show version`: `Arista DCS-7280SR-48C6-M-F`, `Serial number: SSJ17290598`, `Software image version:
//   4.19.5M` (O'Reilly, Arista Warrior 2nd ed., chapter 10 "Upgrading EOS").

import { foldIntoOneBatch } from './bulk';
import { cardsOf, fitCard, opticOf, setCardField, setOptic, type CardView, type Optic } from './cards';
import { setChassisField, setDeviceField } from './edit';
import { asString, edgesOut, fieldValue, findNode, readChassisFields, readPhysicalPortFields, readPowerSupplyFields, type Document } from './model';
import { setSupplyField } from './supplies';
import { deviceOf } from './portTies';

export type FactsVendor = 'junos' | 'cisco' | 'arista';

export interface DeviceFacts {
  vendor: FactsVendor;
  hostname?: string;
  model?: string;
  serial?: string;
  version?: string;
  /** Cards, optics and power supplies the output lists (r35). */
  parts?: PartFact[];
}

/** One part a device reports. A card's `path` is its slot and each sub-slot under it ("FPC 0", "PIC 1" gives
 * ["0", "1"]); an optic's `port` is the numbers of its port ("xe-0/1/2" and "Te0/1/2" both give "0/1/2"); a power
 * supply's `slot` is what follows its name ("PEM 0" gives "0", "Power Supply A" gives "A"). */
export interface PartFact {
  kind: 'card' | 'optic' | 'supply';
  path?: string[];
  port?: string;
  slot?: string;
  /** What the device calls it: "FPC 0", "TenGigabitEthernet1/1/1". */
  name: string;
  model?: string;
  serial?: string;
  description?: string;
}

const usable = (s: string | undefined): string | undefined => {
  const t = s?.trim();
  return t && t.toUpperCase() !== 'BUILTIN' && /^[\x21-\x7e]+$/.test(t) ? t : undefined;
};

/** The numbers at the end of an interface name, "1/1/1" from "TenGigabitEthernet1/1/1"; null when it is not one. */
export function portNumbers(name: string): string | null {
  const m = /(\d+(?:\/\d+)+)$/.exec(name.trim());
  return m ? m[1]! : null;
}

function junosParts(text: string): PartFact[] {
  const head = /^\s*Item\s+Version\s+Part number\s+Serial number\s+Description[^\n]*$/m.exec(text);
  if (!head) return [];
  const out: PartFact[] = [];
  let fpc: string | null = null;
  let mic: string | null = null;
  let pic: string | null = null;
  for (const line of text.slice(head.index + head[0].length).split('\n')) {
    const m = /^\s*(FPC|MIC|PIC|Xcvr|PEM|Power Supply)\s+(\d+)\b\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, item, n, restText] = m as unknown as [string, string, string, string];
    const tokens = restText.trim().split(/\s+/).filter(Boolean);
    let i = /^rev$/i.test(tokens[0] ?? '') ? 2 : 0;
    if (tokens[i] === undefined) i = tokens.length;
    const part = usable(tokens[i]);
    const serial = usable(tokens[i + 1]);
    const description = tokens.slice(i + 2).join(' ') || undefined;
    const name = `${item} ${n}`;
    const base = { name, ...(part ? { model: part } : {}), ...(serial ? { serial } : {}), ...(description ? { description } : {}) };
    if (item === 'FPC') {
      fpc = n;
      mic = null;
      pic = null;
      out.push({ kind: 'card', path: [n], ...base });
    } else if (item === 'MIC' && fpc !== null) {
      mic = n;
      pic = null;
      out.push({ kind: 'card', path: [fpc, n], ...base });
    } else if (item === 'PIC' && fpc !== null) {
      pic = n;
      // A built-in PIC, or one inside a MIC, is not a part anyone fits.
      if (part && mic === null) out.push({ kind: 'card', path: [fpc, n], ...base });
    } else if (item === 'Xcvr' && fpc !== null && pic !== null) {
      out.push({ kind: 'optic', port: `${fpc}/${pic}/${n}`, ...base });
    } else if (item === 'PEM' || item === 'Power Supply') {
      out.push({ kind: 'supply', slot: n, ...base });
    }
  }
  return out;
}

interface CiscoEntry {
  name: string;
  descr: string;
  pid?: string;
  sn?: string;
}

function ciscoEntries(text: string): CiscoEntry[] {
  const out: CiscoEntry[] = [];
  for (const m of text.matchAll(/NAME:\s*"([^"]*)"\s*,\s*DESCR:\s*"([^"]*)"[^\n]*\n\s*PID:([^,\n]*),[^\n]*?SN:([^\n,]*)/g)) {
    const e: CiscoEntry = { name: m[1]!.trim(), descr: m[2]!.trim() };
    const pid = usable(m[3]);
    const sn = usable(m[4]);
    if (pid) e.pid = pid;
    if (sn) e.sn = sn;
    out.push(e);
  }
  return out;
}

function ciscoPart(e: CiscoEntry): PartFact | null {
  const base = { name: e.name, ...(e.pid ? { model: e.pid } : {}), ...(e.sn ? { serial: e.sn } : {}), ...(e.descr ? { description: e.descr } : {}) };
  const supply = /power supply\s*(\S+)?\s*$/i.exec(e.name);
  if (supply || /^PWR-/i.test(e.pid ?? '')) return { kind: 'supply', ...(supply?.[1] ? { slot: supply[1] } : {}), ...base };
  const port = /^[A-Za-z][A-Za-z-]*\s*\d+(?:\/\d+)+$/.test(e.name) ? portNumbers(e.name) : null;
  if (port) return { kind: 'optic', port, ...base };
  if (/fan|chassis|stack|backplane/i.test(e.name)) return null;
  const slot = /(?:module|line ?card|slot)\D*(\d+)\)?\s*$/i.exec(e.name);
  if (slot) return { kind: 'card', path: [slot[1]!], ...base };
  return null;
}

const first = (re: RegExp, text: string): string | undefined => {
  const m = re.exec(text);
  return m?.[1]?.trim() || undefined;
};

function readJunos(text: string): DeviceFacts | null {
  const hostname = first(/^\s*Hostname:\s*(\S+)/m, text);
  const model = first(/^\s*Model:\s*(\S+)/m, text);
  const version = first(/^\s*Junos:\s*(\S+)/m, text) ?? first(/^\s*JUNOS Base OS Software Suite \[([^\]\s]+)\]/m, text);
  // `show chassis hardware`: the Chassis row under its column line carries the serial and the model.
  let serial: string | undefined;
  let hwModel: string | undefined;
  if (/^\s*Item\s+Version\s+Part number\s+Serial number\s+Description/m.test(text)) {
    const row = /^\s*Chassis\s+(\S+)\s+(\S+)/m.exec(text);
    if (row) {
      serial = row[1];
      hwModel = row[2];
    }
  }
  const facts: DeviceFacts = { vendor: 'junos' };
  if (hostname !== undefined && model !== undefined) facts.hostname = hostname;
  if (model !== undefined && (hostname !== undefined || version !== undefined)) facts.model = model;
  else if (hwModel !== undefined) facts.model = hwModel;
  if (serial !== undefined) facts.serial = serial;
  if (version !== undefined && (model !== undefined || hostname !== undefined)) facts.version = version;
  const parts = junosParts(text);
  if (parts.length > 0) facts.parts = parts;
  return facts.model !== undefined || facts.serial !== undefined || facts.version !== undefined || parts.length > 0 ? facts : null;
}

function readCisco(text: string): DeviceFacts | null {
  const version = first(/^\s*Cisco IOS[^\n]*?Software[^\n]*?, Version ([^,\s]+)/m, text);
  // `show inventory`: the chassis entry, else the first one that is not a part.
  const entries = ciscoEntries(text);
  const parts: PartFact[] = [];
  const unparted: CiscoEntry[] = [];
  for (const e of entries) {
    const p = /chassis/i.test(e.name) ? null : ciscoPart(e);
    if (p) parts.push(p);
    else unparted.push(e);
  }
  const chassis = unparted.find((e) => /chassis/i.test(e.name)) ?? unparted[0];
  const serial = first(/^\s*System Serial Number\s*:\s*(\S+)/im, text) ?? chassis?.sn;
  const facts: DeviceFacts = { vendor: 'cisco' };
  if (version !== undefined) facts.version = version;
  if (serial !== undefined) facts.serial = serial;
  if (chassis?.pid !== undefined) facts.model = chassis.pid;
  if (parts.length > 0) facts.parts = parts;
  return facts.model !== undefined || facts.serial !== undefined || facts.version !== undefined || parts.length > 0 ? facts : null;
}

function readArista(text: string): DeviceFacts | null {
  const version = first(/^\s*Software image version:\s*(\S+)/m, text);
  if (version === undefined) return null;
  const facts: DeviceFacts = { vendor: 'arista', version };
  const model = first(/^\s*Arista\s+(\S+)/m, text);
  const serial = first(/^\s*Serial number:\s*(\S+)/m, text);
  if (model !== undefined) facts.model = model;
  if (serial !== undefined) facts.serial = serial;
  return facts;
}

/** The facts in `text`, or null when it reads as none of the outputs above. */
export function readFacts(text: string): DeviceFacts | null {
  const t = text.replace(/\r/g, '');
  return readArista(t) ?? readCisco(t) ?? readJunos(t);
}

/** True when pasted text reads as a device's own report on itself: the canvas then offers its facts. */
export const looksLikeFacts = (text: string): boolean => readFacts(text) !== null;

// ---------------------------------------------------------------------------

export type FactKey = 'serial' | 'version' | 'model' | 'hostname' | `part:${number}`;

/** `fill`: the drawing has none, ticked. `differs`: offered unticked. `same`: nothing to do. `note`: said, never
 * written (the model, and a hostname, which is the drawing's name for the device). */
export type FactState = 'fill' | 'differs' | 'same' | 'note';

export interface FactSuggestion {
  key: FactKey;
  label: string;
  theirs: string;
  ours: string | null;
  state: FactState;
  why: string | null;
  /** For a part's row: the part, and the drawn thing it lands on (a card, a supply, a port); null for a card not yet drawn. */
  part?: { fact: PartFact; targetId: string | null };
}

const fold = (s: string): string => s.trim().toLowerCase();

/** What `facts` would change on the device `id` names (a device or its chassis). */
export function suggestFacts(doc: Document, id: string, facts: DeviceFacts): FactSuggestion[] {
  const deviceId = deviceOf(doc, id);
  const device = deviceId !== null ? findNode(doc, deviceId) : undefined;
  if (deviceId === null || device === undefined) return [];
  const chassisId = edgesOut(doc, deviceId, 'HasChassis')[0]?.to;
  const chassis = chassisId !== undefined ? findNode(doc, chassisId) : undefined;
  const cf = chassis ? readChassisFields(chassis) : {};
  const out: FactSuggestion[] = [];
  const writable = (key: 'serial' | 'version', label: string, theirs: string | undefined, ours: string | undefined) => {
    if (theirs === undefined) return;
    if (ours === undefined || ours.trim() === '') out.push({ key, label, theirs, ours: null, state: 'fill', why: null });
    else if (ours.trim() === theirs) out.push({ key, label, theirs, ours, state: 'same', why: null });
    else out.push({ key, label, theirs, ours, state: 'differs', why: `The device says ${theirs}; the drawing has ${ours}. Tick it to take the device's.` });
  };
  if (chassisId !== undefined) writable('serial', 'Serial', facts.serial, cf.serial);
  writable('version', 'Running version', facts.version, asString(fieldValue(device.fields, 'Device.os_version')));
  if (facts.model !== undefined) {
    const ours = cf.model;
    if (ours === undefined) out.push({ key: 'model', label: 'Model', theirs: facts.model, ours: null, state: 'note', why: `The device says it is a ${facts.model}. Give the box that model from its details to get its faceplate.` });
    else if (fold(ours) === fold(facts.model)) out.push({ key: 'model', label: 'Model', theirs: facts.model, ours, state: 'same', why: null });
    else out.push({ key: 'model', label: 'Model', theirs: facts.model, ours, state: 'note', why: `The device says it is a ${facts.model}, but it is drawn as ${ours}. Swap its model if the drawing is wrong.` });
  }
  if (facts.hostname !== undefined) {
    const ours = asString(fieldValue(device.fields, 'Device.hostname'));
    if (ours !== undefined && fold(ours) !== fold(facts.hostname)) out.push({ key: 'hostname', label: 'Hostname', theirs: facts.hostname, ours, state: 'note', why: `The device calls itself ${facts.hostname}; it is drawn as ${ours}. Check this is the right device.` });
  }
  if (chassisId !== undefined) (facts.parts ?? []).forEach((fact, i) => out.push(partSuggestion(doc, chassisId, fact, `part:${i}`)));
  return out;
}

const partWords = (f: PartFact): string => [f.model, f.serial ? `serial ${f.serial}` : undefined].filter(Boolean).join(' · ') || f.description || f.name;

/** The drawn card at `path` under the chassis, or undefined. */
function cardAt(doc: Document, chassisId: string, path: readonly string[]): CardView | undefined {
  let level = cardsOf(doc, chassisId);
  let found: CardView | undefined;
  for (const slot of path) {
    found = level.find((c) => c.slot === slot);
    if (!found) return undefined;
    level = found.cards;
  }
  return found;
}

/** The chassis port whose label ends in `numbers`, when exactly one does. */
function portAt(doc: Document, chassisId: string, numbers: string): string | null {
  const hits = edgesOut(doc, chassisId, 'HasPort').filter((e) => {
    const n = findNode(doc, e.to);
    const label = n && n.absentSince === undefined ? readPhysicalPortFields(n).label : undefined;
    return label !== undefined && portNumbers(label) === numbers;
  });
  return hits.length === 1 ? hits[0]!.to : null;
}

function partSuggestion(doc: Document, chassisId: string, fact: PartFact, key: `part:${number}`): FactSuggestion {
  const theirs = partWords(fact);
  const row = (label: string, ours: string | null, state: FactState, why: string | null, targetId: string | null): FactSuggestion => ({
    key,
    label,
    theirs,
    ours,
    state,
    why,
    part: { fact, targetId },
  });
  const compare = (label: string, ours: { model?: string | null; serial?: string | null }, targetId: string): FactSuggestion => {
    const oursText = [ours.model, ours.serial ? `serial ${ours.serial}` : undefined].filter(Boolean).join(' · ') || null;
    if (fact.serial === undefined || ours.serial === fact.serial) {
      const missingModel = fact.model !== undefined && !ours.model;
      return missingModel ? row(label, oursText, 'fill', null, targetId) : row(label, oursText, 'same', null, targetId);
    }
    if (!ours.serial) return row(label, oursText, 'fill', null, targetId);
    return row(label, oursText, 'differs', `${label}: the device says serial ${fact.serial}; the drawing has ${ours.serial}. Tick it if the part was swapped.`, targetId);
  };
  if (fact.kind === 'card') {
    const path = fact.path ?? [];
    const label = `Card in ${path.map((p, i) => (i === 0 ? `slot ${p}` : `sub-slot ${p}`)).join(' · ')}`;
    const drawn = cardAt(doc, chassisId, path);
    if (drawn) return compare(label, drawn, drawn.id);
    return row(label, null, 'differs', `${label} (${fact.name}) is not drawn. Tick it to fit it; its ports are added from its panel.`, null);
  }
  if (fact.kind === 'optic') {
    const label = `Optic in ${fact.name}`;
    const portId = fact.port ? portAt(doc, chassisId, fact.port) : null;
    if (portId === null) return row(label, null, 'note', `The device has an optic in ${fact.name}, but no drawn port matches it.`, null);
    const optic = opticOf(findNode(doc, portId)!);
    if (!optic) return row(label, null, 'fill', null, portId);
    return compare(label, { model: optic.part ?? null, serial: optic.serial ?? null }, portId);
  }
  const label = `Power supply ${fact.slot ?? ''}`.trim();
  const supplyId = edgesOut(doc, chassisId, 'FittedIn').find((e) => {
    const n = findNode(doc, e.to);
    const slot = n && n.absentSince === undefined ? readPowerSupplyFields(n).slot : undefined;
    return slot !== undefined && fact.slot !== undefined && (fold(slot) === fold(fact.slot) || slot.match(/(\w+)$/)?.[1]?.toLowerCase() === fold(fact.slot));
  })?.to;
  if (supplyId === undefined) return row(label, null, 'note', `The device reports ${label.toLowerCase()} (${theirs}), but no fitted supply in that slot is drawn.`, null);
  const f = readPowerSupplyFields(findNode(doc, supplyId)!);
  return compare(label, { model: f.model ?? null, serial: f.serial ?? null }, supplyId);
}

/** Writes one part's row. A card not drawn is fitted (its parent must be drawn by now); a drawn one takes the serial
 * and any model it lacks. */
function writePart(doc: Document, chassisId: string, s: FactSuggestion, opts?: { actor?: string; now?: number }): Document {
  const { fact, targetId } = s.part!;
  if (fact.kind === 'card') {
    if (targetId === null) {
      const path = fact.path ?? [];
      const host = path.length === 1 ? chassisId : cardAt(doc, chassisId, path.slice(0, -1))?.id;
      if (host === undefined) return doc;
      return fitCard(doc, host, path.at(-1)!, { ...(fact.description ? { name: fact.description } : {}), ...(fact.model ? { model: fact.model } : {}), ...(fact.serial ? { serial: fact.serial } : {}) }, opts);
    }
    let working = doc;
    const card = cardAt(doc, chassisId, fact.path ?? []);
    if (fact.serial !== undefined) working = setCardField(working, targetId, 'serial', fact.serial, opts);
    if (fact.model !== undefined && !card?.model) working = setCardField(working, targetId, 'model', fact.model, opts);
    return working;
  }
  if (targetId === null) return doc;
  if (fact.kind === 'optic') {
    const had = opticOf(findNode(doc, targetId)!) ?? {};
    const next: Optic = { ...had };
    if (fact.description !== undefined && !had.type) next.type = fact.description;
    if (fact.model !== undefined) next.part = fact.model;
    if (fact.serial !== undefined) next.serial = fact.serial;
    return setOptic(doc, targetId, next, opts);
  }
  let working = doc;
  const f = readPowerSupplyFields(findNode(doc, targetId)!);
  if (fact.serial !== undefined) working = setSupplyField(working, targetId, 'serial', fact.serial, opts);
  if (fact.model !== undefined && !f.model) working = setSupplyField(working, targetId, 'model', fact.model, opts);
  return working;
}

/** The ticked facts written as one undo step. Only serial and version are ever written. */
export function acceptFacts(doc: Document, id: string, facts: DeviceFacts, keys: ReadonlySet<FactKey>, opts?: { actor?: string; now?: number }): Document {
  const deviceId = deviceOf(doc, id);
  if (deviceId === null) return doc;
  const chassisId = edgesOut(doc, deviceId, 'HasChassis')[0]?.to;
  const from = doc.batches.length;
  let working = doc;
  for (const s of suggestFacts(doc, id, facts)) {
    if (!keys.has(s.key) || (s.state !== 'fill' && s.state !== 'differs')) continue;
    if (s.key === 'serial' && chassisId !== undefined) working = setChassisField(working, chassisId, 'serial', s.theirs, opts);
    if (s.key === 'version') working = setDeviceField(working, deviceId, 'os_version', s.theirs, opts);
    if (s.part && chassisId !== undefined) working = writePart(working, chassisId, s, opts);
  }
  return working.batches.length === from ? doc : foldIntoOneBatch(working, from, 'facts from the device');
}
