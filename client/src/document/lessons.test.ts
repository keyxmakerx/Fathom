import { describe, expect, it } from 'vitest';

import { createSketchDevice } from './commands';
import { setDeviceField } from './edit';
import {
  addLessonStep,
  createLesson,
  LessonRefusal,
  listLessons,
  moveLessonStep,
  publishedCopy,
  publishedLesson,
  readLesson,
  removeLesson,
  removeLessonStep,
  setLessonText,
  stepProblem,
  TYPED_AS_WRITTEN,
  updateLessonStep,
} from './lessons';
import { emptyDocument, parseNodeId, type Document } from './model';
import { readPlain, writePlain } from './plain';

const gate = TYPED_AS_WRITTEN;

function withDevice(): { doc: Document; device: string } {
  let doc = createSketchDevice(emptyDocument());
  const device = doc.nodes.find((n) => parseNodeId(n.id).kind === 'Device')!.id;
  doc = setDeviceField(doc, device, 'hostname', 'fw-1');
  return { doc, device };
}

function draft(): { doc: Document; lesson: string; device: string } {
  const base = withDevice();
  const made = createLesson(base.doc, { title: 'Find the firewall', summary: 'Where the zones meet.', gate });
  let doc = made.doc;
  doc = addLessonStep(doc, made.id, { kind: 'read', title: 'Zones', body: 'A zone is a set of interfaces.' }, { gate }).doc;
  doc = addLessonStep(doc, made.id, { kind: 'click', title: 'Pick it', body: 'Click the firewall.', answer: base.device, hint: 'The one in the rack.', after: 'Yes.' }, { gate }).doc;
  return { doc, lesson: made.id, device: base.device };
}

describe('lessons written on a design', () => {
  it('writes a draft with its steps in order, and reads it back after a save', () => {
    const { doc, lesson, device } = draft();
    const back = readPlain(writePlain(doc));
    const l = readLesson(back, lesson);
    expect(l.title).toBe('Find the firewall');
    expect(l.summary).toBe('Where the zones meet.');
    expect(l.publishedAt).toBe('');
    expect(l.steps.map((s) => [s.ordinal, s.kind, s.title])).toEqual([
      [0, 'read', 'Zones'],
      [1, 'click', 'Pick it'],
    ]);
    expect(l.steps[1]!.answer).toBe(device);
    expect(listLessons(back)).toHaveLength(1);
  });

  it('moves, edits and removes steps, keeping the order dense', () => {
    let { doc, lesson } = draft();
    const [read, click] = readLesson(doc, lesson).steps;
    doc = moveLessonStep(doc, click!.id, -1);
    expect(readLesson(doc, lesson).steps.map((s) => s.title)).toEqual(['Pick it', 'Zones']);
    doc = updateLessonStep(doc, click!.id, { kind: 'click', title: 'Pick the firewall', body: 'Click it.', answer: click!.answer, after: '' }, { gate });
    const edited = readLesson(doc, lesson).steps[0]!;
    expect(edited.title).toBe('Pick the firewall');
    expect(edited.hint).toBe('');
    expect(edited.after).toBe('');
    doc = removeLessonStep(doc, edited.id);
    expect(readLesson(doc, lesson).steps.map((s) => [s.ordinal, s.id])).toEqual([[0, read!.id]]);
    doc = setLessonText(doc, lesson, { title: 'Zones', summary: '' }, { gate });
    expect(readLesson(doc, lesson)).toMatchObject({ title: 'Zones', summary: '' });
  });

  it('says what an unfinished step still needs', () => {
    expect(stepProblem({ kind: 'read', title: '' })).toBe('It needs a title.');
    expect(stepProblem({ kind: 'click', title: 'x' })).toBe('Pick the answer on the canvas.');
    expect(stepProblem({ kind: 'trace', title: 'x', traceFrom: 'a', traceTo: 'b' })).toBe('Record what the trace shows.');
    expect(stepProblem({ kind: 'trace', title: 'x', traceFrom: 'a', traceTo: 'b', expectTrace: 'stops' })).toBe('Say where the trace stops.');
    expect(stepProblem({ kind: 'change', title: 'x', expectRule: 'l2.vlan.access-mismatch' })).toBe('Say whether it should fire or clear.');
    expect(stepProblem({ kind: 'change', title: 'x', expectRule: 'l2.vlan.access-mismatch', expectNow: 'fires' })).toBeNull();
  });

  it('publishes a copy holding only this lesson, marked published, which can no longer change', () => {
    let { doc, lesson } = draft();
    doc = createLesson(doc, { title: 'Another', gate }).doc;
    const copy = publishedCopy(doc, lesson, { sourceDesign: '01JB2Y7Q8N6W3V5X4Z1C0D9E8F', now: Date.UTC(2026, 9, 25) });
    const back = readPlain(writePlain(copy));
    expect(listLessons(back).map((l) => l.title)).toEqual(['Find the firewall']);
    const p = publishedLesson(back)!;
    expect(p.publishedAt).toBe('2026-10-25T00:00:00.000Z');
    expect(p.sourceDesign).toBe('01JB2Y7Q8N6W3V5X4Z1C0D9E8F');
    expect(() => addLessonStep(back, p.id, { kind: 'read', title: 'x', body: 'y' }, { gate })).toThrow(LessonRefusal);
    // The author's design is untouched: still a draft, and both lessons.
    expect(publishedLesson(doc)).toBeNull();
    expect(listLessons(doc)).toHaveLength(2);
  });

  it('refuses to publish an empty lesson or one with an unfinished step', () => {
    const base = withDevice();
    const empty = createLesson(base.doc, { title: 'Empty', gate });
    expect(() => publishedCopy(empty.doc, empty.id, { sourceDesign: '' })).toThrow('at least one step');
    const half = addLessonStep(empty.doc, empty.id, { kind: 'click', title: 'Pick' }, { gate }).doc;
    expect(() => publishedCopy(half, empty.id, { sourceDesign: '' })).toThrow('step 1 is not finished: Pick the answer on the canvas.');
  });

  it('removes a lesson with its steps', () => {
    const { doc, lesson } = draft();
    const gone = removeLesson(doc, lesson);
    expect(listLessons(gone)).toEqual([]);
    expect(gone.nodes.filter((n) => parseNodeId(n.id).kind === 'LessonStep' && n.absentSince === undefined)).toEqual([]);
  });

  it('runs every text through the gate it is given', () => {
    const base = withDevice();
    const shout = (t: string) => t.toUpperCase();
    const made = createLesson(base.doc, { title: 'quiet', gate: shout });
    expect(readLesson(made.doc, made.id).title).toBe('QUIET');
    const step = addLessonStep(made.doc, made.id, { kind: 'read', title: 'a', body: 'b' }, { gate: shout });
    expect(readLesson(step.doc, made.id).steps[0]).toMatchObject({ title: 'A', body: 'B' });
  });
});
