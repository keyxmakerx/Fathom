import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { SavedView } from '../drawing/savedViews';
import { SavedViewsMenu, type SavedViewsMenuProps } from './SavedViewsMenu';

const layers = { checks: true, addresses: false, vlans: false, docs: false, maintenance: false, tags: false };
const view = (id: string, name: string): SavedView => ({ id, name, look: 'rack', camera: { x: 0, y: 0, zoom: 1 }, layers });
const props = (over: Partial<SavedViewsMenuProps> = {}): SavedViewsMenuProps => ({ views: [], onSave: () => null, onGo: () => {}, onRename: () => null, onDelete: () => {}, ...over });
const render = (over: Partial<SavedViewsMenuProps> = {}) => renderToStaticMarkup(createElement(SavedViewsMenu, props(over)));

describe('SavedViewsMenu', () => {
  it('is a segmented group: the Views button (closed until pressed) and a plus', () => {
    const html = render();
    expect(html).toContain('data-testid="shell-views"');
    expect(html).toContain('>Views</button>');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-testid="views-add"');
    expect(html).not.toContain('Saved views</div>');
  });

  it('shows the first three saved views as buttons, the rest only in the menu, and marks the current one', () => {
    const html = render({ views: [view('a', 'Wall 1'), view('b', 'Wall 2'), view('c', 'Core'), view('d', 'Edge')], currentId: 'b' });
    expect(html.match(/data-testid="views-bar-go"/g)).toHaveLength(3);
    expect(html).not.toContain('>Edge<');
    expect(html).toContain('vgroup__btn--current');
    expect(html.match(/vgroup__btn--current/g)).toHaveLength(1);
  });
});
