import { describe, expect, it } from 'vitest';

import { connectPorts } from './cables';
import { addSketchPort, createSketchDevice } from './commands';
import { setDeviceField } from './edit';
import { edgesOut, emptyDocument, findNode, type Document } from './model';
import {
  PlanRefusal,
  addStep,
  createPlan,
  currentStep,
  decodeEdit,
  encodeEdit,
  listPlans,
  markDone,
  markWentDifferently,
  moveStep,
  planProblems,
  readPlan,
  recordPlan,
  recordedPlansTouching,
  removeStep,
  startPlan,
  touchedBy,
  type StepEdit,
} from './plans';

const tick = (() => {
  let now = 1_790_900_000_000;
  return () => ({ actor: '01ARZ3NDEKTSV4RRFFQ69G5FAV', now: (now += 1000) });
})();
const gate = (t: string) => t.replace(/hunter2-[A-Za-z0-9]+/g, '<REDACTED>');
const allow = () => null;

function lab(): { doc: Document; device: string; ports: string[] } {
  let doc = emptyDocument();
  const ports: string[] = [];
  let device = '';
  for (const label of ['Et1', 'Et2', 'Et3']) {
    const before = new Set(doc.nodes.map((n) => n.id));
    doc = createSketchDevice(doc, tick());
    const fresh = doc.nodes.filter((n) => !before.has(n.id));
    const chassis = fresh.find((n) => n.id.startsWith('chassis:'))!.id;
    if (device === '') device = fresh.find((n) => n.id.startsWith('device:'))!.id;
    doc = addSketchPort(doc, chassis, { label, connector: 'rj45', face: 'front' }, tick());
    ports.push(edgesOut(doc, chassis, 'HasPort')[0]!.to);
  }
  return { doc, device, ports };
}

function plan(doc: Document, edits: StepEdit[]): { doc: Document; id: string; steps: string[] } {
  let made = createPlan(doc, { title: 'Move uplink', gate, ...tick() });
  const steps: string[] = [];
  for (const [i, edit] of edits.entries()) {
    const s = addStep(made.doc, made.id, { kind: 'cable', change: `step ${i}`, edit, gate, ...tick() });
    made = { doc: s.doc, id: made.id };
    steps.push(s.id);
  }
  return { doc: made.doc, id: made.id, steps };
}

describe('the edit a step holds', () => {
  it('round-trips each kind and refuses a tab or line break', () => {
    const edits: StepEdit[] = [
      { t: 'field', id: 'device:A', key: 'Device.management_address', value: '10.0.0.9' },
      { t: 'cable', a: 'physical-port:A', b: 'physical-port:B' },
      { t: 'cut', cable: 'cable:C' },
      { t: 'move', chassis: 'chassis:A', rack: 'rack:R', positionU: 4, face: 'front' },
    ];
    for (const e of edits) expect(decodeEdit(encodeEdit(e))).toEqual(e);
    expect(() => encodeEdit({ t: 'field', id: 'device:A', key: 'Device.role', value: 'a\nb' })).toThrow(PlanRefusal);
    expect(decodeEdit('nonsense')).toBeNull();
    expect(decodeEdit('move\tc\tr\tx\tfront')).toBeNull();
  });
});

