// A VPN entered by hand, traced (sign-off r96, round 2): a laptop on a tailnet reaches the NAS behind
// a subnet router through the VPN, and the hop says what the design does not record.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { connectPorts } from '../document/cables';
import { addSketchPort, createSketchDevice } from '../document/commands';
import { addAddress, interfaceChoices } from '../document/ipam-write';
import { emptyDocument, parseNodeId, type Document } from '../document/model';
import { addOverlay } from '../document/overlays';
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

describe('a VPN typed by hand', () => {
  it('carries a laptop to the network a member offers', () => {
    const laptop = addDevice(emptyDocument(), ['eth0']);
    const pi = addDevice(laptop.doc, ['eth0']);
    const nas = addDevice(pi.doc, ['eth0']);
    let doc = connectPorts(nas.doc, pi.portIds[0], nas.portIds[0], { sheath: 'grey' });
    doc = address(doc, laptop.deviceId, 'eth0', '10.0.0.5/24');
    doc = address(doc, pi.deviceId, 'eth0', '192.168.1.5/24');
    doc = address(doc, nas.deviceId, 'eth0', '192.168.1.20/24');
    doc = addRoute(doc, { deviceId: laptop.deviceId, destination: 'default', via: '10.0.0.1' }).doc;

    const mirror = new Mirror(engine);
    mirror.load(doc);
    expect(mirror.trace(laptop.deviceId, '192.168.1.20').stopped).not.toBe('');

    doc = addOverlay(doc, {
      name: 'home',
      provider: 'tailscale',
      range: '100.64.0.0/10',
      members: [
        { deviceId: laptop.deviceId, address: '100.64.0.2' },
        { deviceId: pi.deviceId, address: '100.64.0.1', routes: '192.168.1.0/24' },
      ],
    }).doc;
    mirror.load(doc);
    const t = mirror.trace(laptop.deviceId, '192.168.1.20');
    expect(t.stopped).toBe('');
    expect(t.hops.map((h) => h.kind)).toEqual(['start', 'device', 'tunnel', 'device', 'cable', 'end']);
    expect(t.hops[2]!.title).toBe('Tailscale home');
    expect(t.hops[2]!.detail.some((d) => d.includes('--accept-routes'))).toBe(true);
    expect(t.hops.at(-1)!.nodes[0]).toBe(nas.deviceId);
  });
});
