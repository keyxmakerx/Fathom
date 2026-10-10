// A made-up estate for the firmware tests. Test support only: nothing in the app imports this.
import { createSketchDevice } from './commands';
import { begin, finish, setNodeField } from './freeform';
import { emptyDocument, parseNodeId, type Document } from './model';

export const NOW = 1_700_000_000_000;

/** A sketch device made to look captured: a model on its chassis, a platform and a running version. */
export function addDevice(doc: Document, name: string, model: string, platform: string, osVersion: string, at: number): { doc: Document; deviceId: string } {
  const before = new Set(doc.nodes.map((n) => n.id));
  let next = createSketchDevice(doc, { hostname: name, now: at });
  const fresh = next.nodes.filter((n) => !before.has(n.id));
  const deviceId = fresh.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
  const chassisId = fresh.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
  const b = begin(next, { now: at });
  setNodeField(b, chassisId, 'Chassis.model', model);
  if (platform) setNodeField(b, deviceId, 'Device.platform', platform);
  if (osVersion) setNodeField(b, deviceId, 'Device.os_version', osVersion);
  next = finish(b, 'test: captured');
  return { doc: next, deviceId };
}

export function estate() {
  let doc = emptyDocument();
  const ids: Record<string, string> = {};
  let t = NOW;
  for (const [name, model, version] of [
    ['sw1', 'ex4300-48t', '21.4R3-S5'],
    ['sw2', 'ex4300-48t', '21.4R3-S6'],
    ['sw3', 'ex4300-48t', '22.1R1'],
    ['sw4', 'ex4300-48t', ''],
    ['fw1', 'srx300', '21.4R3'],
  ] as const) {
    t += 1000;
    const made = addDevice(doc, name, model, 'junos-ex', version, t);
    doc = made.doc;
    ids[name] = made.deviceId;
  }
  return { doc, ids };
}

