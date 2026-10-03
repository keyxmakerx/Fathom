import { describe, expect, it } from 'vitest';

import { connectPorts } from './cables';
import { addSketchPort, createSketchDevice } from './commands';
import { setDeviceField } from './edit';
import { begin, finish, setNodeField } from './freeform';
import { edgesOut, emptyDocument, findNode, text, type Document } from './model';
import {
  PlanRefusal,
  addStep,
  applyEdit,
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
  setPlanHead,
  recordedPlansTouching,
  removeStep,
  startPlan,
  touchedBy,
  type StepEdit,
} from './plans';
import { UndoConflictError, undo } from './undo';

const tick = (() => {
  let now = 1_790_900_000_000;
  return () => ({ actor: '01ARZ3NDEKTSV4RRFFQ69G5FAV', now: (now += 1000) });
})();
const gate = (t: string) => t.replace(/hunter2-[A-Za-z0-9]+/g, '<REDACTED>');
const allow = () => null;

function lab(): { doc: Document; device: string; ports: string[]; cable: string } {
  let doc = emptyDocument();
  const ports: string[] = [];
  let device = '';
  for (const label of ['Et1', 'Et2', 'Et3', 'Et4', 'Et5']) {
    const before = new Set(doc.nodes.map((n) => n.id));
    doc = createSketchDevice(doc, tick());
    const fresh = doc.nodes.filter((n) => !before.has(n.id));
    const chassis = fresh.find((n) => n.id.startsWith('chassis:'))!.id;
    if (device === '') device = fresh.find((n) => n.id.startsWith('device:'))!.id;
    doc = addSketchPort(doc, chassis, { label, connector: 'rj45', face: 'front' }, tick());
    ports.push(edgesOut(doc, chassis, 'HasPort')[0]!.to);
  }
  doc = connectPorts(doc, ports[3], ports[4], {}, tick());
  const cable = doc.nodes.find((n) => n.id.startsWith('cable:'))!.id;
  return { doc, device, ports, cable };
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

  it('round-trips hostile values and refuses a separator in any slot', () => {
    const values = ['', ' ', '$9$Qz7Lx-VYgoJDm5T3', '"q" \\   \u0000 😀 é', 'x'.repeat(100_000), 'a=b:c,d', '\\t'];
    for (const value of values) {
      const e: StepEdit = { t: 'field', id: 'device:A', key: 'Device.role', value };
      expect(decodeEdit(encodeEdit(e))).toEqual(e);
    }
    for (const bad of ['\t', '\n', '\r', 'a\tb', 'a\r\nb']) {
      const edits: StepEdit[] = [
        { t: 'field', id: bad, key: 'Device.role', value: 'x' },
        { t: 'field', id: 'd', key: bad, value: 'x' },
        { t: 'field', id: 'd', key: 'Device.role', value: bad },
        { t: 'cable', a: bad, b: 'b' },
        { t: 'cable', a: 'a', b: bad },
        { t: 'cut', cable: bad },
        { t: 'move', chassis: bad, rack: 'r', positionU: 1, face: 'front' },
        { t: 'move', chassis: 'c', rack: bad, positionU: 1, face: 'front' },
      ];
      for (const e of edits) expect(refusal(() => encodeEdit(e)).code).toBe('bad-edit');
    }
  });

  it('reads a hostile line as null, or as exactly what it says', () => {
    for (const line of [
      '',
      '\t',
      'field',
      'field\ta\tb',
      'field\ta\tb\tc\td',
      'cut',
      'cut\ta\tb',
      'cable\ta',
      'move\tc\tr\t1',
      'move\tc\tr\t1.5\tfront',
      'move\tc\tr\tNaN\tfront',
      'move\tc\tr\t1\tside',
      'move\tc\tr\t1\tfront\textra',
      'FIELD\ta\tb\tc',
      '\u0000',
    ]) {
      expect(decodeEdit(line), JSON.stringify(line)).toBeNull();
    }
    expect(decodeEdit(undefined)).toBeNull();
    // Kept lenient on purpose: whether it may be applied is `applyEdit`'s call, not the reader's.
    expect(decodeEdit('field\t\t\t')).toEqual({ t: 'field', id: '', key: '', value: '' });
    expect(decodeEdit('cable\ta\tb\textra')).toEqual({ t: 'cable', a: 'a', b: 'b' });
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
    const { doc, ports, cable } = lab();
    const made = plan(doc, [
      { t: 'cable', a: ports[0], b: ports[1] },
      { t: 'cut', cable },
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
    const { doc, ports } = lab();
    const empty = createPlan(doc, { title: 'x', gate, ...tick() });
    expect(() => startPlan(empty.doc, empty.id)).toThrow(/add a step/);
    const made = plan(doc, [{ t: 'cable', a: ports[0], b: ports[1] }]);
    expect(() => markDone(made.doc, made.steps[0], { check: allow })).toThrow(/start the work/);
  });

  it('a refusal from the checks blocks Done and leaves the design as it was', () => {
    const { doc, ports } = lab();
    const made = plan(doc, [{ t: 'cable', a: ports[0], b: ports[1] }]);
    const d = startPlan(made.doc, made.id, tick());
    const refuse = () => markDone(d, made.steps[0], { check: () => ({ title: 'port already cabled' }), ...tick() });
    expect(refuse).toThrow(/already cabled/);
    expect(d.edges.some((e) => e.id.startsWith('terminates:') && e.to === ports[0])).toBe(false);
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
    expect(after.edges.some((e) => e.id.startsWith('terminates:') && e.to === ports[0])).toBe(false);
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
    const { doc, ports, cable } = lab();
    const made = plan(doc, [
      { t: 'cable', a: ports[0], b: ports[1] },
      { t: 'cut', cable },
      { t: 'cut', cable },
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
  // `gate` here is a stand-in that only knows this marker. It proves each field is routed through
  // the gate inside the command; that the real gate stops real device secrets is engine.test.ts.
  const SECRET = 'hunter2-Zk9Qw3Lm0PxV7tYs';

  it('every typed field is gated inside the command', () => {
    const { doc, device } = lab();
    const made = createPlan(doc, { title: `Swap ${SECRET}`, author: `by ${SECRET}`, gate, ...tick() });
    const s = addStep(made.doc, made.id, {
      kind: 'other',
      change: `set password ${SECRET}`,
      before: `old ${SECRET}`,
      after: `new ${SECRET}`,
      edit: { t: 'field', id: device, key: 'Device.role', value: SECRET },
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
    const { doc, device } = lab();
    const made = createPlan(doc, { title: 'x', gate });
    expect(() =>
      addStep(made.doc, made.id, { kind: 'other', change: 'x', edit: { t: 'field', id: device, key: 'Device.platform', value: 'x' }, gate }),
    ).toThrow(/not a field/);
  });
});

const JUNOS_PSK_LINE = 'set security ike policy ike-pol pre-shared-key ascii-text "Ab3dE6gH"';

function refusal(fn: () => unknown): PlanRefusal {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PlanRefusal);
    return e as PlanRefusal;
  }
  throw new Error('expected a PlanRefusal');
}

/** Writes `edit` onto a step straight into the document, the way a hand-edited file or hostile client could. */
function craft(doc: Document, stepId: string, edit: string): Document {
  const b = begin(doc, tick());
  setNodeField(b, stepId, 'PlanStep.edit', text(edit));
  return finish(b, 'crafted');
}

describe('a crafted step is refused where it is applied', () => {
  const lines = (device: string, port: string): string[] => [
    `field\t${device}\tDevice.platform\tjunos-srx`,
    `field\t${device}\tRack.row\tR1`,
    `field\t${port}\tDevice.management_address\t10.0.0.1`,
    `field\t${device}\tMaintenancePlan.stage\trecorded`,
    `field\t${device}\tNope.nothing\tx`,
  ];

  it('markDone refuses each, applies nothing and never asks the checks', () => {
    const { doc, device, ports } = lab();
    for (const line of lines(device, ports[0])) {
      const base = plan(doc, [{ t: 'field', id: device, key: 'Device.role', value: 'x' }]);
      const crafted = startPlan(craft(base.doc, base.steps[0], line), base.id, tick());
      let asked = false;
      const check = (): null => {
        asked = true;
        return null;
      };
      const r = refusal(() => markDone(crafted, base.steps[0], { check, ...tick() }));
      expect(r.code, line).toBe('bad-edit');
      expect(asked, line).toBe(false);
      expect(readPlan(crafted, base.id).steps[0].state).toBe('planned');
    }
  });

  it('applyEdit refuses them too', () => {
    const { doc, device, ports } = lab();
    const edits: StepEdit[] = [
      { t: 'field', id: device, key: 'Device.platform', value: 'x' },
      { t: 'field', id: device, key: 'Rack.row', value: 'R1' },
      { t: 'field', id: ports[0], key: 'Device.management_address', value: '10.0.0.1' },
      { t: 'field', id: 'device:not-an-id', key: 'Device.role', value: 'x' },
      { t: 'field', id: device, key: 'Device.role.extra', value: 'x' },
    ];
    for (const e of edits) expect(refusal(() => applyEdit(doc, e, tick())).code).toBe('bad-edit');
  });

  it('addStep refuses them, and ids that are malformed or not in the design', () => {
    const { doc, device, ports, cable } = lab();
    const made = createPlan(doc, { title: 'x', gate, ...tick() });
    const bad: StepEdit[] = [
      { t: 'field', id: device, key: 'Rack.row', value: 'R1' },
      { t: 'field', id: ports[0], key: 'Device.role', value: 'x' },
      { t: 'field', id: 'device:01ARZ3NDEKTSV4RRFFQ69G5FAV', key: 'Device.role', value: 'x' },
      { t: 'field', id: JUNOS_PSK_LINE, key: 'Device.role', value: 'x' },
      { t: 'cable', a: ports[0], b: JUNOS_PSK_LINE },
      { t: 'cable', a: ports[0], b: device },
      { t: 'cable', a: ports[0], b: 'physical-port:A' },
      { t: 'cut', cable: JUNOS_PSK_LINE },
      { t: 'cut', cable: ports[0] },
      { t: 'cut', cable: `${cable}\tx` },
      { t: 'move', chassis: ports[0], rack: ports[1], positionU: 1, face: 'front' },
      { t: 'move', chassis: 'chassis:x', rack: 'rack:y', positionU: 1.5, face: 'front' },
    ];
    for (const edit of bad) {
      expect(refusal(() => addStep(made.doc, made.id, { kind: 'other', change: 'x', edit, gate })).code, JSON.stringify(edit)).toBe('bad-edit');
    }
    for (const targets of [[JUNOS_PSK_LINE], ['device:01ARZ3NDEKTSV4RRFFQ69G5FAV'], [device, 'nonsense'], ['']]) {
      expect(refusal(() => addStep(made.doc, made.id, { kind: 'other', change: 'x', targets, gate })).code).toBe('bad-edit');
    }
    // The honest form still goes in.
    const ok = addStep(made.doc, made.id, { kind: 'other', change: 'x', targets: [device, cable], gate });
    expect(readPlan(ok.doc, made.id).steps[0].targets).toEqual([device, cable]);
  });
});

describe('the window is a date and time', () => {
  it('refuses a pasted device line, and anything that is not an ISO date-time', () => {
    const { doc } = lab();
    for (const bad of [JUNOS_PSK_LINE, 'tomorrow', '2026-13-45T25:00', '2026-10-03', '2026-10-03 22:00', '2026-10-03T22:00 pre-shared-key Ab3dE6gH']) {
      expect(refusal(() => createPlan(doc, { title: 'x', windowStart: bad, gate })).code, bad).toBe('bad-text');
      expect(refusal(() => createPlan(doc, { title: 'x', windowEnd: bad, gate })).code, bad).toBe('bad-text');
    }
    const made = createPlan(doc, { title: 'x', gate, ...tick() });
    expect(refusal(() => setPlanHead(made.doc, made.id, { windowStart: JUNOS_PSK_LINE }, { gate })).code).toBe('bad-text');
    expect(refusal(() => setPlanHead(made.doc, made.id, { windowEnd: JUNOS_PSK_LINE }, { gate })).code).toBe('bad-text');
  });

  it('takes what a date-time field gives, or nothing', () => {
    const { doc } = lab();
    for (const ok of ['2026-10-03T22:00', '2026-10-03T22:00:30', '2026-10-04T02:00:00.000Z', '2026-10-04T02:00:00+01:00']) {
      const made = createPlan(doc, { title: 'x', windowStart: ok, windowEnd: ok, gate, ...tick() });
      expect(readPlan(made.doc, made.id).windowStart).toBe(ok);
      const edited = setPlanHead(made.doc, made.id, { windowStart: '', windowEnd: ok }, { gate, ...tick() });
      expect(readPlan(edited, made.id).windowStart).toBe('');
    }
    const none = createPlan(doc, { title: 'x', windowStart: '', gate, ...tick() });
    expect(readPlan(none.doc, none.id).windowStart).toBe('');
  });
});

describe('batch labels stay inside the bound', () => {
  const bytes = (s: string): number => new TextEncoder().encode(s).length;

  it('long and multi-byte titles never mint a label past 60 bytes or half a character', () => {
    const { doc, ports } = lab();
    for (const title of ['x'.repeat(500), '日本語のタイトル'.repeat(40), `${'a'.repeat(57)}😀😀`, `${'a'.repeat(58)}😀`, '😀'.repeat(100)]) {
      const made = createPlan(doc, { title, gate, ...tick() });
      const s = addStep(made.doc, made.id, { kind: 'cable', change: 'x', edit: { t: 'cable', a: ports[0], b: ports[1] }, gate, ...tick() });
      let d = startPlan(s.doc, made.id, tick());
      d = markDone(d, s.id, { check: allow, ...tick() });
      const s2 = addStep(made.doc, made.id, { kind: 'other', change: 'y', gate, ...tick() });
      let e = startPlan(s2.doc, made.id, tick());
      e = markWentDifferently(e, s2.id, { note: 'n', gate, ...tick() });
      e = recordPlan(e, made.id, { outcome: 'succeeded', gate, ...tick() });
      for (const label of [...d.batches, ...e.batches].map((b) => b.label)) {
        expect(bytes(label), label).toBeLessThanOrEqual(60);
        expect(label).not.toMatch(/�/);
        expect(label).not.toMatch(/[\ud800-\udbff]$/);
      }
    }
  });
});

describe('a recorded plan is never undone', () => {
  const actor = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

  it('refuses any batch that set a field on the plan or its steps, after recording', () => {
    const { doc, ports } = lab();
    const made = plan(doc, [{ t: 'cable', a: ports[0], b: ports[1] }]);
    const d = startPlan(made.doc, made.id, tick());
    const marked = markDone(d, made.steps[0], { check: allow, ...tick() });
    // While the plan is only being done, one step can still be taken back.
    const back = undo(marked, marked.batches[marked.batches.length - 1].id, { actor, now: 1_790_990_000_000 });
    expect(readPlan(back, made.id).steps[0].state).toBe('planned');
    const recorded = recordPlan(marked, made.id, { outcome: 'succeeded', gate, ...tick() });
    const sets = recorded.batches.filter((b) =>
      b.ops.some((o) => o.type === 'set_field' && (o.element === made.id || o.element === made.steps[0])),
    );
    expect(sets.length).toBeGreaterThanOrEqual(3);
    for (const batch of sets) {
      let err: unknown;
      try {
        undo(recorded, batch.id, { actor, now: 1_790_990_000_000 });
      } catch (e) {
        err = e;
      }
      expect(err, batch.label).toBeInstanceOf(UndoConflictError);
      expect((err as UndoConflictError).conflict.kind, batch.label).toBe('recorded-plan');
    }
  });
});

describe('no plan text says what is forbidden', () => {
  const FORBIDDEN = /zero-knowledge|end-to-end|we cannot read your data|only you hold the key/i;

  it('refusals, batch labels and plan fields in every stage avoid the four phrases', () => {
    const { doc, device, ports } = lab();
    const texts: string[] = [];
    const note = (fn: () => unknown): void => {
      try {
        fn();
      } catch (e) {
        texts.push(String((e as Error).message));
      }
    };
    const made = plan(doc, [{ t: 'cable', a: ports[0], b: ports[1] }]);
    // Stage planned.
    note(() => markDone(made.doc, made.steps[0], { check: allow }));
    note(() => recordPlan(made.doc, made.id, { outcome: 'failed', gate }));
    note(() => createPlan(doc, { title: ' ', gate }));
    note(() => addStep(made.doc, made.id, { kind: 'other', change: 'x', edit: { t: 'cut', cable: device }, gate }));
    note(() => undo(made.doc, made.doc.batches[made.doc.batches.length - 1].id, { actor: 'someone-else', now: 1 }));
    // Stage doing.
    let d = startPlan(made.doc, made.id, tick());
    note(() => addStep(d, made.id, { kind: 'other', change: 'x', gate }));
    note(() => markWentDifferently(d, made.steps[0], { note: '', gate }));
    note(() => markDone(d, made.steps[0], { check: () => ({ title: 'refused' }), ...tick() }));
    d = markDone(d, made.steps[0], { check: allow, ...tick() });
    note(() => markDone(d, made.steps[0], { check: allow }));
    // Stage recorded.
    d = recordPlan(d, made.id, { outcome: 'succeeded', text: 'ok', gate, ...tick() });
    note(() => recordPlan(d, made.id, { outcome: 'failed', gate }));
    note(() => removeStep(d, made.steps[0]));
    note(() => undo(d, d.batches[d.batches.length - 1].id, { actor: '01ARZ3NDEKTSV4RRFFQ69G5FAV', now: 1 }));
    for (const label of d.batches.map((b) => b.label)) texts.push(label);
    texts.push(JSON.stringify(listPlans(d)));
    expect(texts.length).toBeGreaterThan(10);
    for (const t of texts) expect(t).not.toMatch(FORBIDDEN);
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
    const { doc, ports, cable } = lab();
    const made = plan(doc, [
      { t: 'cut', cable },
      { t: 'cut', cable },
    ]);
    const p = readPlan(made.doc, made.id);
    p.steps[1].state = 'done';
    expect(planProblems(p).join()).toMatch(/before the plan started|before an earlier/);
    void ports;
    void setDeviceField;
  });
});
