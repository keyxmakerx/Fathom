// ADR-0061 §7 "Config paste anywhere": a pasted device config goes through the
// wasm redaction gate (CLAUDE.md rule 4, never reimplemented here), and what
// survives is read into a preview card. Nothing is stored or sent from here:
// the caller applies one of the two documents on the card, or neither.
//
// The raw text is a parameter, never a field: the preview holds only what the
// gate let through (counts by kind, never values), so closing the card leaves
// nothing to clean up.

import { addSketchPort } from '../../document/commands';
import { setDeviceField } from '../../document/edit';
import { createFreeBox, foldFrom } from '../../document/freeform';
import { edgesOut, findNode, parseNodeId, type Document, type GraphNode } from '../../document/model';
import { EngineError, ERRORS } from '../../engine/engine';
import { PASTE_PLATFORMS, type PastePlatform } from '../../engine/frames';
import type { Mirror } from '../../engine/mirror';
import { captureOf } from '../../document/capture';
import { tiePlan, tiePorts } from '../../document/portTies';

export interface PasteInterface {
  name: string;
  addresses: string[];
}

export interface PasteMatch {
  /** The Device the paste would attach to, and its Chassis (what the canvas selects). */
  deviceId: string;
  chassisId: string | null;
  hostname: string;
  /** A device carries one capture; a second paste is refused until replace exists. */
  hasCapture: boolean;
  /** Another live device carries the same name, so nothing here can say which is meant. */
  ambiguous: boolean;
}

export interface PastePreview {
  hostname: string;
  platform: string;
  osVersion: string | null;
  lineCount: number;
  interfaces: PasteInterface[];
  /** What the gate destroyed: how many values of each kind, never the values. */
  destroyed: { label: string; count: number }[];
  match: PasteMatch | null;
  /** The new box's Chassis. */
  addChassisId: string;
  /** The design with a new box added and the config attached to it. */
  addDoc: Document;
  /** The design with the config attached to `match`; null with no usable match. */
  attachDoc: Document | null;
}

type Actor = { actor?: string };

/** The platform names as a person says them, for the "which device is this from?" question. */
export const PLATFORM_WORDS: Readonly<Record<PastePlatform, string>> = {
  'junos-srx': 'Juniper SRX',
  'junos-ex': 'Juniper EX',
  edgeos: 'Ubiquiti EdgeOS',
  opnsense: 'OPNsense',
};

/** A platform the engine can be told, or null for anything else (a hand-typed or unknown model). */
export function pastePlatform(value: string | null): PastePlatform | null {
  return (PASTE_PLATFORMS as readonly string[]).includes(value ?? '') ? (value as PastePlatform) : null;
}

const PHYSICAL = /^(ge|xe|et|fe|me|fxp|em|eth|ether|gi|gig|fa|te|ten|port|lan|wan|sfp|igb|ix|vtnet|re)[-/]?\d/i;
const FAST = /^(xe|te|ten|sfp)/i;
const MAX_PORTS = 96;

function str(node: GraphNode, key: string): string | null {
  const e = node.fields[key];
  return e && e.presence === 'set' && typeof e.value === 'string' ? e.value : null;
}

/** Every live node reached from `fromId` by following edges outward, stopping at Device and Chassis. */
function descendants(doc: Document, fromId: string): GraphNode[] {
  const out: GraphNode[] = [];
  const seen = new Set<string>([fromId]);
  const queue = [fromId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const e of doc.edges) {
      if (e.from !== id || e.absentSince !== undefined || seen.has(e.to)) continue;
      const node = findNode(doc, e.to);
      if (!node || node.absentSince !== undefined) continue;
      const kind = parseNodeId(node.id).kind;
      if (kind === 'Device' || kind === 'Chassis') continue;
      seen.add(e.to);
      out.push(node);
      if (kind === 'Interface' || kind === 'LogicalUnit') queue.push(e.to);
    }
  }
  return out;
}

/** Interfaces and their addresses, as the capture bound them. */
export function interfacesOf(doc: Document, deviceId: string): PasteInterface[] {
  const result: PasteInterface[] = [];
  for (const iface of descendants(doc, deviceId)) {
    if (parseNodeId(iface.id).kind !== 'Interface') continue;
    const name = str(iface, 'Interface.name');
    if (name === null) continue;
    const addresses = descendants(doc, iface.id)
      .filter((n) => parseNodeId(n.id).kind === 'Address')
      .map((n) => str(n, 'Address.value'))
      .filter((a): a is string => a !== null);
    result.push({ name, addresses });
  }
  return result;
}

function countByLabel(labels: readonly string[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l === 'unknown' ? 'unrecognised secret' : l, (counts.get(l === 'unknown' ? 'unrecognised secret' : l) ?? 0) + 1);
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => a.label.localeCompare(b.label));
}

