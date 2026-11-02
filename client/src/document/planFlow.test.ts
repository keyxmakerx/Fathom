// The plan-to-maintenance flow (sign-off r73-plan-flow, schema 0.33): If paths, checks after the work, release
// notes, and the issue a step opened.
import { describe, expect, it } from 'vitest';

import { connectPorts } from './cables';
import { addSketchPort, createSketchDevice } from './commands';
import { setDeviceField } from './edit';
import { createIssue } from './issues';
import { edgesOut, emptyDocument, fieldValue, findNode, type Document } from './model';
import { readPlain, writePlain } from './plain';
import {
  PlanRefusal,
  addCheck,
  addChecks,
  addStep,
  answerCheck,
  backOutSteps,
  checksLeft,
  couldTouch,
  createPlan,
  currentStep,
  decodeChecks,
  encodeChecks,
  linkStepIssue,
  markDone,
  markWentDifferently,
  markedNoteLines,
  moveStep,
  noteWords,
  readPlan,
  recordPlan,
  removeCheck,
  removeStep,
  setIfWhen,
  setReleaseNotes,
  startPlan,
  takeIfPath,
  touchedBy,
  TYPED_AS_WRITTEN,
} from './plans';
import { readIssue } from './issues';

const tick = (() => {
  let now = 1_790_900_000_000;
  return () => ({ actor: '01ARZ3NDEKTSV4RRFFQ69G5FAV', now: (now += 1000) });
})();
const gate = (t: string) => t.replace(/hunter2-[A-Za-z0-9]+/g, '<REDACTED>');
const allow = () => null;

function lab(): { doc: Document; devices: string[]; ports: string[] } {
  let doc = emptyDocument();
  const ports: string[] = [];
  const devices: string[] = [];
  for (const [i, label] of ['Et1', 'Et2', 'Et3', 'Et4'].entries()) {
    const before = new Set(doc.nodes.map((n) => n.id));
    doc = createSketchDevice(doc, tick());
    const fresh = doc.nodes.filter((n) => !before.has(n.id));
    const chassis = fresh.find((n) => n.id.startsWith('chassis:'))!.id;
    const device = fresh.find((n) => n.id.startsWith('device:'))!.id;
    devices.push(device);
    doc = setDeviceField(doc, device, 'hostname', `srx${i}`, tick());
    doc = addSketchPort(doc, chassis, { label, connector: 'rj45', face: 'front' }, tick());
    ports.push(edgesOut(doc, chassis, 'HasPort')[0]!.to);
  }
  return { doc, devices, ports };
}

/** A plan of three steps on srx0 and srx1, the second with an If path of two steps on srx2. */
function withIf(): { doc: Document; plan: string; steps: string[]; path: string[]; devices: string[]; ports: string[] } {
  const { doc: d0, devices, ports } = lab();
  const made = createPlan(d0, { title: 'Junos upgrade', gate, ...tick() });
  let doc = made.doc;
  const steps: string[] = [];
  for (const [i, t] of [devices[0], devices[1], devices[0]].entries()) {
    const s = addStep(doc, made.id, { kind: 'other', change: `main ${i + 1}`, targets: [t], gate, ...tick() });
    doc = s.doc;
    steps.push(s.id);
  }
  doc = setIfWhen(doc, steps[1], "It isn't back in 15 minutes", { gate, ...tick() });
  const path: string[] = [];
  for (const w of ['console in, roll back', 'record as failed']) {
    const s = addStep(doc, made.id, { kind: 'other', change: w, targets: [devices[2]], branchOf: steps[1], gate, ...tick() });
    doc = s.doc;
    path.push(s.id);
  }
  return { doc, plan: made.id, steps, path, devices, ports };
}

