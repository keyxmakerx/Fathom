import { describe, expect, it } from 'vitest';

import { addSketchPort, createSketchDevice } from './commands';
import { addStep, createPlan, TYPED_AS_WRITTEN as PLAN_TYPED } from './plans';
import {
  IssueRefusal,
  TYPED_AS_WRITTEN,
  answerStep,
  closeIssue,
  createIssue,
  currentIssueStep,
  issuesTouching,
  linkPlan,
  listIssues,
  readIssue,
  type DraftStep,
} from './issues';
import { findNode, emptyDocument, type Document } from './model';
import { readPlain, writePlain } from './plain';
import { undo } from './undo';

const tick = (() => {
  let now = 1_790_900_000_000;
  return () => ({ actor: '01ARZ3NDEKTSV4RRFFQ69G5FAV', now: (now += 1000) });
})();
const gate = (t: string) => t.replace(/hunter2-[A-Za-z0-9]+/g, '<REDACTED>');

function device(): { doc: Document; device: string } {
  let doc = createSketchDevice(emptyDocument(), { hostname: 'nas-01', ...tick() });
  const dev = doc.nodes.find((n) => n.id.startsWith('device:'))!.id;
  doc = addSketchPort(doc, doc.nodes.find((n) => n.id.startsWith('chassis:'))!.id, { label: 'eth0', connector: 'rj45', face: 'front' }, tick());
  return { doc, device: dev };
}

const steps: DraftStep[] = [
  { topic: 'power', question: 'Is nas-01 getting power from PDU-A outlet 4?', detail: 'Cable, black', targets: ['device:A'], answer: 'ok' },
  { topic: 'link', question: 'Link light on sw-02 port 23?', targets: ['device:A', 'cable:B'], answer: 'not_ok', note: 'Light is off' },
  { topic: 'address', question: 'Does 10.0.20.15 answer?' },
];