function deviceNodes(doc: Document): GraphNode[] {
  return doc.nodes.filter((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Device');
}

/** The live device already named `hostname` (case-blind), if any. */
export function sameNamed(doc: Document, hostname: string): PasteMatch | null {
  const want = hostname.trim().toLowerCase();
  if (want === '') return null;
  const hits = deviceNodes(doc).filter((d) => str(d, 'Device.hostname')?.trim().toLowerCase() === want);
  const d = hits[0];
  if (!d) return null;
  const chassis = edgesOut(doc, d.id, 'HasChassis')[0];
  return { deviceId: d.id, chassisId: chassis?.to ?? null, hostname: str(d, 'Device.hostname') ?? hostname, hasCapture: captureOf(doc, d.id) !== null, ambiguous: hits.length > 1 };
}

/** A port for each physical-looking interface, so the config's lines can light them, each tied to the interface it
 * was made for (the person confirms it with Add). */
function withPorts(doc: Document, deviceId: string, chassisId: string, names: readonly string[], opts?: Actor): Document {
  let working = doc;
  const made = new Map<string, string>();
  for (const name of names) {
    if (made.size >= MAX_PORTS) break;
    if (name.includes('.') || !PHYSICAL.test(name) || made.has(name)) continue;
    const before = new Set(working.nodes.map((n) => n.id));
    working = addSketchPort(working, chassisId, { label: name, connector: FAST.test(name) ? 'sfp_plus' : 'rj45', face: 'front' }, opts);
    const port = working.nodes.find((n) => !before.has(n.id) && parseNodeId(n.id).kind === 'PhysicalPort');
    if (port) made.set(name, port.id);
  }
  const pairs = (tiePlan(working, deviceId, [])?.rows ?? [])
    .filter((r) => made.has(r.name))
    .map((r) => ({ interfaceId: r.interfaceId, portId: made.get(r.name)! }));
  return pairs.length > 0 ? tiePorts(working, deviceId, pairs, opts) : working;
}

/**
 * Runs `text` through the gate and reads the result. `at` is where a new box
 * would sit. Throws what the engine refuses with; the caller words it with
 * `refusalSentence`. Leaves the module holding a scratch design, so the
 * caller must treat it as stale afterwards.
 */
export function previewPaste(
  mirror: Mirror,
  doc: Document,
  text: string,
  at: { x: number; y: number },
  opts?: Actor,
  platform?: PastePlatform,
): PastePreview {
  const made = createFreeBox(doc, { ...opts, x: at.x, y: at.y });
  const device = made.deviceId;
  mirror.load(made.doc);
  const { doc: parsed, result } = mirror.pasteInto(device, text, platform);

  const interfaces = interfacesOf(parsed, device);
  const node = findNode(parsed, device);
  const hostname = (node && str(node, 'Device.hostname')) ?? result.summary.hostname;
  let addDoc = parsed;
  if (hostname !== '' && (node === undefined || str(node, 'Device.hostname') === null)) {
    addDoc = setDeviceField(addDoc, device, 'hostname', hostname, opts);
  }
  addDoc = withPorts(addDoc, device, made.chassisId, interfaces.map((i) => i.name), opts);
  addDoc = foldFrom(addDoc, doc.batches.length);

  const match = sameNamed(doc, hostname);
  let attachDoc: Document | null = null;
  if (match !== null && !match.hasCapture && !match.ambiguous) {
    mirror.load(doc);
    // A paste into a device reads as that device's own platform when it has one.
    attachDoc = mirror.pasteInto(match.deviceId, text, devicePlatform(doc, match.deviceId) ?? platform).doc;
  }

  return {
    hostname,
    platform: result.summary.platform,
    osVersion: node ? str(node, 'Device.os_version') : null,
    lineCount: result.lines.length,
    interfaces,
    destroyed: countByLabel(result.drops.map((d) => d.label)),
    match,
    addChassisId: made.chassisId,
    addDoc,
    attachDoc,
  };
}

/** A config is several lines; one pasted word or sentence is left alone. */
export function worthReading(text: string): boolean {
  return text.trim().includes('\n');
}

/** The platform a placed device already carries, when the engine knows it. */
export function devicePlatform(doc: Document, deviceId: string): PastePlatform | null {
  const node = findNode(doc, deviceId);
  return node ? pastePlatform(str(node, 'Device.platform')) : null;
}

/** The platforms to offer when the engine could not tell, from an `ERR_PLATFORM_CHOICE` refusal; null for any other error. */
export function platformChoices(error: unknown): PastePlatform[] | null {
  if (!(error instanceof EngineError) || error.code !== ERRORS.ERR_PLATFORM_CHOICE) return null;
  const named = error.detail.split(',').filter((p): p is PastePlatform => pastePlatform(p) !== null);
  return named.length > 1 ? named : null;
}
