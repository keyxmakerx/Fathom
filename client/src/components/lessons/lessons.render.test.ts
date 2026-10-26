import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { createSketchDevice } from '../../document/commands';
import { setDeviceField } from '../../document/edit';
import { edgesOut, emptyDocument, parseNodeId, type Document } from '../../document/model';
import { addLessonStep, createLesson, TYPED_AS_WRITTEN } from '../../document/lessons';
import { LessonBuilder, ruleChoices } from './LessonBuilder';
import { LessonPanel } from './LessonPanel';
import { LessonsList } from './LessonsList';
import { loadRuns, publishedLessonDesigns, runForDesign, saveRun, type Lesson } from './lessonModel';

const LESSON: Lesson = {
  id: 'demo',
  title: 'Demo lesson',
  summary: 'A lesson for the test.',
  sample: 'small-office',
  sources: [{ claim: 'A claim.', cite: 'A page', url: 'https://example.org/page', read_on: '2026-10-25' }],
  steps: [
    { kind: 'read', title: 'Read this', body: 'Run `show vlans` to see them.' },
    { kind: 'click', title: 'Pick it', prompt: 'Click fw-1.', answer: { device: 'fw-1' }, hint: 'It is the firewall.', after: 'Right, fw-1.' },
  ],
};

function twoDevices(): { doc: Document; fw: string; fwChassis: string; other: string } {
  let doc = emptyDocument();
  const ids: string[] = [];
  for (const name of ['fw-1', 'desktop-1']) {
    const before = new Set(doc.nodes.map((n) => n.id));
    doc = createSketchDevice(doc);
    const id = doc.nodes.find((n) => !before.has(n.id) && parseNodeId(n.id).kind === 'Device')!.id;
    doc = setDeviceField(doc, id, 'hostname', name);
    ids.push(id);
  }
  return { doc, fw: ids[0]!, fwChassis: edgesOut(doc, ids[0]!, 'HasChassis')[0]!.to, other: ids[1]! };
}

const panel = (step: number, doc: Document | null, selectedId: string | null): string =>
  renderToStaticMarkup(
    createElement(LessonPanel, {
      lesson: LESSON,
      step,
      doc,
      selectedId,
      onAdvance: () => {},
      onTrace: () => {},
      boot: () => new Promise<never>(() => {}),
    }),
  );