describe('an If path under a step', () => {
  it('reads as a path under its step, numbered 2a and 2b, and off the line of work', () => {
    const { doc, plan, steps, path, devices } = withIf();
    const p = readPlan(doc, plan);
    expect(p.steps.map((s) => s.id)).toEqual(steps);
    expect(p.steps.map((s) => s.label)).toEqual(['1', '2', '3']);
    expect(p.ifPaths[steps[1]]!.map((s) => [s.id, s.label])).toEqual([
      [path[0], '2a'],
      [path[1], '2b'],
    ]);
    expect(p.steps[1]!.ifWhen).toBe("It isn't back in 15 minutes");
    // Planning shows what the bad night would touch; the record only what happened.
    expect(couldTouch(p)).toContain(devices[2]);
    expect(touchedBy(p)).not.toContain(devices[2]);
  });

  it('survives the plain face: written and read back the same', () => {
    const { doc, plan, steps } = withIf();
    const back = readPlain(writePlain(doc));
    const p = readPlan(back, plan);
    expect(p.ifPaths[steps[1]]!.map((s) => s.label)).toEqual(['2a', '2b']);
    expect(p.steps[1]!.ifWhen).toBe("It isn't back in 15 minutes");
  });

  it('is one level only, and hangs from this plan only', () => {
    const { doc, plan, path } = withIf();
    expect(() => setIfWhen(doc, path[0], 'and then', { gate, ...tick() })).toThrow(PlanRefusal);
    expect(() => addStep(doc, plan, { kind: 'other', change: 'deeper', branchOf: path[0], gate, ...tick() })).toThrow(/main line/);
    const other = createPlan(doc, { title: 'Other', gate, ...tick() });
    expect(() => addStep(other.doc, other.id, { kind: 'other', change: 'x', branchOf: path[0], gate, ...tick() })).toThrow(PlanRefusal);
  });

  it('keeps its words until its steps are gone, and its step takes it away with it', () => {
    const { doc, plan, steps, path } = withIf();
    expect(() => setIfWhen(doc, steps[1], '', { gate, ...tick() })).toThrow(/steps first/);
    let next = removeStep(doc, path[0], tick());
    expect(readPlan(next, plan).ifPaths[steps[1]]!.map((s) => s.label)).toEqual(['2a']);
    next = removeStep(next, path[1], tick());
    next = setIfWhen(next, steps[1], '', { gate, ...tick() });
    expect(readPlan(next, plan).steps[1]!.ifWhen).toBe('');
    // Removing a main-line step takes its If path too.
    const gone = removeStep(doc, steps[1], tick());
    const p = readPlan(gone, plan);
    expect(p.steps.map((s) => s.label)).toEqual(['1', '2']);
    expect(Object.keys(p.ifPaths)).toEqual([]);
    expect(findNode(gone, path[0])!.absentSince).toBeDefined();
  });

  it('moves within its own line', () => {
    const { doc, plan, steps, path } = withIf();
    const next = moveStep(doc, path[1], 0, tick());
    const p = readPlan(next, plan);
    expect(p.ifPaths[steps[1]]!.map((s) => s.id)).toEqual([path[1], path[0]]);
    expect(p.steps.map((s) => s.id)).toEqual(steps);
  });

  it('pasted words meet the gate', () => {
    const { doc, plan, steps } = withIf();
    const next = setIfWhen(doc, steps[0], 'if it asks for hunter2-abc', { gate, ...tick() });
    expect(readPlan(next, plan).steps[0]!.ifWhen).toBe('if it asks for <REDACTED>');
  });

  it('is taken only from its step gone differently, and its steps come next', () => {
    const { doc, plan, steps, path } = withIf();
    let d = startPlan(doc, plan, tick());
    d = markDone(d, steps[0], { check: allow, ...tick() });
    expect(() => takeIfPath(d, steps[1], tick())).toThrow(/Went differently/);
    // An If path not taken: its steps are not to do.
    expect(() => markDone(d, path[0], { check: allow, ...tick() })).toThrow(PlanRefusal);
    d = markWentDifferently(d, steps[1], { note: 'no ping after reboot', gate, ...tick() });
    d = takeIfPath(d, steps[1], tick());
    expect(() => takeIfPath(d, steps[1], tick())).toThrow(/already/);
    const p = readPlan(d, plan);
    expect(p.steps.map((s) => s.id)).toEqual([steps[0], steps[1], path[0], path[1], steps[2]]);
    expect(currentStep(p)!.id).toBe(path[0]);
    expect(() => markDone(d, steps[2], { check: allow, ...tick() })).toThrow(/earlier step/);
    d = markDone(d, path[0], { check: allow, ...tick() });
    d = markDone(d, path[1], { check: allow, ...tick() });
    d = markDone(d, steps[2], { check: allow, ...tick() });
    const after = readPlan(d, plan);
    expect(after.steps.every((s) => s.state !== 'planned')).toBe(true);
    // The way back undoes what happened, the If path included, newest first.
    expect(backOutSteps(d, after).map((r) => r.change)).toEqual(['Undo step 3: main 3', 'Undo step 2b: record as failed', 'Undo step 2a: console in, roll back', 'Check step 2, it went differently: main 2', 'Undo step 1: main 1']);
    expect(() => recordPlan(d, plan, { outcome: 'partial', gate: TYPED_AS_WRITTEN, ...tick() })).not.toThrow();
  });

  it('is not offered once a later step is marked, and a plan records with it untaken', () => {
    const { doc, plan, steps } = withIf();
    let d = startPlan(doc, plan, tick());
    d = markDone(d, steps[0], { check: allow, ...tick() });
    d = markWentDifferently(d, steps[1], { note: 'it came back on its own', gate, ...tick() });
    d = markDone(d, steps[2], { check: allow, ...tick() });
    expect(() => takeIfPath(d, steps[1], tick())).toThrow(/later step/);
    expect(() => recordPlan(d, plan, { outcome: 'succeeded', gate: TYPED_AS_WRITTEN, ...tick() })).not.toThrow();
  });
});

