// A trace through a pasted device stops at "not tied to a port" until the person ties the interface; then it
// follows the cable to the next device.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { untiedStop } from '../components/trace/traceModel';
import { connectPorts } from '../document/cables';
import { addSketchPort, createSketchDevice } from '../document/commands';
import { emptyDocument, parseNodeId, type Document } from '../document/model';
import { tiePlan, tiePorts } from '../document/portTies';
import { Engine } from './engine';
import { Mirror } from './mirror';
import { fileLoader } from './wasm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(__dirname, '../../public/engine/fathom_wasm.wasm');
if (!existsSync(WASM_PATH)) throw new Error(`${WASM_PATH} does not exist. Run \`bash scripts/build-wasm.sh\` first.`);

const A = ['set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30', 'set routing-options static route 198.51.100.0/24 next-hop 203.0.113.1'].join('\n');
const B = 'set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.1/30';

let engine: Engine;
beforeAll(async () => {
  engine = await Engine.init(fileLoader(WASM_PATH));
});

function addDevice(doc: Document): { doc: Document; deviceId: string; portId: string } {
  const before = new Set(doc.nodes.map((n) => n.id));
  let next = createSketchDevice(doc);
  const fresh = next.nodes.filter((n) => !before.has(n.id));
  const deviceId = fresh.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
  const chassisId = fresh.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
  const had = new Set(next.nodes.map((n) => n.id));
  next = addSketchPort(next, chassisId, { label: '0', connector: 'rj45', face: 'front' });
  const portId = next.nodes.find((n) => !had.has(n.id))!.id;
  return { doc: next, deviceId, portId };
}

const tieAll = (doc: Document, deviceId: string, portId: string): Document =>
  tiePorts(doc, deviceId, tiePlan(doc, deviceId, [])!.rows.map((r) => ({ interfaceId: r.interfaceId, portId })));

describe('a trace through a tied pasted device', () => {
  it('stops at the untied interface, then continues past it once tied', () => {
    const a = addDevice(emptyDocument());
    const b = addDevice(a.doc);
    let doc = connectPorts(b.doc, a.portId, b.portId, { sheath: 'grey' });
    const mirror = new Mirror(engine);
    mirror.load(doc);
    doc = mirror.pasteInto(a.deviceId, A, 'junos-srx').doc;
    doc = mirror.pasteInto(b.deviceId, B, 'junos-srx').doc;

    const before = mirror.trace(a.deviceId, '198.51.100.77');
    expect(before.stopped).toContain('is not tied to a port');
    expect(untiedStop(before)).toBe(a.deviceId);

    doc = tieAll(tieAll(doc, a.deviceId, a.portId), b.deviceId, b.portId);
    mirror.load(doc);
    const after = mirror.trace(a.deviceId, '198.51.100.77');
    expect(after.stopped).not.toContain('is not tied to a port');
    expect(after.hops.map((h) => h.kind)).toContain('cable');
    expect(after.hops.some((h) => h.kind === 'device' && h.nodes[0] === b.deviceId)).toBe(true);
    expect(untiedStop(after)).toBeNull();
  });
});
