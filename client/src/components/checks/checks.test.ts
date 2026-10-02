import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { CheckFinding, ChecksResult } from '../../engine/engine';
import { emptyDocument, type Document } from '../../document/model';
import { CheckBadge } from './CheckBadge';
import { ChecksBarChip, ChecksPanel, WhyCard } from './ChecksPanel';
import { RefusalCard, REFUSAL_HEADING } from './RefusalCard';
import { ChecksContext, createChecksStore } from './checksStore';
import {
  buildBadgeMap,
  buildCanon,
  clampOffset,
  findingKey,
  firstRefusal,
  guardMayReload,
  standingDelay,
  matchShown,
  panelNotes,
  summaryText,
} from './checksModel';
import { loadPrefs, savePrefs, type ChecksController } from './useChecksController';

const finding = (over: Partial<CheckFinding> = {}): CheckFinding => ({
  rule: 'topo.switch.single-cable',
  severity: 'idea',
  title: 'A switch has only one cable recorded',
  fix: 'Record the cables that are missing, or add a second link to another switch.',
  why: 'Only one cable is recorded on this switch.',
  concept: 'check.topo.redundant-paths',
  source: { title: '', url: '', note: 'A design heuristic, not a standard.' },
  elements: [
    { id: 'device:D1', name: 'sw-01' },
    { id: 'cable:C1', name: '(unlabelled)' },
  ],
  ...over,
});

const result = (over: Partial<ChecksResult> = {}): ChecksResult => ({
  refuse: 0,
  warn: 0,
  idea: 0,
  rulesLoaded: 12,
  loadFailed: false,
  unfinished: 0,
  findings: [],
  ...over,
});