describe('checks after the work', () => {
  it('encode one per line with their answers, and a line that does not read is left out', () => {
    const checks = [
      { text: 'BGP to the ISP\tis up', answer: 'open' as const, seen: '' },
      { text: 'VPN users sign in', answer: 'not_ok' as const, seen: 'two of five\nfail' },
    ];
    const raw = encodeChecks(checks);
    expect(raw).toBe('open\tBGP to the ISP is up\t\nnot_ok\tVPN users sign in\ttwo of five fail');
    expect(decodeChecks(raw)).toEqual([
      { text: 'BGP to the ISP is up', answer: 'open', seen: '' },
      { text: 'VPN users sign in', answer: 'not_ok', seen: 'two of five fail' },
    ]);
    expect(decodeChecks('maybe\tsomething\nok\t\nok\tfine')).toEqual([{ text: 'fine', answer: 'ok', seen: '' }]);
  });

  it('are added while planning or doing, answered once the work starts, and Record waits on them', () => {
    const { doc, plan, steps, path } = withIf();
    let d = addCheck(doc, plan, 'ae0 to isp-edge stays up 10 min', { gate, ...tick() });
    d = addChecks(d, plan, ['BGP to the ISP is Established', '', 'ae0 to isp-edge stays up 10 min'], { gate, ...tick() });
    expect(readPlan(d, plan).checks.map((c) => c.text)).toEqual(['ae0 to isp-edge stays up 10 min', 'BGP to the ISP is Established']);
    expect(() => addCheck(d, plan, '  ', { gate, ...tick() })).toThrow(/needs words/);
    expect(() => answerCheck(d, plan, 0, 'ok', { gate, ...tick() })).toThrow(/started/);
    d = startPlan(d, plan, tick());
    for (const s of [steps[0], steps[1], steps[2]]) d = markDone(d, s, { check: allow, ...tick() });
    void path;
    expect(checksLeft(readPlan(d, plan))).toBe(2);
    expect(() => recordPlan(d, plan, { outcome: 'succeeded', gate: TYPED_AS_WRITTEN, ...tick() })).toThrow(/answer every check/);
    d = answerCheck(d, plan, 0, 'ok', { gate, ...tick() });
    d = answerCheck(d, plan, 1, 'not_ok', { seen: 'Active, pasted hunter2-xyz', gate, ...tick() });
    const p = readPlan(d, plan);
    expect(p.checks.map((c) => c.answer)).toEqual(['ok', 'not_ok']);
    expect(p.checks[1]!.seen).toBe('Active, pasted <REDACTED>');
    expect(() => answerCheck(d, plan, 5, 'ok', { gate, ...tick() })).toThrow(/not on this plan/);
    d = recordPlan(d, plan, { outcome: 'partial', gate: TYPED_AS_WRITTEN, ...tick() });
    expect(() => addCheck(d, plan, 'late', { gate, ...tick() })).toThrow(/recorded/);
    expect(() => removeCheck(d, plan, 0, tick())).toThrow(/recorded/);
  });

  it('removing the last takes the field off', () => {
    const { doc, plan } = withIf();
    let d = addCheck(doc, plan, 'one', { gate, ...tick() });
    d = removeCheck(d, plan, 0, tick());
    expect(readPlan(d, plan).checks).toEqual([]);
    expect(fieldValue(findNode(d, plan)!.fields, 'MaintenancePlan.checks')).toBeUndefined();
  });
});

