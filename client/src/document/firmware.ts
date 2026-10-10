// Firmware in the design (schema 0.19): a `FirmwareTarget` per catalogue model names the version
// the people who keep the design chose, and `Device.firmware_hold` says a device stays where it is
// on purpose. The image itself lives on the server (`api/firmware.ts`); a target only names it.
// A target hangs off the root with no edge, as a Tag does. All pure, one undoable batch each.

import { begin, finish, addNode, tombstone, type Build } from './freeform';
import { FIRMWARE_PLATFORMS, versionOlder } from './firmwareVersion';
import {
  archiveField,
  assertHand,
  asString,
  edgesIn,
  edgesOut,
  fieldValue,
  findNode,
  identifier,
  kebab,
  parseNodeId,
  replaceNode,
  requireFieldName,
  text,
  type Document,
  type FieldEntry,
  type GraphNode,
} from './model';

interface Actor {
  actor?: string;
  now?: number;
}

export class FirmwareRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FirmwareRefusal';
  }
}

const DEVICE_PREFIX = `${kebab('Device')}:`;
const TARGET_PREFIX = `${kebab('FirmwareTarget')}:`;

const str = (n: GraphNode, key: string): string => asString(fieldValue(n.fields, key)) ?? '';
const live = (n: GraphNode): boolean => n.absentSince === undefined;

// ---------------------------------------------------------------------------
// Targets

export interface FwTarget {
  id: string;
  model: string;
  version: string;
  platform: string;
  /** The server's image id, or ''. */
  image: string;
  imageSha256: string;
  note: string;
}

function readTarget(n: GraphNode): FwTarget {
  return {
    id: n.id,
    model: str(n, 'FirmwareTarget.model'),
    version: str(n, 'FirmwareTarget.version'),
    platform: str(n, 'FirmwareTarget.platform'),
    image: str(n, 'FirmwareTarget.image'),
    imageSha256: str(n, 'FirmwareTarget.image_sha256'),
    note: str(n, 'FirmwareTarget.note'),
  };
}

/** Every live target, one per model: when a payload holds two, the lowest id is the one shown. */
export function listTargets(doc: Document): FwTarget[] {
  const byModel = new Map<string, FwTarget>();
  for (const n of doc.nodes) {
    if (!live(n) || !n.id.startsWith(TARGET_PREFIX)) continue;
    const t = readTarget(n);
    if (t.model !== '' && !byModel.has(t.model)) byModel.set(t.model, t);
  }
  return [...byModel.values()];
}

export function targetFor(doc: Document, model: string): FwTarget | null {
  return listTargets(doc).find((t) => t.model === model) ?? null;
}

