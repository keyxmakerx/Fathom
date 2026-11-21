import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { defaultLayers, LAYERS } from '../drawing/layers';
import { BottomPill, CanvasStrip, LayersPanel, LookPanel } from './CanvasBar';
import type { ShellProps } from './types';

const noop = () => {};
const layers: NonNullable<ShellProps['layers']> = {
  value: defaultLayers(),
  onToggle: noop,
  style: { value: 'boxes', onChange: noop },
  cables: { value: 'physics', onChange: noop, colour: { value: 'all', onChange: noop } },
  aids: { items: [{ id: 'minimap', label: 'Mini-map', on: true }], onToggle: noop },
};

describe('the bottom pill (r116: the camera, nothing else)', () => {
  const pill = renderToStaticMarkup(createElement(BottomPill, { zoom: { value: 200, onIn: noop, onOut: noop, onFit: noop } }));

  it('has zoom out, the percentage, zoom in and fit', () => {
    expect(pill).toContain('aria-label="Zoom out"');
    expect(pill).toContain('200%');
    expect(pill).toContain('aria-label="Zoom in"');
    expect(pill).toContain('aria-label="Fit to view"');
  });

  it('has no Undo and no Redo: those are the bar\'s', () => {
    expect(pill).not.toContain('Undo');
    expect(pill).not.toContain('Redo');
    expect(pill).toContain('aria-label="Zoom"');
  });
});

describe('Layers and Look (r116: two buttons, two pop-overs)', () => {
  it('the tool row has Layers and Look side by side, and Back\'s slot comes first', () => {
    const markup = renderToStaticMarkup(createElement(CanvasStrip, { place: 'racks', lens: 'cables', onLensChange: noop, layers, slotRef: () => noop }));
    expect(markup).toContain('data-testid="shell-show"');
    expect(markup).toContain('data-testid="shell-look"');
    expect(markup.indexOf('data-testid="shell-show"')).toBeLessThan(markup.indexOf('data-testid="shell-look"'));
    expect(markup.indexOf('data-slot="jump-trail"')).toBeLessThan(markup.indexOf('data-slot="canvas-tools"'));
    expect(markup.indexOf('data-slot="canvas-tools"')).toBeLessThan(markup.indexOf('>Cables'));
  });

  it('Layers holds the layer ticks and the Mini-map, all the same kind of tick box, and no style', () => {
    const markup = renderToStaticMarkup(createElement(LayersPanel, { layers }));
    for (const l of LAYERS.filter((x) => x.available)) expect(markup).toContain(`data-testid="show-${l.id}"`);
    expect(markup).toContain('data-testid="show-minimap"');
    const rows = markup.match(/role="menuitemcheckbox"/g) ?? [];
    const ticks = markup.match(/class="shell-show__tick"/g) ?? [];
    expect(rows.length).toBe(LAYERS.filter((x) => x.available).length + 1);
    expect(ticks.length).toBe(rows.length);
    expect(markup).not.toContain('☑');
    expect(markup).not.toContain('☐');
    expect(markup).not.toContain('Device style');
    expect(markup).not.toContain('Cable style');
    expect(markup).not.toContain('Cable colour');
  });

  it('Look holds device style, cable style, cable colour and the colour key, and no ticks', () => {
    const markup = renderToStaticMarkup(createElement(LookPanel, { layers, extra: createElement('div', { className: 'colour-key-stand-in' }, 'Blue') }));
    expect(markup).toContain('aria-label="Device style"');
    expect(markup).toContain('data-testid="style-icons"');
    expect(markup).toContain('aria-label="Cable style"');
    expect(markup).toContain('data-testid="cable-style-square"');
    expect(markup).toContain('aria-label="Cable colour"');
    expect(markup).toContain('data-testid="cable-colour-pointed"');
    expect(markup).toContain('colour-key-stand-in');
    expect(markup).not.toContain('menuitemcheckbox');
    expect(markup).not.toContain('data-testid="show-checks"');
  });

  it('in the Diagram look there is no cable style or colour to set, and Look keeps the device style', () => {
    const markup = renderToStaticMarkup(createElement(LookPanel, { layers: { ...layers, cables: undefined } }));
    expect(markup).toContain('aria-label="Device style"');
    expect(markup).not.toContain('aria-label="Cable style"');
  });
});

const sheet = (path: string): string => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** What a selector's own rule declares: the first rule that names it alone. */
function ruleOf(css: string, selector: string): string {
  const at = css.search(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{`));
  return at < 0 ? '' : (css.slice(at).split('{')[1]?.split('}')[0] ?? '');
}

describe('the note of what is on show (the banner that names a save lay half under the tool row)', () => {
  const shell = sheet('styles/shell.css');
  const history = sheet('components/history/history.css');

  it('has its place in the bar, after the tool row and outside it', () => {
    const markup = renderToStaticMarkup(createElement(CanvasStrip, { place: 'racks', lens: 'cables', onLensChange: noop, layers, slotRef: () => noop }));
    const row = markup.indexOf('class="shell-canvas-bar__group"');
    const note = markup.indexOf('class="shell-canvas-bar__note" data-slot="canvas-note"');
    expect(row).toBeGreaterThan(0);
    expect(note).toBeGreaterThan(row);
    // The tool row is closed before the note starts: two things side by side, not one inside the other.
    const between = markup.slice(row, note);
    expect((between.match(/<div/g) ?? []).length).toBe((between.match(/<\/div>/g) ?? []).length);
  });

  it('shares the tools\' line where both fit and takes the next line where they do not', () => {
    expect(ruleOf(shell, '.shell-canvas-bar')).toMatch(/flex-wrap:\s*wrap/);
    const note = ruleOf(shell, '.shell-canvas-bar__note');
    expect(note).toMatch(/margin-left:\s*auto/);
    expect(note).toMatch(/max-width:\s*100%/);
    expect(ruleOf(shell, '.shell-canvas-bar__note:empty')).toMatch(/display:\s*none/);
  });

  it('is placed by the bar: the banner has no place of its own over the drawing', () => {
    const banner = ruleOf(history, '.history-banner');
    expect(banner).not.toBe('');
    expect(banner).not.toMatch(/position:|top:|left:|transform:|z-index:/);
  });

  it('stays as it is while something is dragged: only the tools and the zoom buttons step back', () => {
    const stepBack = /([^{}]*)\{\s*opacity:\s*0\.25;?\s*\}/.exec(shell)?.[1] ?? '';
    expect(stepBack).toContain('.shell-canvas-bar__group');
    expect(stepBack).toContain('.shell-pill');
    expect(stepBack).not.toMatch(/\.shell-canvas-bar(,|\s*$)/m);
  });
});
