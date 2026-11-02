// A plan's other ending (schema 0.37, sign-off r94-plan-next): called off before any work, and planned again.
import { describe, expect, it } from 'vitest';

import { emptyDocument, type Document } from './model';
import {
  PlanRefusal,
  addCheck,
  addStep,
  backOut,
  callOff,
  calledOffWhy,
  createPlan,
  isOver,
  listPlans,
  planAgain,
  planProblems,
  readPlan,
  recordPlan,
  setPlanHead,
  setReleaseNotes,
  startPlan,
  TYPED_AS_WRITTEN,
} from './plans';
import { planRoute, bandSentence } from '../components/plans/plansModel';

const tick = (() => {
  let now = 1_790_900_000_000;
  return () => ({ actor: '01ARZ3NDEKTSV4RRFFQ69G5FAV', now: (now += 1000) });
})();
const gate = (t: string) => t.replace(/hunter2-[A-Za-z0-9]+/g, '<REDACTED>');

function planned(): { doc: Document; id: string } {
  const made = createPlan(emptyDocument(), { title: 'Junos upgrade on srx1500', gate: TYPED_AS_WRITTEN, ...tick() });
  const step = addStep(made.doc, made.id, { kind: 'other', change: 'request system software add', targets: [], gate: TYPED_AS_WRITTEN, ...tick() });
  return { doc: step.doc, id: made.id };
}

function refusal(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    if (e instanceof PlanRefusal) return e.code;
    throw e;
  }
  return 'none';
}

describe('calling a plan off', () => {
  it('stops a plan still being planned, keeps the reason and the note, and changes nothing else', () => {
    const { doc, id } = planned();
    const off = callOff(doc, id, { reason: 'not_needed', note: 'JTAC says 22.4R3 already has the fix', gate, ...tick() });
    const plan = readPlan(off, id);
    expect(plan.stage).toBe('called_off');
    expect(plan.outcome).toBeNull();
    expect(plan.steps.map((s) => s.state)).toEqual(['planned']);
    expect(calledOffWhy(plan)).toEqual({ reason: 'Not needed', note: 'JTAC says 22.4R3 already has the fix' });
    expect(isOver(plan)).toBe(true);
    expect(planProblems(plan)).toEqual([]);
    expect(off.batches.at(-1)?.label).toBe('Junos upgrade on srx1500: called off');
    // It stays in the list, as called off.
    expect(listPlans(off).map((p) => p.stage)).toEqual(['called_off']);
  });

  it('passes the note through the gate it is given, and keeps just the reason when there is no note', () => {
    const { doc, id } = planned();
    expect(readPlan(callOff(doc, id, { reason: 'troubleshoot', note: 'key hunter2-abc123', gate, ...tick() }), id).record).toBe('Troubleshooting first\nkey <REDACTED>');
    expect(readPlan(callOff(doc, id, { reason: 'done_another_way', gate, ...tick() }), id).record).toBe('Done another way');
  });

  it('refuses once the work has started, and refuses a reason that is not one', () => {
    const { doc, id } = planned();
    const started = startPlan(doc, id, tick());
    expect(refusal(() => callOff(started, id, { reason: 'not_needed', gate, ...tick() }))).toBe('not-planning');
    expect(refusal(() => callOff(doc, id, { reason: 'bored' as never, gate, ...tick() }))).toBe('bad-edit');
  });

  it('holds a called-off plan still: no steps, checks, notes, start, record or back out', () => {
    const { doc, id } = planned();
    const off = callOff(doc, id, { reason: 'not_needed', gate, ...tick() });
    const at = { gate: TYPED_AS_WRITTEN, ...tick() };
    expect(refusal(() => addStep(off, id, { kind: 'other', change: 'more', targets: [], ...at }))).toBe('called-off');
    expect(refusal(() => setPlanHead(off, id, { title: 'x' }, at))).toBe('called-off');
    expect(refusal(() => startPlan(off, id, tick()))).toBe('called-off');
    expect(refusal(() => addCheck(off, id, 'ping it', at))).toBe('called-off');
    expect(refusal(() => setReleaseNotes(off, id, 'notes', at))).toBe('called-off');
    expect(refusal(() => recordPlan(off, id, { outcome: 'succeeded', ...at }))).toBe('called-off');
    expect(refusal(() => backOut(off, id, tick()))).toBe('called-off');
  });

  it('plans it again as it was, and only a called-off plan', () => {
    const { doc, id } = planned();
    expect(refusal(() => planAgain(doc, id, tick()))).toBe('not-planning');
    const again = planAgain(callOff(doc, id, { reason: 'not_needed', note: 'later', gate, ...tick() }), id, tick());
    const plan = readPlan(again, id);
    expect(plan.stage).toBe('planned');
    expect(plan.record).toBe('');
    expect(plan.steps).toHaveLength(1);
    expect(readPlan(startPlan(again, id, tick()), id).stage).toBe('doing');
  });
});

describe('where a plan goes', () => {
  it('runs Plan, Maintenance, Checks after and Record, with where it is marked now', () => {
    const { doc, id } = planned();
    const route = planRoute(readPlan(doc, id));
    expect(route.map((s) => [s.word, s.at])).toEqual([
      ['Plan', 'now'],
      ['Maintenance', 'next'],
      ['Checks after', 'next'],
      ['Record', 'next'],
    ]);
    expect(route[1].detail).toBe('No window set');
    const windowed = setPlanHead(doc, id, { windowStart: '2026-11-08T02:00', windowEnd: '2026-11-08T04:00' }, { gate: TYPED_AS_WRITTEN, ...tick() });
    expect(planRoute(readPlan(windowed, id))[1].detail).toBe('Sun 8 Nov 02:00–04:00');
    expect(bandSentence(readPlan(windowed, id))).toBe('1 change · Maintenance next, Sun 8 Nov 02:00–04:00');
    const doing = planRoute(readPlan(startPlan(doc, id, tick()), id));
    expect(doing.map((s) => s.at)).toEqual(['done', 'now', 'next', 'next']);
    expect(doing[1].detail).toBe('Step 1 of 1');
  });

  it('a called-off plan stops after Plan, and the maintenance never happens', () => {
    const { doc, id } = planned();
    const plan = readPlan(callOff(doc, id, { reason: 'troubleshoot', gate, ...tick() }), id);
    expect(planRoute(plan).map((s) => [s.word, s.detail, s.at])).toEqual([
      ['Plan', '1 step', 'done'],
      ['Called off', 'Troubleshooting first', 'now'],
      ['Maintenance', 'Not done', 'skipped'],
      ['Record', 'Not needed', 'skipped'],
    ]);
    expect(bandSentence(plan)).toBe('Troubleshooting first · nothing was changed');
  });
});