const FORBIDDEN = [/permitted/i, /denied/i, /you['’]re wrong/i];

function controller(over: Partial<ChecksController> = {}): ChecksController {
  return {
    api: { store: createChecksStore(), guardCable: () => false, clearShow: () => {} },
    result: result(),
    unavailable: false,
    open: true,
    setOpen: () => {},
    prefs: { x: 0, y: 0, open: null },
    setOffset: () => {},
    why: null,
    openWhy: () => {},
    closeWhy: () => {},
    showKey: null,
    toggleShow: () => {},
    refusal: null,
    dismissRefusal: () => {},
    ...over,
  };
}

describe('summary and notes', () => {
  it('counts in words', () => {
    expect(summaryText(result({ warn: 2, idea: 1 }))).toBe('2 warnings · 1 idea');
    expect(summaryText(result({ refuse: 1, warn: 1 }))).toBe("1 can't work · 1 warning");
    expect(summaryText(result())).toBe('');
  });
  it('says "No problems found" only when rules loaded', () => {
    expect(panelNotes(result())).toEqual(['No problems found']);
    expect(panelNotes(result({ rulesLoaded: 0 }))).toEqual([]);
  });
  it('says what could not finish and what failed to load', () => {
    expect(panelNotes(result({ unfinished: 3, idea: 1, findings: [finding()] }))).toEqual(['3 checks could not finish']);
    expect(panelNotes(result({ unfinished: 1, findings: [finding()] }))).toEqual(['1 check could not finish']);
    expect(panelNotes(result({ loadFailed: true, rulesLoaded: 0 }))).toEqual(['Checks are off: a rule failed to load']);
  });
});

describe('the element -> device map and the badge counts', () => {
  const edge = (id: string, from: string, to: string) => ({ id, from, to, prov: 'p', fields: {} });
  const doc: Document = {
    ...emptyDocument(),
    edges: [
      edge('has-chassis:E1', 'device:D1', 'chassis:H1'),
      edge('has-port:E2', 'chassis:H1', 'physical-port:P1'),
      edge('has-port:E3', 'chassis:H1', 'physical-port:P2'),
    ],
  };
  const canon = buildCanon(doc);

  it('maps a port through its chassis to its device, and leaves a cable alone', () => {
    expect(canon('physical-port:P1')).toBe('device:D1');
    expect(canon('chassis:H1')).toBe('device:D1');
    expect(canon('cable:C1')).toBe('cable:C1');
    expect(canon('device:D2')).toBe('device:D2');
  });
  it('counts a finding once per device, ports included, and once per cable', () => {
    const f1 = finding({ elements: [{ id: 'physical-port:P1', name: '' }, { id: 'physical-port:P2', name: '' }, { id: 'cable:C1', name: '' }] });
    const f2 = finding({ rule: 'other', elements: [{ id: 'device:D1', name: '' }] });
    const f3 = finding({ rule: 'minted', elements: [{ id: '', name: 'new port' }, { id: 'device:D2', name: '' }] });
    const map = buildBadgeMap([f1, f2, f3], canon);
    expect(map.get('device:D1')).toBe(2);
    expect(map.get('cable:C1')).toBe(1);
    expect(map.get('device:D2')).toBe(1);
    expect(map.has('')).toBe(false);
  });
  it('a removed edge no longer links a port to its device', () => {
    const gone = { ...doc, edges: doc.edges.map((e) => (e.id === 'has-port:E2' ? { ...e, absentSince: 1 } : e)) };
    expect(buildCanon(gone)('physical-port:P1')).toBe('physical-port:P1');
  });
  it('Show keeps the involved plates and the cable ends, and fades the rest', () => {
    const nodes = [
      { id: 'chassis:H1', type: 'chassis', data: { chassis: { id: 'chassis:H1' } } },
      { id: 'chassis:H9', type: 'chassis', data: { chassis: { id: 'chassis:H9' } } },
      { id: 'rack:R1', type: 'rack', data: {} },
    ];
    const edges = [{ id: 'cable:C1', source: 'chassis:H1', target: 'chassis:H9', data: { cable: { id: 'cable:C1' } } }, { id: 'cable:C2', data: { cable: { id: 'cable:C2' } } }];
    const shown = matchShown(nodes, edges, new Set(['device:D1']), canon);
    expect([...shown.nodeIds]).toEqual(['chassis:H1']);
    expect(shown.edgeIds.size).toBe(0);
    const viaCable = matchShown(nodes, edges, new Set(['cable:C1']), canon);
    expect([...viaCable.nodeIds].sort()).toEqual(['chassis:H1', 'chassis:H9']);
    expect([...viaCable.edgeIds]).toEqual(['cable:C1']);
  });
});

describe('the gesture guard', () => {
  const refuse = finding({ rule: 'phy.port.already-cabled', severity: 'refuse', title: 'A port has more than one cable on it' });
  it('refuses on a refusal row, so nothing is drawn', () => {
    const mirror = { checkCable: () => [finding(), refuse] };
    expect(firstRefusal(mirror, 'a', 'b', ['cat6'])?.rule).toBe('phy.port.already-cabled');
  });
  it('lets a warning or an idea through', () => {
    expect(firstRefusal({ checkCable: () => [finding(), finding({ severity: 'warn' })] }, 'a', 'b', [''])).toBeNull();
  });
  it('tries each candidate medium and names the first that refuses', () => {
    const seen: string[] = [];
    const mirror = {
      checkCable: (_a: unknown, _b: unknown, media: string) => {
        seen.push(media);
        return media === 'twinax' ? [refuse] : [];
      },
    };
    expect(firstRefusal(mirror, 'a', 'b', ['cat6', 'twinax'])).toBe(refuse);
    expect(seen).toEqual(['cat6', 'twinax']);
  });
  it('draws on pass, on an engine error and with no mirror', () => {
    expect(firstRefusal({ checkCable: () => [] }, 'a', 'b', [''])).toBeNull();
    expect(firstRefusal({ checkCable: () => { throw new Error('module trapped'); } }, 'a', 'b', [''])).toBeNull();
    expect(firstRefusal(null, 'a', 'b', [''])).toBeNull();
  });
});

describe('the panel', () => {
  const render = (c: ChecksController) => renderToStaticMarkup(createElement(ChecksPanel, { controller: c }));
  it('lists each finding with a word and a glyph, and Why? and Show', () => {
    const html = render(controller({ result: result({ warn: 1, idea: 1, findings: [finding({ severity: 'warn', title: 'fw-01 has one power supply fed.' }), finding()] }) }));
    expect(html).toContain('1 warning · 1 idea');
    expect(html).toContain('▲');
    expect(html).toContain('Warning');
    expect(html).toContain('○');
    expect(html).toContain('Idea');
    expect(html).toContain('fw-01 has one power supply fed.');
    expect((html.match(/Why\?/g) ?? []).length).toBe(2);
    expect((html.match(/>Show</g) ?? []).length).toBe(2);
    expect(html).toContain('sw-01');
  });
  it('draws a refusal with its word and glyph', () => {
    const html = render(controller({ result: result({ refuse: 1, findings: [finding({ severity: 'refuse' })] }) }));
    expect(html).toContain('✕');
    expect(html).toContain("Can&#x27;t work");
  });
  it('empty with rules loaded', () => {
    expect(render(controller())).toContain('No problems found');
  });
  it('empty with no rules loaded says nothing reassuring', () => {
    expect(render(controller({ result: result({ rulesLoaded: 0 }) }))).not.toContain('No problems found');
  });
  it('unfinished', () => {
    const html = render(controller({ result: result({ unfinished: 2, idea: 1, findings: [finding()] }) }));
    expect(html).toContain('2 checks could not finish');
  });
  it('load failed', () => {
    const html = render(controller({ result: result({ loadFailed: true, rulesLoaded: 0 }) }));
    expect(html).toContain('Checks are off: a rule failed to load');
    expect(html).not.toContain('No problems found');
  });
  it('before the first run and when the engine is unavailable', () => {
    expect(render(controller({ result: null }))).toContain('Checking');
    expect(render(controller({ result: null, unavailable: true }))).toContain('Checks are not running');
  });
  it('uses no hue: no colour literal and no colour token in the stylesheet beyond ink, muted, hairline and page', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const css = readFileSync(fileURLToPath(new URL('./checks.css', import.meta.url)), 'utf8');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|amber|--caution|--danger|--safe|--sheath/);
    expect(css).not.toMatch(/border-radius:\s*[1-9]/);
  });
  it('the bar chip shows the count, and nothing when there is none', () => {
    const chip = (c: ChecksController) => renderToStaticMarkup(createElement(ChecksBarChip, { controller: c }));
    expect(chip(controller({ result: result({ warn: 2, idea: 1 }) }))).toContain('Checks 3');
    expect(chip(controller())).toMatch(/>Checks</);
  });
});

