// Work that clashes on the same devices (sign-off r105), asked of the REAL wasm engine (no stand-in): the engine
// decides what clashes and what time is free; clashes.ts only words it. The engine's own tests are in
// crates/fathom-inventory/src/work.rs and crates/fathom-wasm/tests/work.rs; these prove the page gets the same answer
// over a design the page made.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { Engine } from '../../engine/engine';
import { Mirror } from '../../engine/mirror';
import { fileLoader } from '../../engine/wasm';
import { addSketchPort, createSketchDevice } from '../../document/commands';
import { closeIssue, createIssue, TYPED_AS_WRITTEN as ISSUE_TYPED } from '../../document/issues';
import { edgesOut, emptyDocument, type Document } from '../../document/model';
import { addStep, createPlan, markDone, startPlan, TYPED_AS_WRITTEN, type StepEdit } from '../../document/plans';
import { clashNote, offerNote, runningFrom, windowWords, type PlanClashes } from './clashes';

const WASM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../public/engine/fathom_wasm.wasm');

const tick = (() => {
  let now = 1_790_900_000_000;
  return () => ({ actor: '01ARZ3NDEKTSV4RRFFQ69G5FAV', now: (now += 1000) });
})();
const gate = TYPED_AS_WRITTEN;
const allow = () => null;

let mirror: Mirror;
beforeAll(async () => {
  if (!existsSync(WASM)) throw new Error(`${WASM} is missing; run bash scripts/build-wasm.sh first. This suite does not fall back to a stub.`);
  mirror = new Mirror(await Engine.init(fileLoader(WASM)));
});

const clashesOf = (doc: Document, planId: string): PlanClashes => {
  mirror.load(doc);
  return mirror.workClashes(planId);
};

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

describe('the engine finds the clashes the page shows', () => {
  it('names another plan on the same device in an overlapping window, the shared port, and a free time both ways', () => {
    const l = lab();
    const a = plan(l.doc, 'Move uplinks', [{ t: 'cable', a: l.p2, b: l.p3 }], '2026-11-04T22:00', '2026-11-05T02:00');
    const b = plan(a.doc, 'Replace PSU', [[l.p2]], '2026-11-04T23:00', '2026-11-05T01:00');
    const mine = clashesOf(b.doc, a.id);
    expect(mine.clashes).toHaveLength(1);
    const [c] = mine.clashes;
    expect(c).toMatchObject({ kind: 'plan', id: b.id, title: 'Replace PSU', stage: 'planned' });
    expect(c.devices.map((d) => d.name)).toEqual(['core-sw1']);
    expect(c.ports.map((p) => p.name)).toEqual(['core-sw1 Gi1/0/48']);
    // My four hours, from the end of theirs: 01:00 to 05:00.
    expect(mine.mineFree).toEqual({ start: '2026-11-05T01:00', end: '2026-11-05T05:00' });
    // Their two hours, from the end of mine.
    expect(c.theirsAfterMine).toEqual({ start: '2026-11-05T02:00', end: '2026-11-05T04:00' });
    expect(clashesOf(b.doc, b.id).clashes.map((x) => x.id)).toEqual([a.id]);
  });

  it('windows that do not overlap do not clash; a plan with no window clashes with any, and has no free time', () => {
    const l = lab();
    const a = plan(l.doc, 'Tonight', [{ t: 'cable', a: l.p1, b: l.p3 }], '2026-11-04T22:00', '2026-11-05T02:00');
    const b = plan(a.doc, 'Next week', [[l.p1]], '2026-11-11T22:00', '2026-11-12T02:00');
    const c = plan(b.doc, 'Whenever', [[l.p3]]);
    expect(clashesOf(c.doc, a.id).clashes.map((x) => x.title)).toEqual(['Whenever']);
    const open = clashesOf(c.doc, c.id);
    expect(open.clashes.map((x) => x.title)).toEqual(['Tonight']);
    expect(open.mineFree).toBeNull();
  });

  it("an open It's down issue on the device clashes; a closed one does not", () => {
    const l = lab();
    const a = plan(l.doc, 'Move uplinks', [{ t: 'cable', a: l.p2, b: l.p3 }], '2026-11-04T22:00', '2026-11-05T02:00');
    const made = createIssue(a.doc, { deviceId: l.sw2, title: 'core-sw2 uplink flapping', steps: [{ topic: 'power', question: 'Is it on?' }], gate: ISSUE_TYPED, ...tick() });
    const got = clashesOf(made.doc, a.id);
    expect(got.clashes.map((x) => [x.kind, x.id, x.stage, x.devices.map((d) => d.name)])).toEqual([['issue', made.id, 'open', ['core-sw2']]]);
    expect(got.mineFree).toBeNull();
    const closed = closeIssue(made.doc, made.id, { gate: ISSUE_TYPED, ...tick() });
    expect(clashesOf(closed, a.id).clashes).toEqual([]);
  });

  it('puts a plan under way first, and the Start anyway note names each clash', () => {
    const l = lab();
    const a = plan(l.doc, 'Planned one', [[l.p1]]);
    const b = plan(a.doc, 'Running one', [[l.p2]]);
    const c = plan(startPlan(b.doc, b.id, tick()), 'Mine', [{ t: 'cable', a: l.p1, b: l.p3 }]);
    const { clashes } = clashesOf(c.doc, c.id);
    expect(clashes.map((x) => x.title)).toEqual(['Running one', 'Planned one']);
    expect(clashNote(clashes)).toBe(
      'Started anyway while other work was open on these devices: plan "Running one" (under way) on core-sw1; plan "Planned one" (planned) on the same port core-sw1 Gi1/0/47.',
    );
  });

  it('lists a plan in Do on the device with its finished steps there', () => {
    const l = lab();
    const a = plan(l.doc, 'Move uplinks', [[l.p1], [l.p3], [l.p2]]);
    mirror.load(a.doc);
    expect(mirror.runningOn(l.sw1)).toEqual([]);
    let d = startPlan(a.doc, a.id, tick());
    d = markDone(d, a.steps[0], { check: allow, ...tick() });
    d = markDone(d, a.steps[1], { check: allow, ...tick() });
    mirror.load(d);
    const here = runningFrom(d, mirror.runningOn(l.sw1));
    expect(here.map((r) => [r.plan.id, r.steps.map((s) => s.id)])).toEqual([[a.id, [a.steps[0]]]]);
    expect(runningFrom(d, mirror.runningOn(l.sw2))[0].steps.map((s) => s.id)).toEqual([a.steps[1]]);
  });
});

