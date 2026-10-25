import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Glossed } from './Glossed';

describe('Glossed', () => {
  it('keeps the full stop after a word on the word, so a line never starts with it', () => {
    const html = renderToStaticMarkup(createElement(Glossed, { text: 'joins them into one broadcast domain. Hosts see it.' }));
    expect(html).toContain('broadcast domain</button>.</span> Hosts see it.');
    expect(html.replace(/<[^>]+>/g, '')).toBe('joins them into one broadcast domain. Hosts see it.');
  });
});
