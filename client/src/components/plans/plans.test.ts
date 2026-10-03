import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { addSketchPort, createSketchDevice } from '../../document/commands';
import { edgesOut, emptyDocument, type Document } from '../../document/model';
import {
  addStep,
  createPlan,
  currentStep,
  markDone,
  markWentDifferently,
  readPlan,
  recordPlan,
  startPlan,
  type Plan,
  type StepEdit,
} from '../../document/plans';
import type { CheckFinding } from '../../engine/engine';
import type { Mirror } from '../../engine/mirror';
import { buildCanon } from '../checks/checksModel';
import { PlanBand } from './PlanBand';
import { PlanListPage } from './PlanListPage';
import { PlanPanel } from './PlanPanel';
import {
  EMPTY_FORM,
  buildMarks,
  buildStep,
  changedMarks,
  focusKeys,
  outcomeSentence,
  planEscTarget,
  prefillFor,
  refusalFor,
  stepCheck,
  stepIsLive,
  stepWord,
  windowText,
  bandSentence,
} from './plansModel';
import { ENGINE_DOWN, loadPanelPrefs, refusalText, usePlansController, type PlansController } from './usePlansController';

const tick = (() => {
  let now = 1_790_900_000_000;
  return () => ({ actor: '01ARZ3NDEKTSV4RRFFQ69G5FAV', now: (now += 1000) });
})();
const gate = (t: string) => t.replace(/hunter2-[A-Za-z0-9]+/g, '<REDACTED>');
const allow = () => null;

const finding = (over: Partial<CheckFinding> = {}): CheckFinding => ({
  rule: 'topo.cable.media',
  severity: 'refuse',
  title: 'These two ports cannot be joined',
  fix: 'Use a port of the same kind.',
  why: 'The connectors do not fit.',
  concept: 'check.cable',
  source: { title: '', url: '', note: '' },
  elements: [{ id: 'physical-port:A', name: 'sw-01 · Et1' }],
  ...over,
});

function lab(): { doc: Document; devices: string[]; ports: string[] } {
  let doc = emptyDocument();
  const ports: string[] = [];
  const devices: string[] = [];
  for (const label of ['Et1', 'Et2', 'Et3']) {
    const before = new Set(doc.nodes.map((n) => n.id));
    doc = createSketchDevice(doc, tick());
    const fresh = doc.nodes.filter((n) => !before.has(n.id));
    const chassis = fresh.find((n) => n.id.startsWith('chassis:'))!.id;
    devices.push(fresh.find((n) => n.id.startsWith('device:'))!.id);
    doc = addSketchPort(doc, chassis, { label, connector: 'rj45', face: 'front' }, tick());
    ports.push(edgesOut(doc, chassis, 'HasPort')[0]!.to);
  }
  return { doc, devices, ports };
}

function planWith(doc: Document, edits: (StepEdit | null)[]): { doc: Document; id: string } {
  let made = createPlan(doc, { title: 'Move uplink', gate, ...tick() });
  for (const [i, edit] of edits.entries()) {
    const s = addStep(made.doc, made.id, { kind: edit ? 'cable' : 'other', change: `step ${i + 1}`, ...(edit ? { edit } : { targets: [] }), gate, ...tick() });
    made = { doc: s.doc, id: made.id };
  }
  return made;
}