describe('the words', () => {
  it('says a window plainly, and a whole day as its date', () => {
    expect(windowWords({ start: '2026-11-04T22:00', end: '2026-11-05T02:00' })).toBe('Wed 4 Nov 22:00–Thu 5 Nov 02:00');
    expect(windowWords({ start: '2026-11-04T01:00', end: '2026-11-04T03:00' })).toBe('Wed 4 Nov 01:00–03:00');
    expect(windowWords({ start: '2026-11-04', end: '' })).toBe('Wed 4 Nov');
    expect(windowWords({ start: 'after lunch', end: '' })).toBe('after lunch');
  });

  it('offers a time for their plan, or asks, and never promises anything of theirs', () => {
    const mine = { title: 'Move uplinks', window: { start: '2026-11-04T22:00', end: '2026-11-05T02:00' } };
    const base = {
      kind: 'plan' as const,
      id: 'maintenanceplan:x',
      title: 'Replace PSU',
      stage: 'planned',
      devices: [{ id: 'device:x', name: 'core-sw1' }],
      ports: [],
      window: { start: '', end: '' },
      team: '',
      assignedTo: '',
      author: '',
      theirsAfterMine: { start: '2026-11-05T02:00', end: '2026-11-05T04:00' },
    };
    expect(offerNote(mine, base)).toBe(
      'Plan "Move uplinks" (Wed 4 Nov 22:00–Thu 5 Nov 02:00) also works on core-sw1. This plan could run after it, at Thu 5 Nov 02:00–04:00, if that suits.',
    );
    expect(offerNote(mine, { ...base, theirsAfterMine: null })).toContain('Could the two be done at different times?');
    expect(offerNote(mine, { ...base, kind: 'issue' })).toContain("check this issue's notes before it starts");
  });
});
