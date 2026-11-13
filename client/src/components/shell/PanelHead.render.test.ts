import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { InHeadMenu, PanelHead } from './PanelHead';

const noop = () => {};

describe('PanelHead (r116: one head for every right panel)', () => {
  it('is its name and one fold arrow, with no word "Fold" and no cross', () => {
    const markup = renderToStaticMarkup(createElement(PanelHead, { name: 'Checks', onFold: noop }));
    expect(markup).toContain('<h2 class="panel-head__name">Checks</h2>');
    expect((markup.match(/data-testid="panel-fold"/g) ?? []).length).toBe(1);
    expect(markup).toContain('aria-label="Fold Checks"');
    expect(markup).toContain('>›<');
    expect(markup).not.toContain('>Fold<');
    expect(markup).not.toContain('×');
    expect(markup).not.toContain('⋯');
  });

  it('adds a ⋯ only where the thing has a menu', () => {
    const plain = renderToStaticMarkup(createElement(PanelHead, { name: 'Docs', onFold: noop }));
    expect(plain).not.toContain('⋯');
    const withMenu = renderToStaticMarkup(createElement(PanelHead, { name: "It's down", onFold: noop, rows: [{ label: 'Stop this', onSelect: noop }] }));
    expect(withMenu).toContain('⋯');
    expect((withMenu.match(/data-testid="panel-fold"/g) ?? []).length).toBe(1);
  });

  it('a panel\'s own ⋯ menu draws where it is when there is no head around it', () => {
    expect(renderToStaticMarkup(createElement(InHeadMenu, { children: createElement('span', null, 'dots') }))).toBe('<span>dots</span>');
  });
});
