import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectPorts } from '../../document/cables';
import { addSketchPort, createSketchDevice } from '../../document/commands';
import { emptyDocument, parseNodeId, type Document } from '../../document/model';
import { buildSample, sample } from './sampleNetwork';
import { GettingStarted } from './GettingStarted';
import { loadFirstSteps, recordFirstSteps, rememberSample, setFirstStepsHidden, stepsIn } from './firstSteps';

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
    expect(loadFirstSteps('a1')).toEqual({ done: [], hidden: false, samples: [] });
    expect(() => recordFirstSteps('a1', 'd', emptyDocument(), true)).not.toThrow();
  });

  it('draw the count, the ticked steps struck through, and the paste note', () => {
    const html = renderToStaticMarkup(createElement(GettingStarted, { done: ['device', 'place'], onHide: () => {} }));
    expect(html).toContain('Getting started · 2 of 5');
    expect(html.match(/first-steps__step--done/g)).toHaveLength(2);
    expect(html).toContain('credentials never kept');
    expect(html).toContain('lives under Help');
  });
});