describe('a plan in order', () => {
  it('runs planned, doing, recorded and applies each edit only on Done', () => {
    const { doc, device, ports } = lab();
    const made = plan(doc, [
      { t: 'cable', a: ports[0], b: ports[1] },
      { t: 'field', id: device, key: 'Device.management_address', value: '10.0.0.9' },
    ]);
    // Nothing touches the design while planning.
    expect(edgesOut(made.doc, ports[0], 'Terminates')).toHaveLength(0);
    expect(findNode(made.doc, device)!.fields['Device.management_address']).toBeUndefined();

    let d = startPlan(made.doc, made.id, tick());
    expect(readPlan(d, made.id).stage).toBe('doing');
    expect(currentStep(readPlan(d, made.id))?.id).toBe(made.steps[0]);

    d = markDone(d, made.steps[0], { check: allow, ...tick() });
    const cabled = d.edges.some((e) => e.id.startsWith('terminates:') && e.to === ports[0]);
    expect(cabled).toBe(true);
    expect(readPlan(d, made.id).steps[0].state).toBe('done');
    expect(readPlan(d, made.id).steps[0].doneAt).not.toBe('');

    d = markDone(d, made.steps[1], { check: allow, ...tick() });
    expect(findNode(d, device)!.fields['Device.management_address']?.value).toBe('10.0.0.9');

    d = recordPlan(d, made.id, { outcome: 'succeeded', gate, ...tick() });
    const p = readPlan(d, made.id);
    expect(p.stage).toBe('recorded');
    expect(p.outcome).toBe('succeeded');
    expect(planProblems(p)).toEqual([]);
    // One undo step per Done, labelled with the plan.
    expect(d.batches.some((b) => b.label === 'Move uplink: step 1 done')).toBe(true);
  });

  it('keeps order: a later step cannot be marked, nor one twice', () => {
    const { doc, ports } = lab();
    const made = plan(doc, [
      { t: 'cable', a: ports[0], b: ports[1] },
      { t: 'cut', cable: 'cable:none' },
    ]);
    const d = startPlan(made.doc, made.id, tick());
    expect(() => markDone(d, made.steps[1], { check: allow, ...tick() })).toThrow(/earlier step/);
    const first = markDone(d, made.steps[0], { check: allow, ...tick() });
    // A second editor still holding the old document marks the same step: refused, no double apply.
    const again = () => markDone(first, made.steps[0], { check: allow, ...tick() });
    expect(again).toThrow(PlanRefusal);
    expect(first.edges.filter((e) => e.id.startsWith('terminates:') && e.to === ports[0])).toHaveLength(1);
  });

  it('refuses to start without steps, and to mark before starting', () => {
    const { doc } = lab();
    const empty = createPlan(doc, { title: 'x', gate, ...tick() });
    expect(() => startPlan(empty.doc, empty.id)).toThrow(/add a step/);
    const made = plan(doc, [{ t: 'cable', a: 'physical-port:A', b: 'physical-port:B' }]);
    expect(() => markDone(made.doc, made.steps[0], { check: allow })).toThrow(/start the work/);
  });

  it('a refusal from the checks blocks Done and leaves the design as it was', () => {
    const { doc, ports } = lab();
    const made = plan(doc, [{ t: 'cable', a: ports[0], b: ports[1] }]);
    const d = startPlan(made.doc, made.id, tick());
    const refuse = () => markDone(d, made.steps[0], { check: () => ({ title: 'port already cabled' }), ...tick() });
    expect(refuse).toThrow(/already cabled/);
    expect(d.edges.some((e) => e.id.startsWith('terminates:'))).toBe(false);
  });

  it('an edit the design cannot take blocks Done too (a port already cabled)', () => {
    const { doc, ports } = lab();
    const cabled = connectPorts(doc, ports[0], ports[2], {}, tick());
    const made = plan(cabled, [{ t: 'cable', a: ports[0], b: ports[1] }]);
    const d = startPlan(made.doc, made.id, tick());
    expect(() => markDone(d, made.steps[0], { check: allow, ...tick() })).toThrow();
    expect(readPlan(d, made.id).steps[0].state).toBe('planned');
  });

  it('went differently needs a note and applies nothing', () => {
    const { doc, ports } = lab();
    const made = plan(doc, [{ t: 'cable', a: ports[0], b: ports[1] }]);
    const d = startPlan(made.doc, made.id, tick());
    expect(() => markWentDifferently(d, made.steps[0], { note: '  ', gate })).toThrow(/what happened/);
    const after = markWentDifferently(d, made.steps[0], { note: 'used the patch panel', gate, ...tick() });
    const step = readPlan(after, made.id).steps[0];
    expect(step.state).toBe('went_differently');
    expect(step.note).toBe('used the patch panel');
    expect(after.edges.some((e) => e.id.startsWith('terminates:'))).toBe(false);
  });

  it('recording needs every step marked, and a recorded plan never changes', () => {
    const { doc, ports } = lab();
    const made = plan(doc, [{ t: 'cable', a: ports[0], b: ports[1] }]);
    let d = startPlan(made.doc, made.id, tick());
    expect(() => recordPlan(d, made.id, { outcome: 'failed', gate })).toThrow(/mark every step/);
    d = markWentDifferently(d, made.steps[0], { note: 'skipped', gate, ...tick() });
    d = recordPlan(d, made.id, { outcome: 'partial', text: 'the vendor was late', gate, ...tick() });
    expect(readPlan(d, made.id).record).toBe('the vendor was late');
    expect(() => recordPlan(d, made.id, { outcome: 'succeeded', gate })).toThrow(/recorded/);
    expect(() => addStep(d, made.id, { kind: 'other', change: 'x', gate })).toThrow(/recorded/);
    expect(() => removeStep(d, made.steps[0])).toThrow(/recorded/);
    expect(() => markDone(d, made.steps[0], { check: allow })).toThrow(/recorded/);
  });

  it('steps reorder and renumber only while planning', () => {
    const { doc, ports } = lab();
    const made = plan(doc, [
      { t: 'cable', a: ports[0], b: ports[1] },
      { t: 'cut', cable: 'cable:x' },
      { t: 'cut', cable: 'cable:y' },
    ]);
    let d = moveStep(made.doc, made.steps[2], 0, tick());
    expect(readPlan(d, made.id).steps.map((s) => s.id)).toEqual([made.steps[2], made.steps[0], made.steps[1]]);
    d = removeStep(d, made.steps[0], tick());
    expect(readPlan(d, made.id).steps.map((s) => s.ordinal)).toEqual([0, 1]);
    d = startPlan(d, made.id, tick());
    expect(() => moveStep(d, made.steps[1], 0)).toThrow(/before work starts/);
    expect(() => removeStep(d, made.steps[1])).toThrow(/before work starts/);
  });
});

