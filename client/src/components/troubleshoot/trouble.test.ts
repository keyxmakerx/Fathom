import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';

import { createIssue, readIssue, TYPED_AS_WRITTEN } from '../../document/issues';
import { buildCanon } from '../checks/checksModel';
import { applyTrouble } from '../drawing/troubleMarks';
import { DeviceIssues } from './DeviceIssues';
import { IssuesList } from './IssuesList';
import { TroublePanel } from './TroublePanel';
import { buildChain } from './chain';
import { lab } from './fixtures';
import { POINT_NOTE } from './pointing';
import {
  GLYPH,
  answerForKey,
  answered,
  canvasKeys,
  firstOpen,
  fixSteps,
  headerText,
  historyLine,
  nextOpen,
  planFixState,
  planTitle,
  pointOf,
  startDraft,
  toDraftSteps,
  troubleEscTarget,
  whenText,
  withAnswer,
  withNote,
  type Draft,
} from './troubleModel';
import { createTroubleStore } from './troubleStore';
import type { TroubleController } from './useTroubleController';

// The four sentences ADR-0040 forbids, split so this file does not itself say them.
const FORBIDDEN = [['zero', 'knowledge'].join('-'), ['end', 'to', 'end'].join('-'), 'we cannot read your ' + 'data', 'only you hold the ' + 'key'];
const NOW = 1_790_900_000_000;

function drafted(): { draft: Draft; l: ReturnType<typeof lab> } {
  const l = lab();
  return { draft: startDraft(l.doc, l.nas.device, NOW)!, l };
}

function stub(over: Partial<TroubleController> = {}): TroubleController {
  const noop = () => {};
  return {
    store: createTroubleStore(),
    doc: null,
    canEdit: true,
    draft: null,
    viewing: null,
    focus: 0,
    panelOpen: true,
    setPanelOpen: noop,
    why: null,
    openWhy: noop,
    closeWhy: noop,
    notice: null,
    clearNotice: noop,
    confirmingClose: false,
    issues: [],
    issuesOf: () => [],
    start: () => true,
    openIssue: noop,
    focusStep: noop,
    answer: noop,
    setNote: noop,
    save: async () => true,
    planAFix: async () => true,
    markClosed: async () => true,
    close: noop,
    keepGoing: noop,
    ...over,
  };
}

