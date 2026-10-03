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
  defaultOpen,
  escTarget,
  findingKey,
  firstRefusal,
  guardMayReload,
  isTypingTarget,
  placeCard,
  showPadding,
  sourceView,
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
    canvasWidth: 1200,
    setCanvasWidth: () => {},
    why: null,
    whyToken: 0,
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
    const f1 = finding({ severity: 'warn', elements: [{ id: 'physical-port:P1', name: '' }, { id: 'physical-port:P2', name: '' }, { id: 'cable:C1', name: '' }] });
    const f2 = finding({ rule: 'other', severity: 'refuse', elements: [{ id: 'device:D1', name: '' }] });
    const f3 = finding({ rule: 'minted', severity: 'warn', elements: [{ id: '', name: 'new port' }, { id: 'device:D2', name: '' }] });
    const map = buildBadgeMap([f1, f2, f3], canon);
    expect(map.get('device:D1')).toBe(2);
    expect(map.get('cable:C1')).toBe(1);
    expect(map.get('device:D2')).toBe(1);
    expect(map.has('')).toBe(false);
  });
  it('badges refusals and warnings only, never ideas', () => {
    const idea = finding({ severity: 'idea', elements: [{ id: 'device:D1', name: '' }, { id: 'cable:C1', name: '' }] });
    expect(buildBadgeMap([idea], canon).size).toBe(0);
    const warn = finding({ severity: 'warn', elements: [{ id: 'device:D1', name: '' }] });
    expect(buildBadgeMap([idea, warn], canon).get('device:D1')).toBe(1);
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
        source: {
          title: 'Cisco, SFP installation notes',
          url: 'https://example.test/doc',
          note: 'Located by web search on 2026-10-02; the page could not be opened from this environment (outbound fetch blocked), so the claim has not been read against it.',
        },
      }),
    );
    expect(out).toContain('Only one cable is recorded');
    expect(out).toContain('Fix:');
    expect(out).toContain('href="https://example.test/doc"');
    expect(out).toContain('Source not yet checked by a person.');
    expect(out).toContain('Cisco, SFP installation notes');
    expect(out).not.toMatch(/web search|outbound fetch|could not be opened/);
    expect(out).not.toContain('check.topo.redundant-paths');
  });
  it('a cited source without a note is the title and link only', () => {
    const out = html(finding({ source: { title: 'IETF, RFC 1122', url: 'https://example.test/rfc', note: '' } }));
    expect(out).not.toContain('not yet checked');
    expect(out).toContain('IETF, RFC 1122');
  });
  it('sourceView: a plain one-sentence note is shown as it is', () => {
    expect(sourceView(finding({ source: { title: '', url: '', note: 'Definitional: a port has one connector.' } }))).toMatchObject({
      label: 'Basis',
      unchecked: false,
      note: 'Definitional: a port has one connector.',
    });
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
  const parent = { left: 0, top: 0, width: 800, height: 600 };
  // The panel docked at the top right: 8 px from each edge, 262 wide, 300 tall.
  const docked = { left: 530, top: 8, width: 262, height: 300 };
  it('stays wholly inside its parent however far it is dragged', () => {
    expect(clampOffset(parent, docked, { x: 500, y: -500 })).toEqual({ x: 8, y: -8 });
    expect(clampOffset(parent, docked, { x: -9999, y: 9999 })).toEqual({ x: -530, y: 292 });
    expect(clampOffset(parent, docked, { x: 9999, y: 9999 })).toEqual({ x: 8, y: 292 });
    expect(clampOffset(parent, docked, { x: -9999, y: -9999 })).toEqual({ x: -530, y: -8 });
    expect(clampOffset(parent, docked, { x: -10, y: 10 })).toEqual({ x: -10, y: 10 });
  });
  it('is measured from the docked rect, so a saved offset from a wider canvas is pulled back in', () => {
    const narrow = { left: 0, top: 0, width: 412, height: 500 };
    const dockedNarrow = { left: 142, top: 8, width: 262, height: 300 };
    expect(clampOffset(narrow, dockedNarrow, { x: -600, y: 0 }).x).toBe(-142);
    expect(clampOffset(narrow, dockedNarrow, { x: 600, y: 0 }).x).toBe(8);
  });
  it('pins a panel bigger than the room to the top left instead of throwing it off', () => {
    const small = { left: 0, top: 0, width: 200, height: 200 };
    expect(clampOffset(small, { left: 0, top: 8, width: 262, height: 300 }, { x: 50, y: 50 })).toEqual({ x: 0, y: -8 });
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

describe('the panel starts folded on a narrow canvas, and for ideas alone', () => {
  it('opens by default only for a refusal or a warning on a canvas 720 px or wider', () => {
    expect(defaultOpen(result({ warn: 1 }), 1200)).toBe(true);
    expect(defaultOpen(result({ refuse: 1 }), 720)).toBe(true);
    expect(defaultOpen(result({ warn: 1 }), 719)).toBe(false);
    expect(defaultOpen(result({ warn: 1 }), 412)).toBe(false);
    expect(defaultOpen(result({ idea: 4 }), 1600)).toBe(false);
    expect(defaultOpen(result(), 1600)).toBe(false);
    expect(defaultOpen(null, 1600)).toBe(false);
    expect(defaultOpen(result({ warn: 1 }), null)).toBe(false);
  });
});

describe('where the cards and the camera go', () => {
  const vp = { width: 1000, height: 700 };
  it('the refusal card sits beside the pointer, and flips to stay inside on the right and the bottom', () => {
    const size = { width: 320, height: 180 };
    expect(placeCard({ x: 100, y: 100 }, size, vp)).toEqual({ left: 112, top: 112 });
    expect(placeCard({ x: 900, y: 100 }, size, vp)).toEqual({ left: 568, top: 112 });
    expect(placeCard({ x: 100, y: 650 }, size, vp)).toEqual({ left: 112, top: 458 });
    expect(placeCard({ x: 990, y: 695 }, size, vp)).toEqual({ left: 658, top: 503 });
  });
  it('uses the measured size, not an assumed one', () => {
    expect(placeCard({ x: 100, y: 600 }, { width: 320, height: 60 }, vp).top).toBe(612);
    expect(placeCard({ x: 100, y: 600 }, { width: 320, height: 300 }, vp).top).toBe(288);
  });
  it('never leaves the margin, even for a card bigger than the window', () => {
    expect(placeCard({ x: 5, y: 5 }, { width: 2000, height: 2000 }, vp)).toEqual({ left: 8, top: 8 });
  });
  it('Show pads the right by the docked panel, and is as before without one', () => {
    expect(showPadding(0, 1000, 700)).toBe(0.5);
    const p = showPadding(280, 1000, 700);
    expect(p).toEqual({ top: '116px', bottom: '116px', left: '166px', right: '446px' });
  });
});

describe('Esc', () => {
  it('closes one thing: the refusal card, then Show, then the Why card', () => {
    expect(escTarget({ refusal: true, show: true, why: true })).toBe('refusal');
    expect(escTarget({ refusal: false, show: true, why: true })).toBe('show');
    expect(escTarget({ refusal: false, show: false, why: true })).toBe('why');
    expect(escTarget({ refusal: false, show: false, why: false })).toBeNull();
  });
  it('leaves Esc to a field the user is typing in', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'textarea' })).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('rows, Show and the layers', () => {
  const render = (c: ChecksController, canShow = true) => renderToStaticMarkup(createElement(ChecksPanel, { controller: c, canShow }));
  const warn = finding({ severity: 'warn', title: 'fw-01 has one power supply fed.', elements: [{ id: 'device:D1', name: 'fw-01' }] });
  it('leads a row with the name, then the severity, then the sentence', () => {
    const html = render(controller({ result: result({ warn: 1, findings: [warn] }) }));
    const name = html.indexOf('checks-row__name');
    expect(name).toBeGreaterThan(-1);
    expect(name).toBeLessThan(html.indexOf('checks-row__sev'));
    expect(html.indexOf('checks-row__sev')).toBeLessThan(html.indexOf('checks-row__title'));
  });
  it('hides Show while the open-device view covers the canvas, and keeps Why?', () => {
    const html = render(controller({ result: result({ warn: 1, findings: [warn] }) }), false);
    expect(html).not.toContain('>Show<');
    expect(html).toContain('Why?');
  });
  it('the name is ink at body size, not muted mono', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const css = readFileSync(fileURLToPath(new URL('./checks.css', import.meta.url)), 'utf8');
    const rule = css.slice(css.indexOf('.checks-row__name {'), css.indexOf('}', css.indexOf('.checks-row__name {')));
    expect(rule).toContain('var(--ink)');
    expect(rule).toContain('var(--t-body)');
    expect(rule).not.toMatch(/mono|muted|micro/);
  });
  it('the panel sits below the paste card and the open device is below the panel', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const z = (rel: string, sel: string): number => {
      const css = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      const block = css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
      return Number(/--z-modal\) \+ (\d+)/.exec(block)?.[1]);
    };
    const panel = z('./checks.css', '.checks-panel {');
    expect(panel).toBeLessThan(z('../paste/paste.css', '.paste-card {'));
    expect(panel).toBeGreaterThanOrEqual(z('../jot/jot.css', '.jot {'));
  });
  it('the refusal card is a live region, not a modal', () => {
    const html = renderToStaticMarkup(
      createElement(RefusalCard, { finding: finding({ severity: 'refuse' }), x: 10, y: 10, onWhy: () => {}, onDismiss: () => {} }),
    );
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('aria-modal');
  });
});
