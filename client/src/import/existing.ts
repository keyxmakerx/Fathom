// A read of the document for the importer: devices by name, racks by label with their free units.

import { readChassisFields, readDeviceFields, readMountedInFields, readRackFields, parseNodeId, kebab, type Document } from '../document/model';

export interface ExistingDevice {
  deviceId: string;
  chassisId: string;
  name: string;
  role: string;
  mgmt: string;
  serial: string;
  model: string;
}

export interface RackSlots {
  id: string;
  label: string;
  heightU: number;
  /** `taken[u]` for u in 1..heightU. */
  taken: boolean[];
}

const str = (e: { presence: string; value?: unknown } | undefined): string => (e && e.presence === 'set' && typeof e.value === 'string' ? e.value : '');

/** Live devices that have a name, keyed by lower-cased name; the first of a repeated name wins. */
export function devicesByName(doc: Document): Map<string, ExistingDevice> {
  const out = new Map<string, ExistingDevice>();
  const chassisOf = new Map<string, string>();
  const prefix = `${kebab('HasChassis')}:`;
  for (const e of doc.edges) if (e.absentSince === undefined && e.id.startsWith(prefix) && !chassisOf.has(e.from)) chassisOf.set(e.from, e.to);
  const live = new Set<string>();
  for (const n of doc.nodes) if (n.absentSince === undefined) live.add(n.id);
  for (const n of doc.nodes) {
    if (n.absentSince !== undefined || !n.id.startsWith('device:')) continue;
    const name = readDeviceFields(n).hostname ?? '';
    const chassisId = chassisOf.get(n.id);
    if (name === '' || !chassisId || !live.has(chassisId)) continue;
    const chassis = chassisNode(doc, chassisId);
    const c = chassis ? readChassisFields(chassis) : {};
    const key = name.toLowerCase();
    if (out.has(key)) continue;
    out.set(key, {
      deviceId: n.id,
      chassisId,
      name,
      role: str(n.fields['Device.role']),
      mgmt: str(n.fields['Device.management_address']),
      serial: c.serial ?? '',
      model: c.model ?? '',
    });
  }
  return out;
}

const NODE_CACHE = new WeakMap<Document['nodes'], Map<string, Document['nodes'][number]>>();
function chassisNode(doc: Document, id: string) {
  let m = NODE_CACHE.get(doc.nodes);
  if (!m) {
    m = new Map(doc.nodes.map((n) => [n.id, n]));
    NODE_CACHE.set(doc.nodes, m);
  }
  return m.get(id);
}

/** Live racks by lower-cased label, with the units already taken by mounted chassis. */
export function racksByLabel(doc: Document): Map<string, RackSlots> {
  const out = new Map<string, RackSlots>();
  const racks = new Map<string, RackSlots>();
  for (const n of doc.nodes) {
    if (n.absentSince !== undefined || parseNodeId(n.id).kind !== 'Rack') continue;
    const f = readRackFields(n);
    if (!f.label || !f.heightU) continue;
    const slots: RackSlots = { id: n.id, label: f.label, heightU: f.heightU, taken: new Array<boolean>(f.heightU + 2).fill(false) };
    racks.set(n.id, slots);
    if (!out.has(f.label.toLowerCase())) out.set(f.label.toLowerCase(), slots);
  }
  const mounted = `${kebab('MountedIn')}:`;
  for (const e of doc.edges) {
    if (e.absentSince !== undefined || !e.id.startsWith(mounted)) continue;
    const r = racks.get(e.to);
    const f = readMountedInFields(e);
    if (!r || f.positionU === undefined) continue;
    for (let u = f.positionU; u < f.positionU + (f.heightU ?? 1); u += 1) if (u >= 0 && u < r.taken.length) r.taken[u] = true;
  }
  return out;
}

