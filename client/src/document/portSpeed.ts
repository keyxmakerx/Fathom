/** A port's configured speed (sign-off r109, item 5): `Interface.speed`, the configured rate in bits per
 * second (schema: `Bandwidth`, a u64 whose canonical form is its decimal digits). It is a fact of the
 * port's interface, not of the cage: `PhysicalPort.speed_max` is a different fact.
 *
 * A hand-drawn port often has no interface yet. Setting a speed then gives it one, named after the port's
 * label and occupying the port, the same shape a VLAN or an address gives it, so the two agree later. */

import { addEdge, addNode, begin, clearNodeField, finish, setNodeField } from './freeform';
import { edgesIn, edgesOut, findNode, interfaceName, parseNodeId, token, UnknownReferenceError, type Document } from './model';
import { FieldValueError } from './edit';
import type { Actor } from './networks';

/** The speeds offered by name, fastest first. */
export const COMMON_SPEEDS: readonly { label: string; bps: number }[] = [
  { label: '100G', bps: 100e9 },
  { label: '40G', bps: 40e9 },
  { label: '25G', bps: 25e9 },
  { label: '10G', bps: 10e9 },
  { label: '5G', bps: 5e9 },
  { label: '2.5G', bps: 2.5e9 },
  { label: '1G', bps: 1e9 },
  { label: '100M', bps: 100e6 },
  { label: '10M', bps: 10e6 },
];

/** `10G`, `2.5g`, `100M`, `1000000000`, `10 Gb/s` to bits per second; null when it isn't a speed. */
export function parseSpeed(text: string): number | null {
  const t = text.trim().replace(/\s+/g, '').replace(/(b(ps|it\/s|\/s)?|bit)$/i, '');
  const m = /^(\d+(?:\.\d+)?)([kmgt]?)$/i.exec(t);
  if (m == null) return null;
  const mult = { '': 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12 }[m[2]!.toLowerCase() as '' | 'k' | 'm' | 'g' | 't'];
  const bps = Math.round(Number(m[1]) * mult);
  return Number.isSafeInteger(bps) && bps > 0 ? bps : null;
}

/** The interface on this port: the one occupying it, else the device's interface named like the port. */
export function portInterface(doc: Document, portId: string): string | undefined {
  const occ = edgesIn(doc, portId, 'Occupies').find((e) => parseNodeId(e.from).kind === 'Interface' && findNode(doc, e.from)?.absentSince === undefined);
  if (occ != null) return occ.from;
  const device = deviceOfPort(doc, portId);
  const label = findNode(doc, portId)?.fields['PhysicalPort.label'];
  if (device == null || label?.presence !== 'set') return undefined;
  for (const h of edgesOut(doc, device, 'HasInterface')) {
    const n = findNode(doc, h.to);
    if (n?.absentSince === undefined && parseNodeId(h.to).kind === 'Interface' && n?.fields['Interface.name']?.value === label.value) return h.to;
  }
  return undefined;
}

/** The port's configured speed in bits per second, or null when nobody has said. */
export function portSpeed(doc: Document, portId: string): number | null {
  const i = portInterface(doc, portId);
  const f = i == null ? undefined : findNode(doc, i)?.fields['Interface.speed'];
  if (f?.presence !== 'set') return null;
  const v = typeof f.value === 'number' ? f.value : typeof f.value === 'string' ? Number(f.value) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

function deviceOfPort(doc: Document, portId: string): string | undefined {
  const holder = edgesIn(doc, portId, 'HasPort')[0]?.from;
  return holder == null ? undefined : edgesIn(doc, holder, 'HasChassis')[0]?.from;
}

/** Sets the port's speed, typed as `10G` or in bits per second; blank or null clears it. One batch, one undo. */
export function setPortSpeed(doc: Document, portId: string, value: string | null, opts?: Actor): Document {
  const port = findNode(doc, portId);
  if (port == null || port.absentSince !== undefined || parseNodeId(portId).kind !== 'PhysicalPort') throw new UnknownReferenceError(portId, 'PhysicalPort');
  const typed = (value ?? '').trim();
  const bps = typed === '' ? null : parseSpeed(typed);
  if (typed !== '' && bps == null) throw new FieldValueError('Interface.speed', typed, 'is not a speed (write it like 10G, 2.5G, 100M, or in bits per second)');
  const b = begin(doc, opts);
  let iface = portInterface(doc, portId);
  if (iface == null) {
    if (bps == null) return doc;
    const device = deviceOfPort(doc, portId);
    const label = port.fields['PhysicalPort.label'];
    if (device == null || label?.presence !== 'set' || typeof label.value !== 'string') throw new UnknownReferenceError(portId, 'PhysicalPort');
    iface = addNode(b, 'Interface', { 'Interface.name': interfaceName(label.value), 'Interface.form': token('ethernet') });
    addEdge(b, 'HasInterface', device, iface);
    addEdge(b, 'Occupies', iface, portId);
  }
  if (bps == null) clearNodeField(b, iface, 'Interface.speed');
  else setNodeField(b, iface, 'Interface.speed', String(bps));
  return finish(b, bps == null ? 'clear the port speed' : 'set the port speed');
}
