import { describe, expect, it } from 'vitest';

import { buildCanon } from '../checks/checksModel';
import { addSketchPort, createSketchDevice } from '../../document/commands';
import { closeIssue, createIssue, TYPED_AS_WRITTEN as ISSUE_TYPED } from '../../document/issues';
import { edgesOut, emptyDocument, type Document } from '../../document/model';
import { addStep, createPlan, markDone, readPlan, startPlan, TYPED_AS_WRITTEN, type StepEdit } from '../../document/plans';
import { clashNote, overlaps, planClashes, runningOn, windowSpan } from './clashes';

const tick = (() => {
  let now = 1_790_900_000_000;
  return () => ({ actor: '01ARZ3NDEKTSV4RRFFQ69G5FAV', now: (now += 1000) });
})();
const gate = TYPED_AS_WRITTEN;
const allow = () => null;

/** Two switches: core-sw1 with two ports, core-sw2 with one. */
function lab(): { doc: Document; sw1: string; sw2: string; p1: string; p2: string; p3: string } {
  const sw = (doc: Document, hostname: string, labels: string[]): { doc: Document; device: string; ports: string[] } => {
    const before = new Set(doc.nodes.map((n) => n.id));
    let d = createSketchDevice(doc, { hostname, ...tick() });
    const fresh = d.nodes.filter((n) => !before.has(n.id));
    const chassis = fresh.find((n) => n.id.startsWith('chassis:'))!.id;
    for (const label of labels) d = addSketchPort(d, chassis, { label, connector: 'rj45', face: 'front' }, tick());
    return { doc: d, device: fresh.find((n) => n.id.startsWith('device:'))!.id, ports: edgesOut(d, chassis, 'HasPort').map((e) => e.to) };
  };
  const a = sw(emptyDocument(), 'core-sw1', ['Gi1/0/47', 'Gi1/0/48']);
  const b = sw(a.doc, 'core-sw2', ['Gi1/0/1']);
  return { doc: b.doc, sw1: a.device, sw2: b.device, p1: a.ports[0], p2: a.ports[1], p3: b.ports[0] };
}

/** A step is an edit, or the ids it names when it has none (a port, say). */
function plan(doc: Document, title: string, edits: Array<StepEdit | string[]>, windowStart = '', windowEnd = ''): { doc: Document; id: string; steps: string[] } {
  let made = createPlan(doc, { title, windowStart, windowEnd, gate, ...tick() });
  const steps: string[] = [];
  for (const [i, e] of edits.entries()) {
    const what = Array.isArray(e) ? { kind: 'other' as const, targets: e } : { kind: 'cable' as const, edit: e };
    const s = addStep(made.doc, made.id, { ...what, change: `step ${i}`, gate, ...tick() });
    made = { doc: s.doc, id: made.id };
    steps.push(s.id);
  }
  return { ...made, steps };
}

describe('windows', () => {
  it('reads a bare date as the whole day and an unread end as open', () => {
    const day = windowSpan('2026-11-04', '');
    expect(day.to - day.from).toBe(86_400_000 - 1);
    expect(windowSpan('2026-11-04T22:00', 'after lunch').to).toBe(Infinity);
    expect(windowSpan('', '').from).toBe(-Infinity);
  });

  it('overlaps when either starts before the other ends', () => {
    const night = windowSpan('2026-11-04T22:00', '2026-11-05T02:00');
    expect(overlaps(night, windowSpan('2026-11-04T23:00', '2026-11-05T01:00'))).toBe(true);
    expect(overlaps(night, windowSpan('2026-11-05T03:00', '2026-11-05T04:00'))).toBe(false);
  });
});