describe('the draft', () => {
  it('starts with nothing answered, the chain asked in order and the "Also affected" lines read', () => {
    const { draft } = drafted();
    expect(draft.deviceName).toBe('nas-01');
    expect(draft.steps.map((s) => s.topic)).toEqual(['power', 'neighbours', 'link', 'port', 'address', 'gateway']);
    expect(draft.steps.every((s) => s.answer === 'unanswered')).toBe(true);
    expect(draft.affected).toEqual(['Nothing else depends on nas-01.']);
    expect(draft.savedId).toBeNull();
    expect(firstOpen(draft.steps)).toBe(0);
    expect(startDraft(lab().doc, 'chassis:x', NOW)).toBeNull();
  });

  it('answers a step, moves on, and reads "3 of 6" then "narrowed"', () => {
    let { draft } = drafted();
    expect(headerText(draft)).toBe('nas-01 is down · 1 of 6');
    draft = withAnswer(draft, 0, 'ok', NOW);
    draft = withAnswer(draft, 1, 'ok', NOW);
    expect(headerText(draft)).toBe('nas-01 is down · 3 of 6');
    expect(nextOpen(draft.steps, 1)).toBe(2);
    draft = withAnswer(draft, 2, 'not_ok', NOW);
    expect(headerText(draft)).toBe('nas-01 is down · narrowed');
    expect(answered(draft.steps)).toBe(3);
    expect(pointOf(draft)!.sentence).toBe('Your answers point at the cable or port 23 on sw-02.');
    expect(pointOf(draft)!.note).toBe(POINT_NOTE);
  });

  it('says all answered when nothing points anywhere', () => {
    let { draft } = drafted();
    for (let i = 0; i < draft.steps.length; i += 1) draft = withAnswer(draft, i, 'ok', NOW);
    expect(headerText(draft)).toBe('nas-01 is down · all answered');
    expect(nextOpen(draft.steps, 5)).toBe(5);
  });

  it('keeps notes, and marks a note pasted for good once a paste reached it', () => {
    let { draft } = drafted();
    draft = withNote(draft, 2, 'light is off', false);
    expect(draft.steps[2].pasted).toBe(false);
    draft = withNote(draft, 2, 'light is off, switch said x', true);
    draft = withNote(draft, 2, 'light is off', false);
    expect(draft.steps[2]).toMatchObject({ note: 'light is off', pasted: true });
  });

  it('is read only once saved', () => {
    const { draft } = drafted();
    const locked = { ...draft, savedId: 'issue:X' };
    expect(withAnswer(locked, 0, 'ok', NOW)).toBe(locked);
    expect(withNote(locked, 0, 'x', false)).toBe(locked);
  });

  it('plans a fix only once an answer points at something, with one other step per suspect part', () => {
    let { draft } = drafted();
    const stateFor = () => planFixState(draft, true);
    expect(stateFor()).toEqual({ ok: false, reason: 'Nothing is suspect yet: answer Not OK to a step first.' });
    draft = withAnswer(draft, 2, 'not_ok', NOW);
    expect(stateFor()).toEqual({ ok: true });
    expect(planFixState(draft, false)).toEqual({ ok: false, reason: 'You can look at this but not change it.' });
    const steps = fixSteps(pointOf(draft));
    expect(steps.map((s) => s.change)).toEqual(['Check the cable', 'Check port 23 on sw-02']);
    expect(planTitle('nas-01')).toBe('Fix: nas-01 is down');
    expect(fixSteps(null)).toEqual([]);
  });

  it('lights the chain, the current step and what the answers point at, as canonical keys', () => {
    let { draft, l } = drafted();
    draft = withAnswer(draft, 2, 'not_ok', NOW);
    const canon = buildCanon(l.doc);
    const k = canvasKeys(draft, 2, canon);
    expect(k.chain.has(l.pdu.device)).toBe(true);
    expect(k.chain.has(l.cable)).toBe(true);
    expect(k.current).toEqual(new Set([l.nas.device, l.cable, l.sw.device]));
    expect(k.suspects.has(l.cable)).toBe(true);
    expect(k.suspects.has(l.sw.device)).toBe(true);
    expect(canvasKeys(draft, -1, canon).current.size).toBe(0);
  });

  it('saves every step with its answer and freezes the sentence, then reads back', () => {
    let { draft, l } = drafted();
    draft = withAnswer(draft, 0, 'ok', NOW);
    draft = withAnswer(draft, 2, 'not_ok', NOW);
    const made = createIssue(l.doc, { deviceId: draft.deviceId, title: 'nas-01 is down', steps: toDraftSteps(draft), outcome: pointOf(draft)!.sentence, gate: TYPED_AS_WRITTEN, now: NOW });
    const issue = readIssue(made.doc, made.id);
    expect(issue.steps.map((s) => s.answer)).toEqual(['ok', 'unanswered', 'not_ok', 'unanswered', 'unanswered', 'unanswered']);
    expect(issue.outcome).toBe('Your answers point at the cable or port 23 on sw-02.');
    expect(issue.steps[2].targets).toContain(l.cable);
  });
});

