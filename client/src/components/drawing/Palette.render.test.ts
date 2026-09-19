import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { PaletteItem } from './contract';
import { Palette } from './Palette';

// Render-to-string smoke test, per the Popover precedent: drag-and-drop is a
// DOM interaction this environment cannot drive (no jsdom is installed), so
// only the initial markup is checked here — see the gap noted in the
// handback report.

describe('Palette', () => {
  it('renders one row per catalogue entry, from the prop, not a hard-coded list', () => {
    const palette: PaletteItem[] = [
      { vendor: 'juniper', model: 'EX4300-48P', rackUnits: 1, summary: '48-port access switch' },
      { vendor: 'juniper', model: 'SRX340', rackUnits: 2, summary: 'branch firewall' },
    ];
    const markup = renderToStaticMarkup(createElement(Palette, { palette }));
    expect(markup).toContain('EX4300-48P');
    expect(markup).toContain('SRX340');
    expect(markup).toContain('48-port access switch');
  });

  it('shows an empty state rather than sample data when the catalogue is empty', () => {
    const markup = renderToStaticMarkup(createElement(Palette, { palette: [] }));
    expect(markup).toContain('No catalogue entries.');
  });
});
