import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PaletteSheet } from './CommandPalette';
import type { PaletteAction } from './palette';
import type { SearchHit } from './search';
import type { ShellSearch } from './types';

const act = (id: string, label: string, group?: 'do' | 'go'): PaletteAction => ({ id, label, group, run: () => {} });
const HIT: SearchHit = { group: 'Devices', name: 'switch-1', why: 'EX4300 · R1 U40', where: 'R1 · U40', selection: { kind: 'chassis', id: 'c1' } };

function render(query: string): string {
  const search: ShellSearch = {
    run: () => [HIT],
    choose: () => {},
    actions: () => [act('trace', 'Trace a path from switch-1'), act('shortcuts', 'Show keyboard shortcuts'), act('view:1', 'Saved view · Wall 1 switches', 'go')],
  };
  return renderToStaticMarkup(createElement(PaletteSheet, { search, onClose: () => {}, initialQuery: query }));
}

describe('the command palette', () => {
  it('has a search icon, an Esc chip, and the footer keys', () => {
    const html = render('');
    expect(html).toContain('palette__icon');
    expect(html).toContain('<kbd class="palette__esc" aria-hidden="true">Esc</kbd>');
    expect(html).toContain('↑↓ move');
    expect(html).toContain('Enter go');
    expect(html).toContain('Tab narrow to one group');
    expect(html).toContain('? all shortcuts');
  });

  it('groups what to do and where to go under their own headings', () => {
    const html = render('');
    expect(html).toContain('<div class="palette__group" role="presentation">Do</div>');
    expect(html).toContain('<div class="palette__group" role="presentation">Go to</div>');
    expect(html.indexOf('>Do<')).toBeLessThan(html.indexOf('>Go to<'));
    expect(html).toContain('Saved view · Wall 1 switches');
  });

  it('puts found things first, underlines the typed letters and shows where the device is', () => {
    const html = render('sw1');
    expect(html.indexOf('>Devices<')).toBeLessThan(html.indexOf('>Do<'));
    expect(html).toContain('<span class="palette__hit">sw</span>itch-<span class="palette__hit">1</span>');
    expect(html).toContain('R1 · U40');
    expect(html).toContain('Enter to open');
  });
});
