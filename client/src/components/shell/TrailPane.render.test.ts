import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { TrailPane } from './TrailPane';

function render(open: boolean): string {
  return renderToStaticMarkup(createElement(TrailPane, { open, onOpenChange: () => {}, children: 'rows' }));
}

describe('TrailPane — folded to a strip on the right', () => {
  it('closed: only the strip, which opens it', () => {
    const markup = render(false);
    expect(markup).toContain('aria-label="Open the trail"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('<aside');
    expect(markup).not.toContain('rows');
  });

  it('open: the trail beside the strip, which now closes it', () => {
    const markup = render(true);
    expect(markup).toContain('<aside class="shell-trail" aria-label="Trail">rows</aside>');
    expect(markup).toContain('aria-label="Close the trail"');
  });
});
