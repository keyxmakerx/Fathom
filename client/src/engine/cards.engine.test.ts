// The real module accepts a design holding cards and fitted optics, and gives it back unchanged:
// the Transceiver shape the browser writes (`document/cards.ts`) is the one `fathom-ir` reads.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { Engine } from './engine';
import { Mirror } from './mirror';
import { fileLoader } from './wasm';
import { cardsOf, fitCard, moveOptic, setOptic } from '../document/cards';
import { createSketchDevice } from '../document/commands';
import { edgesOut, emptyDocument, findNode, readPhysicalPortFields } from '../document/model';
import { writePlain } from '../document/plain';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(__dirname, '../../public/engine/fathom_wasm.wasm');
if (!existsSync(WASM_PATH)) throw new Error(`${WASM_PATH} does not exist. Run \`bash scripts/build-wasm.sh\` first.`);

let engine: Engine;
beforeAll(async () => {
  engine = await Engine.init(fileLoader(WASM_PATH));
});

describe('cards and optics through the engine', () => {
  it('loads a card, a sub-card and optics, and exports the same bytes', () => {
    let doc = createSketchDevice(emptyDocument(), { hostname: 'core-sw1' });
    const chassisId = doc.nodes.find((n) => n.id.startsWith('chassis:'))!.id;
    doc = fitCard(doc, chassisId, 'FPC 0', { name: 'MPC', model: 'MPC7E', serial: 'CAFE01', ports: { prefix: '0/', first: 0, last: 1, connector: 'qsfp28' } });
    const cardId = cardsOf(doc, chassisId)[0].id;
    doc = fitCard(doc, cardId, '0', { ports: { prefix: '0/0/', first: 0, last: 0, connector: 'sfp_plus' } });
    const port = (label: string): string =>
      edgesOut(doc, chassisId, 'HasPort').find((e) => readPhysicalPortFields(findNode(doc, e.to)!).label === label)!.to;
    doc = setOptic(doc, port('0/0'), { type: '100GBASE-LR4', vendor: 'Acme', part: 'QSFP28-LR4', serial: 'S1', wavelengthNm: 1310 });
    doc = setOptic(doc, port('0/0/0'), {});
    doc = moveOptic(setOptic(doc, port('0/1'), null), port('0/0'), port('0/1'));

    const mirror = new Mirror(engine);
    mirror.load(doc);
    expect(new TextDecoder().decode(engine.exportPlain())).toEqual(new TextDecoder().decode(writePlain(doc)));
  });

  it('refuses an optic with a member the schema does not have', () => {
    let doc = createSketchDevice(emptyDocument(), { hostname: 'sw2' });
    const chassisId = doc.nodes.find((n) => n.id.startsWith('chassis:'))!.id;
    doc = fitCard(doc, chassisId, '0', { ports: { prefix: '0/', first: 0, last: 0, connector: 'sfp_plus' } });
    const portId = edgesOut(doc, chassisId, 'HasPort')[0].to;
    doc = setOptic(doc, portId, {});
    const bad = { ...doc, nodes: doc.nodes.map((n) => (n.id === portId ? { ...n, fields: { ...n.fields, 'PhysicalPort.transceiver': { ...n.fields['PhysicalPort.transceiver'], value: { colour: 'blue' } } } } : n)) };
    expect(() => new Mirror(engine).load(bad)).toThrow();
  });

  it("a path trace says which card a hop's port is on and what optic is in it", async () => {
    const { buildSample, sample } = await import('../components/home/sampleNetwork');
    const { deviceByHostname } = await import('../components/lessons/lessonModel');
    const doc = buildSample(sample('parts-lab'), new Map()).doc;
    const mirror = new Mirror(engine);
    mirror.load(doc);
    const id = (h: string) => deviceByHostname(doc, h)!;
    const result = mirror.trace(id('desktop-2'), id('server-1'));
    const lines = result.hops.flatMap((h) => h.detail);
    expect(lines).toContain('core-1 1/2 is on the card in slot 1');
    expect(lines).toContain('optic in core-1 1/2: 10GBASE-SR, SFP-10G-SR');
    expect(lines.some((l) => l.includes('OPT-000'))).toBe(false);
  });
});
