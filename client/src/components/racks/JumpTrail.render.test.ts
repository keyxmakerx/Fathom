import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ColourKey } from '../drawing/ColourKey';
import { buildKey } from '../drawing/colourKey';
import { JumpTrail, isEmptyCanvas, swallowNextClick } from './JumpTrail';
import { EMPTY_TRAIL, back, visit, type Spot } from './jumpBack';
import type { Level } from './jumpTree';

const spot = (id: string | null, stop: Spot['stop'] = 'rack'): Spot => ({ look: 'rack', selection: id ? { kind: 'rack', id } : null, jotId: null, stop });
const noop = () => {};
const level = (name: string, kind: Level['kind'], i: number): Level => ({ key: `${kind}${i}`, name, kind, target: null });
const only: Level[] = [level('HQ', 'design', 0)];
const inRack: Level[] = [level('HQ', 'design', 0), level('R1', 'rack', 1), level('switch-1', 'device', 2)];
const html = (props: Partial<Parameters<typeof JumpTrail>[0]> & Pick<Parameters<typeof JumpTrail>[0], 'trail'>) =>
  renderToStaticMarkup(createElement(JumpTrail, { backLabel: null, onBack: noop, levels: only, onGo: noop, ...props }));

describe('JumpTrail', () => {
  it('shows nothing until there is somewhere to go back to or a tree to show', () => {
    const one = visit(EMPTY_TRAIL, spot(null), 'HQ', null, 0);
    expect(html({ trail: one })).toBe('');
  });

  it('names where Back goes, and shows no chips and no Forward button', () => {
    let t = visit(EMPTY_TRAIL, spot(null), 'HQ', null, 0);
    t = visit(t, spot('r1'), 'R1', null, 10_000);
    t = visit(t, spot('r1', 'faceplate'), 'R1 · FACEPLATE', null, 20_000);
    const out = html({ trail: t, backLabel: 'R1', levels: inRack });
    expect(out).toContain('Back to R1');
    expect(out).not.toContain('>HQ<');
    expect(out).not.toContain('jump-forward');
    expect(out).not.toContain('Forward');
    expect(out).not.toContain('→');
  });

  it('drops the Forward button even after going back; Back is hidden at the start', () => {
    let t = visit(EMPTY_TRAIL, spot(null), 'HQ', null, 0);
    t = visit(t, spot('r1'), 'R1', null, 10_000);
    t = back(t)!.trail;
    const out = html({ trail: t, levels: inRack });
    expect(out).not.toContain('jump-forward');
    expect(out).not.toContain('aria-label="Forward');
    expect(out).not.toContain('data-testid="jump-back"');
  });

  it('shows the fold-out arrow whenever there is a tree, even when Back has nowhere to go', () => {
    const one = visit(EMPTY_TRAIL, spot('r1'), 'R1', null, 0);
    const out = html({ trail: one, levels: inRack });
    expect(out).toContain('data-testid="jump-tree-toggle"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('aria-label="Where you are in this design"');
    expect(out).not.toContain('data-testid="jump-back"');
    expect(out).not.toContain('data-testid="jump-tree"');
  });

  it('has no arrow when the tree is only the design', () => {
    let t = visit(EMPTY_TRAIL, spot(null), 'HQ', null, 0);
    t = visit(t, spot('r1'), 'R1', null, 10_000);
    const out = html({ trail: t, backLabel: 'HQ' });
    expect(out).toContain('data-testid="jump-back"');
    expect(out).not.toContain('jump-tree-toggle');
  });

  it('unfolds to a list: name and kind word on each line, the current one marked', () => {
    const one = visit(EMPTY_TRAIL, spot('r1'), 'R1', null, 0);
    const out = html({ trail: one, levels: inRack, defaultOpen: true });
    expect(out).toContain('aria-expanded="true"');
    expect(out).toContain('<ol');
    expect((out.match(/data-testid="jump-tree-line"/g) ?? []).length).toBe(3);
    expect(out).toContain('>HQ</span><span class="jump-tree__kind">DESIGN<');
    expect(out).toContain('>R1</span><span class="jump-tree__kind">RACK<');
    expect(out).toContain('>switch-1</span><span class="jump-tree__kind">DEVICE<');
    expect((out.match(/aria-current="location"/g) ?? []).length).toBe(1);
    expect(out).toMatch(/aria-current="location"[^>]*>(?:(?!<\/button>).)*switch-1(?:(?!<\/button>).)*you are here/);
  });

  it('folds a deep tree to the top two, "N more" and the last three', () => {
    const deep = Array.from({ length: 9 }, (_, i) => level(`L${i}`, 'device', i));
    const one = visit(EMPTY_TRAIL, spot('r1'), 'R1', null, 0);
    const out = html({ trail: one, levels: deep, defaultOpen: true });
    expect(out).toContain('4 more');
    expect(out).toContain('data-testid="jump-tree-fold"');
    for (const shown of ['L0', 'L1', 'L6', 'L7', 'L8']) expect(out).toContain(`>${shown}<`);
    for (const hidden of ['L2', 'L3', 'L4', 'L5']) expect(out).not.toContain(`>${hidden}<`);
  });

  it('does not fold six or fewer levels', () => {
    const six = Array.from({ length: 6 }, (_, i) => level(`L${i}`, 'device', i));
    const one = visit(EMPTY_TRAIL, spot('r1'), 'R1', null, 0);
    expect(html({ trail: one, levels: six, defaultOpen: true })).not.toContain('more');
  });
});

describe('ColourKey', () => {
  it('lists each colour with its words and a swatch', () => {
    const rows = buildKey(
      [
        { id: 'a', sheath: 'blue' },
        { id: 'b', sheath: 'blue' },
        { id: 'c', sheath: 'white' },
      ],
      [{ kind: 'vlan', name: 'Staff VLAN 20', cableIds: new Set(['a', 'b']) }],
    );
    const html = renderToStaticMarkup(createElement(ColourKey, { rows, onHighlight: noop }));
    expect(html).toContain('Blue · Staff VLAN 20');
    expect(html).toContain('White · 1 cable');
    expect(html).toContain('colour-key__swatch--outlined');
    expect(html).toContain('aria-pressed="false"');
  });

  it('draws nothing for a design with no cables', () => {
    expect(renderToStaticMarkup(createElement(ColourKey, { rows: [], onHighlight: noop }))).toBe('');
  });
});

describe('a click on the empty canvas while the tree is open', () => {
  afterEach(() => vi.useRealTimers());
  const within = (matches: Record<string, boolean>): EventTarget => ({ closest: (sel: string) => (matches[sel] ? {} : null) }) as unknown as EventTarget;
  const click = () => {
    const e = new Event('click');
    const stop = vi.spyOn(e, 'stopPropagation');
    return { e, stop };
  };

  it('knows the empty canvas (the pane) from something drawn on it', () => {
    expect(isEmptyCanvas(within({ '.react-flow__pane': true }))).toBe(true);
    expect(isEmptyCanvas(within({ '.react-flow__pane': true, '.react-flow__node, .react-flow__edge': true }))).toBe(false);
    expect(isEmptyCanvas(within({}))).toBe(false);
    expect(isEmptyCanvas(null)).toBe(false);
  });

  it('only folds the tree: the click it ends in is stopped, so the selection stays', () => {
    const doc = new EventTarget();
    swallowNextClick(doc as unknown as Document);
    const first = click();
    doc.dispatchEvent(first.e);
    expect(first.stop).toHaveBeenCalledTimes(1);
  });

  it('is only that one click: the next click on empty canvas behaves normally', () => {
    const doc = new EventTarget();
    swallowNextClick(doc as unknown as Document);
    doc.dispatchEvent(click().e);
    const next = click();
    doc.dispatchEvent(next.e);
    expect(next.stop).not.toHaveBeenCalled();
  });

  it('lets go when the press ended without a click (a drag)', () => {
    vi.useFakeTimers();
    const doc = new EventTarget();
    swallowNextClick(doc as unknown as Document);
    doc.dispatchEvent(new Event('pointerup'));
    vi.runAllTimers();
    const later = click();
    doc.dispatchEvent(later.e);
    expect(later.stop).not.toHaveBeenCalled();
  });
});
