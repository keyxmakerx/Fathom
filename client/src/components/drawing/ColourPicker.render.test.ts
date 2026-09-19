import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ColourPicker } from './ColourPicker';

// Render-to-string smoke tests only, per `shell/Popover.render.test.ts`'s
// own precedent: no DOM testing library is installed, so Escape, click-away
// and Enter (this component's `useEffect`) are not exercised here — see the
// gap noted in the handback report. This checks the initial markup: which
// sheaths a kind lists, and which one starts selected.

describe('ColourPicker (render-to-string)', () => {
  it('lists the nine copper sheaths, grey preselected', () => {
    const markup = renderToStaticMarkup(
      createElement(ColourPicker, {
        kind: 'copper',
        initial: 'grey',
        screenX: 10,
        screenY: 20,
        onConfirm: () => {},
        onCancel: () => {},
      }),
    );
    for (const name of ['grey', 'blue', 'red', 'yellow', 'green', 'orange', 'purple', 'black', 'white']) {
      expect(markup).toContain(`aria-label="${name}"`);
    }
    expect(markup).not.toContain('aria-label="aqua"');
    expect(markup).toContain('drawing-picker__swatch--selected');
    expect(markup).toContain('>grey<');
  });

  it('lists the four fibre (TIA-598-C) sheaths', () => {
    const markup = renderToStaticMarkup(
      createElement(ColourPicker, {
        kind: 'fibre',
        initial: 'aqua',
        screenX: 0,
        screenY: 0,
        onConfirm: () => {},
        onCancel: () => {},
      }),
    );
    for (const name of ['orange', 'aqua', 'erika', 'yellow']) {
      expect(markup).toContain(`aria-label="${name}"`);
    }
    expect(markup).not.toContain('aria-label="grey"');
    expect(markup).toContain('>aqua<');
  });

  it('lists one fixed grey for power', () => {
    const markup = renderToStaticMarkup(
      createElement(ColourPicker, {
        kind: 'power',
        initial: 'grey',
        screenX: 0,
        screenY: 0,
        onConfirm: () => {},
        onCancel: () => {},
      }),
    );
    const swatchCount = (markup.match(/drawing-picker__swatch/g) ?? []).length;
    // One swatch button, whose className contains the base class once and
    // the "--selected" modifier once (also matching the base substring) —
    // three occurrences total for a single swatch.
    expect(swatchCount).toBe(3);
  });

  it('positions the fixed overlay at the given screen point', () => {
    const markup = renderToStaticMarkup(
      createElement(ColourPicker, {
        kind: 'copper',
        initial: 'grey',
        screenX: 123,
        screenY: 456,
        onConfirm: () => {},
        onCancel: () => {},
      }),
    );
    expect(markup).toContain('left:123px');
    expect(markup).toContain('top:456px');
    expect(markup).toContain('position:fixed');
  });
});