describe('words and keys', () => {
  it('answers with 1, 2, 3 and nothing else', () => {
    expect(answerForKey('1')).toBe('ok');
    expect(answerForKey('2')).toBe('not_ok');
    expect(answerForKey('3')).toBe('cant_tell');
    expect(answerForKey('4')).toBeNull();
    expect(answerForKey('a')).toBeNull();
  });

  it('closes the Why? card first, then the panel', () => {
    expect(troubleEscTarget({ why: true, panel: true })).toBe('why');
    expect(troubleEscTarget({ why: false, panel: true })).toBe('panel');
    expect(troubleEscTarget({ why: false, panel: false })).toBeNull();
  });

  it('shows a date as "3 Oct 21:40" and an issue as one line of its history', () => {
    expect(whenText('2026-10-03T21:40:00')).toBe('3 Oct 21:40');
    expect(whenText('not a date')).toBe('not a date');
    expect(historyLine({ title: 'nas-01 is down', openedAt: '2026-10-03T21:40:00', outcome: 'Your answers point at the cable.\nReplaced', stage: 'open' })).toBe(
      'nas-01 is down · 3 Oct 21:40 · open · Your answers point at the cable.',
    );
  });

  it('uses glyphs, not colours, for the answers', () => {
    expect(GLYPH).toEqual({ ok: '✓', not_ok: '✗', cant_tell: '?', unanswered: '○' });
  });

  it('never writes the four forbidden sentences, nor "the problem is", in any step, Why? or sentence', () => {
    const { draft } = drafted();
    let d = draft;
    for (let i = 0; i < d.steps.length; i += 1) d = withAnswer(d, i, i % 2 === 0 ? 'not_ok' : 'ok', NOW);
    const all = [
      ...draft.steps.flatMap((s) => [s.question, s.detail, ...s.why, ...s.tests, ...s.suspects.map((x) => x.label)]),
      ...draft.affected,
      pointOf(d)!.sentence,
      pointOf(d)!.note,
    ]
      .join('\n')
      .toLowerCase();
    for (const f of FORBIDDEN) expect(all).not.toContain(f);
    expect(all).not.toMatch(/the problem is/);
  });
});

