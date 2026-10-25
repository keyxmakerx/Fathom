// Every lesson in corpus/lessons/ holds against its sample: each answer is in the design, each trace gives the answer
// the step expects, and each change step's Check is in the state the step starts from and moves when the learner
// makes the change the prompt asks for. A lesson whose answer stops being true fails here, not in front of a learner.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../api/catalogue';
import { buildSample, modelKey, sample, type SamplePaste } from '../components/home/sampleNetwork';
import {
  cableOnPort,
  checkChange,
  checkClick,
  checkTrace,
  deviceByHostname,
  lessons,
  portByRef,
  traceArgs,
  type Lesson,
  type LessonStep,
} from '../components/lessons/lessonModel';
import { connectPorts } from '../document/cables';
import { edgesIn, edgesOut, type Document } from '../document/model';
import { attachToVlan, detachVlanMember } from '../document/networks';
import { Engine } from './engine';
import { Mirror } from './mirror';
import { CATALOGUE } from './testCatalogue';
import { fileLoader } from './wasm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(__dirname, '../../public/engine/fathom_wasm.wasm');
if (!existsSync(WASM_PATH)) throw new Error(`${WASM_PATH} does not exist. Run \`bash scripts/build-wasm.sh\` first.`);

let engine: Engine;
beforeAll(async () => {
  engine = await Engine.init(fileLoader(WASM_PATH));
});

/** Moves a switch port's access VLAN, the way Inventory's Networks panel does: out of one, into the other. */
function moveAccessVlan(doc: Document, ref: string, vlanId: number): Document {
  const portId = portByRef(doc, ref)!;
  const iface = edgesIn(doc, portId, 'Occupies').find((e) => e.absentSince === undefined)!.from;
  const unitId = edgesOut(doc, iface, 'HasUnit').find((e) => e.absentSince === undefined)!.to;
  let next = doc;
  for (const vm of edgesOut(doc, unitId, 'VlanMember')) if (vm.absentSince === undefined) next = detachVlanMember(next, vm.id);
  return attachToVlan(next, { vlanId, target: { kind: 'unit', unitId } });
}

/** What a learner does for each change step, keyed `lesson/step index`. */
const CHANGES: Record<string, (doc: Document) => Document> = {
  'vlans/4': (doc) => moveAccessVlan(doc, 'switch-2:1', 30),
  'vlans/5': (doc) => moveAccessVlan(doc, 'switch-2:1', 10),
  'single-points-of-failure/4': (doc) => connectPorts(doc, portByRef(doc, 'switch-3:2')!, portByRef(doc, 'switch-2:4')!, { sheath: 'blue' }),
};

const ALL = lessons();

describe('the lessons', () => {
  it('are the three first lessons, each on a sample that exists', () => {
    expect(ALL.map((l) => l.id)).toEqual(['vlans', 'single-points-of-failure', 'firewall-policy-order']);
    for (const l of ALL) expect(() => sample(l.sample)).not.toThrow();
  });

  it.each(ALL.map((l) => [l.id, l] as const))('%s cites a source read on a stated day for its claims', (_, l: Lesson) => {
    expect(l.sources.length).toBeGreaterThan(0);
    for (const s of l.sources) {
      expect(s.cite).not.toBe('');
      expect(s.url).toMatch(/^https:\/\//);
      expect(s.read_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('use only the step kinds ADR-0066 fixes, and every step says something', () => {
    for (const l of ALL) {
      for (const s of l.steps) {
        expect(['read', 'click', 'trace', 'change']).toContain(s.kind);
        expect(s.title).not.toBe('');
        if (s.kind !== 'read') expect(s.after).not.toBe('');
      }
    }
  });
});

describe.each([
  ['drawn as sketches', new Map<string, CatalogueModel>()],
  ['drawn from the catalogue', new Map(CATALOGUE.map((m) => [modelKey(m.vendor, m.model), m]))],
])('each lesson on its sample, %s', (_, models) => {
  it.each(ALL.map((l) => [l.id, l] as const))('%s holds step by step', (_, l: Lesson) => {
    const mirror = new Mirror(engine);
    const paste: SamplePaste = (doc, deviceId, text, platform) => {
      mirror.load(doc);
      return mirror.pasteInto(deviceId, text, platform).doc;
    };
    let doc = buildSample(sample(l.sample), models, undefined, paste).doc;
    l.steps.forEach((step: LessonStep, i) => {
      const where = `${l.id} step ${i + 1}`;
      mirror.load(doc);
      if (step.kind === 'click') {
        const answer =
          'device' in step.answer ? deviceByHostname(doc, step.answer.device) : cableOnPort(doc, portByRef(doc, step.answer.cable) ?? '');
        expect(answer, where).not.toBeNull();
        expect(checkClick(doc, step, answer).state, where).toBe('passed');
        // A wrong pick gets the hint, never a pass.
        const other = deviceByHostname(doc, 'desktop-1')!;
        if (answer !== other) expect(checkClick(doc, step, other), where).toEqual({ state: 'wrong', detail: step.hint });
      } else if (step.kind === 'trace') {
        const args = traceArgs(doc, step);
        expect(args, where).not.toBeNull();
        const result = mirror.trace(args!.from, args!.to, args!.flow);
        expect(checkTrace(step.expect, result), `${where}: ${JSON.stringify(result.hops.map((h) => h.title))} ${result.stopped}`).toEqual({
          state: 'passed',
        });
      } else if (step.kind === 'change') {
        expect(checkChange(step, mirror.checks()).state, `${where}, before the change`).toBe('waiting');
        const change = CHANGES[`${l.id}/${i}`];
        expect(change, `${where} has no change in this test`).toBeDefined();
        doc = change!(doc);
        mirror.load(doc);
        expect(checkChange(step, mirror.checks()).state, `${where}, after the change`).toBe('passed');
      }
    });
  });

  it('opens the small office with nothing a check refuses or warns about', () => {
    const mirror = new Mirror(engine);
    const paste: SamplePaste = (doc, deviceId, text, platform) => {
      mirror.load(doc);
      return mirror.pasteInto(deviceId, text, platform).doc;
    };
    const doc = buildSample(sample('small-office'), models, undefined, paste).doc;
    mirror.load(doc);
    const findings = mirror.checks().findings;
    expect(findings.filter((f) => f.severity !== 'idea')).toEqual([]);
    expect(findings.map((f) => f.rule)).toEqual(['topo.switch.single-cable']);
  });
});
