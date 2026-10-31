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
    expect(markup).toContain('<button type="button" class="shell-bar__tab shell-bar__tab--on">Canvas</button>');
    expect(markup).toContain('Undo');
    expect(markup).toContain('aria-label="Zoom in"');
  });

  it('shows only the lenses that change the place: Canvas Cables and Routing; Inventory also Power and Owner', () => {
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

  it('with nothing open (Home, Admin): the four view names are not controls, and Undo, Redo and zoom are absent', () => {
    const markup = renderToStaticMarkup(createElement(Bar, { ...BASE, place: null }));
    for (const name of ['Diagram', 'Canvas', 'Inventory', 'Sheet']) expect(markup).toContain(`<span class="shell-bar__tab">${name}</span>`);
    expect(markup).not.toContain('Undo');
    expect(markup).not.toContain('aria-label="Zoom in"');
  });

  it('with nothing open but a design open before (Home, Admin): the same four views go back to it, none marked', () => {
    const markup = renderToStaticMarkup(
      createElement(Bar, { ...BASE, place: null, mainView: { value: null, backTo: 'Main closet', onChange: () => {} } }),
    );
    expect(markup).toContain('title="Back to Main closet, Diagram"');
    expect(markup).toContain('title="Back to Main closet, Sheet"');
    expect(markup).not.toContain('shell-bar__tab--on');
    expect(markup).not.toContain('aria-current');
    expect(markup).not.toContain('Undo');
  });

  it('the brand is a way Home only when there is somewhere else to be', () => {
    expect(renderToStaticMarkup(createElement(Bar, BASE))).toContain('<span class="shell-bar__brand">Fathom</span>');
    expect(renderToStaticMarkup(createElement(Bar, { ...BASE, onHome: () => {} }))).toContain(
      '<button type="button" class="shell-bar__brand">Fathom</button>',
    );
  });
});

describe('Bar — who else is here', () => {
  it('shows a focusable initials dot per person, labelled with the full name, in a labelled group; nothing when alone', () => {
    const markup = renderToStaticMarkup(
      createElement(Bar, {
        ...BASE,
        presence: [
          { id: 'a', initials: 'SK', name: 'Sam Kerr' },
          { id: 'b', initials: 'AB', name: 'Ann Bell' },
        ],
      }),
    );
    expect(markup).toContain('role="group" aria-label="Also in this view"');
    expect(markup).toContain('<span class="shell-person" role="img" tabindex="0" aria-label="Sam Kerr" title="Sam Kerr">SK</span>');
    expect(markup).toContain('<span class="shell-person" role="img" tabindex="0" aria-label="Ann Bell" title="Ann Bell">AB</span>');
    expect(renderToStaticMarkup(createElement(Bar, BASE))).not.toContain('shell-person');
  });

  it('shows five dots, then one "+N" for the rest', () => {
    const presence = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, initials: `P${i}`, name: `Person ${i}` }));
    const markup = renderToStaticMarkup(createElement(Bar, { ...BASE, presence }));
    expect(markup.match(/role="img"/g)).toHaveLength(5);
    expect(markup).toContain('aria-label="15 more in this view"');
    expect(markup).toContain('>+15</button>');
  });
});

describe('Bar — the search box', () => {
  it('is absent where there is nothing to search', () => {
    expect(renderToStaticMarkup(createElement(Bar, BASE))).not.toContain('shell-search');
  });

  it('is a live button with its shortcut when a search is offered', () => {
    const markup = renderToStaticMarkup(createElement(Bar, { ...BASE, search: { run: () => [], choose: () => {} } }));
    expect(markup).toContain('<button type="button" class="shell-search" aria-label="Search"');
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

describe('Bar — r31-bar A, on the drawing', () => {
  const onCanvas = (over: Partial<BarProps> = {}) =>
    renderToStaticMarkup(
      createElement(Bar, {
        ...BASE,
        toolsOnCanvas: true,
        mainView: { value: 'canvas', onChange: () => {} },
        doing: [
          { id: 'plan', label: 'Plan a change', onSelect: () => {} },
          { id: 'down', label: "It's down", hint: 'select a device first' },
        ],
        onShare: () => {},
        onPrint: () => {},
        onDocs: () => {},
        onHistory: () => {},
        ...over,
      }),
    );

  it('names the four views, Canvas current', () => {
    const markup = onCanvas();
    for (const v of ['diagram', 'canvas', 'inventory', 'sheet']) expect(markup).toContain(`data-testid="view-${v}"`);
    expect(markup).toMatch(/aria-current="page"[^>]*data-testid="view-canvas"/);
  });

  it('keeps Doing and Share, and leaves the lens, Undo, zoom, Docs, History and Print to the drawing and the panel', () => {
    const markup = onCanvas();
    expect(markup).toContain('data-testid="shell-doing"');
    expect(markup).toContain('data-testid="shell-share"');
    expect(markup).not.toContain('>Routing<');
    expect(markup).not.toContain('>Undo<');
    expect(markup).not.toContain('aria-label="Zoom in"');
    expect(markup).not.toContain('data-testid="shell-docs"');
    expect(markup).not.toContain('data-testid="shell-history"');
    expect(markup).not.toContain('data-testid="shell-show"');
  });
});

describe('Bar — renaming the design from its crumb', () => {
  const crumb = { label: 'Untitled design', opensTree: true };

  it('shows the pencil, and a double-click hint, where the person may rename', () => {
    const markup = renderToStaticMarkup(
      createElement(Bar, { ...BASE, path: [{ ...crumb, rename: { onRename: () => Promise.resolve() } }] }),
    );
    expect(markup).toContain('data-testid="shell-rename-pencil"');
    expect(markup).toContain('aria-label="Rename Untitled design"');
    expect(markup).toContain('double-click to rename');
  });

  it('shows neither where the person may only read', () => {
    const markup = renderToStaticMarkup(createElement(Bar, { ...BASE, path: [crumb] }));
    expect(markup).not.toContain('shell-rename-pencil');
    expect(markup).not.toContain('double-click to rename');
  });
});

describe('Bar — a long design name', () => {
  it('sits in its own clipped span, with the whole name in the tooltip', () => {
    const name = 'N'.repeat(100);
    const markup = renderToStaticMarkup(createElement(Bar, { ...BASE, path: [{ label: name, opensTree: true }] }));
    expect(markup).toContain(`<span class="shell-bar__path-text">${name}</span>`);
    expect(markup).toContain(`title="${name} · switch to another place or design"`);
  });
});