describe('marks and their words', () => {
  it('words a step PLANNED, STEP n, ✓ DONE or ≠ WENT DIFFERENTLY', () => {
    const { doc, ports } = lab();
    const made = planWith(doc, [
      { t: 'cable', a: ports[0], b: ports[1] },
      { t: 'cut', cable: 'cable:X' },
      { t: 'cable', a: ports[1], b: ports[2] },
    ]);
    const planning = readPlan(made.doc, made.id);
    expect(planning.steps.map((s) => stepWord(planning, s, currentStep(planning)))).toEqual(['PLANNED', 'PLANNED', 'PLANNED']);

    let d = startPlan(made.doc, made.id, tick());
    d = markDone(d, planning.steps[0].id, { check: allow, ...tick() });
    d = markWentDifferently(d, planning.steps[1].id, { note: 'cable was already gone', gate, ...tick() });
    const doing = readPlan(d, made.id);
    const cur = currentStep(doing);
    expect(doing.steps.map((s) => stepWord(doing, s, cur))).toEqual(['✓ DONE', '≠ WENT DIFFERENTLY', 'STEP 3']);
  });

  it('maps edits to marks by kind, with canonical keys, in step order', () => {
    const { doc, devices, ports } = lab();
    const made = planWith(doc, [
      { t: 'cable', a: ports[0], b: ports[1] },
      { t: 'cut', cable: 'cable:X' },
      null,
    ]);
    const plan = readPlan(made.doc, made.id);
    const canon = buildCanon(made.doc);
    const marks = buildMarks(plan, canon);
    // The third step has no edit and no target: nothing to draw.
    expect(marks.map((m) => [m.ordinal, m.kind])).toEqual([
      [0, 'add-cable'],
      [1, 'cut-cable'],
    ]);
    expect(marks[0].ends).toEqual([ports[0], ports[1]]);
    expect(marks[0].keys).toEqual([devices[0], devices[1]]);
    expect(marks[1].keys).toEqual(['cable:X']);
  });

  it('Do lights only the current step; Record lights nothing until asked, then the changes', () => {
    const { doc, devices, ports } = lab();
    const made = planWith(doc, [
      { t: 'cable', a: ports[0], b: ports[1] },
      { t: 'cable', a: ports[1], b: ports[2] },
    ]);
    const canon = buildCanon(made.doc);
    expect(focusKeys(readPlan(made.doc, made.id), canon, false)).toBeNull();

    let d = startPlan(made.doc, made.id, tick());
    const steps = readPlan(d, made.id).steps;
    expect([...focusKeys(readPlan(d, made.id), canon, false)!]).toEqual([devices[0], devices[1]]);
    d = markDone(d, steps[0].id, { check: allow, ...tick() });
    expect([...focusKeys(readPlan(d, made.id), canon, false)!]).toEqual([devices[1], devices[2]]);
    d = markWentDifferently(d, steps[1].id, { note: 'used port 3 instead', gate, ...tick() });
    d = recordPlan(d, made.id, { outcome: 'partial', text: 'one went differently', gate, ...tick() });
    const recorded = readPlan(d, made.id);
    expect(buildMarks(recorded, canon)).toEqual([]);
    expect(focusKeys(recorded, canon, false)).toBeNull();
    expect(focusKeys(recorded, canon, true)?.size).toBe(3);
    expect(changedMarks(recorded, canon).map((m) => m.word)).toEqual(['✓ DONE', '≠ WENT DIFFERENTLY']);
  });
});

describe('the words on the band and the page', () => {
  it('says what a plan is doing without predicting anything', () => {
    const { doc, ports } = lab();
    const made = planWith(doc, [{ t: 'cable', a: ports[0], b: ports[1] }, null]);
    const plan = readPlan(made.doc, made.id);
    expect(bandSentence(plan)).toBe('2 changes');
    const doing = readPlan(startPlan(made.doc, made.id, tick()), made.id);
    expect(bandSentence(doing)).toBe('Step 1 of 2');
    expect(outcomeSentence({ ...doing, steps: doing.steps.map((s) => ({ ...s, state: 'done' as const })) })).toBe('2 of 2 as planned.');
  });

  it('formats a window, and leaves what does not read as a date', () => {
    expect(windowText('2026-10-04T02:00', '2026-10-04T04:00')).toBe('Sun 4 Oct 02:00–04:00');
    expect(windowText('next Sat', '')).toBe('next Sat');
    expect(windowText('', '')).toBe('');
  });
});

