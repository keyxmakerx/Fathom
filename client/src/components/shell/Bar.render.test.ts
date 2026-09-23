import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { Bar, type BarProps } from './Bar';
import { PopoverRow } from './Popover';

beforeAll(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
});

const BASE: BarProps = {
  place: 'racks',
  onPlaceChange: () => {},
  path: [],
  tree: null,
  lens: 'cables',
  onLensChange: () => {},
  presence: [],
  zoom: 100,
  onZoomIn: () => {},
  onZoomOut: () => {},
  canUndo: false,
  canRedo: false,
  onUndo: () => {},
  onRedo: () => {},
  account: { initials: 'AB', address: 'a@example.com' },
};

describe('Bar — what is present where', () => {
  it('with a design open: the place tabs act, and Undo, Redo and zoom are there', () => {
    const markup = renderToStaticMarkup(createElement(Bar, BASE));
    expect(markup).toContain('<button type="button" class="shell-bar__tab shell-bar__tab--on">Racks</button>');
    expect(markup).toContain('Undo');
    expect(markup).toContain('aria-label="Zoom in"');
  });

  it('shows only the lenses that change the place: Racks Cables and Routing; Inventory also Power and Owner', () => {
    const racks = renderToStaticMarkup(createElement(Bar, BASE));
    expect(racks).toContain('>Routing<');
    expect(racks).not.toContain('>Links<');
    expect(racks).not.toContain('>Power<');
    const inventory = renderToStaticMarkup(createElement(Bar, { ...BASE, place: 'inventory' }));
    expect(inventory).toContain('>Power<');
    expect(inventory).toContain('>Owner<');
    expect(inventory).not.toContain('>Links<');
  });

  it('in Inventory: Undo and Redo, but no zoom (there is no drawing to zoom)', () => {
    const markup = renderToStaticMarkup(createElement(Bar, { ...BASE, place: 'inventory' }));
    expect(markup).toContain('Undo');
    expect(markup).not.toContain('aria-label="Zoom in"');
  });

  it('the percentage fits the view only where a fit is offered', () => {
    expect(renderToStaticMarkup(createElement(Bar, BASE))).toContain('<span class="shell-zoom-value">100%</span>');
    expect(renderToStaticMarkup(createElement(Bar, { ...BASE, onZoomFit: () => {} }))).toContain('aria-label="Fit to view"');
  });

  it('with nothing open (Home, Site): the place names are not controls, and Undo, Redo and zoom are absent', () => {
    const markup = renderToStaticMarkup(createElement(Bar, { ...BASE, place: null }));
    expect(markup).toContain('<span class="shell-bar__tab">Racks</span>');
    expect(markup).not.toContain('Undo');
    expect(markup).not.toContain('aria-label="Zoom in"');
  });

  it('the brand is a way Home only when there is somewhere else to be', () => {
    expect(renderToStaticMarkup(createElement(Bar, BASE))).toContain('<span class="shell-bar__brand">Fathom</span>');
    expect(renderToStaticMarkup(createElement(Bar, { ...BASE, onHome: () => {} }))).toContain(
      '<button type="button" class="shell-bar__brand">Fathom</button>',
    );
  });
});

describe('Bar — the search box', () => {
  it('is drawn in the bar with its shortcut', () => {
    const markup = renderToStaticMarkup(createElement(Bar, BASE));
    expect(markup).toContain('class="shell-search"');
    expect(markup).toContain('Ctrl K');
  });
});

// The menu itself renders only when opened, so its rows are checked through
// the `menu` prop's own markup: no disabled placeholder rows are supplied by
// the bar any more.
describe('Bar — account menu rows', () => {
  it('supplies no disabled placeholder rows of its own', () => {
    const markup = renderToStaticMarkup(
      createElement(Bar, { ...BASE, menu: createElement(PopoverRow, { children: 'Site' }) }),
    );
    expect(markup).not.toContain('People and permissions');
  });
});