describe('the panel', () => {
  it('reads "NAS-01 IS DOWN · 3 OF 6" with ✓ steps, the open step with its buttons, and ○ later steps', () => {
    let { draft } = drafted();
    draft = withAnswer(withAnswer(draft, 0, 'ok', NOW), 1, 'ok', NOW);
    const html = renderToStaticMarkup(createElement(TroublePanel, { controller: stub({ draft, focus: 2 }), besideChecks: false }));
    expect(html).toContain('nas-01 is down · 3 of 6');
    expect(html).toContain('✓');
    expect(html).toContain('○');
    expect(html).toContain('Link light on sw-02 port 23?');
    expect(html).toContain('Cable 0412, red, to nas-01 eth0');
    for (const word of ['OK', 'Not OK', "Can&#x27;t tell"]) expect(html).toContain(`>${word}<`);
    expect(html).toContain('Why?');
    expect(html).toContain('Also affected');
    expect(html).toContain('Nothing else depends on nas-01.');
    expect(html).toContain('Plan a fix');
    expect(html).toContain('Save as an issue');
    expect(html).toContain('Nothing is suspect yet');
    // Exactly one step is open.
    expect(html.match(/data-state="current"/g)).toHaveLength(1);
    expect(html).toContain('aria-current="step"');
  });

  it('shows where the answers point, the tests, and a live Plan a fix after a Not OK', () => {
    let { draft } = drafted();
    draft = withAnswer(draft, 2, 'not_ok', NOW);
    const html = renderToStaticMarkup(createElement(TroublePanel, { controller: stub({ draft, focus: 3 }), besideChecks: false }));
    expect(html).toContain('Your answers point at the cable or port 23 on sw-02.');
    expect(html).toContain('Try nas-01 on a free port');
    expect(html).toContain('nas-01 is down · narrowed');
    expect(html).toContain('✗');
    expect(html).not.toContain('Nothing is suspect yet');
    expect(html).toMatch(/data-testid="trouble-plan"/);
  });

  it('opens the Why? card on the open step', () => {
    const { draft } = drafted();
    const html = renderToStaticMarkup(createElement(TroublePanel, { controller: stub({ draft, focus: 0, why: 0 }), besideChecks: false }));
    expect(html).toContain('data-testid="trouble-why"');
    expect(html).toContain('A device with no power shows no lights and answers nothing');
  });

  it('puts a note field with the typed sentence on the open step', () => {
    const { draft } = drafted();
    const html = renderToStaticMarkup(createElement(TroublePanel, { controller: stub({ draft, focus: 0 }), besideChecks: false }));
    expect(html).toContain('Add what you saw');
    expect(html).toContain('Stored as typed. Fathom does not redact what you type, only what you paste.');
  });

  it('leaves out Save and Plan a fix for someone who cannot edit, and locks the answers', () => {
    const { draft } = drafted();
    const html = renderToStaticMarkup(createElement(TroublePanel, { controller: stub({ draft, focus: 0, canEdit: false }), besideChecks: false }));
    expect(html).not.toContain('Save as an issue');
    expect(html).not.toContain('Plan a fix');
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-answer="ok"|<button[^>]*data-answer="ok"[^>]*disabled/);
  });

  it('locks the steps once saved and offers Mark closed', () => {
    const { draft } = drafted();
    const html = renderToStaticMarkup(createElement(TroublePanel, { controller: stub({ draft: { ...draft, savedId: 'issue:X' }, focus: 0 }), besideChecks: false }));
    expect(html).toContain("Saved to nas-01&#x27;s history.");
    expect(html).toContain('Mark closed');
    expect(html).not.toContain('Save as an issue');
    expect(html).toMatch(/data-answer="ok"/);
  });

  it('asks before throwing answers away', () => {
    const { draft } = drafted();
    const html = renderToStaticMarkup(createElement(TroublePanel, { controller: stub({ draft, confirmingClose: true }), besideChecks: false }));
    expect(html).toContain('Close without saving?');
    expect(html).toContain('Close anyway');
  });

  it('folds to a bar that can reopen it or stop the session', () => {
    const { draft } = drafted();
    const html = renderToStaticMarkup(createElement(TroublePanel, { controller: stub({ draft, panelOpen: false }), besideChecks: false }));
    expect(html).toContain('data-testid="trouble-folded"');
    expect(html).toContain('Stop');
  });

  it('reads a saved issue for anyone, with its steps as glyphs and its frozen sentence, and no way to change it', () => {
    const { draft, l } = drafted();
    let d = withAnswer(draft, 2, 'not_ok', NOW);
    d = withNote(d, 2, 'light is off', false);
    const made = createIssue(l.doc, { deviceId: d.deviceId, title: 'nas-01 is down', steps: toDraftSteps(d), outcome: pointOf(d)!.sentence, gate: TYPED_AS_WRITTEN, now: NOW });
    const issue = readIssue(made.doc, made.id);
    const html = renderToStaticMarkup(createElement(TroublePanel, { controller: stub({ viewing: issue, canEdit: false }), besideChecks: false }));
    expect(html).toContain('nas-01 is down');
    expect(html).toContain('✗');
    expect(html).toContain('light is off');
    expect(html).toContain('Your answers point at the cable or port 23 on sw-02.');
    expect(html).not.toContain('Mark closed');
    expect(html).not.toMatch(/data-answer="ok"[^>]*>OK/);
  });

  it('uses no colour of its own: only tokens and ink', () => {
    const css = readCss();
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgb|rgba|hsl)\(/);
    expect(css).not.toContain('--m-plan');
    expect(css).not.toContain('--m-do');
  });
});

function readCss(): string {
  return readFileSync(fileURLToPath(new URL('./trouble.css', import.meta.url)), 'utf8');
}

describe('a device page', () => {
  it('offers It\'s down and the saved issues to someone who can edit, only the issues to a reader, nothing when there is neither', () => {
    const { draft, l } = drafted();
    const made = createIssue(l.doc, { deviceId: draft.deviceId, title: 'nas-01 is down', steps: toDraftSteps(draft), gate: TYPED_AS_WRITTEN, now: NOW });
    const issues = [readIssue(made.doc, made.id)];
    const edit = renderToStaticMarkup(createElement(DeviceIssues, { controller: stub({ issuesOf: () => issues }), chassisId: l.nas.chassis, deviceId: l.nas.device }));
    expect(edit).toContain("It&#x27;s down");
    expect(edit).toContain('Issues · 1');
    expect(edit).toContain('nas-01 is down');
    const read = renderToStaticMarkup(createElement(DeviceIssues, { controller: stub({ canEdit: false, issuesOf: () => issues }), chassisId: l.nas.chassis, deviceId: l.nas.device }));
    expect(read).not.toContain("It&#x27;s down</button>");
    expect(read).toContain('nas-01 is down');
    expect(renderToStaticMarkup(createElement(DeviceIssues, { controller: stub({ canEdit: false }), chassisId: l.nas.chassis, deviceId: l.nas.device }))).toBe('');
  });

  it('lists issues as an Inventory kind', () => {
    const { draft, l } = drafted();
    expect(renderToStaticMarkup(createElement(IssuesList, { doc: l.doc }))).toContain('No issues yet');
    const made = createIssue(l.doc, { deviceId: draft.deviceId, title: 'nas-01 is down', steps: toDraftSteps(draft), outcome: 'Your answers point at the cable.', gate: TYPED_AS_WRITTEN, now: NOW });
    const html = renderToStaticMarkup(createElement(IssuesList, { doc: made.doc }));
    expect(html).toContain('nas-01 is down');
    expect(html).toContain('Your answers point at the cable.');
  });
});