describe('the add-step form', () => {
  it('builds each kind as the edit the canvas already makes', () => {
    const { doc, devices, ports } = lab();
    const canon = buildCanon(doc);
    const addr = buildStep(doc, canon, { ...EMPTY_FORM, kind: 'address', device: devices[0], value: '10.0.1.1' });
    expect(addr).toMatchObject({ kind: 'address', after: '10.0.1.1', edit: { t: 'field', id: devices[0], key: 'Device.management_address', value: '10.0.1.1' } });
    const cable = buildStep(doc, canon, { ...EMPTY_FORM, kind: 'cable', portA: ports[0], portB: ports[1] });
    expect(cable).toMatchObject({ kind: 'cable', edit: { t: 'cable', a: ports[0], b: ports[1] } });
    const route = buildStep(doc, canon, { ...EMPTY_FORM, kind: 'route', change: 'New default route', device: devices[0] });
    expect(route).toMatchObject({ kind: 'route', targets: [devices[0]] });
    expect(route).not.toHaveProperty('edit');
  });

  it('says what is missing instead of guessing', () => {
    const { doc, ports } = lab();
    const canon = buildCanon(doc);
    expect(buildStep(doc, canon, { ...EMPTY_FORM, kind: 'address' })).toEqual({ error: 'Choose the device.' });
    expect(buildStep(doc, canon, { ...EMPTY_FORM, kind: 'cable', portA: ports[0], portB: ports[0] })).toEqual({ error: 'A cable needs two different ports.' });
    expect(buildStep(doc, canon, { ...EMPTY_FORM, kind: 'other' })).toEqual({ error: 'Say what changes.' });
    expect(buildStep(doc, canon, { ...EMPTY_FORM, kind: 'move', device: '', rack: 'rack:R' })).toEqual({ error: 'Choose a device that has a chassis.' });
  });

  it('a right-click on a thing prefills the right kind', () => {
    const { doc, devices, ports } = lab();
    const canon = buildCanon(doc);
    expect(prefillFor(doc, canon, devices[0])).toMatchObject({ kind: 'address', device: devices[0] });
    expect(prefillFor(doc, canon, ports[0])).toMatchObject({ kind: 'cable', portA: ports[0], device: devices[0] });
    expect(prefillFor(doc, canon, 'device:nothing-here')).toBeNull();
  });
});

describe('Done is gated by the checks', () => {
  const noFieldKey = () => undefined;

  it('a refusal blocks markDone, is kept whole for the Why card, and leaves the design as it was', () => {
    const { doc, ports } = lab();
    const made = planWith(doc, [{ t: 'cable', a: ports[0], b: ports[1] }]);
    const d = startPlan(made.doc, made.id, tick());
    const step = readPlan(d, made.id).steps[0];
    const hit = finding();
    let kept: CheckFinding | null = null;
    const mirror = { checkCable: () => [finding({ severity: 'warn', title: 'only a warning' }), hit], checkFieldEdit: () => [] };
    expect(() => markDone(d, step.id, { check: stepCheck(mirror, noFieldKey, (f) => (kept = f)), ...tick() })).toThrow(/cannot be joined/);
    expect(kept).toBe(hit);
    expect(readPlan(d, made.id).steps[0].state).toBe('planned');
    // Went differently is still open to that step.
    const after = markWentDifferently(d, step.id, { note: 'patched by hand', gate, ...tick() });
    expect(readPlan(after, made.id).steps[0].state).toBe('went_differently');
  });

  it('warnings and ideas do not block; a failing engine fails open; a field edit uses the registry number', () => {
    const calls: unknown[][] = [];
    const mirror = {
      checkCable: () => [finding({ severity: 'idea' })],
      checkFieldEdit: (...a: unknown[]) => {
        calls.push(a);
        return [];
      },
    };
    expect(refusalFor(mirror, { t: 'cable', a: 'p:1', b: 'p:2' }, noFieldKey)).toBeNull();
    expect(refusalFor(mirror, { t: 'field', id: 'device:A', key: 'Device.role', value: 'edge' }, (k) => (k === 'Device.role' ? 9 : undefined))).toBeNull();
    expect(calls).toEqual([[9, 'device:A', 'edge']]);
    const broken = {
      checkCable: () => {
        throw new Error('module gone');
      },
      checkFieldEdit: () => [],
    };
    expect(refusalFor(broken, { t: 'cable', a: 'p:1', b: 'p:2' }, noFieldKey)).toBeNull();
    expect(refusalFor(null, { t: 'cut', cable: 'cable:X' }, noFieldKey)).toBeNull();
  });

  it('only the current step of a plan being done is live, and only for someone who can edit', () => {
    const { doc, ports } = lab();
    const made = planWith(doc, [
      { t: 'cable', a: ports[0], b: ports[1] },
      { t: 'cable', a: ports[1], b: ports[2] },
    ]);
    const planning = readPlan(made.doc, made.id);
    expect(planning.steps.some((s) => stepIsLive(planning, s, true))).toBe(false);
    const doing = readPlan(startPlan(made.doc, made.id, tick()), made.id);
    expect(doing.steps.map((s) => stepIsLive(doing, s, true))).toEqual([true, false]);
    expect(doing.steps.map((s) => stepIsLive(doing, s, false))).toEqual([false, false]);
  });
});

