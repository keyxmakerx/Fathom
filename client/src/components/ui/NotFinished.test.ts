import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { IP_PLAN_MISSING, IP_PLAN_WORKS, MAIL_MISSING, MAIL_WORKS, ORDER_TYPES_MISSING, ORDER_TYPES_WORKS } from '../organisation/notFinishedText';
import { NOT_FINISHED, NotFinishedMark, NotFinishedPage } from './NotFinished';

describe('the Not finished mark', () => {
  it('is the same two words everywhere', () => {
    expect(NOT_FINISHED).toBe('Not finished');
    expect(renderToStaticMarkup(createElement(NotFinishedMark))).toContain('>Not finished</span>');
  });

  it('puts the mark and a plain sentence first, then what is there and what is not', () => {
    const html = renderToStaticMarkup(createElement(NotFinishedPage, { title: 'Mail', works: ['a'], missing: ['b'] }));
    expect(html.indexOf('Not finished')).toBeLessThan(html.indexOf('What is there'));
    expect(html).toContain('What is not there yet');
    expect(html).not.toContain('<button');
  });

  it('never uses a forbidden phrase (CLAUDE.md rule 5)', () => {
    const all = [ORDER_TYPES_WORKS, ORDER_TYPES_MISSING, IP_PLAN_WORKS, IP_PLAN_MISSING, MAIL_WORKS, MAIL_MISSING].flat().join(' ').toLowerCase();
    // Built from parts so this file does not itself write them (scripts/forbidden-claims.sh).
    for (const phrase of [['zero', 'knowledge'].join('-'), ['end', 'to', 'end'].join('-'), ['we cannot read', 'your data'].join(' '), ['only you hold', 'the key'].join(' ')]) expect(all).not.toContain(phrase);
  });
});
