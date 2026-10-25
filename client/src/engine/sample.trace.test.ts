// The sample home lab (corpus/samples/home-lab.json) opens and traces end to end, through two switches, whether its
// devices come from the whole shipped catalogue or are drawn as sketches.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../api/catalogue';
import { identifier } from '../document/model';
import { buildSample, modelKey, sample } from '../components/home/sampleNetwork';
import { Engine } from './engine';
import { Mirror } from './mirror';
import { CATALOGUE, catalogueFiles } from './testCatalogue';
import { fileLoader } from './wasm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(__dirname, '../../public/engine/fathom_wasm.wasm');
if (!existsSync(WASM_PATH)) throw new Error(`${WASM_PATH} does not exist. Run \`bash scripts/build-wasm.sh\` first.`);

let engine: Engine;
beforeAll(async () => {
  engine = await Engine.init(fileLoader(WASM_PATH));
});

const spec = sample('home-lab');

describe.each([
  ['sketches only', new Map<string, CatalogueModel>()],
  ['against the full catalogue', new Map(CATALOGUE.map((m) => [modelKey(m.vendor, m.model), m]))],
])('the sample home lab, %s', (_, models) => {
  const built = buildSample(spec, models);
  const mirror = (): Mirror => {
    const m = new Mirror(engine);
    m.load(built.doc);
    return m;
  };

  it('traces from the desktop to the NAS through both switches', () => {
    const from = built.devices.get(spec.trace.from)!;
    const to = built.devices.get(spec.trace.to)!;
    const result = mirror().trace(from, to);
    expect(result.stopped).toBe('');
    expect(result.hops.at(-1)?.kind).toBe('end');
    expect(result.hops.at(-1)?.nodes).toEqual([to]);
    expect(result.hops.filter((h) => h.kind === 'switch').map((h) => h.title)).toEqual(['switch-2', 'switch-1']);
  });

  // Card nu-vlan A: a VLAN keeps the cameras on their own network, and the rule on router-1 is what keeps them out.
  const routerRows = (from: string, to: string): string[] => {
    const result = mirror().trace(built.devices.get(from)!, to, { protocol: 6, port: 445 });
    expect(result.stopped).toBe('');
    const router = result.hops.find((h) => h.title === 'router-1' && h.kind === 'device');
    return (router?.policies ?? []).map((p) => `${router?.scope}: ${p.name} ${p.action} ${p.state}`);
  };

  it('reads the deny rule at the router when a camera is traced to the NAS', () => {
    expect(routerRows('camera-1', '192.168.10.10')).toEqual(['cameras to lan: cameras-stay-out deny matches']);
  });

  it('reads the permit rule at the router when the desktop is traced to a camera', () => {
    expect(routerRows('desktop-1', '192.168.30.21')).toEqual(['lan to cameras: lan-may-view-cameras permit matches']);
  });

  it('traces every ready-made question to its far end', () => {
    for (const q of spec.questions ?? []) {
      const result = mirror().trace(built.devices.get(q.from)!, q.to);
      expect(result.stopped, q.ask).toBe('');
    }
    expect(spec.questions?.length).toBeGreaterThan(0);
  });

  it('opens with nothing a check refuses', () => {
    const checks = mirror().checks();
    expect(checks.findings.filter((f) => f.severity === 'refuse')).toEqual([]);
  });
});

describe('the sample home lab against the full catalogue', () => {
  it('reads every catalogue model', () => {
    expect(CATALOGUE.length).toBe(Object.keys(catalogueFiles).length);
    expect(CATALOGUE.length).toBeGreaterThan(0);
  });

  // Chassis.model is an Identifier (schema/schema.yaml): a model named with a space could not be placed at all.
  it.each(CATALOGUE.map((m) => [`${m.vendor}/${m.model}`, m.model]))('%s is a model id a chassis can carry', (_, model) => {
    expect(() => identifier(model)).not.toThrow();
  });

  it('draws every device the sample names a model for from the catalogue', () => {
    const built = buildSample(spec, new Map(CATALOGUE.map((m) => [modelKey(m.vendor, m.model), m])));
    expect(built.catalogued.sort()).toEqual(spec.devices.filter((d) => d.catalogue).map((d) => d.hostname).sort());
  });
});