describe('the Why card', () => {
  const html = (f: CheckFinding) => renderToStaticMarkup(createElement(WhyCard, { finding: f, onClose: () => {} }));
  it('shows why, the fix and the source, but not the concept id', () => {
    const out = html(
      finding({
        source: { title: 'Cisco, SFP installation notes', url: 'https://example.test/doc', note: 'Located by web search; could not be opened, so it has not been read against the page.' },
      }),
    );
    expect(out).toContain('Only one cable is recorded');
    expect(out).toContain('Fix:');
    expect(out).toContain('href="https://example.test/doc"');
    expect(out).toContain('has not been read against the page');
    expect(out).not.toContain('check.topo.redundant-paths');
  });
  it('a definitional rule prints its sentence as the basis, with no link', () => {
    const out = html(finding());
    expect(out).toContain('Basis');
    expect(out).toContain('A design heuristic, not a standard.');
    expect(out).not.toContain('<a ');
  });
  it('never links anything but http(s)', () => {
    expect(html(finding({ source: { title: 'X', url: 'javascript:alert(1)', note: '' } }))).not.toContain('href=');
  });
});

describe('the refusal card', () => {
  const html = renderToStaticMarkup(
    createElement(RefusalCard, {
      finding: finding({ severity: 'refuse', title: 'A port has more than one cable on it', fix: 'Move one of the cables to a free port.' }),
      x: 100,
      y: 100,
      onWhy: () => {},
      onDismiss: () => {},
    }),
  );
  it('says the fact, the fix, Why? and Dismiss', () => {
    expect(html).toContain(REFUSAL_HEADING.replace("'", '&#x27;'));
    expect(html).toContain('A port has more than one cable on it');
    expect(html).toContain('Fix:');
    expect(html).toContain('Why?');
    expect(html).toContain('Dismiss');
  });
  it('uses none of the words the product never says', () => {
    for (const re of FORBIDDEN) expect(html).not.toMatch(re);
    const everything = renderToStaticMarkup(createElement(ChecksPanel, { controller: controller({ result: result({ loadFailed: true, unfinished: 1 }) }) }));
    for (const re of FORBIDDEN) expect(everything).not.toMatch(re);
  });
});

