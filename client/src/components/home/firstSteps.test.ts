import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectPorts } from '../../document/cables';
import { addSketchPort, createSketchDevice } from '../../document/commands';
import { emptyDocument, parseNodeId, type Document } from '../../document/model';
import { buildSample, sample } from './sampleNetwork';
import { GettingStarted } from './GettingStarted';
import {
  FIRST_STEPS,
  freshSteps,
  homeStartsWith,
  howTo,
  loadFirstSteps,
  markStepsSeen,
  nextStep,
  recordFirstSteps,
  rememberSample,
  sampleOfDesign,
  setFirstStepsHidden,
  stepsIn,
} from './firstSteps';

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

afterEach(() => vi.unstubAllGlobals());

function deviceWithPort(doc: Document): { doc: Document; portId: string } {
  const before = new Set(doc.nodes.map((n) => n.id));
  let next = createSketchDevice(doc);
  const chassisId = next.nodes.find((n) => !before.has(n.id) && parseNodeId(n.id).kind === 'Chassis')!.id;
  const had = new Set(next.nodes.map((n) => n.id));
  next = addSketchPort(next, chassisId, { label: 'eth0', connector: 'rj45', face: 'rear' });
  return { doc: next, portId: next.nodes.find((n) => !had.has(n.id))!.id };
}

