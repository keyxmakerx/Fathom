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
  presence: [],
  canUndo: false,
  canRedo: false,
  onUndo: () => {},
  onRedo: () => {},
  account: { initials: 'AB', address: 'a@example.com' },
};

describe('Bar — what is present where', () => {
  it('with a design open: the place tabs act, and Undo and Redo are there', () => {
    const markup = renderToStaticMarkup(createElement(Bar, BASE));
    expect(markup).toContain('<button type="button" class="shell-bar__tab shell-bar__tab--on">Canvas</button>');
    expect(markup).toContain('>Undo<');
    expect(markup).toContain('>Redo<');
  });

  it('the bar holds no lens, no zoom and no Docs, History or Print chip: those are the view\'s, and the panel\'s', () => {
    for (const place of ['racks', 'inventory'] as const) {
      const markup = renderToStaticMarkup(createElement(Bar, { ...BASE, place, onPrint: () => {}, onShare: () => {} }));
      expect(markup).not.toContain('>Routing<');
      expect(markup).not.toContain('>Cables<');
      expect(markup).not.toContain('>Power<');
      expect(markup).not.toContain('aria-label="Zoom in"');
      expect(markup).not.toContain('data-testid="shell-docs"');
      expect(markup).not.toContain('data-testid="shell-history"');
      expect(markup).not.toContain('data-testid="shell-print"');
      expect(markup).not.toContain('>More ▾<');
    }
  });

  it('with nothing open (Home, Admin), and no design opened this session: no view names, no Undo, no Redo', () => {
    const markup = renderToStaticMarkup(createElement(Bar, { ...BASE, place: null, work: { on: false, onOpen: () => {} } }));
    for (const name of ['Diagram', 'Canvas', 'Inventory', 'Sheet']) expect(markup).not.toContain(`>${name}<`);
    expect(markup).toContain('data-testid="view-work"');
    expect(markup).not.toContain('Undo');
    expect(markup).not.toContain('Redo');
  });

  it('with nothing open but a design open before (Home, Admin): the four views go back to it, none marked', () => {
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

// r116: the same bar on Canvas, Diagram, Inventory and Sheet.
describe('Bar — r116, identical on every view', () => {
  const sample = createElement('span', { className: 'sample-chip-stand-in' }, 'Sample');
  const on = (view: 'diagram' | 'canvas' | 'inventory' | 'sheet', over: Partial<BarProps> = {}) =>
    renderToStaticMarkup(
      createElement(Bar, {
        ...BASE,
        place: view === 'diagram' || view === 'canvas' ? 'racks' : 'inventory',
        mainView: { value: view, onChange: () => {} },
        work: { on: false, onOpen: () => {} },
        path: [{ label: 'Harbour Networks', onSelect: () => {} }, { label: 'Sample home lab', opensTree: true }],
        designExtra: sample,
        doing: [
          { id: 'plan', label: 'Plan a change', onSelect: () => {} },
          { id: 'down', label: "It's down", hint: 'select a device first' },
        ],
        onShare: () => {},
        onPrint: () => {},
        adminPill: { onSelect: () => {} },
        search: { run: () => [], choose: () => {} },
        ...over,
      }),
    );
  const VIEWS = ['diagram', 'canvas', 'inventory', 'sheet'] as const;

  it('names the four views and Work, the current view marked', () => {
    const markup = on('canvas');
    for (const v of VIEWS) expect(markup).toContain(`data-testid="view-${v}"`);
    expect(markup).toContain('data-testid="view-work"');
    expect(markup).toMatch(/aria-current="page"[^>]*data-testid="view-canvas"/);
  });

  it('is the same bar on every view: the same controls, in the same order', () => {
    // What differs is only which view is marked; everything else is the same markup.
    const strip = (markup: string) => markup.replace(/ aria-current="page"/g, '').replace(/ aria-selected="(true|false)"/g, '').replace(/ shell-bar__tab--on/g, '').replace(/<span class="shell-bar__tabs-mark"[^>]*><\/span>/g, '');
    const [first, ...rest] = VIEWS.map((v) => strip(on(v)));
    for (const other of rest) expect(other).toBe(first);
  });

  it.each(VIEWS)('%s: the organisation, the design name, the Sample chip, Search, Undo, Redo, Doing, Share and the Admin pill', (view) => {
    const markup = on(view);
    expect(markup).toContain('>Harbour Networks<');
    expect(markup).toContain('Sample home lab');
    expect(markup).toContain('sample-chip-stand-in');
    expect(markup).toContain('class="shell-search"');
    expect(markup).toContain('>Undo<');
    expect(markup).toContain('>Redo<');
    expect(markup).toContain('data-testid="shell-doing"');
    expect(markup).toContain('data-testid="shell-share"');
    expect(markup).toContain('data-testid="shell-admin-pill"');
    // Search is the one field, never an icon beside the others.
    expect(markup).not.toContain('shell-search--collapsed');
  });

  it('puts Undo and Redo before Doing and Share, and Search before Undo', () => {
    const markup = on('inventory');
    expect(markup.indexOf('class="shell-search"')).toBeLessThan(markup.indexOf('>Undo<'));
    expect(markup.indexOf('>Redo<')).toBeLessThan(markup.indexOf('data-testid="shell-doing"'));
    expect(markup.indexOf('data-testid="shell-doing"')).toBeLessThan(markup.indexOf('data-testid="shell-share"'));
    expect(markup.indexOf('data-testid="shell-share"')).toBeLessThan(markup.indexOf('data-testid="shell-admin-pill"'));
  });

  it('holds no lens, no zoom and no Docs, History or Print chip', () => {
    const markup = on('canvas');
    expect(markup).not.toContain('>Routing<');
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
