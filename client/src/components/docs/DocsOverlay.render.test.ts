import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DocsContext, type DocsApi } from './context';
import { DocsOverlay } from './DocsOverlay';

const api = { canEdit: true, all: () => [], label: () => '', get: () => undefined, of: () => [] } as unknown as DocsApi;
const render = (view: Parameters<typeof DocsOverlay>[0]['view']) =>
  renderToStaticMarkup(createElement(DocsContext.Provider, { value: api, children: createElement(DocsOverlay, { view, onView: () => {}, onClose: () => {} }) }));

describe('the Docs panel head (r116)', () => {
  it('is the shared head: its name and one fold arrow, with no cross', () => {
    const html = render({ kind: 'list' });
    expect(html).toContain('<h2 class="panel-head__name">Docs</h2>');
    expect(html).toContain('aria-label="Fold Docs"');
    expect(html).not.toContain('Close docs');
    expect(html).not.toContain('×');
  });

  it('a doc opened from the list keeps its way back to the list, under the head', () => {
    const html = render({ kind: 'doc', id: 'd1', from: 'list' });
    expect(html).toContain('← All docs');
    expect(html).not.toContain('×');
  });
});