describe('the canvas', () => {
  const node = (id: string, chassis: string): Node => ({ id, type: 'chassis', position: { x: 0, y: 0 }, data: { chassis: { id: chassis } } });
  const edge = (id: string, source: string, target: string, cable: string): Edge => ({ id, source, target, data: { cable: { id: cable } } });

  it('lights the chain, fades the rest, drops the sheath colours and tags what the answers point at', () => {
    const { draft, l } = drafted();
    const d = withAnswer(draft, 2, 'not_ok', NOW);
    const canon = buildCanon(l.doc);
    const keys = canvasKeys(d, 3, canon);
    const nodes = [node('n-nas', l.nas.chassis), node('n-sw', l.sw.chassis), node('n-pc', l.pc.chassis), node('n-far', 'chassis:far-away')];
    const edges = [edge('e-up', 'n-nas', 'n-sw', l.cable), edge('e-other', 'n-sw', 'n-far', 'cable:elsewhere')];
    const out = applyTrouble({ nodes, edges, trouble: { active: true, chain: keys.chain, current: keys.current, suspects: keys.suspects }, canon, checksShowing: false });
    const cls = (n: Node) => n.className ?? '';
    expect(cls(out.nodes[0])).not.toContain('checks-faded');
    expect(cls(out.nodes[1])).not.toContain('checks-faded');
    expect(cls(out.nodes[3])).toContain('checks-faded');
    expect((out.edges[0].data as { troubleLit?: boolean }).troubleLit).toBe(true);
    expect((out.edges[1].data as { troubleLit?: boolean }).troubleLit).toBeUndefined();
    expect(out.edges[1].className).toContain('checks-faded');
    // Every cable draws in ink while it runs.
    for (const e of out.edges) expect((e.data as { troubleInk?: boolean }).troubleInk).toBe(true);
    // The suspect device wears the tag.
    expect(cls(out.nodes[1])).toContain('trouble-suspect');
    expect(String((out.nodes[1].style as Record<string, unknown>)['--trouble-word'])).toContain('POINTS HERE');
  });

  it('draws nothing and returns the same arrays when no session runs, and leaves the fade to a Checks Show', () => {
    const nodes = [node('a', 'chassis:a')];
    const edges: Edge[] = [];
    const idle = { active: false, chain: new Set<string>(), current: new Set<string>(), suspects: new Set<string>() };
    const same = applyTrouble({ nodes, edges, trouble: idle, canon: (id) => id, checksShowing: false });
    expect(same.nodes).toBe(nodes);
    expect(same.edges).toBe(edges);
    const chain = new Set(['chassis:b']);
    const shown = applyTrouble({ nodes, edges, trouble: { ...idle, active: true, chain }, canon: (id) => id, checksShowing: true });
    expect(shown.nodes[0].className ?? '').not.toContain('checks-faded');
  });

  it('keeps the store between the panel and the canvas, and tells listeners', () => {
    const store = createTroubleStore();
    const seen = vi.fn();
    const off = store.subscribe(seen);
    store.set({ active: true, chain: new Set(['a']) });
    expect(store.get().active).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    store.set({ active: false });
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('the chain of the lab, for a sanity read', () => {
  it('has the six steps the mockup shows', () => {
    const l = lab();
    expect(buildChain(l.doc, l.nas.device).steps).toHaveLength(6);
  });
});