describe('release notes on a plan', () => {
  it('pasted notes meet the gate, and the lines that name what the plan touches are marked', () => {
    const { doc, plan } = withIf();
    const notes = [
      '23.4R2 Known issues',
      'PR1734512 LACP may flap on srx1 ae interfaces after upgrade',
      'PR1739001 J-Web login page slow',
      'Default admin password hunter2-abc is no longer accepted',
      'srx10 is a different box',
    ].join('\r\n');
    const d = setReleaseNotes(doc, plan, notes, { gate, ...tick() });
    const p = readPlan(d, plan);
    expect(p.releaseNotes).toContain('<REDACTED>');
    expect(p.releaseNotes).not.toContain('\r');
    const marked = markedNoteLines(p.releaseNotes, noteWords(d, p));
    // srx1 is a step's device; srx2 is on the If path, which planning counts; srx10 is a different word.
    expect(marked.map((m) => m.line)).toEqual([1]);
    expect(marked[0]!.words).toEqual(['srx1']);
    const off = setReleaseNotes(d, plan, '   ', { gate, ...tick() });
    expect(readPlan(off, plan).releaseNotes).toBe('');
  });

  it('a version a step names is a word to look for', () => {
    const { doc, devices } = lab();
    const made = createPlan(doc, { title: 'Upgrade', gate, ...tick() });
    const s = addStep(made.doc, made.id, { kind: 'other', change: 'Record 23.4R2 as running', targets: [devices[0]], gate, ...tick() });
    const p = readPlan(s.doc, made.id);
    expect(noteWords(s.doc, p)).toEqual(expect.arrayContaining(['srx0', '23.4R2']));
    expect(markedNoteLines('Fixed in 23.4R2-S1\nnothing here', ['23.4R2'])).toEqual([]);
    expect(markedNoteLines('Fixed in 23.4R2.\nnothing here', ['23.4R2'])).toEqual([{ line: 0, words: ['23.4R2'] }]);
  });
});

describe('the issue a step opened', () => {
  it('links both ways, and a recorded plan does not change', () => {
    const { doc, plan, steps, devices } = withIf();
    let d = startPlan(doc, plan, tick());
    d = markDone(d, steps[0], { check: allow, ...tick() });
    d = markWentDifferently(d, steps[1], { note: 'ae0 drops', gate, ...tick() });
    const issue = createIssue(d, { deviceId: devices[1], title: 'srx1 is down', steps: [{ topic: 'power', question: 'Power?' }], step: steps[1], gate, ...tick() });
    d = linkStepIssue(issue.doc, steps[1], issue.id, tick());
    expect(readPlan(d, plan).steps[1]!.issue).toBe(issue.id);
    expect(readIssue(d, issue.id).stepId).toBe(steps[1]);
    expect(() => linkStepIssue(d, steps[1], devices[0], tick())).toThrow(/issue/);
    expect(() => createIssue(d, { deviceId: devices[1], title: 'x', steps: [{ topic: 'power', question: 'Power?' }], step: devices[0], gate, ...tick() })).toThrow();
    d = markDone(d, steps[2], { check: allow, ...tick() });
    d = recordPlan(d, plan, { outcome: 'partial', gate: TYPED_AS_WRITTEN, ...tick() });
    expect(() => linkStepIssue(d, steps[1], issue.id, tick())).toThrow(/recorded/);
  });
});

describe('older plans', () => {
  it('a plan written before 0.33 reads with no If paths, checks or notes', () => {
    const { doc, ports } = lab();
    const made = createPlan(doc, { title: 'Old', gate, ...tick() });
    const s = addStep(made.doc, made.id, { kind: 'cable', change: 'cable', edit: { t: 'cable', a: ports[0], b: ports[1] }, gate, ...tick() });
    const p = readPlan(connectPorts(s.doc, ports[2], ports[3], {}, tick()), made.id);
    expect(p.ifPaths).toEqual({});
    expect(p.checks).toEqual([]);
    expect(p.releaseNotes).toBe('');
    expect(p.steps[0]!).toMatchObject({ label: '1', ifWhen: '', branchOf: '', ifTaken: false, issue: '' });
  });
});
