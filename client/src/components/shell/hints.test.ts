import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { HintCard } from './Hints';
import { HINT_DELAY_MS, HINT_EDGE, HINT_FOCUS_DELAY_MS, HINT_GAP, HINT_STIR_PX, HINT_WARM_DELAY_MS, HINT_WARM_FOR_MS, hint, hintDelay, keyCaps, placeHint, pointerAtRest, readHint } from './hints';
import { BAR_HINT, DOCK_HINT, LENS_HINT, LENS_HINT_INVENTORY, TOOL_HINT, VIEW_HINT, WORK_HINT, ZOOM_HINT } from './hintWords';

describe('a control that explains itself', () => {
  it('carries its name, its sentence and its shortcut, and says the same in its title', () => {
    expect(hint('Undo', 'Take back your last change.', 'Ctrl+Z')).toEqual({
      'data-hint': 'Undo',
      'data-hint-more': 'Take back your last change.',
      'data-hint-keys': 'Ctrl+Z',
      'data-hint-side': undefined,
      title: 'Take back your last change. (Ctrl+Z)',
    });
  });

  it('with a name alone, the title is the name', () => {
    expect(hint('Admin').title).toBe('Admin');
    expect(hint('Fit', undefined, '')).toMatchObject({ 'data-hint-keys': undefined, title: 'Fit' });
  });

  it('is read back off the attributes; no name, no hint', () => {
    const attrs: Record<string, string> = { 'data-hint': ' Layers ', 'data-hint-more': 'What is written on the drawing.', 'data-hint-keys': '' };
    expect(readHint((n) => attrs[n] ?? null)).toEqual({ name: 'Layers', more: 'What is written on the drawing.' });
    expect(readHint(() => null)).toBeNull();
    expect(readHint((n) => (n === 'data-hint' ? '  ' : null))).toBeNull();
  });

  it('splits a shortcut into its caps, and keeps a lone plus as a key', () => {
    expect(keyCaps('Ctrl+Shift+Z')).toEqual(['Ctrl', 'Shift', 'Z']);
    expect(keyCaps('?')).toEqual(['?']);
    expect(keyCaps('+')).toEqual(['+']);
  });
});

describe('where the hint card sits', () => {
  const win = { width: 1440, height: 900 };
  const card = { width: 200, height: 50 };

  it('is centred under its control', () => {
    expect(placeHint({ left: 400, top: 50, width: 80, height: 28 }, card, win)).toEqual({ left: 340, top: 50 + 28 + HINT_GAP, from: 'above' });
  });

  it('stays inside the window at either side', () => {
    expect(placeHint({ left: 4, top: 50, width: 40, height: 28 }, card, win).left).toBe(HINT_EDGE);
    expect(placeHint({ left: 1400, top: 50, width: 30, height: 28 }, card, win).left).toBe(1440 - 200 - HINT_EDGE);
  });

  it('goes over a control at the bottom of the window (the zoom pill)', () => {
    expect(placeHint({ left: 700, top: 860, width: 52, height: 28 }, card, win)).toEqual({ left: 626, top: 860 - HINT_GAP - 50, from: 'below' });
  });

  it('goes beside a tab on the right edge, level with it', () => {
    expect(placeHint({ left: 1412, top: 100, width: 28, height: 80 }, card, win, 'left')).toEqual({ left: 1412 - HINT_GAP - 200, top: 115, from: 'right' });
    // No room on the left: under it, like any other.
    expect(placeHint({ left: 100, top: 100, width: 28, height: 80 }, card, win, 'left').from).toBe('above');
  });
});

describe('when the hint shows', () => {
  it('waits on a first look, comes at once while moving along, and sooner for a tab', () => {
    expect(hintDelay(10_000, null, false)).toBe(HINT_DELAY_MS);
    expect(hintDelay(10_000, 10_000 - HINT_WARM_FOR_MS, false)).toBe(HINT_WARM_DELAY_MS);
    expect(hintDelay(10_000, 10_000 - HINT_WARM_FOR_MS - 1, false)).toBe(HINT_DELAY_MS);
    expect(hintDelay(10_000, null, true)).toBe(HINT_FOCUS_DELAY_MS);
  });
});

describe('a pointer at rest', () => {
  it('stays quiet where a press put the hints away, until it has travelled', () => {
    const rest = { x: 40, y: 60 };
    expect(pointerAtRest(rest, 40, 60)).toBe(true);
    expect(pointerAtRest(rest, 40 + HINT_STIR_PX - 1, 60)).toBe(true);
    expect(pointerAtRest(rest, 40 + HINT_STIR_PX, 60)).toBe(false);
    expect(pointerAtRest(rest, 40, 60 - HINT_STIR_PX)).toBe(false);
  });

  it('is not held back when nothing put the hints away', () => {
    expect(pointerAtRest(null, 40, 60)).toBe(false);
  });
});

describe('the hint card', () => {
  it('draws the name, each key cap, and the sentence', () => {
    const html = renderToStaticMarkup(createElement(HintCard, { hint: { name: 'Redo', more: 'Put it back.', keys: 'Ctrl+Shift+Z' } }));
    expect(html).toContain('<span class="hint__name">Redo</span>');
    expect(html).toContain('<kbd class="hint__key">Ctrl</kbd><kbd class="hint__key">Shift</kbd><kbd class="hint__key">Z</kbd>');
    expect(html).toContain('<div class="hint__more">Put it back.</div>');
  });

  it('with a name alone, draws only the name', () => {
    const html = renderToStaticMarkup(createElement(HintCard, { hint: { name: 'Admin' } }));
    expect(html).not.toContain('hint__keys');
    expect(html).not.toContain('hint__more');
  });
});

describe('the words', () => {
  const all = [...Object.values(VIEW_HINT), WORK_HINT, ...Object.values(BAR_HINT), ...Object.values(LENS_HINT), ...Object.values(LENS_HINT_INVENTORY), ...Object.values(TOOL_HINT), ...Object.values(ZOOM_HINT), ...Object.values(DOCK_HINT)];

  it('are whole sentences, short enough to read at a glance', () => {
    for (const s of all) {
      expect(s, s).toMatch(/^[A-Z].*\.$/);
      expect(s.length, s).toBeLessThanOrEqual(120);
    }
  });
});