describe('createIssue', () => {
  it('saves the device, the steps in order and the frozen sentence as one undoable change', () => {
    const { doc, device: dev } = device();
    const made = createIssue(doc, { deviceId: dev, title: 'nas-01 is down', steps, outcome: 'Your answers point at the cable.', author: 'KM', gate: TYPED_AS_WRITTEN, ...tick() });
    expect(made.doc.batches.length).toBe(doc.batches.length + 1);
    const issue = readIssue(made.doc, made.id);
    expect(issue).toMatchObject({ title: 'nas-01 is down', deviceId: dev, author: 'KM', stage: 'open', outcome: 'Your answers point at the cable.', planId: '' });
    expect(issue.openedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(issue.steps.map((s) => [s.ordinal, s.topic, s.answer])).toEqual([
      [0, 'power', 'ok'],
      [1, 'link', 'not_ok'],
      [2, 'address', 'unanswered'],
    ]);
    expect(issue.steps[1]).toMatchObject({ note: 'Light is off', targets: ['device:A', 'cable:B'] });
    expect(issue.steps[0].answeredAt).not.toBe('');
    expect(issue.steps[2].answeredAt).toBe('');
    expect(currentIssueStep(issue)?.topic).toBe('address');
  });

  it('survives the plain face byte for byte', () => {
    const { doc, device: dev } = device();
    const made = createIssue(doc, { deviceId: dev, title: 'nas-01 is down', steps, gate: TYPED_AS_WRITTEN, ...tick() });
    const back = readPlain(writePlain(made.doc));
    expect(readIssue(back, made.id)).toEqual(readIssue(made.doc, made.id));
  });

  it('is undone in one step, leaving no trace', () => {
    const { doc, device: dev } = device();
    const made = createIssue(doc, { deviceId: dev, title: 'nas-01 is down', steps, gate: TYPED_AS_WRITTEN, ...tick() });
    const undone = undo(made.doc, made.doc.batches.at(-1)!.id, tick());
    expect(listIssues(undone)).toEqual([]);
  });

  it('refuses an unknown device, an empty title and no steps, writing nothing', () => {
    const { doc, device: dev } = device();
    const base = { steps, gate: TYPED_AS_WRITTEN, ...tick() };
    expect(() => createIssue(doc, { ...base, deviceId: 'device:01ARZ3NDEKTSV4RRFFQ69G5FAV', title: 'x' })).toThrow(IssueRefusal);
    expect(() => createIssue(doc, { ...base, deviceId: dev, title: '  ' })).toThrow(IssueRefusal);
    expect(() => createIssue(doc, { ...base, deviceId: dev, title: 'x', steps: [] })).toThrow(IssueRefusal);
    expect(() => createIssue(doc, { ...base, deviceId: dev, title: 'x', steps: [{ topic: 'bogus' as never, question: 'q' }] })).toThrow(IssueRefusal);
  });
});

describe('the redaction gate (ADR-0053 section 6)', () => {
  const secret = 'the switch said hunter2-AbC123 on login';
  it('stores a typed note as typed', () => {
    const { doc, device: dev } = device();
    const made = createIssue(doc, { deviceId: dev, title: 'nas-01 is down', steps: [{ topic: 'link', question: 'q', note: secret, answer: 'not_ok' }], gate, ...tick() });
    expect(readIssue(made.doc, made.id).steps[0].note).toBe(secret);
  });

  it('puts a pasted note through the gate', () => {
    const { doc, device: dev } = device();
    const made = createIssue(doc, { deviceId: dev, title: 'nas-01 is down', steps: [{ topic: 'link', question: 'q', note: secret, pasted: true, answer: 'not_ok' }], gate, ...tick() });
    expect(readIssue(made.doc, made.id).steps[0].note).toBe('the switch said <REDACTED> on login');
  });

  it('puts the answer note of a saved issue through the gate only when the caller says it was pasted', () => {
    const { doc, device: dev } = device();
    const made = createIssue(doc, { deviceId: dev, title: 't', steps, gate, ...tick() });
    const step = readIssue(made.doc, made.id).steps[2];
    const typed = answerStep(made.doc, step.id, { answer: 'cant_tell', note: secret, gate: TYPED_AS_WRITTEN, ...tick() });
    expect(readIssue(typed, made.id).steps[2].note).toBe(secret);
    const pasted = answerStep(made.doc, step.id, { answer: 'cant_tell', note: secret, gate, ...tick() });
    expect(readIssue(pasted, made.id).steps[2].note).toBe('the switch said <REDACTED> on login');
  });

  it("shares the plan commands' own explicit choice", () => {
    expect(TYPED_AS_WRITTEN).toBe(PLAN_TYPED);
  });

  it('refuses text the gate leaves holding a character that cannot be stored', () => {
    const { doc, device: dev } = device();
    expect(() => createIssue(doc, { deviceId: dev, title: 'nas\u0000', steps, gate: TYPED_AS_WRITTEN, ...tick() })).toThrow(IssueRefusal);
  });
});

describe('answerStep, closeIssue, linkPlan', () => {
  function saved() {
    const { doc, device: dev } = device();
    const made = createIssue(doc, { deviceId: dev, title: 'nas-01 is down', steps, outcome: 'Your answers point at the cable.', gate: TYPED_AS_WRITTEN, ...tick() });
    return { ...made, dev, issue: readIssue(made.doc, made.id) };
  }

  it('answers a step and stamps the time; a later answer replaces it', () => {
    const s = saved();
    const next = answerStep(s.doc, s.issue.steps[2].id, { answer: 'ok', gate: TYPED_AS_WRITTEN, ...tick() });
    expect(readIssue(next, s.id).steps[2]).toMatchObject({ answer: 'ok' });
    expect(readIssue(next, s.id).steps[2].answeredAt).not.toBe('');
    const again = answerStep(next, s.issue.steps[2].id, { answer: 'not_ok', gate: TYPED_AS_WRITTEN, ...tick() });
    expect(readIssue(again, s.id).steps[2].answer).toBe('not_ok');
    expect(() => answerStep(next, s.issue.steps[2].id, { answer: 'nope' as never, gate: TYPED_AS_WRITTEN })).toThrow(IssueRefusal);
  });

  it('closes an issue, keeps the frozen sentence and adds typed text after it, then refuses more changes', () => {
    const s = saved();
    const closed = closeIssue(s.doc, s.id, { text: 'Replaced the cable', gate: TYPED_AS_WRITTEN, ...tick() });
    const issue = readIssue(closed, s.id);
    expect(issue.stage).toBe('closed');
    expect(issue.outcome).toBe('Your answers point at the cable.\nReplaced the cable');
    expect(() => closeIssue(closed, s.id, { gate: TYPED_AS_WRITTEN })).toThrow(IssueRefusal);
    expect(() => answerStep(closed, s.issue.steps[2].id, { answer: 'ok', gate: TYPED_AS_WRITTEN })).toThrow(/closed/);
  });

  it('links a live maintenance plan and nothing else', () => {
    const s = saved();
    const plan = createPlan(s.doc, { title: 'Fix: nas-01 is down', gate: PLAN_TYPED, ...tick() });
    const withStep = addStep(plan.doc, plan.id, { kind: 'other', change: 'Check the cable', targets: [s.dev], gate: PLAN_TYPED, ...tick() }).doc;
    const linked = linkPlan(withStep, s.id, plan.id, tick());
    expect(readIssue(linked, s.id).planId).toBe(plan.id);
    expect(() => linkPlan(withStep, s.id, s.dev, tick())).toThrow(IssueRefusal);
    expect(() => linkPlan(withStep, s.dev, plan.id, tick())).toThrow(IssueRefusal);
  });
});

describe('reading', () => {
  it('lists issues newest first and finds those touching a device or a lit element', () => {
    const { doc, device: dev } = device();
    const a = createIssue(doc, { deviceId: dev, title: 'first', steps: [{ topic: 'power', question: 'q', targets: ['device:other'] }], gate: TYPED_AS_WRITTEN, ...tick() });
    const b = createIssue(a.doc, { deviceId: dev, title: 'second', steps, gate: TYPED_AS_WRITTEN, ...tick() });
    expect(listIssues(b.doc).map((i) => i.title)).toEqual(['second', 'first']);
    expect(issuesTouching(b.doc, dev).map((i) => i.title)).toEqual(['second', 'first']);
    expect(issuesTouching(b.doc, 'device:other').map((i) => i.title)).toEqual(['first']);
    expect(issuesTouching(b.doc, 'device:A').map((i) => i.title)).toEqual(['second']);
    // A port or cable target counts toward its device when a canon is given.
    expect(issuesTouching(b.doc, 'device:Z', (id) => (id === 'cable:B' ? 'device:Z' : id)).map((i) => i.title)).toEqual(['second']);
    expect(issuesTouching(b.doc, 'device:nothing')).toEqual([]);
  });

  it('refuses to read what is not a live issue, and drops a tombstoned one from the list', () => {
    const { doc, device: dev } = device();
    expect(() => readIssue(doc, dev)).toThrow(IssueRefusal);
    const made = createIssue(doc, { deviceId: dev, title: 't', steps, gate: TYPED_AS_WRITTEN, ...tick() });
    const undone = undo(made.doc, made.doc.batches.at(-1)!.id, tick());
    expect(findNode(undone, made.id)?.absentSince).toBeDefined();
    expect(listIssues(undone)).toEqual([]);
  });
});
