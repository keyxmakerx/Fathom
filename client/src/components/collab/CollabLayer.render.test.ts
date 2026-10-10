import { ReactFlowProvider } from '@xyflow/react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CollabContext, type CollabApi } from './CollabContext';
import { CollabLayer } from './CollabLayer';

function render(collab: CollabApi | null): string {
  return renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(CollabContext.Provider, { value: collab }, createElement(CollabLayer))));
}

const api = (changes: CollabApi['changes']): CollabApi => ({ setPointer: () => {}, subscribePointers: () => () => {}, changes, select: () => {} });

describe('CollabLayer', () => {
  it('draws nothing outside a design, or when nothing changed', () => {
    expect(render(null)).toBe('');
    expect(render(api(null))).toBe('');
  });

  it('says what changed, with a way to step through and a way to close', () => {
    const html = render(api({ sentence: '2 changes by Sam since Tuesday', things: [{ id: 'chassis:a', kind: 'chassis' }], glowed: { current: true }, dismiss: () => {} }));
    expect(html).toContain('2 changes by Sam since Tuesday');
    expect(html).toContain('>Step through</button>');
    expect(html).toContain('aria-label="Close and mark as seen"');
  });

  it('offers no stepping when nothing it changed can be shown on the canvas', () => {
    const html = render(api({ sentence: '1 change by someone since today at 09:00', things: [], glowed: { current: true }, dismiss: () => {} }));
    expect(html).toContain('1 change by someone');
    expect(html).not.toContain('Step through');
  });
});
