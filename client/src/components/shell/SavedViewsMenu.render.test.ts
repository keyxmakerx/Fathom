import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SavedViewsMenu } from './SavedViewsMenu';

describe('SavedViewsMenu', () => {
  it('is a Views button beside Show, closed until pressed', () => {
    const html = renderToStaticMarkup(createElement(SavedViewsMenu, { views: [], onSave: () => null, onGo: () => {}, onRename: () => null, onDelete: () => {} }));
    expect(html).toContain('Views ▾');
    expect(html).toContain('data-testid="shell-views"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Saved views');
  });
});