describe('badges', () => {
  const badge = (counts: Record<string, number>, id: string) => {
    const store = createChecksStore();
    store.set({ badges: new Map(Object.entries(counts)) });
    return renderToStaticMarkup(
      createElement(ChecksContext.Provider, { value: { store, guardCable: () => false, clearShow: () => {} } }, createElement(CheckBadge, { id })),
    );
  };
  it('draws a small numeral for a device with findings and nothing for one without', () => {
    expect(badge({ 'device:D1': 2 }, 'device:D1')).toContain('>2<');
    expect(badge({ 'device:D1': 2 }, 'device:D2')).toBe('');
  });
  it('draws nothing outside a provider', () => {
    expect(renderToStaticMarkup(createElement(CheckBadge, { id: 'device:D1' }))).toBe('');
  });
  it('reads a chassis id through the device map', () => {
    const store = createChecksStore();
    store.set({ badges: new Map([['device:D1', 1]]), canon: (id) => (id === 'chassis:H1' ? 'device:D1' : id) });
    const out = renderToStaticMarkup(
      createElement(ChecksContext.Provider, { value: { store, guardCable: () => false, clearShow: () => {} } }, createElement(CheckBadge, { id: 'chassis:H1' })),
    );
    expect(out).toContain('>1<');
  });
});

describe('panel position', () => {
  it('stays inside its parent, header reachable', () => {
    const parent = { left: 0, top: 0, width: 800, height: 600 };
    const docked = { left: 530, top: 8, width: 262, height: 300 };
    expect(clampOffset(parent, docked, { x: 500, y: -500 })).toEqual({ x: 8, y: -8 });
    expect(clampOffset(parent, docked, { x: -9999, y: 9999 })).toEqual({ x: -530, y: 556 });
    expect(clampOffset(parent, docked, { x: -10, y: 10 })).toEqual({ x: -10, y: 10 });
  });
  it('is remembered, and a broken store never throws', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    savePrefs({ x: -40, y: 12, open: false }, storage);
    expect(loadPrefs(storage)).toEqual({ x: -40, y: 12, open: false });
    const broken = { getItem: () => { throw new Error('denied by the browser'); }, setItem: () => { throw new Error('full'); } };
    expect(loadPrefs(broken)).toEqual({ x: 0, y: 0, open: null });
    expect(() => savePrefs({ x: 0, y: 0, open: null }, broken)).not.toThrow();
    mem.set('fathom.checks.panel', '{not json');
    expect(loadPrefs(storage)).toEqual({ x: 0, y: 0, open: null });
  });
  it('findingKey tells two findings of one rule apart', () => {
    expect(findingKey(finding())).not.toBe(findingKey(finding({ elements: [{ id: 'device:D2', name: '' }] })));
  });
});

describe('how long the standing checks wait, and when the guard may reload', () => {
  it('waits 300 ms until a load has been measured, and for cheap loads', () => {
    expect(standingDelay(null)).toBe(300);
    expect(standingDelay(0)).toBe(300);
    expect(standingDelay(40)).toBe(300);
    expect(standingDelay(60)).toBe(300);
  });
  it('waits five times a dear load, capped at 10 s', () => {
    expect(standingDelay(200)).toBe(1000);
    expect(standingDelay(1500)).toBe(7500);
    expect(standingDelay(2500)).toBe(10_000);
    expect(standingDelay(60_000)).toBe(10_000);
  });
  it('ignores a measurement that is not a number', () => {
    expect(standingDelay(Number.NaN)).toBe(300);
    expect(standingDelay(-5)).toBe(300);
  });
  it('lets the guard reload up to 800 ms, and not above', () => {
    expect(guardMayReload(null)).toBe(true);
    expect(guardMayReload(120)).toBe(true);
    expect(guardMayReload(800)).toBe(true);
    expect(guardMayReload(801)).toBe(false);
    expect(guardMayReload(2500)).toBe(false);
  });
});
