// The sample home lab (corpus/samples/home-lab.json) traces end to end, through two switches, whether its devices come
// from the catalogue or are drawn as sketches.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import type { CatalogueModel, CataloguePort } from '../api/catalogue';
import { buildSample, modelKey, sample } from '../components/home/sampleNetwork';
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

const ports = (kind: string, count: number, start: number): CataloguePort[] =>
  Array.from({ length: count }, (_, i) => ({ kind, number: start + i, uplink: false, row: 'single', column: i, groupGapBefore: false }));

// The two models the sample racks that main's catalogue holds, as corpus/catalogue/ubiquiti/*.yaml lists their ports.
const MODELS: CatalogueModel[] = [
  {
    vendor: 'ubiquiti',
    model: 'UDM-SE',
    rackUnits: 1,
    reviewedBy: '<named human>',
    source: { cite: 'corpus/catalogue/ubiquiti/udm-se.yaml', readOn: '2026-09-19' },
    psuSlots: [],
    faceplates: [{ face: 'front', portCount: 11, ports: [...ports('RJ45', 9, 1), ...ports('SFP+', 2, 1)] }],
  },
  {
    vendor: 'ubiquiti',
    model: 'USW-24-PoE',
    rackUnits: 1,
    reviewedBy: '<named human>',
    source: { cite: 'corpus/catalogue/ubiquiti/usw-24-poe.yaml', readOn: '2026-09-19' },
    psuSlots: [],
    faceplates: [{ face: 'front', portCount: 26, ports: [...ports('RJ45', 24, 1), ...ports('SFP+', 2, 1)] }],
  },
];

const spec = sample('home-lab');

describe.each([
  ['sketches only', new Map<string, CatalogueModel>()],
  ['with catalogue models', new Map(MODELS.map((m) => [modelKey(m.vendor, m.model), m]))],
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

  it('stops where the design stops when a camera is traced to the NAS', () => {
    const result = mirror().trace(built.devices.get('camera-1')!, built.devices.get('nas-1')!);
    expect(result.stopped).not.toBe('');
  });

  it('opens with nothing a check refuses', () => {
    const checks = mirror().checks();
    expect(checks.findings.filter((f) => f.severity === 'refuse')).toEqual([]);
  });
});
