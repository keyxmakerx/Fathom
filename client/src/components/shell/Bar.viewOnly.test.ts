import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { Bar, type BarProps } from './Bar';

// Render-to-string smoke test, the same shape `Popover.render.test.ts` and
// `Editor.render.test.ts` already use (file headers on both: no DOM testing
// library is installed here). `Bar.tsx`'s theme switch reads `localStorage`
// synchronously in its own initial state (`getStoredTheme()`), which the
// `node` vitest environment (`vitest.config.ts`) does not provide — stubbed
// minimally here rather than reaching for a DOM library, since nothing in
// this test exercises the theme switch itself.
beforeAll(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
});

const BASE_PROPS: BarProps = {
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

describe('Bar — ADR-0052 §5 "view only" chip', () => {
  it('renders no chip when viewOnly is absent', () => {
    const markup = renderToStaticMarkup(createElement(Bar, BASE_PROPS));
    expect(markup).not.toContain('View only');
  });

  it('renders no chip when viewOnly is explicitly false', () => {
    const markup = renderToStaticMarkup(createElement(Bar, { ...BASE_PROPS, viewOnly: false }));
    expect(markup).not.toContain('View only');
  });

  it('renders the chip when viewOnly is true', () => {
    const markup = renderToStaticMarkup(createElement(Bar, { ...BASE_PROPS, viewOnly: true }));
    expect(markup).toContain('View only');
    expect(markup).toContain('aria-label="view only"');
  });
});