describe('LessonPanel', () => {
  const { doc, fwChassis, other } = twoDevices();

  it('shows a read step with its code set as code, and lets the learner move on', () => {
    const html = panel(0, doc, null);
    expect(html).toContain('step 1 of 2');
    expect(html).toContain('<code>show vlans</code>');
    expect(html).toMatch(/class="lesson-step__next"[^>]*>Next</);
    expect(html).not.toMatch(/lesson-step__next" disabled/);
  });

  it('waits for a pick on the canvas, then tells a wrong pick the hint', () => {
    expect(panel(1, doc, null)).toContain('Pick it on the canvas.');
    expect(panel(1, doc, null)).toMatch(/lesson-step__next" disabled/);
    const wrong = panel(1, doc, other);
    expect(wrong).toContain('Not that one. It is the firewall.');
    expect(wrong).toMatch(/lesson-step__next" disabled/);
  });

  it('passes when the answer is picked, by its box (the chassis) as much as by the device', () => {
    const right = panel(1, doc, fwChassis);
    expect(right).toContain('Right, fw-1.');
    expect(right).toMatch(/class="lesson-step__next"[^>]*>Finish</);
    expect(right).not.toMatch(/lesson-step__next" disabled/);
  });

  it('says the lesson is done after the last step', () => {
    expect(panel(2, doc, null)).toContain('Lesson done.');
  });
});

describe('LessonsList', () => {
  const list = (runs: Parameters<typeof LessonsList>[0]['runs'], openable: string[]): string =>
    renderToStaticMarkup(
      createElement(LessonsList, {
        lessons: [LESSON],
        runs,
        openable: new Set(openable),
        busyId: null,
        error: null,
        disabled: false,
        onStart: () => {},
        onContinue: () => {},
      }),
    );

  it('offers Start, then Continue with the step reached, then done', () => {
    expect(list([], [])).toContain('>Start<');
    expect(list([{ lessonId: 'demo', designId: 'd1', step: 1 }], ['d1'])).toContain('Continue · 2 of 2');
    const done = list([{ lessonId: 'demo', designId: 'd1', step: 2 }], ['d1']);
    expect(done).toContain('>done<');
    expect(done).toContain('>Again<');
  });

  it('starts again when the copy the learner was using is gone', () => {
    expect(list([{ lessonId: 'demo', designId: 'gone', step: 1 }], [])).toContain('>Start<');
  });

  it('names the sample network and says nothing touches a real design', () => {
    const html = list([], []);
    expect(html).toContain('Small office');
    expect(html).toContain('nothing you try touches your real designs');
  });
});

describe('lesson progress', () => {
  it('keeps one run per lesson, per account, and survives a bad store', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveRun('a', { lessonId: 'demo', designId: 'd1', step: 0 }, storage);
    saveRun('a', { lessonId: 'demo', designId: 'd2', step: 1 }, storage);
    expect(loadRuns('a', storage)).toEqual([{ lessonId: 'demo', designId: 'd2', step: 1 }]);
    expect(loadRuns('b', storage)).toEqual([]);
    expect(runForDesign(loadRuns('a', storage), 'd2')?.step).toBe(1);
    store.set('fathom.lessons.a', '{not json');
    expect(loadRuns('a', storage)).toEqual([]);
  });
});

describe('LessonBuilder', () => {
  const { doc, fw } = twoDevices();
  const builder = (d: Document, canDraw = true): string =>
    renderToStaticMarkup(
      createElement(LessonBuilder, {
        doc: d,
        selectedId: null,
        canDraw,
        apply: () => {},
        onPublish: async () => '',
        onClose: () => {},
        boot: () => new Promise<never>(() => {}),
      }),
    );

  it('starts a lesson on a design with a title, and says a copy is what learners get', () => {
    const html = builder(doc);
    expect(html).toContain('Start writing');
    expect(html).toContain('Publishing makes a copy for learners');
  });

  it('says a reader cannot write one', () => {
    expect(builder(doc, false)).toContain('cannot be written here');
  });

  it('lists the steps, names what an unfinished one needs, and holds Publish until all are done', () => {
    const made = createLesson(doc, { title: 'Firewall', gate: TYPED_AS_WRITTEN });
    let d = addLessonStep(made.doc, made.id, { kind: 'click', title: 'Pick it', answer: fw, after: 'Yes.' }, { gate: TYPED_AS_WRITTEN }).doc;
    expect(builder(d)).toMatch(/lesson-step__next"[^>]*>Publish a copy for learners</);
    d = addLessonStep(d, made.id, { kind: 'change', title: 'Change it' }, { gate: TYPED_AS_WRITTEN }).doc;
    const html = builder(d);
    expect(html).toContain('Pick the check to watch.');
    expect(html).toMatch(/disabled=""[^>]*title="Step 2 is not finished"/);
  });

  it('offers every shipped Checks rule by its title', () => {
    const rules = ruleChoices();
    expect(rules.find((r) => r.id === 'l2.vlan.access-mismatch')?.title).toBe('The two ends of a link are access ports in different VLANs');
    expect(rules.every((r) => r.title !== '')).toBe(true);
  });
});

describe('published lessons on Home', () => {
  it('lists designs named Lesson, but not a copy someone is running', () => {
    const designs = [
      { designId: 'p1', name: 'Lesson: Our office' },
      { designId: 'mine', name: 'Lesson: VLANs' },
      { designId: 'x', name: 'Rack room' },
    ];
    expect(publishedLessonDesigns(designs, [{ lessonId: 'vlans', designId: 'mine', step: 0 }])).toEqual([
      { lessonId: 'design:p1', designId: 'p1', title: 'Our office' },
    ]);
  });

  it('shows Start, then Continue with the step count saved at the start', () => {
    const list = (runs: Parameters<typeof LessonsList>[0]['runs']) =>
      renderToStaticMarkup(
        createElement(LessonsList, {
          lessons: [],
          written: [{ lessonId: 'design:p1', designId: 'p1', title: 'Our office' }],
          runs,
          openable: new Set(['c1']),
          busyId: null,
          error: null,
          disabled: false,
          onStart: () => {},
          onContinue: () => {},
        }),
      );
    expect(list([])).toContain('Our office');
    expect(list([])).toContain('>Start<');
    expect(list([{ lessonId: 'design:p1', designId: 'c1', step: 1, of: 4 }])).toContain('Continue · 2 of 4');
  });
});
