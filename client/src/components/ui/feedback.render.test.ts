import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EmptyState } from './EmptyState';
import { SkeletonRacks, SkeletonRows } from './Skeleton';

describe('EmptyState', () => {
  it('says what is empty, what belongs there, and offers the one button', () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, { title: 'No docs yet.', action: { label: 'Add doc', onClick: () => {} } }, 'Write down how this works.'),
    );
    expect(html).toContain('No docs yet.');
    expect(html).toContain('Write down how this works.');
    expect(html).toContain('>Add doc</button>');
  });

  it('draws no button where nothing fits, and keeps the caller\'s class', () => {
    const html = renderToStaticMarkup(createElement(EmptyState, { title: 'No changes yet.', className: 'racks-trail__empty' }, 'Edits are recorded here.'));
    expect(html).not.toContain('<button');
    expect(html).toContain('racks-trail__empty');
  });
});

describe('Skeleton', () => {
  it('keeps the loading words as hidden text, so readers and scripts still find them', () => {
    const rows = renderToStaticMarkup(createElement(SkeletonRows, { label: 'Loading the saves…' }));
    expect(rows).toContain('<span class="skeleton__said">Loading the saves…</span>');
    expect(rows).toContain('aria-busy="true"');
    const racks = renderToStaticMarkup(createElement(SkeletonRacks, {}));
    expect(racks).toContain('Opening the design…');
    expect(racks).toContain('aria-busy="true"');
  });
});