describe('text passes the gate', () => {
  const SECRET = 'hunter2-Zk9Qw3Lm0PxV7tYs'; // longer than any device's own limit: rule 2 is checked against the real gate in engine.test.ts

  it('every typed field is gated inside the command', () => {
    const { doc, ports } = lab();
    let made = createPlan(doc, { title: `Swap ${SECRET}`, gate, ...tick() });
    const s = addStep(made.doc, made.id, {
      kind: 'other',
      change: `set password ${SECRET}`,
      before: `old ${SECRET}`,
      after: `new ${SECRET}`,
      edit: { t: 'field', id: ports[0], key: 'Device.role', value: SECRET },
      gate,
      ...tick(),
    });
    let d = startPlan(s.doc, made.id, tick());
    d = markWentDifferently(d, s.id, { note: `pasted: ${SECRET}`, gate, ...tick() });
    d = recordPlan(d, made.id, { outcome: 'failed', text: `line: ${SECRET}`, gate, ...tick() });
    expect(JSON.stringify(d.nodes)).not.toContain(SECRET);
    expect(JSON.stringify(d.nodes)).toContain('<REDACTED>');
  });

  it('a field no hand can set is refused', () => {
    const { doc } = lab();
    const made = createPlan(doc, { title: 'x', gate });
    expect(() =>
      addStep(made.doc, made.id, { kind: 'other', change: 'x', edit: { t: 'field', id: 'device:A', key: 'Device.platform', value: 'x' }, gate }),
    ).toThrow(/not a field/);
  });
});

describe('reading', () => {
  it('lists plans, what each touches, and History for a recorded one', () => {
    const { doc, device, ports } = lab();
    const made = plan(doc, [
      { t: 'cable', a: ports[0], b: ports[1] },
      { t: 'field', id: device, key: 'Device.role', value: 'switch' },
    ]);
    expect(touchedBy(readPlan(made.doc, made.id))).toEqual([ports[0], ports[1], device]);
    let d = startPlan(made.doc, made.id, tick());
    d = markDone(d, made.steps[0], { check: allow, ...tick() });
    expect(recordedPlansTouching(d, device)).toEqual([]);
    d = markDone(d, made.steps[1], { check: allow, ...tick() });
    d = recordPlan(d, made.id, { outcome: 'succeeded', gate, author: undefined, ...tick() } as never);
    expect(recordedPlansTouching(d, device).map((p) => p.id)).toEqual([made.id]);
    expect(recordedPlansTouching(d, 'device:other')).toEqual([]);
    expect(listPlans(d)).toHaveLength(1);
  });

  it('flags a document whose states are out of order', () => {
    const { doc, ports } = lab();
    const made = plan(doc, [
      { t: 'cut', cable: 'cable:x' },
      { t: 'cut', cable: 'cable:y' },
    ]);
    const p = readPlan(made.doc, made.id);
    p.steps[1].state = 'done';
    expect(planProblems(p).join()).toMatch(/before the plan started|before an earlier/);
    void ports;
    void setDeviceField;
  });
});
