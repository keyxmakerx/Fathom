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
// - Arista EOS `show version`: `Arista DCS-7280SR-48C6-M-F`, `Serial number: SSJ17290598`, `Software image version:
//   4.19.5M` (O'Reilly, Arista Warrior 2nd ed., chapter 10 "Upgrading EOS").

import { foldIntoOneBatch } from './bulk';
import { setChassisField, setDeviceField } from './edit';
import { asString, edgesOut, fieldValue, findNode, readChassisFields, type Document } from './model';
import { deviceOf } from './portTies';

export type FactsVendor = 'junos' | 'cisco' | 'arista';

export interface DeviceFacts {
  vendor: FactsVendor;
  hostname?: string;
  model?: string;
  serial?: string;
  version?: string;
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
  return facts.model !== undefined || facts.serial !== undefined || facts.version !== undefined ? facts : null;
}

function readCisco(text: string): DeviceFacts | null {
  const version = first(/^\s*Cisco IOS[^\n]*?Software[^\n]*?, Version ([^,\s]+)/m, text);
  // `show inventory`: the chassis entry, else the first one.
  const entries = [...text.matchAll(/NAME:\s*"([^"]*)"[^\n]*\n\s*PID:\s*([^\s,]+)\s*,[^\n]*?SN:\s*(\S+)/g)];
  const chassis = entries.find((e) => /chassis/i.test(e[1]!)) ?? entries[0];
  const serial = first(/^\s*System Serial Number\s*:\s*(\S+)/im, text) ?? chassis?.[3];
  const facts: DeviceFacts = { vendor: 'cisco' };
  if (version !== undefined) facts.version = version;
  if (serial !== undefined) facts.serial = serial;
  if (chassis !== undefined) facts.model = chassis[2];
  return facts.model !== undefined || facts.serial !== undefined || facts.version !== undefined ? facts : null;
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

export type FactKey = 'serial' | 'version' | 'model' | 'hostname';

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
  return out;
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
  }
  return working.batches.length === from ? doc : foldIntoOneBatch(working, from, 'facts from the device');
}