describe('planClashes', () => {
  it('names another plan on the same device in an overlapping window, and the shared port', () => {
    const l = lab();
    const a = plan(l.doc, 'Move uplinks', [{ t: 'cable', a: l.p2, b: l.p3 }], '2026-11-04T22:00', '2026-11-05T02:00');
    const b = plan(a.doc, 'Replace PSU', [[l.p2]], '2026-11-04T23:00', '2026-11-05T01:00');
    const canon = buildCanon(b.doc);
    const clashes = planClashes(b.doc, canon, readPlan(b.doc, a.id));
    expect(clashes).toHaveLength(1);
    expect(clashes[0]).toMatchObject({ kind: 'plan', id: b.id, title: 'Replace PSU', stage: 'planned', devices: ['core-sw1'], ports: ['core-sw1 · Gi1/0/48'] });
    // Both ways round.
    expect(planClashes(b.doc, canon, readPlan(b.doc, b.id)).map((c) => c.id)).toEqual([a.id]);
  });

  it('a different port on the same device still clashes, without a shared port', () => {
    const l = lab();
    const a = plan(l.doc, 'A', [{ t: 'cable', a: l.p1, b: l.p3 }]);
    const b = plan(a.doc, 'B', [[l.p2]]);
    const [c] = planClashes(b.doc, buildCanon(b.doc), readPlan(b.doc, a.id));
    expect(c).toMatchObject({ devices: ['core-sw1'], ports: [] });
  });

  it('windows that do not overlap do not clash; a plan with no window clashes with any', () => {
    const l = lab();
    const a = plan(l.doc, 'Tonight', [{ t: 'cable', a: l.p1, b: l.p3 }], '2026-11-04T22:00', '2026-11-05T02:00');
    const b = plan(a.doc, 'Next week', [[l.p1]], '2026-11-11T22:00', '2026-11-12T02:00');
    const c = plan(b.doc, 'Whenever', [[l.p3]]);
    const canon = buildCanon(c.doc);
    expect(planClashes(c.doc, canon, readPlan(c.doc, a.id)).map((x) => x.title)).toEqual(['Whenever']);
    expect(planClashes(c.doc, canon, readPlan(c.doc, c.id)).map((x) => x.title)).toEqual(['Tonight']);
  });

  it('another device is no clash', () => {
    const l = lab();
    const a = plan(l.doc, 'A', [[l.p1]]);
    const b = plan(a.doc, 'B', [[l.p3]]);
    expect(planClashes(b.doc, buildCanon(b.doc), readPlan(b.doc, a.id))).toEqual([]);
  });

  it('an open It\'s down issue on the device clashes; a closed one does not', () => {
    const l = lab();
    const a = plan(l.doc, 'Move uplinks', [{ t: 'cable', a: l.p2, b: l.p3 }], '2026-11-04T22:00', '2026-11-05T02:00');
    const made = createIssue(a.doc, { deviceId: l.sw2, title: 'core-sw2 uplink flapping', steps: [{ topic: 'power', question: 'Is it on?' }], gate: ISSUE_TYPED, ...tick() });
    const canon = buildCanon(made.doc);
    expect(planClashes(made.doc, canon, readPlan(made.doc, a.id))).toEqual([
      expect.objectContaining({ kind: 'issue', id: made.id, devices: ['core-sw2'], stage: 'open' }),
    ]);
    const closed = closeIssue(made.doc, made.id, { gate: ISSUE_TYPED, ...tick() });
    expect(planClashes(closed, buildCanon(closed), readPlan(closed, a.id))).toEqual([]);
  });

  it('puts a plan under way first, and the note names each clash', () => {
    const l = lab();
    const a = plan(l.doc, 'Planned one', [[l.p1]]);
    const b = plan(a.doc, 'Running one', [[l.p2]]);
    const c = plan(startPlan(b.doc, b.id, tick()), 'Mine', [{ t: 'cable', a: l.p1, b: l.p3 }]);
    const clashes = planClashes(c.doc, buildCanon(c.doc), readPlan(c.doc, c.id));
    expect(clashes.map((x) => x.title)).toEqual(['Running one', 'Planned one']);
    expect(clashNote(clashes)).toBe(
      'Started anyway while other work was open on these devices: plan "Running one" (under way) on core-sw1; plan "Planned one" (planned) on the same port core-sw1 · Gi1/0/47.',
    );
  });
});

describe('runningOn', () => {
  it('lists a plan in Do on the device with its finished steps there, newest first', () => {
    const l = lab();
    const a = plan(l.doc, 'Move uplinks', [
      [l.p1],
      [l.p3],
      [l.p2],
    ]);
    expect(runningOn(a.doc, buildCanon(a.doc), l.sw1)).toEqual([]);
    let d = startPlan(a.doc, a.id, tick());
    d = markDone(d, a.steps[0], { check: allow, ...tick() });
    d = markDone(d, a.steps[1], { check: allow, ...tick() });
    const here = runningOn(d, buildCanon(d), l.sw1);
    expect(here).toHaveLength(1);
    expect(here[0].plan.id).toBe(a.id);
    expect(here[0].steps.map((s) => s.id)).toEqual([a.steps[0]]);
    expect(runningOn(d, buildCanon(d), l.sw2)[0].steps.map((s) => s.id)).toEqual([a.steps[1]]);
  });
});
