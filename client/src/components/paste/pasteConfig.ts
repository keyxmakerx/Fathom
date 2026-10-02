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
import type { Mirror } from '../../engine/mirror';
import { captureOf } from '../../document/capture';

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
  for (const d of deviceNodes(doc)) {
    const name = str(d, 'Device.hostname');
    if (name !== null && name.trim().toLowerCase() === want) {
      const chassis = edgesOut(doc, d.id, 'HasChassis')[0];
      return { deviceId: d.id, chassisId: chassis?.to ?? null, hostname: name, hasCapture: captureOf(doc, d.id) !== null };
    }
  }
  return null;
}

/** A port for each physical-looking interface, so the config's lines can light them. */
function withPorts(doc: Document, chassisId: string, names: readonly string[], opts?: Actor): Document {
  let working = doc;
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.size >= MAX_PORTS) break;
    if (name.includes('.') || !PHYSICAL.test(name) || seen.has(name)) continue;
    seen.add(name);
    working = addSketchPort(working, chassisId, { label: name, connector: FAST.test(name) ? 'sfp_plus' : 'rj45', face: 'front' }, opts);
  }
  return working;
}

/**
 * Runs `text` through the gate and reads the result. `at` is where a new box
 * would sit. Throws what the engine refuses with; the caller words it with
 * `refusalSentence`. Leaves the module holding a scratch design, so the
 * caller must treat it as stale afterwards.
 */
export function previewPaste(mirror: Mirror, doc: Document, text: string, at: { x: number; y: number }, opts?: Actor): PastePreview {
  const made = createFreeBox(doc, { ...opts, x: at.x, y: at.y });
  const device = made.deviceId;
  mirror.load(made.doc);
  const { doc: parsed, result } = mirror.pasteInto(device, text);

  const interfaces = interfacesOf(parsed, device);
  const node = findNode(parsed, device);
  const hostname = (node && str(node, 'Device.hostname')) ?? result.summary.hostname;
  let addDoc = parsed;
  if (hostname !== '' && (node === undefined || str(node, 'Device.hostname') === null)) {
    addDoc = setDeviceField(addDoc, device, 'hostname', hostname, opts);
  }
  addDoc = withPorts(addDoc, made.chassisId, interfaces.map((i) => i.name), opts);
  addDoc = foldFrom(addDoc, doc.batches.length);

  const match = sameNamed(doc, hostname);
  let attachDoc: Document | null = null;
  if (match !== null && !match.hasCapture) {
    mirror.load(doc);
    attachDoc = mirror.pasteInto(match.deviceId, text).doc;
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
