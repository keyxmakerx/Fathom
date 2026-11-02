// A drawn network traced past its first hop (sign-off r96, round 1): a host typed by hand reaches
// only its own network until Inventory › Routes gives it a gateway; then the trace crosses the router.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { connectPorts } from '../document/cables';
import { addSketchPort, createSketchDevice } from '../document/commands';
import { addAddress, interfaceChoices } from '../document/ipam-write';
import { emptyDocument, parseNodeId, type Document } from '../document/model';
import { addRoute } from '../document/routes';
import { Engine } from './engine';
import { Mirror } from './mirror';
import { fileLoader } from './wasm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(__dirname, '../../public/engine/fathom_wasm.wasm');
if (!existsSync(WASM_PATH)) throw new Error(`${WASM_PATH} does not exist. Run \`bash scripts/build-wasm.sh\` first.`);

let engine: Engine;
beforeAll(async () => {
  engine = await Engine.init(fileLoader(WASM_PATH));
});

function addDevice(doc: Document, ports: string[]): { doc: Document; deviceId: string; portIds: string[] } {
  const before = new Set(doc.nodes.map((n) => n.id));
  let next = createSketchDevice(doc);
  const fresh = next.nodes.filter((n) => !before.has(n.id));
  const deviceId = fresh.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
  const chassisId = fresh.find((n) => parseNodeId(n.id).kind === 'Chassis')!.id;
  const portIds: string[] = [];
  for (const label of ports) {
    const had = new Set(next.nodes.map((n) => n.id));
    next = addSketchPort(next, chassisId, { label, connector: 'rj45', face: 'front' });
    portIds.push(next.nodes.find((n) => !had.has(n.id))!.id);
  }
  return { doc: next, deviceId, portIds };
}

function address(doc: Document, deviceId: string, label: string, cidr: string): Document {
  const owner = interfaceChoices(doc, deviceId).find((c) => c.label.startsWith(label))!;
  return addAddress(doc, { address: cidr, owner }, undefined);
}

describe('a gateway typed by hand', () => {
  it('takes a drawn host past its own network', () => {
    const a = addDevice(emptyDocument(), ['eth0']);
    const r = addDevice(a.doc, ['0', '1']);
    const b = addDevice(r.doc, ['eth0']);
    let doc = connectPorts(b.doc, a.portIds[0], r.portIds[0], { sheath: 'grey' });
    doc = connectPorts(doc, r.portIds[1], b.portIds[0], { sheath: 'grey' });
    doc = address(doc, a.deviceId, 'eth0', '10.0.1.10/24');
    doc = address(doc, r.deviceId, '0', '10.0.1.1/24');
    doc = address(doc, r.deviceId, '1', '10.0.2.1/24');
    doc = address(doc, b.deviceId, 'eth0', '10.0.2.10/24');

    const mirror = new Mirror(engine);
    mirror.load(doc);
    expect(mirror.trace(a.deviceId, '10.0.2.10').stopped).toContain('no connected or static route');

    doc = addRoute(doc, { deviceId: a.deviceId, destination: 'default', via: '10.0.1.1' }).doc;
    mirror.load(doc);
    const t = mirror.trace(a.deviceId, '10.0.2.10');
    expect(t.stopped).toBe('');
    expect(t.hops[1]!.detail).toContain('static route 0.0.0.0/0 via 10.0.1.1');
    expect(t.hops.at(-1)!.kind).toBe('end');
    expect(t.hops.at(-1)!.nodes[0]).toBe(b.deviceId);
  });
});