describe('Esc and sentences', () => {
  it('Esc closes the Why card first, then a notice, then the changes shown', () => {
    expect(planEscTarget({ why: true, notice: true, changes: true })).toBe('why');
    expect(planEscTarget({ why: false, notice: true, changes: true })).toBe('notice');
    expect(planEscTarget({ why: false, notice: false, changes: true })).toBe('changes');
    expect(planEscTarget({ why: false, notice: false, changes: false })).toBeNull();
  });

  it('speaks a refusal in words, with a capital and a full stop', () => {
    expect(refusalText(new Error('already done'))).toBe('already done');
    expect(loadPanelPrefs({ getItem: () => 'not json' })).toEqual({ x: 0, y: 0, open: null });
    expect(loadPanelPrefs({ getItem: () => JSON.stringify({ x: 5, y: 'no', open: false }) })).toEqual({ x: 5, y: 0, open: false });
  });
});

// The controller's commands, driven without a DOM: render once to get the controller, then call it.
interface Harness {
  controller: PlansController;
  applied: Document[];
}

function harness(doc: Document, opts: { gate?: ((t: string) => string) | null; mirror?: Partial<Mirror> | null; open?: string; canEdit?: boolean } = {}): Harness {
  const applied: Document[] = [];
  let live = doc;
  const mirror = (opts.mirror === undefined ? { checkCable: () => [], checkFieldEdit: () => [], planPreview: () => [] } : opts.mirror) as Mirror | null;
  let captured: PlansController | null = null;
  const Probe = () => {
    captured = usePlansController({
      doc: live,
      boot: () => Promise.resolve(mirror as Mirror),
      mirrorNow: () => mirror,
      loadCostMs: () => null,
      redact: () => (opts.gate === undefined ? gate : opts.gate),
      applyDocChange: (next) => {
        applied.push(next);
        live = next;
      },
      actor: { actor: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
      canEdit: opts.canEdit ?? true,
      initialOpen: opts.open ?? null,
    });
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  return { controller: captured!, applied };
}

describe('the controller applies commands through the one write path', () => {
  it('refuses, and changes nothing, when the engine has not given a gate', async () => {
    const { doc } = lab();
    const h = harness(doc, { gate: null });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await h.controller.create({ title: 'Move uplink' })).toBe(false);
    spy.mockRestore();
    expect(h.applied).toEqual([]);
    expect(ENGINE_DOWN).toMatch(/nothing was changed/);
  });

  it('runs a plan created, stepped, started and done through applyDocChange, gated and attributed', async () => {
    const { doc, ports } = lab();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let h = harness(doc);
    expect(await h.controller.create({ title: 'Move uplink hunter2-abc123' })).toBe(true);
    const planId = h.applied[0].nodes.find((n) => n.id.startsWith('maintenance-plan:'))!.id;
    // The title passed through the gate before it reached the document.
    expect(readPlan(h.applied[0], planId).title).toBe('Move uplink <REDACTED>');

    h = harness(h.applied[0], { open: planId });
    const form = { ...EMPTY_FORM, kind: 'cable' as const, portA: ports[0], portB: ports[1], change: 'Cable it hunter2-zzz999' };
    expect(await h.controller.addStep(form)).toBe(true);
    const withStep = readPlan(h.applied[0], planId);
    expect(withStep.steps[0].change).toBe('Cable it <REDACTED>');

    const withStepDoc = h.applied[0];
    h = harness(withStepDoc, { open: planId });
    expect(await h.controller.start()).toBe(true);
    const startedDoc = h.applied[0];
    const stepId = readPlan(startedDoc, planId).steps[0].id;
    expect(withStepDoc.nodes.some((n) => n.id.startsWith('cable:'))).toBe(false);
    h = harness(startedDoc, { open: planId });
    expect(await h.controller.done(stepId)).toBe(true);
    const after = h.applied[0];
    expect(readPlan(after, planId).steps[0].state).toBe('done');
    // Done applied the step's edit through the normal command: a cable now joins the two ports.
    expect(after.nodes.some((n) => n.id.startsWith('cable:'))).toBe(true);
    expect(after.provenance.filter((r) => r.assertedBy === '01ARZ3NDEKTSV4RRFFQ69G5FAV').length).toBeGreaterThan(withStepDoc.provenance.length);
    spy.mockRestore();
  });

  it('a refusal from the checks blocks Done and applies nothing', async () => {
    const { doc, ports } = lab();
    const made = planWith(doc, [{ t: 'cable', a: ports[0], b: ports[1] }]);
    const started = startPlan(made.doc, made.id, tick());
    const stepId = readPlan(started, made.id).steps[0].id;
    const h = harness(started, { open: made.id, mirror: { checkCable: () => [finding()], checkFieldEdit: () => [], planPreview: () => [] } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await h.controller.done(stepId)).toBe(false);
    spy.mockRestore();
    expect(h.applied).toEqual([]);
  });

  it('the gate is applied to a Went differently note, and an empty note is refused', async () => {
    const { doc, ports } = lab();
    const made = planWith(doc, [{ t: 'cable', a: ports[0], b: ports[1] }]);
    const started = startPlan(made.doc, made.id, tick());
    const stepId = readPlan(started, made.id).steps[0].id;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness(started, { open: made.id });
    expect(await h.controller.wentDifferently(stepId, '   ')).toBe(false);
    expect(h.applied).toEqual([]);
    expect(await h.controller.wentDifferently(stepId, 'port dead, line was: hunter2-secretpw99')).toBe(true);
    spy.mockRestore();
    const step = readPlan(h.applied[0], made.id).steps[0];
    expect(step.note).toBe('port dead, line was: <REDACTED>');
    expect(step.state).toBe('went_differently');
  });

  it('a reader can look but not change', async () => {
    const { doc } = lab();
    const h = harness(doc, { canEdit: false });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await h.controller.create({ title: 'Nope' })).toBe(false);
    spy.mockRestore();
    expect(h.applied).toEqual([]);
  });
});

describe('the panel and the page, rendered', () => {
  function render(plan: Plan, doc: Document, extra: { canEdit?: boolean } = {}): { panel: string; page: string; band: string } {
    let controller: PlansController | null = null;
    const Probe = () => {
      controller = usePlansController({
        doc,
        boot: () => Promise.reject(new Error('no engine')),
        mirrorNow: () => null,
        loadCostMs: () => null,
        redact: () => null,
        applyDocChange: () => {},
        actor: undefined,
        canEdit: extra.canEdit ?? true,
        initialOpen: plan.id,
      });
      return null;
    };
    renderToStaticMarkup(createElement(Probe));
    const c = controller!;
    return {
      panel: renderToStaticMarkup(createElement(PlanPanel, { controller: c, plan: c.plan!, besideChecks: false })),
      page: renderToStaticMarkup(createElement(PlanListPage, { controller: c, plan: c.plan! })),
      band: renderToStaticMarkup(createElement(PlanBand, { controller: c })),
    };
  }

  it('Plan lists the steps with reorder, remove, the add form and Start work', () => {
    const { doc, ports } = lab();
    const made = planWith(doc, [
      { t: 'cable', a: ports[0], b: ports[1] },
      { t: 'cable', a: ports[1], b: ports[2] },
    ]);
    const out = render(readPlan(made.doc, made.id), made.doc);
    expect(out.panel).toContain('data-mode="plan"');
    expect(out.panel).toContain('plans-step--planned');
    expect(out.panel).toContain('aria-label="Move step 2 up"');
    expect(out.panel).toContain('aria-label="Remove step 1"');
    expect(out.panel).toContain('Start work');
    expect(out.panel).toContain('Add a step');
    expect(out.band).toContain('PLANNING');
    expect(out.band).toContain('Move uplink');
  });

  it('Do: only the current step has buttons, in order; marked and later steps have none', () => {
    const { doc, ports } = lab();
    const made = planWith(doc, [
      { t: 'cable', a: ports[0], b: ports[1] },
      { t: 'cable', a: ports[1], b: ports[2] },
      { t: 'cable', a: ports[0], b: ports[2] },
    ]);
    let d = startPlan(made.doc, made.id, tick());
    d = markDone(d, readPlan(d, made.id).steps[0].id, { check: allow, ...tick() });
    const out = render(readPlan(d, made.id), d);
    expect(out.panel).toContain('data-mode="do"');
    expect(out.panel.match(/Mark done/g)).toHaveLength(1);
    expect(out.panel.match(/Went differently/g)).toHaveLength(1);
    expect(out.panel).toContain('data-state="done"');
    expect(out.panel).toContain('data-state="current"');
    expect(out.panel).toContain('data-state="later"');
    // Marked, then current, then later: the order a keyboard walks.
    const order = ['data-state="done"', 'data-state="current"', 'data-state="later"'].map((s) => out.panel.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(out.panel).not.toContain('Start work');
    expect(out.band).toContain('Step 2 of 3');
  });

  it('Do shows nothing live to a reader', () => {
    const { doc, ports } = lab();
    const made = planWith(doc, [{ t: 'cable', a: ports[0], b: ports[1] }]);
    const d = startPlan(made.doc, made.id, tick());
    const out = render(readPlan(d, made.id), d, { canEdit: false });
    expect(out.panel).not.toContain('Mark done');
  });

  it('Record asks for an outcome, then reads back with Show these changes and where it was saved', () => {
    const { doc, ports } = lab();
    const made = planWith(doc, [{ t: 'cable', a: ports[0], b: ports[1] }]);
    let d = startPlan(made.doc, made.id, tick());
    d = markDone(d, readPlan(d, made.id).steps[0].id, { check: allow, ...tick() });
    const ask = render(readPlan(d, made.id), d);
    expect(ask.panel).toContain('data-mode="record"');
    for (const word of ['Succeeded', 'Partial', 'Failed', 'What went wrong']) expect(ask.panel).toContain(word);
    expect(ask.panel).not.toContain('Show these changes');

    d = recordPlan(d, made.id, { outcome: 'partial', text: 'port 24 is dead', gate, ...tick() });
    const out = render(readPlan(d, made.id), d);
    expect(out.panel).toContain('Show these changes');
    expect(out.panel).toContain('port 24 is dead');
    expect(out.panel).toContain('Saved to the history of');
    expect(out.band).toContain('RECORDED');
    expect(out.band).toContain('Partial');
  });

  it('the list page has the table, What it touches, Notes, Print and Back to canvas, with row labels for a phone', () => {
    const { doc, ports } = lab();
    const made = planWith(doc, [{ t: 'cable', a: ports[0], b: ports[1] }]);
    let d = startPlan(made.doc, made.id, tick());
    d = markWentDifferently(d, readPlan(d, made.id).steps[0].id, { note: 'used port 23', gate, ...tick() });
    const { page } = render(readPlan(d, made.id), d);
    for (const word of ['What it touches', 'Notes', 'Print', 'Back to canvas', 'used port 23', 'data-label="Before"', '≠ Went differently']) {
      expect(page).toContain(word);
    }
  });

  it('never uses amber or calls a plan private', () => {
    const { doc, ports } = lab();
    const made = planWith(doc, [{ t: 'cable', a: ports[0], b: ports[1] }]);
    const out = render(readPlan(made.doc, made.id), made.doc);
    const all = `${out.panel}${out.page}${out.band}`.toLowerCase();
    expect(all).not.toMatch(/amber|private|zero-knowledge|end-to-end/);
  });
});
