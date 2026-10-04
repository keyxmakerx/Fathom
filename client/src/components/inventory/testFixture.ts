// A small made-up estate for tests: one premises, racks in rows, switches and servers with
// sketch ports, and cables between them. Built with the same commands the editor uses.
// Test support only: nothing in the app imports this.

import { connectPorts, setCableField } from '../../document/cables';
import { addSketchPortRange, createRack, createSketchDevice, movePlacement } from '../../document/commands';
import { setChassisField, setDeviceField, setRackField } from '../../document/edit';
import { emptyDocument, formatNodeId, parseNodeId, type Document } from '../../document/model';
import { newUlid } from '../../document/ulid';
import { viewOf, type ClosetView } from '../../document/view';

export const T0 = 1_726_000_000_000;

export interface Estate {
  doc: Document;
  view: ClosetView;
  premisesId: string;
  rackIds: Record<string, string>;
  chassis: Record<string, string>;
  ports: Record<string, string[]>;
  cables: Record<string, string>;
}

const newIds = (before: Document, after: Document, kind: string): string[] => {
  const seen = new Set(before.nodes.map((n) => n.id));
  return after.nodes.filter((n) => !seen.has(n.id) && parseNodeId(n.id).kind === kind).map((n) => n.id);
};

export interface EstateSpec {
  site?: string;
  racks: ReadonlyArray<{ label: string; row?: string; heightU?: number }>;
  devices: ReadonlyArray<{ name: string; rack: string; u: number; role?: string; serial?: string; ports?: { prefix: string; first: number; last: number } }>;
  cables?: ReadonlyArray<{ from: [string, string]; to: [string, string]; label?: string; lengthM?: number; sheath?: string }>;
}

/** `ports['host/label']` is not used: look a port up with `portId(estate, host, label)`. */
export function buildEstate(spec: EstateSpec): Estate {
  const premisesId = formatNodeId('Premises', newUlid(T0));
  const prov = newUlid(T0);
  let doc: Document = {
    ...emptyDocument(),
    nodes: [{ id: premisesId, existence: prov, fields: { 'Premises.label': { presence: 'set', prov, value: spec.site ?? 'LON1' } } }],
  };
  const rackIds: Record<string, string> = {};
  for (const r of spec.racks) {
    const before = doc;
    doc = createRack(doc, premisesId, { label: r.label, heightU: r.heightU ?? 42, unitNumbering: 'ascending', now: T0 });
    rackIds[r.label] = newIds(before, doc, 'Rack')[0]!;
    if (r.row) doc = setRackField(doc, rackIds[r.label]!, 'row', r.row, { now: T0 });
  }
  const chassis: Record<string, string> = {};
  for (const d of spec.devices) {
    const before = doc;
    doc = createSketchDevice(doc, { hostname: d.name, now: T0 });
    const chassisId = newIds(before, doc, 'Chassis')[0]!;
    const deviceId = newIds(before, doc, 'Device')[0]!;
    chassis[d.name] = chassisId;
    doc = movePlacement(doc, chassisId, { kind: 'rack', rackId: rackIds[d.rack]!, positionU: d.u, face: 'front' }, { now: T0 });
    if (d.serial) doc = setChassisField(doc, chassisId, 'serial', d.serial, { now: T0 });
    if (d.role) doc = setDeviceField(doc, deviceId, 'role', d.role, { now: T0 });
    if (d.ports) doc = addSketchPortRange(doc, chassisId, { labelPrefix: d.ports.prefix, first: d.ports.first, last: d.ports.last, connector: 'rj45', face: 'front' }, { now: T0 });
  }
  const view0 = viewOf(doc, []);
  const portsOf: Record<string, string[]> = {};
  for (const rack of view0.racks) for (const c of rack.chassis) portsOf[c.hostname] = c.ports.map((p) => p.id);
  const labelOf = (host: string, label: string): string => {
    const rack = view0.racks.find((r) => r.chassis.some((c) => c.hostname === host));
    const p = rack?.chassis.find((c) => c.hostname === host)?.ports.find((x) => x.label === label);
    if (!p) throw new Error(`no port ${host} ${label}`);
    return p.id;
  };
  const cables: Record<string, string> = {};
  for (const c of spec.cables ?? []) {
    const before = doc;
    doc = connectPorts(doc, labelOf(...c.from), labelOf(...c.to), {}, { now: T0 });
    const id = newIds(before, doc, 'Cable')[0]!;
    cables[c.label ?? `${c.from.join(' ')}>${c.to.join(' ')}`] = id;
    if (c.label) doc = setCableField(doc, id, 'label', c.label, { now: T0 });
    if (c.lengthM != null) doc = setCableField(doc, id, 'length_m', c.lengthM, { now: T0 });
    if (c.sheath) doc = setCableField(doc, id, 'sheath', c.sheath, { now: T0 });
  }
  return { doc, view: viewOf(doc, []), premisesId, rackIds, chassis, ports: portsOf, cables };
}

/** Two rows, five devices, three cables (one unlabelled). */
export function smallEstate(): Estate {
  return buildEstate({
    racks: [
      { label: 'A03', row: 'Row A' },
      { label: 'A04', row: 'Row A' },
      { label: 'B01', row: 'Row B' },
    ],
    devices: [
      { name: 'lon1-a03-tor1', rack: 'A03', u: 40, role: 'switch', serial: 'XH12345678', ports: { prefix: 'ge-0/0/', first: 0, last: 3 } },
      { name: 'lon1-a03-srv0001', rack: 'A03', u: 20, role: 'server', ports: { prefix: 'eno', first: 1, last: 2 } },
      { name: 'lon1-a04-tor1', rack: 'A04', u: 40, role: 'switch', ports: { prefix: 'ge-0/0/', first: 0, last: 3 } },
      { name: 'lon1-b01-fw1', rack: 'B01', u: 30, role: 'firewall', ports: { prefix: 'xe-0/0/', first: 0, last: 1 } },
      { name: 'core1', rack: 'B01', u: 40, role: 'switch', ports: { prefix: 'Gi1/0/', first: 1, last: 24 } },
    ],
    cables: [
      { from: ['lon1-a03-srv0001', 'eno1'], to: ['lon1-a03-tor1', 'ge-0/0/0'], label: 'C-10412', lengthM: 2, sheath: 'blue' },
      { from: ['lon1-a03-srv0001', 'eno2'], to: ['lon1-a03-tor1', 'ge-0/0/1'], lengthM: 2 },
      { from: ['lon1-a04-tor1', 'ge-0/0/0'], to: ['core1', 'Gi1/0/24'], label: 'C-10500', lengthM: 38, sheath: 'aqua' },
    ],
  });
}