/** Writes one field, or clears it when `value` is undefined; says nothing when nothing changes. */
function putField(b: Build, id: string, key: string, value: FieldEntry['value'] | undefined): void {
  requireFieldName(key);
  const node = findNode(b.doc, id);
  if (!node) throw new FirmwareRefusal('That is not in the design any more.');
  const existing = node.fields[key];
  const had = existing !== undefined && existing.presence === 'set' ? existing.value : undefined;
  if (had === value) return;
  const prov = assertHand(b.doc, { assertedAt: b.now, assertedBy: b.actor, supersedes: existing?.prov });
  b.doc = existing !== undefined ? archiveField(prov.doc, id, key, existing) : prov.doc;
  const next: FieldEntry = value === undefined ? { presence: 'absent', prov: prov.id } : { presence: 'set', prov: prov.id, value };
  b.ops.push({ type: 'set_field', element: id, key, presence: next.presence, prov: prov.id });
  b.doc = replaceNode(b.doc, id, (n) => ({ ...n, fields: { ...n.fields, [key]: next } }));
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const HEX64 = /^[0-9a-f]{64}$/;
export const MAX_VERSION = 64;
export const MAX_NOTE = 500;
export const MAX_REASON = 200;

/** A hash as a person pastes it: spaces, a `sha256:` lead and capitals tolerated; returns 64 lowercase hex or null. */
export function cleanSha256(raw: string): string | null {
  const s = raw.trim().replace(/^sha-?256\s*[:=]?\s*/i, '').replace(/\s+/g, '').toLowerCase();
  return HEX64.test(s) ? s : null;
}

export function cleanVersion(raw: string): string {
  const v = raw.trim();
  if (v === '') throw new FirmwareRefusal('Give a version.');
  if (/\s/.test(v)) throw new FirmwareRefusal('A version has no spaces. Type it as the vendor writes it.');
  if (v.length > MAX_VERSION) throw new FirmwareRefusal(`A version is at most ${MAX_VERSION} characters.`);
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point.
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new FirmwareRefusal('A version cannot hold control characters.');
  return v;
}

export interface TargetPatch {
  version: string;
  platform?: string | null;
  image?: string | null;
  imageSha256?: string | null;
  note?: string | null;
}

/**
 * Chooses the version for a model: makes its target or changes the one it has. `platform`, `image`,
 * `imageSha256` and `note` left out are left as they are; `null` clears them. One undo step.
 */
export function setTarget(doc: Document, model: string, patch: TargetPatch, opts?: Actor): Document {
  let modelId: FieldEntry['value'];
  try {
    modelId = identifier(model.trim());
  } catch {
    throw new FirmwareRefusal('A model is written without spaces, as the catalogue has it.');
  }
  const version = cleanVersion(patch.version);
  if (patch.platform != null && !FIRMWARE_PLATFORMS.some((p) => p.id === patch.platform)) {
    throw new FirmwareRefusal('Pick a platform from the list.');
  }
  if (patch.image != null && !ULID.test(patch.image)) throw new FirmwareRefusal('That image is not one the server knows.');
  if (patch.imageSha256 != null && !HEX64.test(patch.imageSha256)) throw new FirmwareRefusal('A SHA-256 is 64 hexadecimal characters.');
  if (patch.note != null && patch.note.length > MAX_NOTE) throw new FirmwareRefusal(`A note is at most ${MAX_NOTE} characters.`);

  const b = begin(doc, opts);
  const existing = targetFor(doc, model.trim());
  const id = existing?.id ?? addNode(b, 'FirmwareTarget', { 'FirmwareTarget.model': modelId, 'FirmwareTarget.version': text(version) });
  if (existing) putField(b, id, 'FirmwareTarget.version', text(version));
  const optional = (key: string, v: string | null | undefined) => {
    if (v === undefined) return;
    putField(b, id, key, v === null || v === '' ? undefined : text(v));
  };
  optional('FirmwareTarget.platform', patch.platform);
  if (patch.image !== undefined) putField(b, id, 'FirmwareTarget.image', patch.image === null ? undefined : identifier(patch.image));
  optional('FirmwareTarget.image_sha256', patch.imageSha256);
  optional('FirmwareTarget.note', patch.note === undefined || patch.note === null ? patch.note : patch.note.trim());
  return finish(b, existing ? 'change firmware version' : 'choose firmware version');
}

/** Takes a model's chosen version away. Its devices read "no chosen version" again. */
export function clearTarget(doc: Document, model: string, opts?: Actor): Document {
  const t = targetFor(doc, model);
  if (!t) return doc;
  const b = begin(doc, opts);
  // A payload that holds the model twice loses every copy, so none comes back to speak for it.
  const ids = doc.nodes.filter((n) => live(n) && n.id.startsWith(TARGET_PREFIX) && str(n, 'FirmwareTarget.model') === model).map((n) => n.id);
  tombstone(b, new Set(ids), new Set());
  return finish(b, 'clear firmware version');
}

// ---------------------------------------------------------------------------
// Devices

export interface FwDevice {
  deviceId: string;
  chassisIds: string[];
  hostname: string;
  /** The catalogue models of its chassis; empty when none says one. */
  models: string[];
  platform: string;
  osVersion: string;
  /** Why it is held, or null. */
  hold: string | null;
}

function readDevice(doc: Document, n: GraphNode): FwDevice {
  const chassisIds: string[] = [];
  const models: string[] = [];
  for (const e of edgesOut(doc, n.id, 'HasChassis')) {
    const c = findNode(doc, e.to);
    if (!c || !live(c)) continue;
    chassisIds.push(c.id);
    const m = str(c, 'Chassis.model');
    if (m !== '' && !models.includes(m)) models.push(m);
  }
  const hold = fieldValue(n.fields, 'Device.firmware_hold');
  return {
    deviceId: n.id,
    chassisIds,
    hostname: str(n, 'Device.hostname'),
    models,
    platform: str(n, 'Device.platform'),
    osVersion: str(n, 'Device.os_version'),
    hold: typeof hold === 'string' ? hold : null,
  };
}

export function allDevices(doc: Document): FwDevice[] {
  const out: FwDevice[] = [];
  for (const n of doc.nodes) if (live(n) && n.id.startsWith(DEVICE_PREFIX)) out.push(readDevice(doc, n));
  return out;
}

export function deviceFirmware(doc: Document, deviceId: string): FwDevice | null {
  const n = findNode(doc, deviceId);
  return n && live(n) && n.id.startsWith(DEVICE_PREFIX) ? readDevice(doc, n) : null;
}

/** The Device a chassis belongs to, or null. */
export function deviceOfChassis(doc: Document, chassisId: string): string | null {
  return edgesIn(doc, chassisId, 'HasChassis')[0]?.from ?? null;
}

/** Holds a device at the version it runs, with the reason; `null` lifts the hold. One undo step. */
export function setFirmwareHold(doc: Document, deviceId: string, reason: string | null, opts?: Actor): Document {
  const n = findNode(doc, deviceId);
  if (!n || !live(n) || parseNodeId(deviceId).kind !== 'Device') throw new FirmwareRefusal('That device is not in the design any more.');
  let value: string | undefined;
  if (reason !== null) {
    value = reason.trim();
    if (value === '') throw new FirmwareRefusal('Say why it is held.');
    if (value.length > MAX_REASON) throw new FirmwareRefusal(`The reason is at most ${MAX_REASON} characters.`);
  }
  const b = begin(doc, opts);
  putField(b, deviceId, 'Device.firmware_hold', value === undefined ? undefined : text(value));
  return finish(b, value === undefined ? 'lift firmware hold' : 'hold firmware');
}

// ---------------------------------------------------------------------------
// State, in words

export type FwState = 'current' | 'behind' | 'held' | 'no-target' | 'not-recorded' | 'unclear';

export const STATE_WORD: Readonly<Record<FwState, string>> = {
  current: 'Up to date',
  behind: 'Behind',
  held: 'Held',
  'no-target': 'No chosen version',
  'not-recorded': 'Version not recorded',
  unclear: 'Cannot compare',
};

/**
 * Where one device stands against its model's chosen version. Held wins over behind, as the check
 * does; a version the numbers cannot order is `unclear`, never guessed.
 */
export function stateOf(device: Pick<FwDevice, 'platform' | 'osVersion' | 'hold'>, target: Pick<FwTarget, 'version' | 'platform'> | null): FwState {
  if (target === null || target.version === '') return 'no-target';
  if (device.hold !== null) return 'held';
  if (device.osVersion === '') return 'not-recorded';
  const older = versionOlder(device.platform || target.platform, device.osVersion, target.version);
  return older === null ? 'unclear' : older ? 'behind' : 'current';
}

/** The target for the first of a device's models that has one. */
export function targetOfDevice(doc: Document, device: FwDevice): FwTarget | null {
  const targets = listTargets(doc);
  for (const m of device.models) {
    const t = targets.find((x) => x.model === m);
    if (t) return t;
  }
  return null;
}

export interface FwDeviceLine {
  device: FwDevice;
  state: FwState;
}

export interface FwModelRow {
  model: string;
  target: FwTarget | null;
  devices: FwDeviceLine[];
  behind: number;
  held: number;
}

/** One row per model that has a device or a target, in model order. */
export function modelRows(doc: Document): FwModelRow[] {
  const targets = listTargets(doc);
  const byModel = new Map<string, FwModelRow>();
  const rowOf = (model: string): FwModelRow => {
    let r = byModel.get(model);
    if (!r) {
      r = { model, target: targets.find((t) => t.model === model) ?? null, devices: [], behind: 0, held: 0 };
      byModel.set(model, r);
    }
    return r;
  };
  for (const t of targets) rowOf(t.model);
  for (const d of allDevices(doc)) {
    for (const m of d.models) {
      const r = rowOf(m);
      const state = stateOf(d, r.target);
      r.devices.push({ device: d, state });
      if (state === 'behind') r.behind += 1;
      if (d.hold !== null) r.held += 1;
    }
  }
  return [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model));
}