describe('the five first steps', () => {
  it('tick from what a design holds', () => {
    expect(stepsIn(emptyDocument(), false)).toEqual([]);
    const a = deviceWithPort(emptyDocument());
    expect(stepsIn(a.doc, false)).toEqual(['device']);
    const b = deviceWithPort(a.doc);
    expect(stepsIn(connectPorts(b.doc, a.portId, b.portId, {}), false).sort()).toEqual(['cable', 'device']);
  });

  it('count nothing a sample came with', () => {
    const built = buildSample(sample('home-lab'), new Map()).doc;
    expect(stepsIn(built, false).sort()).toEqual(['cable', 'device', 'place']);
    expect(stepsIn(built, true)).toEqual([]);
  });

  it('remember per account, and a trace ticks anywhere, the sample included', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    const built = buildSample(sample('home-lab'), new Map()).doc;
    rememberSample('a1', 'sample-design');
    expect(recordFirstSteps('a1', 'sample-design', built, false)).toBe(false);
    expect(recordFirstSteps('a1', 'sample-design', built, true)).toBe(true);
    expect(loadFirstSteps('a1').done).toEqual(['trace']);
    expect(loadFirstSteps('a2').done).toEqual([]);
    recordFirstSteps('a1', 'own-design', built, false);
    expect(loadFirstSteps('a1').done.sort()).toEqual(['cable', 'device', 'place', 'trace']);
  });

  it('hide and come back, and survive a browser that refuses storage', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(setFirstStepsHidden('a1', true).hidden).toBe(true);
    expect(loadFirstSteps('a1').hidden).toBe(true);
    expect(setFirstStepsHidden('a1', false).hidden).toBe(false);
    vi.stubGlobal('localStorage', undefined);
    expect(loadFirstSteps('a1')).toEqual({ done: [], hidden: false, samples: [], sampleOf: {}, seen: [] });
    expect(() => recordFirstSteps('a1', 'd', emptyDocument(), true)).not.toThrow();
  });

  it('remember which sample a design was made from', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    rememberSample('a1', 'd-old');
    rememberSample('a1', 'd-new', 'practice-lab');
    expect(sampleOfDesign('a1', 'd-new')).toBe('practice-lab');
    expect(sampleOfDesign('a1', 'd-old')).toBe('home-lab');
    expect(sampleOfDesign('a1', 'own')).toBeNull();
  });

  it('draw the count, the ticked steps struck through, and the paste note', () => {
    const html = renderToStaticMarkup(createElement(GettingStarted, { done: ['device', 'place'], onHide: () => {} }));
    expect(html).toContain('Getting started · 2 of 5');
    expect(html.match(/first-steps__step--done/g)).toHaveLength(2);
    expect(html).toContain('credentials never kept');
    expect(html).toContain('lives under Help');
  });

  it('say how: the next step without being asked, the others when pressed', () => {
    expect(nextStep([])).toBe('device');
    expect(nextStep(['device', 'place', 'cable'])).toBe('paste');
    expect(nextStep(FIRST_STEPS.map((s) => s.id))).toBeNull();
    const html = renderToStaticMarkup(createElement(GettingStarted, { done: ['device', 'place'], onHide: () => {} }));
    // Three steps are left, each a button that opens its how; only the next one (paste) starts open.
    expect(html.match(/first-steps__row--ask/g)).toHaveLength(3);
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(html.match(/first-steps__how--open/g)).toHaveLength(1);
    expect(html).toMatch(/first-steps__step--next[^>]*>.*?Paste its config/);
    // A ticked step is not a button and has no how.
    expect(html).not.toContain(FIRST_STEPS[0]!.how);
    for (const step of FIRST_STEPS) {
      expect(step.how).toMatch(/^[A-Z].*\.$/);
      expect(step.how.length).toBeLessThanOrEqual(110);
    }
  });

  it('name the button this Home really has for the first step', () => {
    const first = FIRST_STEPS[0]!;
    expect(howTo(first)).toBe(first.how);
    expect(howTo(first, 'new-design')).toContain('Press New design,');
    expect(howTo(first, 'start-drawing')).toContain('Press Start drawing,');
    expect(howTo(first, 'none')).not.toMatch(/Press/);
    for (const startsWith of ['new-design', 'start-drawing', 'none'] as const) {
      expect(howTo(first, startsWith)).toMatch(/^[A-Z].*\.$/);
      expect(howTo(first, startsWith).length).toBeLessThanOrEqual(110);
      // Only the first step changes with the button.
      for (const step of FIRST_STEPS.slice(1)) expect(howTo(step, startsWith)).toBe(step.how);
    }
    // First Home has the welcome's Start drawing; after that New design, or neither for someone who may not draw.
    expect(homeStartsWith(true, false, true)).toBe('start-drawing');
    expect(homeStartsWith(false, true, true)).toBe('new-design');
    expect(homeStartsWith(false, false, true)).toBe('none');
    // Until Home has loaded, the words stay as they will most likely be.
    expect(homeStartsWith(false, false, false)).toBe('new-design');
    const html = renderToStaticMarkup(createElement(GettingStarted, { done: [], startsWith: 'start-drawing', onHide: () => {} }));
    expect(html).toContain('Press Start drawing,');
    expect(html).not.toContain('New design');
  });

  it('tick themselves once: a step done since Home last drew the list is fresh until it has been seen', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    const built = buildSample(sample('home-lab'), new Map()).doc;
    recordFirstSteps('a1', 'own-design', built, false);
    expect(freshSteps(loadFirstSteps('a1'))).toEqual(['device', 'place', 'cable']);
    markStepsSeen('a1');
    expect(freshSteps(loadFirstSteps('a1'))).toEqual([]);
    recordFirstSteps('a1', 'own-design', built, true);
    expect(freshSteps(loadFirstSteps('a1'))).toEqual(['trace']);
    // What was kept before ticks were tracked counts as seen: nothing replays.
    localStorage.setItem('fathom.firstSteps.a3', JSON.stringify({ done: ['device', 'cable'], hidden: false, samples: [] }));
    expect(freshSteps(loadFirstSteps('a3'))).toEqual([]);
  });

  it('draw a fresh tick from where the bar stood', () => {
    const html = renderToStaticMarkup(createElement(GettingStarted, { done: ['device', 'place', 'cable'], fresh: ['cable'], onHide: () => {} }));
    expect(html.match(/first-steps__step--fresh/g)).toHaveLength(1);
    expect(html).toContain('first-steps__fill--grow');
    expect(html).toMatch(/width:60%;--from:40%/);
    const still = renderToStaticMarkup(createElement(GettingStarted, { done: ['device', 'place', 'cable'], onHide: () => {} }));
    expect(still).not.toContain('first-steps__fill--grow');
    expect(still).not.toContain('first-steps__step--fresh');
  });
});
